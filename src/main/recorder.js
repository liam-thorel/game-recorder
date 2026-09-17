// Orchestrateur : détecte les parties, pilote OBS, collecte les événements et lance le post-traitement.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { listProcesses, EXE } = require('./games/processes');
const lolClient = require('./games/lolClient');
const riotClient = require('./games/riotClient');
const { processRecording, fetchValorantHighlights } = require('./postprocess');

const TICK_MS = 2000;
// OBS reste ouvert un moment après la fermeture du jeu (enchaînement de parties, relance du client).
const OBS_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const VALORANT_RETRY_MS = 60 * 1000;

class Recorder extends EventEmitter {
  constructor({ obs, library, getSettings, updateSettings, log }) {
    super();
    this.obs = obs;
    this.library = library;
    this.getSettings = getSettings;
    this.updateSettings = updateSettings;
    this.log = log || (() => {});
    this.session = null;
    this.state = 'idle'; // idle | starting | recording | stopping
    this.queue = [];
    this.processing = null;
    this.lastGameSeen = 0;
    this.cooldownUntil = 0;
    this.lastError = null;
    this.riot = { puuid: null, checkedAt: 0 };
    this.valorantTimers = new Map();
  }

  get rawDir() {
    return path.join(this.getSettings().recordingsDir, '_raw');
  }

  get sessionFile() {
    return path.join(this.rawDir, 'session.json');
  }

  start() {
    this.recover();
    for (const meta of this.library.list()) {
      if (meta.game === 'valorant' && meta.highlightsStatus === 'pending') this.scheduleValorant(meta.id, 5000);
    }
    const loop = async () => {
      try {
        await this.tick();
      } catch (e) {
        this.log(`tick : ${e.stack || e.message}`);
      }
      this.timer = setTimeout(loop, TICK_MS);
    };
    loop();
  }

  status() {
    return {
      state: this.state,
      game: this.session?.game || null,
      startedAtMs: this.session?.startedAtMs || null,
      markers: this.session?.markers.length || 0,
      obsConnected: this.obs.connected,
      processing: this.queue.length + (this.processing ? 1 : 0),
      finalizing: !!this.finalizing,
      lastError: this.lastError,
    };
  }

  emitStatus() {
    this.emit('status', this.status());
  }

  setError(msg) {
    this.lastError = msg ? { message: msg, at: Date.now() } : null;
    if (msg) this.log(`Erreur : ${msg}`);
    this.emitStatus();
  }

  addMarker() {
    if (this.state !== 'recording' || !this.session) return null;
    const t = (Date.now() - this.session.startedAtMs) / 1000;
    this.session.markers.push(t);
    this.persistSession();
    this.emitStatus();
    return t;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickInner();
    } finally {
      this.ticking = false;
    }
  }

  async tickInner() {
    const s = this.getSettings();
    const now = Date.now();
    const procs = await listProcesses();
    const lolRunning = s.recordLol && procs.has(EXE.lol);
    const valoRunning = s.recordValorant && procs.has(EXE.valorant);
    if (lolRunning || valoRunning) this.lastGameSeen = now;

    // OBS est lancé dès que le jeu est ouvert, pour être prêt au début de la partie.
    if ((lolRunning || valoRunning) && !this.obs.connected && !this.obsStarting) {
      this.obsStarting = this.obs
        .start()
        .then(() => this.setError(null))
        .catch((e) => this.setError(`OBS : ${e.message}`))
        .finally(() => {
          this.obsStarting = null;
          this.emitStatus();
        });
    }

    if (!this.session) {
      if (now < this.cooldownUntil || this.obs.finalizing) return;
      if (lolRunning) {
        const data = await lolClient.getAllGameData();
        // Après la fin de partie, le jeu reste ouvert quelques secondes et l'API répond encore : on ne relance pas.
        const ended = data?.events?.Events?.some((e) => e.EventName === 'GameEnd');
        if (data && data.gameData && !ended) await this.begin('lol', { data });
      } else if (valoRunning) {
        const puuid = await this.riotPuuid();
        const presence = puuid && (await riotClient.getValorantPresence(puuid));
        if (presence && presence.state === 'INGAME' && presence.provisioningFlow !== 'ShootingRange') {
          await this.begin('valorant', { puuid, presence });
        }
      } else if (this.obs.connected && !this.processing && now - this.lastGameSeen > OBS_IDLE_SHUTDOWN_MS) {
        this.log('Plus de jeu ouvert : arrêt d\'OBS');
        await this.obs.shutdown();
        this.emitStatus();
      }
      return;
    }

    if (this.state !== 'recording') return;
    const session = this.session;

    if (session.game === 'lol') {
      if (!procs.has(EXE.lol)) return this.end('fermeture du jeu');
      const data = await lolClient.getAllGameData();
      if (data) {
        this.updateLol(data);
        session.lol.lastOkAt = now;
        if (!session.lol.endSeenAt && session.lol.events.some((e) => e.EventName === 'GameEnd')) session.lol.endSeenAt = now;
      }
      if (session.lol.endSeenAt && now - session.lol.endSeenAt > 6000) return this.end('fin de partie');
      if (!data && now - (session.lol.lastOkAt || session.startedAtMs) > 30000) return this.end('API LoL indisponible');
    } else {
      if (!procs.has(EXE.valorant)) return this.end('fermeture du jeu');
      const presence = await riotClient.getValorantPresence(session.valorant.puuid);
      if (presence) {
        if (presence.state !== 'INGAME') {
          if (++session.valorant.notInGame >= 2) return this.end('fin de partie');
        } else {
          session.valorant.notInGame = 0;
          if (presence.map) session.valorant.map = presence.map;
          if (presence.queue) session.valorant.queue = presence.queue;
          if (presence.allyScore != null && presence.enemyScore != null) {
            const total = presence.allyScore + presence.enemyScore;
            const changes = session.valorant.scoreChanges;
            if (total > (changes.length ? changes[changes.length - 1].total : 0)) {
              changes.push({ total, t: Math.round(((now - session.startedAtMs) / 1000) * 100) / 100 });
            }
          }
        }
      }
    }

    if (now - (session.persistedAt || 0) > 30000) this.persistSession();
  }

  async riotPuuid() {
    const now = Date.now();
    if (!this.riot.puuid && now - this.riot.checkedAt > 10000) {
      this.riot.checkedAt = now;
      const sess = await riotClient.getSession();
      if (sess) this.riot = { ...sess, checkedAt: now };
    }
    return this.riot.puuid;
  }

  updateLol(data) {
    const lol = this.session.lol;
    lol.events = data.events?.Events || lol.events;
    lol.activePlayer = data.activePlayer || lol.activePlayer;
    lol.allPlayers = data.allPlayers || lol.allPlayers;
    lol.gameMode = data.gameData?.gameMode || lol.gameMode;
    if (typeof data.gameData?.gameTime === 'number') {
      const elapsed = (Date.now() - this.session.startedAtMs) / 1000;
      const offset = elapsed - data.gameData.gameTime;
      lol.offset = lol.offset == null ? offset : Math.min(lol.offset, offset);
    }
  }

  async begin(game, ctx) {
    this.state = 'starting';
    this.session = {
      game,
      startedAtMs: null,
      markers: [],
      lol: { events: [], offset: null },
      valorant: {
        puuid: ctx.puuid || null,
        map: ctx.presence?.map || null,
        queue: ctx.presence?.queue || null,
        scoreChanges: [],
        notInGame: 0,
      },
    };
    this.emitStatus();
    try {
      // Garde-fou : quoi qu'il arrive côté OBS, on ne reste pas bloqué sur « Démarrage… ».
      let timer;
      const giveUp = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('OBS ne répond pas (délai dépassé)')), 90000);
      });
      try {
        this.session.startedAtMs = await Promise.race([
          (async () => {
            if (this.obsStarting) await this.obsStarting;
            return this.obs.startRecording(game);
          })(),
          giveUp,
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      this.session = null;
      this.state = 'idle';
      this.cooldownUntil = Date.now() + 30000;
      this.setError(`Impossible de démarrer l'enregistrement : ${e.message}`);
      return;
    }
    this.state = 'recording';
    this.setError(null);
    this.persistSession();
    this.log(`Enregistrement ${game} démarré`);
    this.emit('recording-started', { game });
    this.emitStatus();
  }

  async end(reason) {
    const session = this.session;
    this.state = 'stopping';
    this.emitStatus();
    this.log(`Arrêt de l'enregistrement (${reason})`);
    let stop = null;
    try {
      stop = await this.obs.stopRecording();
    } catch (e) {
      this.setError(`Arrêt de l'enregistrement : ${e.message}`);
    }
    this.session = null;
    this.state = 'idle';
    this.cooldownUntil = Date.now() + 5000;
    this.emit('recording-stopped', { game: session.game });
    this.emitStatus();
    if (!stop) return;

    // La finalisation du fichier peut être longue : on ne bloque pas la détection pendant ce temps.
    this.finalizing = stop.done.then((res) => {
      this.finalizing = null;
      fs.rmSync(this.sessionFile, { force: true });
      if (!res || !res.path || !fs.existsSync(res.path)) {
        this.setError("Fichier d'enregistrement introuvable");
        return;
      }
      const s = res.stats;
      if (s && s.outputTotalFrames > 0) {
        const lost = s.outputSkippedFrames / (s.outputTotalFrames + s.outputSkippedFrames);
        session.skippedRatio = Math.round(lost * 1000) / 1000;
        if (lost > 0.05) {
          this.setError(`${Math.round(lost * 100)} % d'images perdues (encodeur surchargé) — voir Réglages`);
        }
      }
      this.log(`Fichier finalisé : ${res.path}${session.skippedRatio != null ? ` (images perdues ${Math.round(session.skippedRatio * 100)} %)` : ''}`);
      this.enqueue({ rawPath: res.path, session });
    });
    this.emitStatus();
  }

  persistSession() {
    if (!this.session) return;
    this.session.persistedAt = Date.now();
    try {
      fs.mkdirSync(this.rawDir, { recursive: true });
      fs.writeFileSync(this.sessionFile, JSON.stringify(this.session));
    } catch (e) {
      this.log(`Sauvegarde session : ${e.message}`);
    }
  }

  /** Reprend les post-traitements en attente et les enregistrements interrompus (crash, extinction du PC). */
  recover() {
    if (!fs.existsSync(this.rawDir)) return;
    for (const f of fs.readdirSync(this.rawDir).filter((f) => /^job-\d+\.json$/.test(f))) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(this.rawDir, f), 'utf8'));
        if (fs.existsSync(job.rawPath)) this.enqueue(job, path.join(this.rawDir, f));
        else fs.rmSync(path.join(this.rawDir, f), { force: true });
      } catch {}
    }
    let session;
    try {
      session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
    } catch {
      return;
    }
    fs.rmSync(this.sessionFile, { force: true });
    if (!session?.startedAtMs) return;
    const queued = new Set(this.queue.map((j) => j.rawPath));
    const candidate = fs
      .readdirSync(this.rawDir)
      .filter((f) => f.endsWith('.mkv'))
      .map((f) => ({ p: path.join(this.rawDir, f), m: fs.statSync(path.join(this.rawDir, f)).mtimeMs }))
      .filter((f) => f.m >= session.startedAtMs && !queued.has(f.p))
      .sort((x, y) => x.m - y.m)[0];
    if (candidate) {
      this.log(`Récupération d'un enregistrement interrompu : ${candidate.p}`);
      this.enqueue({ rawPath: candidate.p, session });
    }
  }

  enqueue(job, jobFile) {
    if (!jobFile) {
      jobFile = path.join(this.rawDir, `job-${job.session.startedAtMs}.json`);
      try {
        fs.writeFileSync(jobFile, JSON.stringify(job));
      } catch {}
    }
    this.queue.push({ ...job, jobFile });
    this.emitStatus();
    if (!this.shuttingDown) this.drain();
  }

  async drain() {
    if (this.processing) return;
    while (this.queue.length && !this.shuttingDown) {
      this.processing = this.queue.shift();
      this.emitStatus();
      try {
        const { rawPath, session, jobFile } = this.processing;
        const meta = await processRecording({ rawPath, session, library: this.library, log: this.log });
        fs.rmSync(jobFile, { force: true });
        this.library.enforceRetention();
        this.emit('library-changed');
        this.emit('vod-ready', meta);
        if (meta.game === 'valorant') this.scheduleValorant(meta.id, 90 * 1000);
      } catch (e) {
        this.setError(`Post-traitement : ${e.message}`);
      }
      this.processing = null;
    }
    this.emitStatus();
  }

  scheduleValorant(id, delay = VALORANT_RETRY_MS) {
    clearTimeout(this.valorantTimers.get(id));
    this.valorantTimers.set(
      id,
      setTimeout(async () => {
        this.valorantTimers.delete(id);
        const res = await fetchValorantHighlights({
          id,
          library: this.library,
          settings: this.getSettings(),
          updateSettings: this.updateSettings,
          log: this.log,
        });
        this.emit('library-changed');
        if (res === 'retry') this.scheduleValorant(id);
      }, delay)
    );
  }

  /** Relance manuelle (ex. après avoir ajouté la clé API). */
  refetchValorant(id) {
    const meta = this.library.read(id);
    if (!meta?.valorant) return;
    meta.valorant.attempts = 0;
    meta.highlightsStatus = 'pending';
    this.library.write(meta);
    this.scheduleValorant(id, 100);
  }

  async shutdown() {
    this.shuttingDown = true;
    clearTimeout(this.timer);
    for (const t of this.valorantTimers.values()) clearTimeout(t);
    if (this.state === 'recording') await this.end('fermeture de l\'application');
    if (this.finalizing) await Promise.race([this.finalizing, new Promise((r) => setTimeout(r, 120000))]);
    await this.obs.shutdown();
  }
}

module.exports = { Recorder };
