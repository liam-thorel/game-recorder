import { h, icon, fmtTime, fmtBytes, fmtClock, dayLabel, GAME, RESULT, vodTitle, vodSubtitle, kda, toast } from '../util.js';

// Filtres conservés entre deux visites de la page.
const filters = { game: 'all', result: 'all', favorites: false, highlights: false, q: '' };

const HL_SHORT = {
  penta: 'PENTA',
  quadra: 'QUADRA',
  triple: 'TRIPLE',
  ace: 'ACE',
  '4k': '4K',
  '3k': '3K',
  steal: 'VOL',
  clutch: null,
  solokill: 'SOLO KILL',
};

function bestTags(v) {
  const counts = new Map();
  for (const hl of v.highlights || []) {
    if (hl.importance < 2) continue;
    let label = HL_SHORT[hl.type];
    if (hl.type === 'clutch') label = hl.label.split('· ').pop().toUpperCase();
    if (!label) continue;
    const cur = counts.get(label) || { n: 0, imp: hl.importance };
    cur.n++;
    counts.set(label, cur);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].imp - a[1].imp || b[1].n - a[1].n)
    .slice(0, 3)
    .map(([label, { n, imp }]) => h(`span.hl-tag.i${imp}`, n > 1 ? `${label} ×${n}` : label));
}

function matches(v) {
  if (filters.game !== 'all' && v.game !== filters.game) return false;
  if (filters.result !== 'all' && v.stats?.result !== filters.result) return false;
  if (filters.favorites && !v.favorite) return false;
  if (filters.highlights && !(v.highlights || []).some((x) => x.importance >= 2)) return false;
  if (filters.q) {
    const hay = [vodTitle(v), v.stats?.map, v.stats?.mode, GAME[v.game]?.name, ...(v.highlights || []).map((x) => x.label)]
      .join(' ')
      .toLowerCase();
    if (!filters.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

export async function renderLibrary(root) {
  const page = h('div.page');
  root.append(page);

  const grid = h('div');
  const usageEl = h('div.usage');
  // Mode sélection (suppression groupée)
  let selecting = false;
  const selected = new Set();
  const selectBtn = h('button.btn', { onclick: () => setSelecting(!selecting) }, 'Sélectionner');
  const selBar = h('div.sel-bar', { hidden: true });

  function setSelecting(on) {
    selecting = on;
    selected.clear();
    selectBtn.textContent = on ? 'Terminer' : 'Sélectionner';
    selectBtn.classList.toggle('on', on);
    paint();
  }

  function paintSelBar() {
    selBar.hidden = !selecting;
    if (!selecting) return;
    const visibleIds = vods.filter(matches).map((v) => v.id);
    const bytes = vods.filter((v) => selected.has(v.id)).reduce((a, v) => a + (v.sizeBytes || 0), 0);
    const allOn = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    selBar.replaceChildren(
      h('span', selected.size ? `${selected.size} sélectionnée${selected.size > 1 ? 's' : ''} · ${fmtBytes(bytes)}` : 'Clique sur les parties à supprimer'),
      h('div.spacer'),
      h('button.btn.ghost', {
        onclick: () => {
          if (allOn) visibleIds.forEach((id) => selected.delete(id));
          else visibleIds.forEach((id) => selected.add(id));
          paint();
        },
      }, allOn ? 'Tout désélectionner' : 'Tout sélectionner'),
      h('button.btn.danger-solid', { disabled: !selected.size, onclick: () => remove([...selected]) }, icon('trash'), 'Supprimer'),
      h('button.btn.ghost', { onclick: () => setSelecting(false) }, 'Annuler')
    );
  }

  async function remove(ids) {
    if (!ids.length || !(await window.api.library.confirmDelete(ids))) return;
    const res = await window.api.library.delete(ids);
    if (res.failed.length) toast(`${res.failed.length} partie(s) n'ont pas pu être supprimées (fichier utilisé)`);
    else toast(res.deleted > 1 ? `${res.deleted} parties supprimées` : 'Partie supprimée');
    if (selecting) setSelecting(false);
  }
  const chipGroup = (key, options) => {
    const wrap = h('div.chips');
    for (const [value, label] of options) {
      wrap.append(
        h(`button.chip${filters[key] === value ? '.on' : ''}`, {
          onclick: () => {
            filters[key] = value;
            wrap.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('on', options[i][0] === value));
            paint();
          },
        }, label)
      );
    }
    return wrap;
  };
  const toggleChip = (key, label) => {
    const btn = h(`button.chip${filters[key] ? '.on' : ''}`, {
      onclick: () => {
        filters[key] = !filters[key];
        btn.classList.toggle('on', filters[key]);
        paint();
      },
    }, label);
    return h('div.chips', btn);
  };

  page.append(
    h('div.page-head', h('h1', 'Mes parties'), usageEl),
    h(
      'div.lib-toolbar',
      h('input.input.search', {
        type: 'search',
        placeholder: 'Champion, agent, map…',
        value: filters.q,
        oninput: (e) => {
          filters.q = e.target.value;
          paint();
        },
      }),
      chipGroup('game', [['all', 'Tous'], ['lol', 'LoL'], ['valorant', 'Valorant']]),
      chipGroup('result', [['all', 'Tous'], ['win', 'Victoires'], ['loss', 'Défaites']]),
      toggleChip('highlights', 'Avec highlights'),
      toggleChip('favorites', '★ Favoris'),
      h('div.spacer'),
      selectBtn
    ),
    selBar,
    grid
  );

  let vods = [];

  function card(v) {
    const s = v.stats || {};
    const favBtn = h(`button.fav-btn${v.favorite ? '.on' : ''}`, {
      title: v.favorite ? 'Retirer des favoris' : 'Favori (jamais supprimé automatiquement)',
      onclick: async (e) => {
        e.stopPropagation();
        v.favorite = !v.favorite;
        favBtn.classList.toggle('on', v.favorite);
        await window.api.library.update(v.id, { favorite: v.favorite });
      },
    }, icon('star'));
    const delBtn = h('button.del-btn', {
      title: 'Supprimer',
      onclick: (e) => {
        e.stopPropagation();
        remove([v.id]);
      },
    }, icon('trash'));
    const pending = v.game === 'valorant' && v.highlightsStatus === 'pending';
    const isSel = selected.has(v.id);
    const el = h(
      `div.card${selecting ? '.selecting' : ''}${isSel ? '.selected' : ''}`,
      {
        onclick: () => {
          if (!selecting) return (location.hash = `#/vod/${v.id}`);
          if (selected.has(v.id)) selected.delete(v.id);
          else selected.add(v.id);
          el.classList.toggle('selected', selected.has(v.id));
          paintSelBar();
        },
      },
      h(
        'div.thumb',
        v.urls.thumb ? h('img', { src: v.urls.thumb, loading: 'lazy', alt: '', onerror: (e) => e.target.remove() }) : null,
        h('div.tl', h(`span.game-badge.${v.game}`, GAME[v.game]?.short)),
        h('div.bl', pending ? h('span.hl-tag', { style: { color: 'var(--text-2)', borderColor: 'var(--line-2)' } }, 'Highlights…') : bestTags(v)),
        h('span.br.tnum', fmtTime(v.duration))
      ),
      selecting ? h('span.check', icon('check')) : [favBtn, delBtn],
      h(
        'div.card-body',
        h('div.card-title', h('span.name', vodTitle(v)), s.result ? h(`span.pill.${s.result}`, RESULT[s.result]) : null),
        h(
          'div.card-meta',
          kda(s) ? h('span.kda.tnum', kda(s)) : null,
          s.score ? h('span.tnum', s.score) : null,
          h('span', vodSubtitle(v)),
          h('span.time.tnum', fmtClock(v.startedAt))
        )
      )
    );
    return el;
  }

  function paint() {
    const list = vods.filter(matches);
    for (const id of selected) if (!vods.some((v) => v.id === id)) selected.delete(id);
    paintSelBar();
    grid.replaceChildren();
    if (!vods.length) {
      grid.append(
        h(
          'div.empty',
          h('h2', 'Aucune partie pour le moment'),
          h('p', 'Lance une partie de League of Legends ou de Valorant : elle sera enregistrée automatiquement.'),
          h('p.dim', 'Les VODs apparaîtront ici à la fin de la partie.')
        )
      );
      return;
    }
    if (!list.length) {
      grid.append(h('div.empty', h('h2', 'Aucun résultat'), h('p', 'Essaie d\'autres filtres.')));
      return;
    }
    const days = new Map();
    for (const v of list) {
      const key = new Date(v.startedAt).toDateString();
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(v);
    }
    for (const items of days.values()) {
      const wins = items.filter((v) => v.stats?.result === 'win').length;
      const losses = items.filter((v) => v.stats?.result === 'loss').length;
      grid.append(
        h(
          'section.day',
          h(
            'h3.day-head',
            dayLabel(items[0].startedAt),
            h('span.dim', `${items.length} partie${items.length > 1 ? 's' : ''}${wins + losses ? ` · ${wins}V ${losses}D` : ''}`)
          ),
          h('div.grid', items.map(card))
        )
      );
    }
  }

  async function load() {
    const [list, usage] = await Promise.all([window.api.library.list(), window.api.library.usage()]);
    vods = list;
    const ratio = usage.maxBytes ? Math.min(1, usage.bytes / usage.maxBytes) : 0;
    usageEl.replaceChildren(
      h('span.tnum', `${fmtBytes(usage.bytes)}${usage.maxBytes ? ` / ${fmtBytes(usage.maxBytes)}` : ''}`),
      usage.maxBytes ? h('div.usage-bar', h('div', { style: { width: `${ratio * 100}%` } })) : null
    );
    paint();
  }

  await load();
  const off = window.api.library.onChanged(load);
  const onKey = (e) => {
    if (e.key === 'Escape' && selecting) setSelecting(false);
  };
  document.addEventListener('keydown', onKey);
  return () => {
    off();
    document.removeEventListener('keydown', onKey);
  };
}
