// API "Live Client Data" exposée par League of Legends pendant une partie.
// https://developer.riotgames.com/docs/lol#game-client-api
const { getLocalJson } = require('./http');

function getAllGameData() {
  return getLocalJson({ port: 2999, path: '/liveclientdata/allgamedata', timeoutMs: 1500 });
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

module.exports = { getAllGameData, playerAliases };
