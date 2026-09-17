// Calcule les highlights Valorant à partir d'un match (normalisé par henrik.js)
// et les aligne sur la vidéo.

/**
 * Estime le décalage (s) tel que tempsVidéo = tempsMatch + offset.
 * 1) Par défaut : started_at du match vs début de l'enregistrement.
 * 2) Si on a observé les changements de score (présence Riot) pendant la partie,
 *    on les aligne sur le dernier kill des rounds gagnés par élimination : plus précis.
 */
function estimateOffset(match, recording) {
  const metaOffset = match.startedAtMs ? (match.startedAtMs - recording.startedAtMs) / 1000 : 0;
  const samples = [];
  const changes = recording.scoreChanges || []; // [{ total, t }] t = temps vidéo (s)
  for (const r of match.rounds) {
    if (!/elim/i.test(r.result || '')) continue;
    const change = changes.find((c) => c.total === r.id + 1);
    const roundKills = match.kills.filter((k) => k.round === r.id);
    if (!change || !roundKills.length) continue;
    const lastKill = Math.max(...roundKills.map((k) => k.timeInMatchMs)) / 1000;
    samples.push(change.t - lastKill);
  }
  if (samples.length >= 3) {
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    // La présence se met à jour un peu après le kill final.
    return { offset: median - 1, method: 'score', metaOffset, samples: samples.length };
  }
  return { offset: metaOffset, method: 'started_at', metaOffset, samples: samples.length };
}

function analyze(match, puuid, recording) {
  const me = match.players.find((p) => p.puuid === puuid);
  if (!me) throw new Error('Joueur introuvable dans le match');
  const sync = estimateOffset(match, recording);
  const toVideo = (ms) => Math.max(0, round(ms / 1000 + sync.offset));
  const highlights = [];
  const teamOf = new Map(match.players.map((p) => [p.puuid, p.team]));
  const nameOf = new Map(match.players.map((p) => [p.puuid, `${p.name}`]));
  const agentOf = new Map(match.players.map((p) => [p.puuid, p.agent]));

  for (const r of match.rounds) {
    const kills = match.kills.filter((k) => k.round === r.id).sort((a, b) => a.timeInMatchMs - b.timeInMatchMs);
    const mine = kills.filter((k) => k.killer === puuid);
    const label = (s) => `R${r.id + 1} · ${s}`;

    for (const k of kills) {
      if (k.killer === puuid) {
        highlights.push({
          type: 'kill',
          label: label(`Kill sur ${agentOf.get(k.victim) || nameOf.get(k.victim)}${k.weapon ? ` (${k.weapon})` : ''}`),
          t: toVideo(k.timeInMatchMs),
          importance: 1,
          round: r.id,
        });
      } else if (k.victim === puuid) {
        highlights.push({ type: 'death', label: label(`Mort (${agentOf.get(k.killer) || nameOf.get(k.killer)})`), t: toVideo(k.timeInMatchMs), importance: 0, round: r.id });
      }
    }

    if (mine.length >= 3) {
      const type = mine.length >= 5 ? 'ace' : `${mine.length}k`;
      highlights.push({
        type,
        label: label(mine.length >= 5 ? 'ACE' : `${mine.length}K`),
        t: toVideo(mine[0].timeInMatchMs),
        end: toVideo(mine[mine.length - 1].timeInMatchMs) + 2,
        importance: mine.length >= 4 ? 3 : 2,
        round: r.id,
      });
    } else if (mine.length === 2 && mine[1].timeInMatchMs - mine[0].timeInMatchMs <= 3000) {
      highlights.push({
        type: 'double',
        label: label('Double kill rapide'),
        t: toVideo(mine[0].timeInMatchMs),
        end: toVideo(mine[1].timeInMatchMs) + 2,
        importance: 1,
        round: r.id,
      });
    }

    const clutch = detectClutch(kills, puuid, teamOf, r);
    if (clutch) {
      highlights.push({
        type: 'clutch',
        label: label(`Clutch 1v${clutch.vs}`),
        t: toVideo(clutch.startMs),
        end: toVideo(clutch.endMs) + 2,
        importance: clutch.vs >= 2 ? 3 : 2,
        round: r.id,
      });
    }
  }

  const myTeam = match.teams.find((t) => t.team === me.team);
  const enemy = match.teams.find((t) => t.team !== me.team);
  const rounds = match.rounds.length || 1;
  const result = !myTeam || !enemy ? null : myTeam.roundsWon === enemy.roundsWon ? 'draw' : myTeam.won ? 'win' : 'loss';

  return {
    highlights: highlights.sort((a, b) => a.t - b.t).map((h, i) => ({ id: `h${i}`, end: h.end ?? round(h.t + 2), ...h })),
    stats: {
      agent: me.agent,
      map: match.map,
      mode: match.queue,
      result,
      score: myTeam && enemy ? `${myTeam.roundsWon}-${enemy.roundsWon}` : null,
      kills: me.kills,
      deaths: me.deaths,
      assists: me.assists,
      acs: Math.round(me.score / rounds),
      hsPercent: pct(me.headshots, me.headshots + me.bodyshots + me.legshots),
      rank: me.rank,
      matchId: match.matchId,
      player: `${me.name}#${me.tag}`,
    },
    scoreboard: match.players
      .map((p) => ({ name: `${p.name}#${p.tag}`, team: p.team, agent: p.agent, k: p.kills, d: p.deaths, a: p.assists, acs: Math.round(p.score / rounds), me: p.puuid === puuid }))
      .sort((a, b) => (a.team === b.team ? b.acs - a.acs : a.team === me.team ? -1 : 1)),
    sync,
  };
}

/** Clutch : je suis le dernier en vie de mon équipe face à ≥1 ennemi, et mon équipe gagne le round. */
function detectClutch(kills, puuid, teamOf, round) {
  const myTeam = teamOf.get(puuid);
  if (round.winningTeam !== myTeam) return null;
  const players = [...teamOf.entries()];
  const allies = players.filter(([id, t]) => t === myTeam && id !== puuid).map(([id]) => id);
  const enemies = players.filter(([, t]) => t !== myTeam).map(([id]) => id);
  const dead = new Set();
  for (const k of kills) {
    dead.add(k.victim);
    if (dead.has(puuid)) return null;
    if (allies.every((a) => dead.has(a))) {
      const vs = enemies.filter((e) => !dead.has(e)).length;
      if (vs < 1) return null;
      const after = kills.filter((x) => x.timeInMatchMs >= k.timeInMatchMs);
      return { vs, startMs: k.timeInMatchMs, endMs: after[after.length - 1].timeInMatchMs };
    }
  }
  return null;
}

const round = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

module.exports = { analyze, estimateOffset };
