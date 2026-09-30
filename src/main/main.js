const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  protocol,
  shell,
  dialog,
  globalShortcut,
  Notification,
  nativeImage,
} = require('electron');
const settings = require('./settings');
const { ObsController } = require('./obs');
const { Library } = require('./library');
const { Recorder } = require('./recorder');
const { execFile } = require('child_process');
const { exportClip } = require('./clips');
const { ClipLibrary } = require('./clipLibrary');
const { YouTube } = require('./youtube');
const { serveFile } = require('./media');
const henrik = require('./highlights/henrik');
const riotClient = require('./games/riotClient');

const APP_NAME = 'Game Recorder';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const startHidden = process.argv.includes('--hidden');

app.setName(APP_NAME);
app.setAppUserModelId('com.letoa.gamerecorder');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'gr', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------- Logs ----------
// Journal rangé avec les VODs : facile à retrouver et à envoyer en cas de souci.
function logPath() {
  try {
    const dir = path.join(settings.get().recordingsDir, '_logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'app.log');
  } catch {
    return path.join(app.getPath('userData'), 'app.log');
  }
}
let lastLogError = null;
process.stdout.on?.('error', () => {});
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  const logFile = logPath();
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, line);
  } catch (e) {
    lastLogError = e;
  }
  // Pas de console dans l'appli installée : écrire sur stdout peut échouer.
  if (!app.isPackaged) {
    try {
      process.stdout.write(line);
    } catch {}
  }
}

// ---------- Services ----------
const obs = new ObsController({
  baseDir: path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'GameRecorder', 'obs'),
  getSettings: settings.get,
  log,
});
const library = new Library(settings.get, log);
const clips = new ClipLibrary(settings.get, library, log);
const youtube = new YouTube(settings.get, settings.update, log);
const recorder = new Recorder({ obs, library, getSettings: settings.get, updateSettings: settings.update, log });

let win = null;
let tray = null;
let quitting = false;

function icon(name) {
  return nativeImage.createFromPath(path.join(ASSETS_DIR, name));
}

function createWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0e1014',
    title: APP_NAME,
    icon: icon('icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadURL('gr://app/index.html');
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notify(title, body) {
  if (!settings.get().notifications || !Notification.isSupported()) return;
  new Notification({ title, body, icon: path.join(ASSETS_DIR, 'icon.png'), silent: true }).show();
}

const GAME_LABEL = { lol: 'League of Legends', valorant: 'Valorant' };

function updateTray(status) {
  if (!tray) return;
  const recording = status.state === 'recording';
  tray.setImage(icon(recording ? 'tray-rec.png' : 'tray.png'));
  const label = recording
    ? `● Enregistrement ${GAME_LABEL[status.game]}`
    : status.processing
      ? `Traitement de ${status.processing} partie(s)…`
      : 'En attente d\'une partie';
  tray.setToolTip(`${APP_NAME} — ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Ouvrir', click: createWindow },
      { label: 'Ouvrir le dossier des VODs', click: () => shell.openPath(settings.get().recordingsDir) },
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() },
    ])
  );
}

function applyLoginItem() {
  if (!app.isPackaged) return; // en dev, on n'inscrit pas electron.exe au démarrage
  app.setLoginItemSettings({ openAtLogin: !!settings.get().openAtLogin, args: ['--hidden'] });
}

function registerMarkerHotkey(enable) {
  globalShortcut.unregisterAll();
  if (!enable) return;
  const key = settings.get().markerHotkey;
  if (!key) return;
  try {
    const ok = globalShortcut.register(key, () => {
      const t = recorder.addMarker();
      if (t != null) log(`Marqueur à ${t.toFixed(1)} s`);
    });
    if (!ok) log(`Raccourci ${key} indisponible`);
  } catch (e) {
    log(`Raccourci invalide ${key} : ${e.message}`);
  }
}

// ---------- IPC ----------
/** Réglages sans les secrets (mot de passe OBS, identifiants Google). */
function publicSettings() {
  const { obsPassword, youtubeClientSecret, youtubeRefreshToken, ...rest } = settings.get();
  return { ...rest, youtubeHasSecret: !!youtubeClientSecret };
}

function vodWithUrls(meta) {
  const base = `gr://vod/${meta.id}/`;
  return {
    ...meta,
    urls: {
      video: base + meta.files.video,
      thumb: meta.files.thumb ? base + meta.files.thumb : null,
      tracks: Object.fromEntries(Object.entries(meta.files.tracks || {}).map(([k, f]) => [k, base + f])),
    },
  };
}

function setupIpc() {
  ipcMain.handle('library:list', () => library.list().map(vodWithUrls));
  ipcMain.handle('library:get', (_e, id) => {
    const m = library.read(id);
    return m ? vodWithUrls(m) : null;
  });
  ipcMain.handle('library:update', (_e, id, patch) => {
    const m = library.update(id, patch);
    send('library:changed');
    return vodWithUrls(m);
  });
  ipcMain.handle('library:confirmDelete', async (_e, ids) => {
    const metas = ids.map((id) => library.read(id)).filter(Boolean);
    if (!metas.length) return false;
    const bytes = metas.reduce((s, m) => s + (m.sizeBytes || 0), 0);
    const size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} Go` : `${Math.round(bytes / 1024 ** 2)} Mo`;
    const favs = metas.filter((m) => m.favorite).length;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Supprimer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      title: 'Supprimer',
      message: metas.length > 1 ? `Supprimer définitivement ces ${metas.length} parties ?` : 'Supprimer définitivement cette partie ?',
      detail: `${size} libérés. La vidéo et les pistes audio seront effacées du disque.${favs ? `\n${favs} favori${favs > 1 ? 's' : ''} inclus.` : ''}`,
    });
    return response === 0;
  });
  ipcMain.handle('library:delete', (_e, ids) => {
    const failed = [];
    for (const id of ids) {
      try {
        library.delete(id);
        log(`VOD supprimée : ${id}`);
      } catch (e) {
        log(`Suppression impossible (${id}) : ${e.message}`);
        failed.push(id);
      }
    }
    send('library:changed');
    return { deleted: ids.length - failed.length, failed };
  });
  ipcMain.handle('library:usage', () => library.usage());
  ipcMain.handle('library:reveal', (_e, id) => shell.openPath(library.dir(id)));
  ipcMain.handle('library:refetch', (_e, id) => recorder.refetchValorant(id));

  ipcMain.handle('clip:export', async (_e, { id, start, end, volumes, label }) => {
    const meta = library.read(id);
    if (!meta) throw new Error('VOD introuvable');
    const outDir = path.join(settings.get().recordingsDir, 'Clips');
    const file = await exportClip({
      meta,
      videoPath: library.resolveFile(id, meta.files.video),
      start,
      end,
      volumes,
      label,
      outDir,
      onProgress: (ratio) => send('clip:progress', { id, ratio }),
    });
    const name = await clips.register(file, { vod: meta, start, end, label });
    return { file, name };
  });
  ipcMain.handle('clip:reveal', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('clips:openFolder', () => {
    fs.mkdirSync(clips.dir, { recursive: true });
    return shell.openPath(clips.dir);
  });
  ipcMain.handle('clips:list', () => clips.list());
  ipcMain.handle('clips:revealByName', (_e, name) => shell.showItemInFolder(clips.resolve(name)));
  ipcMain.handle('clips:rename', (_e, name, title) => clips.rename(name, title));
  ipcMain.handle('clips:confirmDelete', async (_e, names) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Supprimer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      title: 'Supprimer',
      message: names.length > 1 ? `Supprimer ces ${names.length} clips ?` : 'Supprimer ce clip ?',
      detail: 'Le fichier sera effacé du disque.',
    });
    return response === 0;
  });
  ipcMain.handle('clips:delete', (_e, names) => clips.delete(names));
  // Copie le fichier (pas un lien) : Ctrl+V dans Discord ou l'explorateur l'envoie directement.
  // ---------- YouTube ----------
  ipcMain.handle('youtube:status', () => youtube.status());
  ipcMain.handle('youtube:saveCredentials', (_e, { clientId, clientSecret }) => {
    const patch = { youtubeClientId: String(clientId || '').trim() };
    // Champ laissé vide = on garde le code secret déjà enregistré.
    if (clientSecret) patch.youtubeClientSecret = String(clientSecret).trim();
    settings.update(patch);
    return youtube.status();
  });
  ipcMain.handle('youtube:connect', async () => {
    try {
      await youtube.connect((url) => shell.openExternal(url));
      return { ok: true, status: youtube.status() };
    } catch (e) {
      log(`YouTube : ${e.message}`);
      return { ok: false, message: e.message };
    }
  });
  ipcMain.handle('youtube:disconnect', () => {
    youtube.disconnect();
    return youtube.status();
  });
  ipcMain.handle('youtube:upload', async (_e, name) => {
    const meta = clips.readMeta(name) || {};
    const s = meta.source || {};
    const when = meta.createdAt ? new Date(meta.createdAt).toLocaleDateString('fr-FR') : '';
    const game = GAME_LABEL[meta.game] || 'partie';
    try {
      const res = await youtube.upload({
        file: clips.resolve(name),
        title: meta.title || path.basename(name, '.mp4'),
        description: [`${game}${s.champion ? ` — ${s.champion}` : ''}${s.map ? ` sur ${s.map}` : ''}`, when && `Partie du ${when}`].filter(Boolean).join('\n'),
        tags: [game, s.champion, s.map].filter(Boolean),
        privacy: settings.get().youtubePrivacy || 'unlisted',
        onProgress: (ratio) => send('youtube:progress', { name, ratio }),
      });
      clips.setYoutube(name, { ...res, uploadedAt: new Date().toISOString() });
      return { ok: true, ...res };
    } catch (e) {
      log(`Envoi YouTube (${name}) : ${e.message}`);
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('clips:copy', (_e, name) => {
    const file = clips.resolve(name).replace(/'/g, "''");
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -LiteralPath '${file}'`], { windowsHide: true }, (err) =>
        resolve(!err)
      );
    });
  });
  ipcMain.on('clips:startDrag', (e, name) => {
    try {
      const file = clips.resolve(name);
      let dragIcon = nativeImage.createFromPath(clips.thumbPath(name));
      dragIcon = dragIcon.isEmpty() ? icon('icon.png').resize({ width: 64 }) : dragIcon.resize({ width: 160 });
      e.sender.startDrag({ file, icon: dragIcon });
    } catch (err) {
      log(`Glisser le clip : ${err.message}`);
    }
  });

  ipcMain.handle('settings:get', () => {
    return { ...publicSettings(), isPackaged: app.isPackaged, logFile: logPath() };
  });
  ipcMain.handle('settings:update', (_e, patch) => {
    for (const k of ['obsPassword', 'youtubeClientSecret', 'youtubeRefreshToken']) delete patch[k];
    const before = { ...settings.get() };
    const needsObsRestart = ['recordingsDir', 'width', 'height', 'fps', 'bitrateKbps', 'encoder', 'obsInstallDir'].some(
      (k) => k in patch && patch[k] !== before[k]
    );
    const s = settings.update(patch);
    if ('openAtLogin' in patch) applyLoginItem();
    if ('recordingsDir' in patch) clips.watch();
    if ('micDevice' in patch && obs.connected) {
      obs.call('SetInputSettings', { inputName: 'Mic', inputSettings: { device_id: s.micDevice }, overlay: true }).catch(() => {});
    }
    if (needsObsRestart && obs.connected && recorder.state === 'idle') obs.shutdown();
    if ('markerHotkey' in patch && recorder.state === 'recording') registerMarkerHotkey(true);
    return publicSettings();
  });
  ipcMain.handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('settings:micDevices', async () => {
    try {
      await obs.start();
      return await obs.listMicDevices();
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle('settings:testHenrik', async (_e, key) => {
    const sess = await riotClient.getSession();
    try {
      if (sess) {
        const region = await henrik.getAccountRegion(sess.puuid, key);
        if (region) settings.update({ valorantRegion: region });
        return { ok: true, message: `Clé valide — ${sess.name}#${sess.tag} (${region})` };
      }
      // Sans client Riot connecté : on teste juste la clé sur un compte public.
      await henrik.getAccountRegion('00000000-0000-0000-0000-000000000000', key).catch((e) => {
        if (e.status === 401 || e.status === 403) throw e;
      });
      return { ok: true, message: 'Clé valide (lance le client Riot pour détecter ta région)' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:openLog', () => shell.openPath(logPath()));

  ipcMain.handle('status:get', () => recorder.status());
}

// ---------- Cycle de vie ----------
app.on('second-instance', () => createWindow());

app.whenReady().then(() => {
  protocol.handle('gr', (request) => {
    const url = new URL(request.url);
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (url.host === 'app') {
      const p = path.resolve(RENDERER_DIR, ...parts);
      if (!p.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
      return serveFile(p, request);
    }
    if (url.host === 'clip' && (parts.length === 1 || (parts.length === 2 && parts[0] === '.meta'))) {
      try {
        const file = parts.length === 1 ? clips.resolve(parts[0]) : path.join(clips.metaDir, path.basename(parts[1]));
        return serveFile(file, request);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    if (url.host === 'vod' && parts.length === 2) {
      try {
        return serveFile(library.resolveFile(parts[0], parts[1]), request);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    return new Response('Not found', { status: 404 });
  });

  setupIpc();
  applyLoginItem();

  tray = new Tray(icon('tray.png'));
  tray.on('click', createWindow);
  updateTray(recorder.status());

  recorder.on('status', (st) => {
    updateTray(st);
    send('status', st);
  });
  recorder.on('library-changed', () => send('library:changed'));
  clips.on('changed', () => send('clips:changed'));
  clips.watch();
  recorder.on('recording-started', ({ game }) => {
    registerMarkerHotkey(true);
    notify('Enregistrement démarré', `${GAME_LABEL[game]} — ${settings.get().markerHotkey} pour marquer un moment`);
  });
  recorder.on('recording-stopped', () => registerMarkerHotkey(false));
  recorder.on('vod-ready', (meta) => {
    const n = meta.highlights.filter((h) => h.importance >= 2).length;
    notify('Partie enregistrée', meta.game === 'lol' ? `${n} highlight(s)` : 'Recherche des highlights en cours…');
  });

  if (!obs.isInstalled()) log('OBS Studio introuvable : installe-le depuis obsproject.com');
  // --no-record : interface seule (tests), sans détection de partie ni OBS.
  if (!process.argv.includes('--no-record')) recorder.start();
  log(`${APP_NAME} démarré${startHidden ? ' (caché)' : ''}`);
  if (!startHidden) createWindow();
});

app.on('window-all-closed', () => {
  // On reste dans la zone de notification.
});

app.on('before-quit', async (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  globalShortcut.unregisterAll();
  try {
    await recorder.shutdown();
  } catch (err) {
    log(`Arrêt : ${err.message}`);
  }
  app.exit(0);
});
