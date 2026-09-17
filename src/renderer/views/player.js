import { h, icon, fmtTime, fmtClock, dayLabel, GAME, RESULT, vodTitle, vodSubtitle, prettyMode, kda, toast } from '../util.js';

const TRACKS = [
  { key: 'mic', label: 'Micro', icon: 'mic' },
  { key: 'discord', label: 'Discord', icon: 'discord' },
  { key: 'game', label: 'Jeu', icon: 'game' },
];

const KILL_TYPES = new Set(['kill', 'solokill', 'double', 'triple', 'quadra', 'penta', '3k', '4k', 'ace', 'clutch', 'firstblood']);

function loadMix() {
  try {
    return { mic: { v: 1, m: false }, discord: { v: 1, m: false }, game: { v: 1, m: false }, ...JSON.parse(localStorage.getItem('mix') || '{}') };
  } catch {
    return { mic: { v: 1, m: false }, discord: { v: 1, m: false }, game: { v: 1, m: false } };
  }
}
function saveMix(mix) {
  try {
    localStorage.setItem('mix', JSON.stringify(mix));
  } catch {}
}

/** Joue les pistes audio séparées en synchro avec la vidéo (muette), avec un gain par piste. */
class TrackMixer {
  constructor(video, urls, mix) {
    this.video = video;
    this.ctx = new AudioContext();
    this.tracks = {};
    for (const [key, url] of Object.entries(urls)) {
      const el = new Audio();
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.src = url;
      const gain = this.ctx.createGain();
      this.ctx.createMediaElementSource(el).connect(gain).connect(this.ctx.destination);
      this.tracks[key] = { el, gain };
    }
    this.applyMix(mix);
    const each = (fn) => Object.values(this.tracks).forEach((t) => fn(t.el));
    this.handlers = {
      play: () => {
        this.ctx.resume();
        this.hardSync();
        each((a) => a.play().catch(() => {}));
      },
      pause: () => each((a) => a.pause()),
      waiting: () => each((a) => a.pause()),
      playing: () => {
        this.hardSync();
        each((a) => a.play().catch(() => {}));
      },
      seeking: () => this.hardSync(),
      seeked: () => this.hardSync(),
      ratechange: () => each((a) => (a.playbackRate = video.playbackRate)),
    };
    for (const [ev, fn] of Object.entries(this.handlers)) video.addEventListener(ev, fn);
    this.timer = setInterval(() => this.softSync(), 250);
  }

  hardSync() {
    for (const { el } of Object.values(this.tracks)) {
      if (Math.abs(el.currentTime - this.video.currentTime) > 0.02) el.currentTime = this.video.currentTime;
    }
  }

  softSync() {
    const v = this.video;
    if (v.paused || v.seeking) return;
    for (const { el } of Object.values(this.tracks)) {
      if (el.paused && el.readyState >= 2) el.play().catch(() => {});
      const drift = el.currentTime - v.currentTime;
      if (Math.abs(drift) > 0.3) {
        el.currentTime = v.currentTime;
        el.playbackRate = v.playbackRate;
      } else if (Math.abs(drift) > 0.03) {
        el.playbackRate = v.playbackRate * (drift > 0 ? 0.97 : 1.03);
      } else {
        el.playbackRate = v.playbackRate;
      }
    }
  }

  applyMix(mix) {
    for (const [key, t] of Object.entries(this.tracks)) {
      const c = mix[key] || { v: 1, m: false };
      t.gain.gain.setTargetAtTime(c.m ? 0 : c.v, this.ctx.currentTime, 0.02);
    }
  }

  destroy() {
    clearInterval(this.timer);
    for (const [ev, fn] of Object.entries(this.handlers)) this.video.removeEventListener(ev, fn);
    for (const { el } of Object.values(this.tracks)) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    this.ctx.close();
  }
}

function parseTime(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export async function renderPlayer(root, id, { t: startAt = 0 } = {}) {
  let vod = await window.api.library.get(id);
  if (!vod) {
    root.append(h('div.page', h('div.empty', h('h2', 'VOD introuvable'), h('button.btn', { onclick: () => (location.hash = '#/library') }, 'Retour'))));
    return null;
  }
  const settings = await window.api.settings.get();
  const disposers = [];
  const mix = loadMix();
  const hasTracks = Object.keys(vod.urls.tracks).length > 0;
  let filter = null;
  let clipRange = null;
  let saveTimer;
  let released = false;

  // ---------- Vidéo ----------
  const video = h('video', { src: vod.urls.video, preload: 'auto', muted: hasTracks, playsInline: true });
  video.muted = hasTracks;
  const flash = h('div.flash');
  const wrap = h('div.video-wrap.paused', video, h('div.big-play', h('span', icon('play'))), flash);
  const mixer = hasTracks ? new TrackMixer(video, vod.urls.tracks, mix) : null;
  disposers.push(() => mixer?.destroy());

  const togglePlay = () => (video.paused ? video.play() : video.pause());
  video.addEventListener('click', togglePlay);
  video.addEventListener('dblclick', () => toggleFullscreen());
  video.addEventListener('play', () => {
    wrap.classList.remove('paused');
    playBtn.replaceChildren(icon('pause'));
  });
  video.addEventListener('pause', () => {
    wrap.classList.add('paused');
    playBtn.replaceChildren(icon('play'));
  });

  let flashTimer;
  const showFlash = (msg) => {
    flash.textContent = msg;
    flash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flash.classList.remove('show'), 900);
  };

  const seek = (t) => {
    const d = video.duration || vod.duration || 0;
    video.currentTime = Math.max(0, Math.min(d - 0.05, t));
  };

  // ---------- Éléments (highlights + marqueurs) ----------
  const items = () => {
    const off = vod.syncOffset || 0;
    const hls = (vod.highlights || []).map((x) => ({ ...x, t: x.t + off, end: (x.end ?? x.t + 2) + off, manual: false }));
    const mks = (vod.markers || []).map((m) => ({ ...m, type: 'manual', importance: 2, end: m.t + 2, manual: true }));
    return [...hls, ...mks].sort((a, b) => a.t - b.t);
  };
  const visible = () => {
    const all = items();
    switch (filter) {
      case 'important':
        return all.filter((x) => x.importance >= 2);
      case 'kills':
        return all.filter((x) => KILL_TYPES.has(x.type));
      case 'deaths':
        return all.filter((x) => x.type === 'death');
      case 'markers':
        return all.filter((x) => x.manual);
      default:
        return all;
    }
  };
  filter = items().some((x) => x.importance >= 2) ? 'important' : 'all';

  // ---------- Timeline ----------
  const progress = h('div.progress');
  const buffered = h('div.buffered');
  const headEl = h('div.head');
  const markersEl = h('div');
  const tip = h('div.hover-tip', { hidden: true });
  const rangeEl = h('div.clip-range', { hidden: true });
  const timeline = h('div.timeline', h('div.track', buffered, progress), markersEl, rangeEl, headEl, tip);
  const dur = () => video.duration || vod.duration || 1;

  function paintMarkers() {
    markersEl.replaceChildren(
      ...items().map((x) =>
        h(`div.mk.i${x.importance}${x.manual ? '.manual' : ''}`, {
          style: { left: `${(x.t / dur()) * 100}%` },
          title: `${fmtTime(x.t)} · ${x.label}`,
        })
      )
    );
  }

  let scrubbing = false;
  const posToTime = (e) => {
    const r = timeline.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur();
  };
  timeline.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    timeline.setPointerCapture(e.pointerId);
    seek(posToTime(e));
  });
  timeline.addEventListener('pointermove', (e) => {
    const t = posToTime(e);
    if (scrubbing) seek(t);
    const r = timeline.getBoundingClientRect();
    const near = items().find((x) => Math.abs(((x.t - t) / dur()) * r.width) < 6);
    tip.hidden = false;
    tip.style.left = `${((t / dur()) * 100).toFixed(2)}%`;
    tip.textContent = near ? `${fmtTime(near.t)} · ${near.label}` : fmtTime(t);
  });
  timeline.addEventListener('pointerup', () => (scrubbing = false));
  timeline.addEventListener('pointerleave', () => (tip.hidden = true));

  // ---------- Contrôles ----------
  const playBtn = h('button.btn.icon', { title: 'Lecture / pause (Espace)', onclick: togglePlay }, icon('play'));
  const timeEl = h('span.time.tnum');
  const jumpHighlight = (dir) => {
    const list = visible();
    const cur = video.currentTime;
    const target = dir > 0 ? list.find((x) => x.t - 1 > cur + 0.5) : [...list].reverse().find((x) => x.t - 1 < cur - 1.5);
    if (target) {
      seek(target.t - 3);
      showFlash(target.label);
    }
  };
  const speed = h(
    'select.input',
    { title: 'Vitesse', onchange: (e) => (video.playbackRate = Number(e.target.value)) },
    [0.25, 0.5, 1, 1.5, 2].map((r) => h('option', { value: r, selected: r === 1 }, `${r}×`))
  );

  const mixerEl = h('div.mixer');
  if (hasTracks) {
    for (const t of TRACKS) {
      if (!vod.urls.tracks[t.key]) continue;
      const state = mix[t.key];
      const val = h('span.val.tnum', `${Math.round(state.v * 100)}%`);
      const ch = h(`div.mix-ch${state.m ? '.muted' : ''}`);
      const update = () => {
        ch.classList.toggle('muted', state.m);
        val.textContent = `${Math.round(state.v * 100)}%`;
        mixer.applyMix(mix);
        saveMix(mix);
      };
      ch.append(
        h('button', { title: `Couper / rétablir ${t.label}`, onclick: () => ((state.m = !state.m), update()) }, icon(t.icon), t.label),
        h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: state.v, oninput: (e) => ((state.v = Number(e.target.value)), (state.m = false), update()) }),
        val
      );
      mixerEl.append(ch);
    }
  } else {
    mixerEl.append(h('span.dim', 'Pistes séparées indisponibles'));
  }

  const controls = h(
    'div.controls',
    playBtn,
    h('button.btn.icon.ghost', { title: 'Highlight précédent (P)', onclick: () => jumpHighlight(-1) }, icon('prev')),
    h('button.btn.icon.ghost', { title: 'Highlight suivant (N)', onclick: () => jumpHighlight(1) }, icon('next')),
    h('button.btn.icon.ghost', { title: '-10 s (J)', onclick: () => seek(video.currentTime - 10) }, icon('rewind')),
    h('button.btn.icon.ghost', { title: '+10 s (L)', onclick: () => seek(video.currentTime + 10) }, icon('forward')),
    timeEl,
    speed,
    h('div.spacer'),
    mixerEl,
    h('button.btn', { title: 'Ajouter un marqueur ici (M)', onclick: () => addMarker() }, icon('marker'), 'Marqueur'),
    h('button.btn', { title: 'Créer un clip autour de ce moment (C)', onclick: () => openClip({ start: video.currentTime - settings.clipPaddingBefore, end: video.currentTime + settings.clipPaddingAfter, label: 'clip' }) }, icon('scissors'), 'Clip'),
    h('button.btn.icon.ghost', { title: 'Plein écran (F)', onclick: () => toggleFullscreen() }, icon('fullscreen'))
  );

  const stage = h('div.stage', wrap, timeline, controls);
  const toggleFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen());

  // ---------- En-tête ----------
  const s = vod.stats || {};
  const favBtn = h(`button.btn.icon.fav${vod.favorite ? '.on' : ''}`, {
    title: 'Favori (jamais supprimé automatiquement)',
    onclick: async () => {
      vod.favorite = !vod.favorite;
      favBtn.classList.toggle('on', vod.favorite);
      await window.api.library.update(vod.id, { favorite: vod.favorite });
    },
  }, icon('star'));
  const head = h(
    'div.player-head',
    h('button.btn.icon.ghost', { title: 'Retour', onclick: () => (location.hash = '#/library') }, icon('back')),
    h(`span.game-badge.${vod.game}`, GAME[vod.game]?.short),
    h('h1', vodTitle(vod)),
    s.result ? h(`span.pill.${s.result}`, RESULT[s.result]) : null,
    h('span.sub', [kda(s), s.score, vodSubtitle(vod), `${dayLabel(vod.startedAt)} ${fmtClock(vod.startedAt)}`].filter(Boolean).join(' · ')),
    h('div.spacer'),
    favBtn,
    h('button.btn.icon.ghost', { title: 'Ouvrir le dossier', onclick: () => window.api.library.reveal(vod.id) }, icon('folder')),
    h('button.btn.icon.ghost.danger', {
      title: 'Supprimer',
      onclick: async () => {
        video.pause();
        if (!(await window.api.library.confirmDelete([vod.id]))) return;
        // Libère les fichiers (vidéo + pistes) avant de les effacer, sinon Windows les verrouille.
        releaseMedia();
        const res = await window.api.library.delete([vod.id]);
        if (res.failed.length) toast('Suppression impossible : fichier encore utilisé. Réessaie depuis la liste.');
        location.hash = '#/library';
      },
    }, icon('trash'))
  );

  // ---------- Panneau latéral ----------
  let tab = 'highlights';
  const sideBody = h('div.side-body');
  const tabs = h('div.side-tabs');
  const listEl = h('div');

  function paintTabs() {
    const n = items().length;
    tabs.replaceChildren(
      h(`button.side-tab${tab === 'highlights' ? '.on' : ''}`, { onclick: () => ((tab = 'highlights'), paintSide()) }, 'Moments', h('span.count', n)),
      h(`button.side-tab${tab === 'stats' ? '.on' : ''}`, { onclick: () => ((tab = 'stats'), paintSide()) }, 'Stats')
    );
  }

  function statusNotice() {
    if (vod.game !== 'valorant') return null;
    const st = vod.highlightsStatus;
    const retry = h('button.btn', { onclick: async () => (await window.api.library.refetch(vod.id), toast('Recherche relancée')) }, icon('refresh'), 'Réessayer');
    if (st === 'pending')
      return h('div.notice', 'Récupération des highlights en cours… Les données du match sont disponibles quelques minutes après la fin de la partie.');
    if (st === 'no-api-key')
      return h('div.notice.warn', vod.highlightsError || 'Clé API HenrikDev manquante.', h('div', { style: { display: 'flex', gap: '6px' } },
        h('button.btn', { onclick: () => (location.hash = '#/settings') }, 'Paramètres'), retry));
    if (st === 'unavailable') return h('div.notice.warn', `Highlights indisponibles : ${vod.highlightsError || 'erreur inconnue'}`, h('div', retry));
    return null;
  }

  function syncRow() {
    if (!(vod.highlights || []).length) return null;
    const val = h('span.tnum', `${(vod.syncOffset || 0) >= 0 ? '+' : ''}${(vod.syncOffset || 0).toFixed(1)} s`);
    const nudge = (d) => {
      vod.syncOffset = Math.round(((vod.syncOffset || 0) + d) * 10) / 10;
      val.textContent = `${vod.syncOffset >= 0 ? '+' : ''}${vod.syncOffset.toFixed(1)} s`;
      paintMarkers();
      paintList();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => window.api.library.update(vod.id, { syncOffset: vod.syncOffset }), 600);
    };
    return h(
      'div.sync-row',
      { title: 'Si les highlights sont décalés par rapport à la vidéo, ajuste ici.' },
      'Décalage',
      val,
      h('div', { style: { flex: 1 } }),
      h('button.btn', { onclick: () => nudge(-1) }, '−1 s'),
      h('button.btn', { onclick: () => nudge(-0.2) }, '−0.2'),
      h('button.btn', { onclick: () => nudge(0.2) }, '+0.2'),
      h('button.btn', { onclick: () => nudge(1) }, '+1 s')
    );
  }

  function paintList() {
    const list = visible();
    const cur = video.currentTime;
    listEl.replaceChildren(
      ...(list.length
        ? list.map((x) => {
            const row = h(
              `div.hl-item.i${x.importance}${x.manual ? '.manual' : ''}`,
              { onclick: () => (seek(x.t - 3), video.play()) },
              h('span.dot'),
              h('span.t.tnum', fmtTime(x.t)),
              h('span.label', { title: x.label }, x.label),
              h(
                'span.actions',
                h('button.btn.icon.ghost', {
                  title: 'Créer un clip',
                  onclick: (e) => {
                    e.stopPropagation();
                    openClip({ start: x.t - settings.clipPaddingBefore, end: x.end + settings.clipPaddingAfter, label: x.label });
                  },
                }, icon('scissors')),
                x.manual
                  ? h('button.btn.icon.ghost', {
                      title: 'Supprimer le marqueur',
                      onclick: async (e) => {
                        e.stopPropagation();
                        vod.markers = vod.markers.filter((m) => m.id !== x.id);
                        await window.api.library.update(vod.id, { markers: vod.markers });
                        paintMarkers();
                        paintSide();
                      },
                    }, icon('trash'))
                  : null
              )
            );
            row.dataset.t = x.t;
            row.dataset.end = x.end;
            return row;
          })
        : [h('div.dim', { style: { padding: '12px 4px' } }, 'Rien à afficher avec ce filtre.')])
    );
    highlightCurrent(cur);
  }

  function highlightCurrent(cur) {
    for (const row of listEl.children) {
      if (!row.dataset.t) continue;
      row.classList.toggle('current', cur >= Number(row.dataset.t) - 3 && cur <= Number(row.dataset.end) + 1);
    }
  }

  function paintSide() {
    paintTabs();
    sideBody.replaceChildren();
    if (tab === 'highlights') {
      const opts = [
        ['important', 'Importants'],
        ['all', 'Tout'],
        ['kills', 'Kills'],
        ['deaths', 'Morts'],
        ['markers', 'Marqueurs'],
      ];
      sideBody.append(
        statusNotice() || '',
        syncRow() || '',
        h('div.side-filters', opts.map(([v, l]) => h(`button.chip${filter === v ? '.on' : ''}`, { onclick: () => ((filter = v), paintSide()) }, l))),
        listEl
      );
      paintList();
    } else {
      const stat = (k, v) => (v == null || v === '' ? null : h('div.stat', h('div.k', k), h('div.v.tnum', v)));
      sideBody.append(
        statusNotice() || '',
        h(
          'div.stats-grid',
          stat(vod.game === 'lol' ? 'Champion' : 'Agent', s.champion || s.agent),
          stat('Résultat', RESULT[s.result]),
          stat('KDA', kda(s)),
          stat('Score', s.score),
          stat('Map', s.map),
          stat('Mode', s.mode && prettyMode(s.mode)),
          stat('CS', s.cs),
          stat('ACS', s.acs),
          stat('HS %', s.hsPercent != null ? `${s.hsPercent}%` : null),
          stat('Rang', s.rank),
          stat('Durée', fmtTime(vod.duration))
        )
      );
      if (vod.scoreboard?.length) {
        let lastTeam = null;
        sideBody.append(
          h(
            'table.board',
            h('tr', h('th', 'Joueur'), h('th', 'Agent'), h('th.n', 'K/D/A'), h('th.n', 'ACS')),
            vod.scoreboard.map((p) => {
              const sep = lastTeam && p.team !== lastTeam;
              lastTeam = p.team;
              return h(
                `tr${p.me ? '.me' : ''}${sep ? '.team-sep' : ''}`,
                h('td.pname', { title: p.name }, p.name.split('#')[0]),
                h('td', p.agent),
                h('td.n.tnum', `${p.k}/${p.d}/${p.a}`),
                h('td.n.tnum', p.acs)
              );
            })
          )
        );
      }
      if (s.player) sideBody.append(h('p.dim', { style: { fontSize: '12px', marginTop: '14px' } }, `Compte : ${s.player}`));
    }
  }

  // ---------- Marqueurs ----------
  async function addMarker() {
    const t = Math.round(video.currentTime * 100) / 100;
    vod.markers = [...(vod.markers || []), { id: `m${Date.now()}`, t, label: `Marqueur ${fmtTime(t)}` }];
    await window.api.library.update(vod.id, { markers: vod.markers });
    paintMarkers();
    paintSide();
    showFlash('Marqueur ajouté');
  }

  // ---------- Export de clip ----------
  /** Boutons −5 / −1 / +1 / +5 s pour ajuster un champ de temps. */
  function nudges(input, onChange) {
    return h(
      'div.nudge-group',
      [-5, -1, 1, 5].map((d) =>
        h('button.btn', {
          onclick: () => {
            const t = parseTime(input.value);
            if (!Number.isFinite(t)) return;
            input.value = fmtTime(Math.max(0, Math.min(dur(), t + d)));
            onChange();
          },
        }, `${d > 0 ? '+' : '−'}${Math.abs(d)} s`)
      )
    );
  }

  function openClip({ start, end, label }) {
    video.pause();
    start = Math.max(0, start);
    end = Math.min(dur(), Math.max(start + 1, end));
    const startIn = h('input.input.tnum', { value: fmtTime(start) });
    const endIn = h('input.input.tnum', { value: fmtTime(end) });
    const nameIn = h('input.input', { value: label || 'clip' });
    const bar = h('div');
    const barWrap = h('div.progress-bar', { hidden: true }, bar);
    const msg = h('div.dim', { style: { fontSize: '12px', marginTop: '8px' } });
    const exportBtn = h('button.btn.primary', 'Exporter');
    const updateRange = () => {
      const a = parseTime(startIn.value);
      const b = parseTime(endIn.value);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
        clipRange = [a, b];
        rangeEl.hidden = false;
        rangeEl.style.left = `${(a / dur()) * 100}%`;
        rangeEl.style.width = `${((b - a) / dur()) * 100}%`;
        msg.textContent = `Durée ${fmtTime(b - a)} · audio : ${hasTracks ? TRACKS.filter((t) => vod.urls.tracks[t.key] && !mix[t.key].m && mix[t.key].v > 0).map((t) => `${t.label} ${Math.round(mix[t.key].v * 100)}%`).join(', ') || 'aucun' : 'mix d\'origine'}`;
      }
    };
    startIn.addEventListener('input', updateRange);
    endIn.addEventListener('input', updateRange);
    updateRange();

    const close = () => {
      back.remove();
      rangeEl.hidden = true;
      clipRange = null;
      offProgress();
    };
    const offProgress = window.api.clips.onProgress((p) => {
      if (p.id === vod.id) bar.style.width = `${Math.round(p.ratio * 100)}%`;
    });
    exportBtn.addEventListener('click', async () => {
      const a = parseTime(startIn.value);
      const b = parseTime(endIn.value);
      if (!(Number.isFinite(a) && Number.isFinite(b) && b > a)) {
        msg.textContent = 'Temps invalides (format m:ss).';
        return;
      }
      exportBtn.disabled = true;
      barWrap.hidden = false;
      bar.style.width = '0%';
      const volumes = Object.fromEntries(TRACKS.map((t) => [t.key, mix[t.key].m ? 0 : mix[t.key].v]));
      try {
        const { name } = await window.api.clips.export({ id: vod.id, start: a, end: b, volumes, label: nameIn.value });
        close();
        toast('Clip exporté', { label: 'Voir le clip', run: () => (location.hash = `#/clips/${encodeURIComponent(name)}`) });
      } catch (e) {
        exportBtn.disabled = false;
        msg.textContent = `Échec : ${e.message}`;
      }
    });
    const preview = h('button.btn', { onclick: () => { const a = parseTime(startIn.value); if (Number.isFinite(a)) { seek(a); video.play(); } } }, icon('play'), 'Aperçu');
    const back = h(
      'div.modal-back',
      { onclick: (e) => e.target === back && !exportBtn.disabled && close() },
      h(
        'div.modal',
        h('h2', 'Exporter un clip'),
        h('div.row', h('label', 'Début', startIn), h('label', 'Fin', endIn)),
        h('div.row.nudges', nudges(startIn, updateRange), nudges(endIn, updateRange)),
        h('label', 'Nom', nameIn),
        msg,
        barWrap,
        h('div.foot', preview, h('button.btn.ghost', { onclick: () => !exportBtn.disabled && close() }, 'Annuler'), exportBtn)
      )
    );
    document.body.append(back);
    nameIn.focus();
    nameIn.select();
  }

  // ---------- Boucle d'affichage ----------
  let raf;
  let lastListPaint = 0;
  const frame = (now) => {
    const cur = video.currentTime;
    const d = dur();
    progress.style.width = `${(cur / d) * 100}%`;
    headEl.style.left = `${(cur / d) * 100}%`;
    timeEl.textContent = `${fmtTime(cur)} / ${fmtTime(d)}`;
    if (video.buffered.length) buffered.style.width = `${(video.buffered.end(video.buffered.length - 1) / d) * 100}%`;
    if (now - lastListPaint > 400) {
      lastListPaint = now;
      if (tab === 'highlights') highlightCurrent(cur);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  disposers.push(() => cancelAnimationFrame(raf));
  video.addEventListener('loadedmetadata', () => {
    paintMarkers();
    // Ouverture depuis un clip : on se place au moment du clip.
    if (startAt > 0) seek(startAt);
  }, { once: true });

  // ---------- Raccourcis ----------
  const onKey = (e) => {
    if (e.target.closest('input, select, textarea') || document.querySelector('.modal-back')) return;
    const k = e.key.toLowerCase();
    const map = {
      ' ': togglePlay,
      k: togglePlay,
      arrowleft: () => seek(video.currentTime - 5),
      arrowright: () => seek(video.currentTime + 5),
      j: () => seek(video.currentTime - 10),
      l: () => seek(video.currentTime + 10),
      ',': () => video.paused && seek(video.currentTime - 1 / 60),
      '.': () => video.paused && seek(video.currentTime + 1 / 60),
      n: () => jumpHighlight(1),
      p: () => jumpHighlight(-1),
      f: toggleFullscreen,
      m: addMarker,
      c: () => openClip({ start: video.currentTime - settings.clipPaddingBefore, end: video.currentTime + settings.clipPaddingAfter, label: 'clip' }),
      escape: () => document.fullscreenElement && document.exitFullscreen(),
    };
    if (map[k]) {
      e.preventDefault();
      map[k]();
    }
  };
  document.addEventListener('keydown', onKey);
  disposers.push(() => document.removeEventListener('keydown', onKey));

  const offChanged = window.api.library.onChanged(async () => {
    const fresh = await window.api.library.get(vod.id);
    if (!fresh) return;
    const changed = fresh.highlightsStatus !== vod.highlightsStatus || (fresh.highlights || []).length !== (vod.highlights || []).length;
    vod = { ...fresh, syncOffset: vod.syncOffset, markers: vod.markers, favorite: vod.favorite };
    if (changed) {
      paintMarkers();
      paintSide();
    }
  });
  disposers.push(offChanged);

  root.append(h('div.player-page', h('div.player-main', head, stage), h('aside.side', tabs, sideBody)));
  paintMarkers();
  paintSide();

  return () => {
    clearTimeout(saveTimer);
    if (document.fullscreenElement) document.exitFullscreen();
    releaseMedia();
    document.querySelector('.modal-back')?.remove();
  };

  function releaseMedia() {
    if (released) return;
    released = true;
    video.pause();
    disposers.forEach((d) => d());
    video.removeAttribute('src');
    video.load();
  }
}
