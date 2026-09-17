// Client minimal pour l'API non officielle HenrikDev (https://docs.henrikdev.xyz).
const https = require('https');

const BASE = 'api.henrikdev.xyz';

function get(path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: BASE, path, headers: { Authorization: apiKey, Accept: 'application/json' }, timeout: 20000 },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          if (res.statusCode !== 200) {
            const msg = json?.errors?.[0]?.message || `HTTP ${res.statusCode}`;
            const err = new Error(`HenrikDev : ${msg}`);
            err.status = res.statusCode;
            return reject(err);
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('HenrikDev : délai dépassé')));
    req.on('error', reject);
  });
}

async function getAccountRegion(puuid, apiKey) {
  const res = await get(`/valorant/v1/by-puuid/account/${encodeURIComponent(puuid)}`, apiKey);
  return res?.data?.region || null;
}

async function getRecentMatches(region, puuid, apiKey, size = 5) {
  const res = await get(
    `/valorant/v4/by-puuid/matches/${encodeURIComponent(region)}/pc/${encodeURIComponent(puuid)}?size=${size}`,
    apiKey
  );
  return (res?.data || []).map(normalizeMatch);
}

function normalizeMatch(m) {
  const md = m.metadata || {};
  return {
    matchId: md.match_id,
    map: md.map?.name || null,
    queue: md.queue?.name || md.queue?.id || null,
    startedAtMs: md.started_at ? Date.parse(md.started_at) : null,
    lengthMs: md.game_length_in_ms || null,
    players: (m.players || []).map((p) => ({
      puuid: p.puuid,
      name: p.name,
      tag: p.tag,
      team: p.team_id,
      agent: p.agent?.name || null,
      kills: p.stats?.kills ?? 0,
      deaths: p.stats?.deaths ?? 0,
      assists: p.stats?.assists ?? 0,
      score: p.stats?.score ?? 0,
      headshots: p.stats?.headshots ?? 0,
      bodyshots: p.stats?.bodyshots ?? 0,
      legshots: p.stats?.legshots ?? 0,
      damage: p.stats?.damage?.dealt ?? p.stats?.damage ?? null,
      rank: p.tier?.name || null,
    })),
    teams: (m.teams || []).map((t) => ({
      team: t.team_id,
      won: !!t.won,
      roundsWon: t.rounds?.won ?? 0,
      roundsLost: t.rounds?.lost ?? 0,
    })),
    rounds: (m.rounds || []).map((r) => ({ id: r.id, winningTeam: r.winning_team, result: r.result })),
    kills: (m.kills || []).map((k) => ({
      round: k.round,
      timeInMatchMs: k.time_in_match_in_ms,
      timeInRoundMs: k.time_in_round_in_ms,
      killer: k.killer?.puuid,
      killerTeam: k.killer?.team,
      victim: k.victim?.puuid,
      victimTeam: k.victim?.team,
      assistants: (k.assistants || []).map((a) => a.puuid || a.assistant_puuid).filter(Boolean),
      weapon: k.weapon?.name || null,
    })),
  };
}

module.exports = { getAccountRegion, getRecentMatches };
