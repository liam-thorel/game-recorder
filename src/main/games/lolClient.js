// API "Live Client Data" exposée par League of Legends pendant une partie.
// https://developer.riotgames.com/docs/lol#game-client-api
const { getLocalJson } = require('./http');

const fs = require('fs');
const path = require('path');

function getAllGameData() {
  return getLocalJson({ port: 2999, path: '/liveclientdata/allgamedata', timeoutMs: 1500 });
}

// ---- Client de jeu (hors partie) : donne la file, donc le mode exact ----
const LOCKFILES = [
  path.join('C:', 'Riot Games', 'League of Legends', 'lockfile'),
  path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'League of Legends', 'lockfile'),
];

function readLockfile() {
  for (const file of LOCKFILES) {
    try {
      const [, , port, password] = fs.readFileSync(file, 'utf8').split(':');
      if (port && password) return { port: Number(port), password };
    } catch {}
  }
  return null;
}

/** @returns {Promise<{queue:object, isCustom:boolean, phase:string}|null>} */
async function getGameflow() {
  const lock = readLockfile();
  if (!lock) return null;
  const session = await getLocalJson({
    port: lock.port,
    path: '/lol-gameflow/v1/session',
    headers: { Authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64') },
  });
  if (!session || !session.phase) return null;
  return { queue: session.gameData?.queue || null, isCustom: !!session.gameData?.isCustomGame, phase: session.phase };
}

/** Identifiants possibles du joueur local tels qu'ils apparaissent dans les événements. */
function playerAliases(activePlayer) {
  const names = new Set();
  if (!activePlayer) return names;
  for (const n of [activePlayer.riotId, activePlayer.riotIdGameName, activePlayer.summonerName]) {
    if (!n) continue;
    names.add(n);
    names.add(n.split('#')[0]);
  }
  return names;
}

module.exports = { getAllGameData, getGameflow, playerAliases };
