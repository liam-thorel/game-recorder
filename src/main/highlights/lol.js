// Transforme les événements du Live Client Data API en highlights horodatés sur la vidéo.
const { playerAliases } = require('../games/lolClient');

const MULTI = { 2: ['double', 'Double kill', 1], 3: ['triple', 'Triple kill', 2], 4: ['quadra', 'Quadra kill', 3], 5: ['penta', 'PENTAKILL', 3] };
const OBJECTIVES = {
  DragonKill: 'Dragon',
  BaronKill: 'Baron',
  HeraldKill: 'Héraut',
  HordeKill: 'Larve du Néant',
  AtakhanKill: 'Atakhan',
};

/**
 * @param {object} session  { events, activePlayer, allPlayers, offset }
 *   offset = temps vidéo (s) - temps de jeu (s)
 */
function analyze(session) {
  const me = playerAliases(session.activePlayer);
  const isMe = (name) => !!name && me.has(name);
  const off = session.offset || 0;
  const highlights = [];
  const add = (type, label, gameT, importance, extra = {}) =>
    highlights.push({
      type,
      label,
      t: Math.max(0, round(gameT + off)),
      importance,
      ...extra,
    });

  const myKills = [];
  let result = null;

  for (const e of session.events || []) {
    const t = e.EventTime;
    switch (e.EventName) {
      case 'ChampionKill':
        if (isMe(e.KillerName)) {
          myKills.push(t);
          const solo = !e.Assisters || e.Assisters.length === 0;
          add(solo ? 'solokill' : 'kill', solo ? `Solo kill sur ${e.VictimName}` : `Kill sur ${e.VictimName}`, t, solo ? 2 : 1, {
            victim: e.VictimName,
          });
        } else if (isMe(e.VictimName)) {
          add('death', `Mort (${e.KillerName})`, t, 0);
        } else if ((e.Assisters || []).some(isMe)) {
          add('assist', `Assist sur ${e.VictimName}`, t, 0);
        }
        break;
      case 'Multikill':
        if (isMe(e.KillerName) && MULTI[e.KillStreak]) {
          const [type, label, importance] = MULTI[e.KillStreak];
          // Début = premier kill de la série
          const prior = myKills.filter((k) => k <= t + 0.5).slice(-e.KillStreak);
          const start = prior.length ? prior[0] : t;
          // Un double qui devient triple : on ne garde que le plus gros multikill de la série.
          const startT = Math.max(0, round(start + off));
          const idx = highlights.findIndex((x) => x.multi && x.t === startT);
          if (idx >= 0) highlights.splice(idx, 1);
          add(type, label, start, importance, { end: round(t + off + 2), multi: true });
        }
        break;
      case 'Ace':
        if (isMe(e.Acer)) add('ace', 'Ace', t, 3);
        break;
      case 'FirstBlood':
        if (isMe(e.Recipient)) add('firstblood', 'First blood', t, 1);
        break;
      case 'GameEnd':
        result = e.Result === 'Win' ? 'win' : e.Result === 'Lose' ? 'loss' : null;
        break;
      default:
        if (OBJECTIVES[e.EventName] && isMe(e.KillerName)) {
          const stolen = String(e.Stolen).toLowerCase() === 'true';
          const name = OBJECTIVES[e.EventName] + (e.DragonType ? ` ${e.DragonType}` : '');
          add(stolen ? 'steal' : 'objective', stolen ? `Vol de ${name} !` : name, t, stolen ? 3 : 1);
        }
    }
  }

  return { highlights: finalize(highlights), stats: stats(session, result) };
}

function stats(session, result) {
  const me = playerAliases(session.activePlayer);
  const p = (session.allPlayers || []).find((x) => me.has(x.riotId) || me.has(x.riotIdGameName) || me.has(x.summonerName));
  const s = p?.scores || {};
  return {
    champion: p?.championName || null,
    mode: session.gameMode || null,
    result,
    kills: s.kills ?? null,
    deaths: s.deaths ?? null,
    assists: s.assists ?? null,
    cs: s.creepScore ?? null,
    level: p?.level ?? session.activePlayer?.level ?? null,
    player: session.activePlayer?.riotId || session.activePlayer?.summonerName || null,
  };
}

function finalize(list) {
  return list
    .sort((a, b) => a.t - b.t)
    .map((h, i) => ({ id: `h${i}`, end: h.end ?? round(h.t + 2), ...h }));
}

const round = (n) => Math.round(n * 100) / 100;

module.exports = { analyze };
