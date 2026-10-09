// Après une partie : MKV brut -> dossier VOD (MP4 + pistes audio séparées + miniature + meta.json).
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const lolHighlights = require('./highlights/lol');
const valorantHighlights = require('./highlights/valorant');
const henrik = require('./highlights/henrik');

const TRACK_FILES = ['mic', 'discord', 'game']; // pistes audio 2, 3, 4 d'OBS

function vodId(startedAtMs, game) {
  const d = new Date(startedAtMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_${game}`;
}

/**
 * @param {object} p
 * @param {string} p.rawPath
 * @param {object} p.session  données collectées pendant la partie (voir recorder.js)
 * @param {import('./library').Library} p.library
 */
async function processRecording({ rawPath, session, library, log = () => {} }) {
  const id = vodId(session.startedAtMs, session.game);
  const dir = library.dir(id);
  fs.mkdirSync(dir, { recursive: true });
  log(`Post-traitement ${id}`);

  const meta = {
    id,
    game: session.game,
    status: 'processing',
    startedAt: new Date(session.startedAtMs).toISOString(),
    duration: 0,
    files: { video: 'video.mp4', thumb: 'thumb.jpg', tracks: {} },
    stats: {},
    highlights: [],
    markers: (session.markers || []).map((t, i) => ({ id: `m${i}`, t: Math.round(t * 100) / 100, label: 'Marqueur' })),
    favorite: false,
    syncOffset: 0,
    highlightsStatus: 'pending',
  };
  library.write(meta);

  const info = await ffmpeg.probe(rawPath);
  if (session.skippedRatio != null) meta.skippedRatio = session.skippedRatio;

  // Remux sans ré-encodage ; la piste "Mix" reste la piste audio par défaut.
  const video = path.join(dir, 'video.mp4');
  await ffmpeg.run(['-i', rawPath, '-map', '0', '-c', 'copy', '-disposition:a', '0', '-disposition:a:0', 'default', '-movflags', '+faststart', video]);
  // Durée lue sur le MP4 : un MKV interrompu (crash) n'a pas de durée dans son en-tête.
  meta.duration = Math.round((await ffmpeg.probe(video)).duration * 100) / 100;
  if (!meta.duration) throw new Error(`Vidéo vide ou illisible : ${rawPath}`);

  // Pistes séparées pour le lecteur (mixage en direct).
  const trackArgs = ['-i', rawPath];
  TRACK_FILES.forEach((name, i) => {
    if (i + 1 < info.audioStreams) {
      trackArgs.push('-map', `0:a:${i + 1}`, '-c', 'copy', path.join(dir, `${name}.m4a`));
      meta.files.tracks[name] = `${name}.m4a`;
    }
  });
  if (Object.keys(meta.files.tracks).length) await ffmpeg.run(trackArgs);

  const thumbAt = Math.min(90, Math.max(0, meta.duration / 3));
  await ffmpeg
    .run(['-ss', String(thumbAt), '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', path.join(dir, 'thumb.jpg')])
    .catch((e) => log(`Miniature : ${e.message}`));

  if (session.game === 'lol') {
    const { highlights, stats } = lolHighlights.analyze(session.lol || {});
    meta.highlights = highlights.filter((h) => h.t <= meta.duration + 5);
    meta.stats = { ...stats, mode: session.mode?.label || stats.mode };
    meta.highlightsStatus = 'ready';
  } else if (session.game === 'valorant') {
    const v = session.valorant || {};
    meta.stats = { map: prettyMap(v.map), mode: session.mode?.label || v.queue || null };
    meta.valorant = { puuid: v.puuid, scoreChanges: v.scoreChanges || [], recordingStartedAtMs: session.startedAtMs, attempts: 0 };
  }

  meta.status = 'ready';
  meta.sizeBytes = library.folderSize(id);
  library.write(meta);
  fs.rmSync(rawPath, { force: true });
  return meta;
}

/**
 * Récupère le match sur HenrikDev et calcule les highlights Valorant.
 * @returns {Promise<'ready'|'retry'|'failed'>}
 */
async function fetchValorantHighlights({ id, library, settings, updateSettings, log = () => {} }) {
  const meta = library.read(id);
  if (!meta || !meta.valorant) return 'failed';
  const v = meta.valorant;
  const save = (status, error) => {
    meta.highlightsStatus = status;
    meta.highlightsError = error || null;
    library.write(meta);
  };
  if (!settings.henrikApiKey) {
    save('no-api-key', 'Ajoute une clé API HenrikDev dans les paramètres');
    return 'failed';
  }
  if (!v.puuid) {
    save('unavailable', 'Compte Riot non détecté pendant la partie');
    return 'failed';
  }
  v.attempts = (v.attempts || 0) + 1;
  try {
    let region = settings.valorantRegion;
    if (!region) {
      region = await henrik.getAccountRegion(v.puuid, settings.henrikApiKey);
      if (region) updateSettings({ valorantRegion: region });
    }
    const matches = await henrik.getRecentMatches(region, v.puuid, settings.henrikApiKey, 5);
    const recStart = v.recordingStartedAtMs;
    const match = matches
      .filter((m) => m.startedAtMs && Math.abs(m.startedAtMs - recStart) < 15 * 60 * 1000)
      .sort((a, b) => Math.abs(a.startedAtMs - recStart) - Math.abs(b.startedAtMs - recStart))[0];
    if (!match) {
      if (v.attempts >= 12) {
        save('unavailable', 'Match introuvable sur HenrikDev (partie personnalisée ?)');
        return 'failed';
      }
      save('pending');
      return 'retry';
    }
    const res = valorantHighlights.analyze(match, v.puuid, { startedAtMs: recStart, scoreChanges: v.scoreChanges });
    meta.highlights = res.highlights.filter((h) => h.t <= meta.duration + 5);
    meta.stats = { ...meta.stats, ...res.stats, map: res.stats.map || meta.stats.map };
    meta.scoreboard = res.scoreboard;
    meta.sync = res.sync;
    save('ready');
    log(`Highlights Valorant prêts pour ${id} (sync ${res.sync.method}, ${res.sync.offset.toFixed(1)} s)`);
    return 'ready';
  } catch (e) {
    log(`HenrikDev (${id}) : ${e.message}`);
    if (e.status === 401 || e.status === 403) {
      save('no-api-key', 'Clé API HenrikDev invalide');
      return 'failed';
    }
    if (v.attempts >= 12) {
      save('unavailable', e.message);
      return 'failed';
    }
    save('pending', e.message);
    return 'retry';
  }
}

function prettyMap(mapPath) {
  if (!mapPath) return null;
  const known = {
    Ascent: 'Ascent', Duality: 'Bind', Bonsai: 'Split', Port: 'Icebox', Triad: 'Haven', Foxtrot: 'Breeze',
    Canyon: 'Fracture', Pitt: 'Pearl', Jam: 'Lotus', Juliett: 'Sunset', Infinity: 'Abyss', Rook: 'Corrode',
    Range: 'Range', HURM_Alley: 'District', HURM_Yard: 'Piazza', HURM_Bowl: 'Kasbah', HURM_Helix: 'Drift',
  };
  const key = mapPath.split('/').pop();
  return known[key] || key;
}

module.exports = { processRecording, fetchValorantHighlights, vodId };
