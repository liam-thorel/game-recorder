// API locale du client Riot (utilisée par Valorant pour la présence).
// Lecture seule, aucune interaction avec le jeu lui-même.
const fs = require('fs');
const path = require('path');
const { getLocalJson } = require('./http');

const LOCKFILE = path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'Riot Client', 'Config', 'lockfile');

function readLockfile() {
  try {
    const [, , port, password] = fs.readFileSync(LOCKFILE, 'utf8').split(':');
    return { port: Number(port), password };
  } catch {
    return null;
  }
}

async function request(p) {
  const lock = readLockfile();
  if (!lock) return null;
  return getLocalJson({
    port: lock.port,
    path: p,
    headers: { Authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64') },
  });
}

/** @returns {Promise<{puuid:string,name:string,tag:string}|null>} */
async function getSession() {
  const s = await request('/chat/v1/session');
  if (!s || !s.puuid) return null;
  return { puuid: s.puuid, name: s.game_name, tag: s.game_tag };
}

/** Présence Valorant du joueur local, normalisée entre anciens et nouveaux formats. */
async function getValorantPresence(puuid) {
  const data = await request('/chat/v4/presences');
  if (!data || !Array.isArray(data.presences)) return null;
  const p = data.presences.find((x) => x.puuid === puuid && x.product === 'valorant');
  if (!p || !p.private) return null;
  let priv;
  try {
    priv = JSON.parse(Buffer.from(p.private, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const match = priv.matchPresenceData || {};
  const party = priv.partyPresenceData || {};
  return {
    state: priv.sessionLoopState || match.sessionLoopState || null, // MENUS | PREGAME | INGAME
    provisioningFlow: priv.provisioningFlow || match.provisioningFlow || null, // Matchmaking | CustomGame | ShootingRange
    map: priv.matchMap || match.matchMap || null,
    queue: priv.queueId || match.queueId || party.queueId || null,
    allyScore: num(priv.partyOwnerMatchScoreAllyTeam ?? party.partyOwnerMatchScoreAllyTeam),
    enemyScore: num(priv.partyOwnerMatchScoreEnemyTeam ?? party.partyOwnerMatchScoreEnemyTeam),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { getSession, getValorantPresence };
