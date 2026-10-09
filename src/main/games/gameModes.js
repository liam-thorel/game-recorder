// Reconnaissance du mode de jeu, pour n'enregistrer que les modes choisis.
const LOL_MODES = [
  { key: 'ranked', label: 'Classée' },
  { key: 'normal', label: 'Normale (Faille)' },
  { key: 'aram', label: 'ARAM' },
  { key: 'arena', label: 'Arena' },
  { key: 'other', label: 'Autres modes (URF, Swarm…)' },
  { key: 'custom', label: 'Perso / entraînement' },
];

const VALORANT_MODES = [
  { key: 'competitive', label: 'Compétitif' },
  { key: 'unrated', label: 'Non classé' },
  { key: 'swiftplay', label: 'Vélocité' },
  { key: 'spikerush', label: 'Spike Rush' },
  { key: 'deathmatch', label: 'Deathmatch' },
  { key: 'tdm', label: 'Team Deathmatch' },
  { key: 'other', label: 'Autres modes' },
  { key: 'custom', label: 'Partie perso' },
];

const RANKED_QUEUES = new Set([420, 440]);
const ARAM_QUEUES = new Set([450, 100, 930]);
const NORMAL_QUEUES = new Set([400, 430, 490, 700, 720]);
const ARENA_QUEUES = new Set([1700, 1710]);

/**
 * @param {object} info
 * @param {object} [info.queue]     gameData.queue du client LoL (id, type, gameMode)
 * @param {boolean} [info.isCustom] gameData.isCustomGame
 * @param {string} [info.gameMode]  gameMode de l'API en jeu (CLASSIC, ARAM, CHERRY, PRACTICETOOL…)
 * @returns {{key:string, label:string, sure:boolean}} sure = false quand classée et normale sont indiscernables
 */
function lolMode({ queue, isCustom, gameMode } = {}) {
  const mode = String(queue?.gameMode || gameMode || '').toUpperCase();
  const type = String(queue?.type || '').toUpperCase();
  const id = Number(queue?.id);

  if (isCustom || mode === 'PRACTICETOOL' || type === 'PRACTICE_GAME' || id === 0) return info('custom');
  if (mode === 'TUTORIAL' || type.startsWith('BOT') || type === 'TUTORIAL_MODULE') return info('other');
  if (mode === 'CHERRY' || ARENA_QUEUES.has(id)) return info('arena');
  if (mode === 'ARAM' || ARAM_QUEUES.has(id)) return info('aram');
  if (type.startsWith('RANKED') || RANKED_QUEUES.has(id)) return info('ranked');
  if (mode === 'CLASSIC') {
    if (NORMAL_QUEUES.has(id) || type.startsWith('NORMAL') || type === 'QUICKPLAY') return info('normal');
    // Sans info de file (client fermé), une partie sur la Faille peut être classée ou normale.
    return { ...info('normal'), sure: false };
  }
  return info('other');
}

/** @param {{queue?:string, provisioningFlow?:string}} presence présence Valorant */
function valorantMode({ queue, provisioningFlow } = {}) {
  const q = String(queue || '').toLowerCase();
  if (provisioningFlow === 'CustomGame' || q === 'custom' || q === '') return vinfo('custom');
  const known = { competitive: 'competitive', unrated: 'unrated', swiftplay: 'swiftplay', spikerush: 'spikerush', deathmatch: 'deathmatch', hurm: 'tdm' };
  return vinfo(known[q] || 'other');
}

function info(key) {
  return { key, label: LOL_MODES.find((m) => m.key === key)?.label || key, sure: true };
}
function vinfo(key) {
  return { key, label: VALORANT_MODES.find((m) => m.key === key)?.label || key, sure: true };
}

/**
 * Le mode est-il à enregistrer ? Une liste absente = tout enregistrer.
 * Quand le mode est incertain (classée ou normale), on enregistre si l'un des deux est coché.
 */
function isEnabled(mode, enabledKeys) {
  if (!Array.isArray(enabledKeys)) return true;
  if (mode.sure) return enabledKeys.includes(mode.key);
  return enabledKeys.includes('normal') || enabledKeys.includes('ranked');
}

module.exports = { LOL_MODES, VALORANT_MODES, lolMode, valorantMode, isEnabled };
