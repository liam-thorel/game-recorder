// Pilote une instance OBS "portable" isolée (config séparée de l'OBS perso de l'utilisateur).
// Les binaires ne sont pas copiés : on crée des jonctions vers l'install d'OBS.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { default: OBSWebSocket } = require('obs-websocket-js');

const PROFILE = 'GameRecorder';
const COLLECTION = 'GameRecorder';
const SCENE = 'Game';
const INPUTS = {
  capture: 'Game Capture',
  game: 'Game Audio',
  discord: 'Discord Audio',
  mic: 'Mic',
};
// Piste 1 = mix complet, 2 = micro, 3 = Discord, 4 = jeu
const TRACKS = { mic: [1, 2], discord: [1, 3], game: [1, 4] };
const TRACK_NAMES = ['Mix', 'Micro', 'Discord', 'Jeu'];

const GAME_WINDOWS = {
  lol: 'League of Legends (TM) Client:RiotWindowClass:League of Legends.exe',
  valorant: 'VALORANT  :UnrealWindow:VALORANT-Win64-Shipping.exe',
};
const DISCORD_WINDOW = 'Discord:Chrome_WidgetWin_1:Discord.exe';
const PRIORITY_EXE = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ini(sections) {
  return (
    Object.entries(sections)
      .map(([name, kv]) => `[${name}]\n` + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n'))
      .join('\n\n') + '\n'
  );
}

function encoderSettings(s) {
  const common = { rate_control: 'CBR', bitrate: s.bitrateKbps, profile: 'high', keyint_sec: 2 };
  switch (s.encoder) {
    case 'h264_texture_amf': // iGPU AMD du Ryzen : libère l'encodeur de la carte NVIDIA
      return { ...common, preset: 'speed', bf: 0 };
    case 'obs_x264':
      return { ...common, preset: 'veryfast', tune: '' };
    default:
      // Réglages légers : le GPU est déjà chargé par le jeu (et parfois par Discord).
      return { ...common, preset2: 'p3', tune: 'hq', multipass: 'disabled', lookahead: false, adaptive_quantization: false, bf: 2 };
  }
}

function obsVersionNumber(exe) {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', windowsHide: true }
    ).trim();
    const [maj, min, pat] = out.split('.').map((n) => parseInt(n, 10) || 0);
    return (maj << 24) | (min << 16) | pat;
  } catch {
    return 0;
  }
}

class ObsController extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir   dossier de l'instance portable (ex. %LOCALAPPDATA%/GameRecorder/obs)
   * @param {() => object} opts.getSettings
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ baseDir, getSettings, log }) {
    super();
    this.baseDir = baseDir;
    this.getSettings = getSettings;
    this.log = log || (() => {});
    this.ws = new OBSWebSocket();
    this.proc = null;
    this.connected = false;
    this.recording = false;
    this.ws.on('ConnectionClosed', () => {
      this.connected = false;
      this.emit('disconnected');
    });
    this.ws.on('RecordStateChanged', (e) => this.emit('record-state', e));
  }

  get configDir() {
    return path.join(this.baseDir, 'config', 'obs-studio');
  }

  get exePath() {
    return path.join(this.baseDir, 'bin', '64bit', 'obs64.exe');
  }

  isInstalled() {
    const s = this.getSettings();
    return fs.existsSync(path.join(s.obsInstallDir, 'bin', '64bit', 'obs64.exe'));
  }

  /** Crée les jonctions + écrit la config (profil, websocket...). Idempotent. */
  prepare() {
    const s = this.getSettings();
    if (!this.isInstalled()) throw new Error(`OBS introuvable dans ${s.obsInstallDir}`);
    fs.mkdirSync(this.baseDir, { recursive: true });
    for (const dir of ['bin', 'data', 'obs-plugins']) {
      const link = path.join(this.baseDir, dir);
      if (!fs.existsSync(link)) fs.symlinkSync(path.join(s.obsInstallDir, dir), link, 'junction');
    }
    fs.writeFileSync(path.join(this.baseDir, 'portable_mode.txt'), '');

    const cfg = this.configDir;
    const locationsRoot = path.join(this.baseDir, 'config');
    const profileDir = path.join(cfg, 'basic', 'profiles', PROFILE);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(path.join(cfg, 'basic', 'scenes'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'plugin_config', 'obs-websocket'), { recursive: true });

    const lastVersion = obsVersionNumber(path.join(s.obsInstallDir, 'bin', '64bit', 'obs64.exe'));
    const esc = (p) => p.replace(/\\/g, '\\\\');
    const appIni = ini({
      General: {
        FirstRun: true,
        LastVersion: lastVersion,
        InfoIncrement: -1,
        EnableAutoUpdates: false,
        ConfirmOnExit: false,
        ProcessPriority: 'AboveNormal',
        HotkeyFocusType: 'NeverDisableHotkeys',
        Pre19Defaults: false,
        Pre21Defaults: false,
        Pre23Defaults: false,
        'Pre24.1Defaults': false,
      },
      BasicWindow: {
        SysTrayEnabled: true,
        SysTrayWhenStarted: true,
        SysTrayMinimizeToTray: true,
        PreviewEnabled: false,
        WarnBeforeStartingRecord: false,
        WarnBeforeStoppingRecord: false,
        ShowRecordingPausedWarning: false,
      },
      Basic: {
        Profile: PROFILE,
        ProfileDir: PROFILE,
        SceneCollection: COLLECTION,
        SceneCollectionFile: COLLECTION,
      },
      Locations: {
        Configuration: esc(locationsRoot),
        SceneCollections: esc(locationsRoot),
        Profiles: esc(locationsRoot),
        PluginManagerSettings: esc(locationsRoot),
      },
      Audio: { DisableAudioDucking: true },
    });
    fs.writeFileSync(path.join(cfg, 'global.ini'), appIni);
    fs.writeFileSync(path.join(cfg, 'user.ini'), appIni);

    const rawDir = path.join(s.recordingsDir, '_raw');
    fs.mkdirSync(rawDir, { recursive: true });
    const trackKeys = {};
    TRACK_NAMES.forEach((name, i) => {
      trackKeys[`Track${i + 1}Name`] = name;
      trackKeys[`Track${i + 1}Bitrate`] = 160;
    });
    fs.writeFileSync(
      path.join(profileDir, 'basic.ini'),
      ini({
        General: { Name: PROFILE },
        Output: { Mode: 'Advanced' },
        AdvOut: {
          RecType: 'Standard',
          RecFilePath: esc(rawDir),
          RecFormat2: 'mkv',
          RecEncoder: s.encoder || 'obs_nvenc_h264_tex',
          RecAudioEncoder: 'ffmpeg_aac',
          RecTracks: 15, // pistes 1..4
          RecRB: false,
          RecSplitFile: false,
          ...trackKeys,
        },
        SimpleOutput: { FilePath: esc(rawDir), RecFormat2: 'mkv' },
        Video: {
          BaseCX: s.width,
          BaseCY: s.height,
          OutputCX: s.width,
          OutputCY: s.height,
          FPSType: 0,
          FPSCommon: s.fps,
          ScaleType: 'bicubic',
          ColorFormat: 'NV12',
          ColorSpace: '709',
          ColorRange: 'Partial',
        },
        Audio: { SampleRate: 48000, ChannelSetup: 'Stereo' },
      })
    );
    fs.writeFileSync(
      path.join(profileDir, 'recordEncoder.json'),
      JSON.stringify(encoderSettings(s))
    );
    fs.writeFileSync(
      path.join(cfg, 'plugin_config', 'obs-websocket', 'config.json'),
      JSON.stringify(
        {
          alerts_enabled: false,
          auth_required: true,
          first_load: false,
          server_enabled: true,
          server_password: s.obsPassword,
          server_port: s.obsPort,
        },
        null,
        2
      )
    );
  }

  isRunning() {
    return !!this.proc && this.proc.exitCode === null;
  }

  async start() {
    if (this.connected) return;
    if (!this.isRunning()) {
      // Une instance d'une session précédente peut encore tourner : on tente d'abord de s'y connecter.
      if (!(await this.tryConnect())) {
        this.prepare();
        this.log('Lancement d\'OBS');
        this.proc = spawn(
          this.exePath,
          [
            '--portable',
            '--multi',
            '--minimize-to-tray',
            '--disable-updater',
            '--disable-shutdown-check',
            '--disable-missing-files-check',
            '--profile',
            PROFILE,
            '--collection',
            COLLECTION,
          ],
          { cwd: path.dirname(this.exePath), detached: false, stdio: 'ignore' }
        );
        this.proc.on('exit', (code) => {
          this.log(`OBS s'est arrêté (code ${code})`);
          this.proc = null;
        });
      }
    }
    for (let i = 0; i < 60 && !this.connected; i++) {
      if (await this.tryConnect()) break;
      await sleep(500);
    }
    if (!this.connected) throw new Error('Impossible de se connecter à OBS');
    // Juste après le lancement, OBS peut encore charger sa collection de scènes : on réessaie.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.setupScene();
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        this.log(`Configuration OBS (essai ${attempt}) : ${e.message}`);
        await sleep(1500);
      }
    }
  }

  async tryConnect() {
    if (this.connected) return true;
    const s = this.getSettings();
    try {
      await this.ws.connect(`ws://127.0.0.1:${s.obsPort}`, s.obsPassword, { rpcVersion: 1 });
      this.connected = true;
      this.log('Connecté à OBS');
      return true;
    } catch {
      return false;
    }
  }

  async call(req, data) {
    if (process.env.OBS_DEBUG) this.log(`-> ${req} ${data ? JSON.stringify(data) : ''}`);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`OBS : délai dépassé pour ${req}`)), 15000);
    });
    try {
      return await Promise.race([this.ws.call(req, data), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async setupScene() {
    const s = this.getSettings();
    // Pas de sources audio globales (bureau/micro par défaut) : uniquement nos captures ciblées.
    const special = await this.call('GetSpecialInputs');
    for (const name of Object.values(special)) {
      if (name) await this.call('RemoveInput', { inputName: name }).catch(() => {});
    }

    const { scenes } = await this.call('GetSceneList');
    if (!scenes.some((sc) => sc.sceneName === SCENE)) {
      await this.call('CreateScene', { sceneName: SCENE });
    }
    await this.call('SetCurrentProgramScene', { sceneName: SCENE });
    for (const sc of scenes) {
      if (sc.sceneName !== SCENE) await this.call('RemoveScene', { sceneName: sc.sceneName }).catch(() => {});
    }

    const { inputs } = await this.call('GetInputList');
    const has = (name) => inputs.some((i) => i.inputName === name);
    const ensure = async (inputName, inputKind, inputSettings) => {
      if (!has(inputName)) {
        await this.call('CreateInput', { sceneName: SCENE, inputName, inputKind, inputSettings });
      } else {
        await this.call('SetInputSettings', { inputName, inputSettings, overlay: true });
      }
    };

    await ensure(INPUTS.capture, 'game_capture', {
      capture_mode: 'window',
      window: GAME_WINDOWS.lol,
      priority: PRIORITY_EXE,
      capture_cursor: true,
      anti_cheat_hook: true,
      allow_transparency: false,
      capture_overlays: false,
    });
    await ensure(INPUTS.game, 'wasapi_process_output_capture', {
      window: GAME_WINDOWS.lol,
      priority: PRIORITY_EXE,
    });
    await ensure(INPUTS.discord, 'wasapi_process_output_capture', {
      window: DISCORD_WINDOW,
      priority: PRIORITY_EXE,
    });
    await ensure(INPUTS.mic, 'wasapi_input_capture', { device_id: s.micDevice || 'default' });

    const trackMap = (list) => Object.fromEntries([1, 2, 3, 4, 5, 6].map((t) => [String(t), list.includes(t)]));
    await this.call('SetInputAudioTracks', { inputName: INPUTS.mic, inputAudioTracks: trackMap(TRACKS.mic) });
    await this.call('SetInputAudioTracks', { inputName: INPUTS.discord, inputAudioTracks: trackMap(TRACKS.discord) });
    await this.call('SetInputAudioTracks', { inputName: INPUTS.game, inputAudioTracks: trackMap(TRACKS.game) });
    for (const name of [INPUTS.mic, INPUTS.discord, INPUTS.game]) {
      await this.call('SetInputMute', { inputName: name, inputMuted: false });
    }

    await this.call('SetVideoSettings', {
      baseWidth: s.width,
      baseHeight: s.height,
      outputWidth: s.width,
      outputHeight: s.height,
      fpsNumerator: s.fps,
      fpsDenominator: 1,
    }).catch((e) => this.log(`SetVideoSettings: ${e.message}`));

    const { sceneItemId } = await this.call('GetSceneItemId', { sceneName: SCENE, sourceName: INPUTS.capture });
    await this.call('SetSceneItemTransform', {
      sceneName: SCENE,
      sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        alignment: 5,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsAlignment: 0,
        boundsWidth: s.width,
        boundsHeight: s.height,
      },
    });
  }

  async listMicDevices() {
    const { propertyItems } = await this.call('GetInputPropertiesListPropertyItems', {
      inputName: INPUTS.mic,
      propertyName: 'device_id',
    });
    return propertyItems.map((p) => ({ id: p.itemValue, name: p.itemName }));
  }

  async setGame(game) {
    const window = GAME_WINDOWS[game];
    await this.call('SetInputSettings', { inputName: INPUTS.capture, inputSettings: { window }, overlay: true });
    await this.call('SetInputSettings', { inputName: INPUTS.game, inputSettings: { window }, overlay: true });
  }

  waitForRecordState(state, timeoutMs) {
    return new Promise((resolve) => {
      const onState = (e) => {
        if (e.outputState !== state) return;
        clearTimeout(timer);
        this.off('record-state', onState);
        resolve(e);
      };
      const timer = setTimeout(() => {
        this.off('record-state', onState);
        resolve(null);
      }, timeoutMs);
      this.on('record-state', onState);
    });
  }

  /** @returns {Promise<number>} horodatage (ms) du début effectif de l'enregistrement */
  async startRecording(game) {
    await this.start();
    if (this.finalizing) throw new Error("OBS finalise encore l'enregistrement précédent");
    await this.setGame(game);
    const status = await this.call('GetRecordStatus');
    if (status.outputActive) {
      // Enregistrement orphelin (ex. appli redémarrée pendant une partie) : on le clôt avant d'en lancer un neuf.
      this.log('Enregistrement orphelin détecté : arrêt');
      const stopped = this.waitForRecordState('OBS_WEBSOCKET_OUTPUT_STOPPED', 120000);
      await this.call('StopRecord');
      if (!(await stopped)) throw new Error("OBS n'arrive pas à arrêter l'enregistrement précédent");
    }
    const started = this.waitForRecordState('OBS_WEBSOCKET_OUTPUT_STARTED', 15000);
    await this.call('StartRecord');
    if (!(await started)) throw new Error("OBS n'a pas démarré l'enregistrement (voir les logs OBS)");
    this.recording = true;
    return Date.now();
  }

  /**
   * Demande l'arrêt. Renvoie tout de suite ; `done` se résout avec le chemin du fichier
   * une fois OBS ayant fini d'écrire (peut prendre du temps si l'encodeur a pris du retard).
   * @returns {Promise<{ done: Promise<{path:string, stats:object}|null> }>}
   */
  async stopRecording() {
    this.recording = false;
    if (!this.connected) return { done: Promise.resolve(null) };
    const status = await this.call('GetRecordStatus');
    if (!status.outputActive) return { done: Promise.resolve(null) };
    const stats = await this.call('GetStats').catch(() => null);
    this.finalizing = true;
    const stopped = this.waitForRecordState('OBS_WEBSOCKET_OUTPUT_STOPPED', 60 * 60 * 1000);
    const { outputPath } = await this.call('StopRecord');
    const done = stopped.then((e) => {
      this.finalizing = false;
      const path = (e && e.outputPath) || outputPath;
      return e ? { path, stats } : null;
    });
    return { done };
  }

  async shutdown() {
    // Tant qu'on n'a pas confirmé l'absence d'enregistrement, on ferme OBS proprement.
    let outputStopped = false;
    try {
      if (this.connected) {
        const status = await this.call('GetRecordStatus');
        outputStopped = !status.outputActive;
        if (status.outputActive) {
          const stopped = this.waitForRecordState('OBS_WEBSOCKET_OUTPUT_STOPPED', 30000);
          await this.call('StopRecord');
          outputStopped = !!(await stopped);
        }
        this.ws.disconnect();
      }
    } catch {}
    this.connected = false;
    this.recording = false;
    // OBS 32 plante parfois pendant sa fermeture normale (destructeur de l'aperçu) et affiche
    // une fenêtre de crash. Le fichier étant finalisé, on termine le processus directement.
    const safeToForce = outputStopped;
    // Couvre aussi une instance lancée par une session précédente de l'appli.
    const exe = this.exePath.replace(/'/g, "''");
    const ps = (force) =>
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-Process obs64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' } | ForEach-Object { taskkill ${force ? '/F ' : ''}/PID $_.Id | Out-Null; $_.Id }`,
        ],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
    try {
      if (safeToForce) {
        ps(true);
      } else if (ps(false)) {
        for (let i = 0; i < 20; i++) {
          await sleep(250);
          if (!this.findRunningPid()) break;
        }
        if (this.findRunningPid()) ps(true);
      }
    } catch {}
    this.proc = null;
  }

  findRunningPid() {
    const exe = this.exePath.replace(/'/g, "''");
    try {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Process obs64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' }).Id`],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
    } catch {
      return '';
    }
  }
}

module.exports = { ObsController, INPUTS, TRACK_NAMES };
