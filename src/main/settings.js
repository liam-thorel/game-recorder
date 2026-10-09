const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const DEFAULTS = {
  recordingsDir: 'E:\\GameRecordings',
  maxStorageGB: 500,
  recordLol: true,
  recordValorant: true,
  // Modes enregistrés (null = tous). Voir games/gameModes.js
  lolModes: null,
  valorantModes: null,
  // Vidéo
  width: 1920,
  height: 1080,
  fps: 60,
  bitrateKbps: 15000,
  // Audio
  micDevice: 'default',
  encoder: 'obs_nvenc_h264_tex',
  // OBS
  obsInstallDir: 'C:\\Program Files\\obs-studio',
  obsPassword: '',
  // Highlights
  henrikApiKey: '',
  valorantRegion: '', // auto-détecté si vide
  clipPaddingBefore: 10,
  clipPaddingAfter: 5,
  // YouTube (identifiants OAuth du projet Google Cloud de l'utilisateur)
  youtubeClientId: '',
  youtubeClientSecret: '',
  youtubeRefreshToken: '',
  youtubePrivacy: 'unlisted',
  // Divers
  markerHotkey: 'F9',
  notifications: true,
  openAtLogin: true,
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {}
  cache = { ...DEFAULTS, ...data };
  // Anciennes marges par défaut (6 s / 3 s) jugées trop courtes : on passe aux nouvelles si l'utilisateur ne les a pas changées.
  if (data.clipPaddingBefore === 6 && data.clipPaddingAfter === 3) {
    cache.clipPaddingBefore = DEFAULTS.clipPaddingBefore;
    cache.clipPaddingAfter = DEFAULTS.clipPaddingAfter;
    save();
  }
  if (!cache.obsPassword) {
    cache.obsPassword = crypto.randomBytes(16).toString('hex');
    save();
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function get() {
  return load();
}

function update(patch) {
  load();
  Object.assign(cache, patch);
  save();
  return cache;
}

module.exports = { get, update, DEFAULTS };
