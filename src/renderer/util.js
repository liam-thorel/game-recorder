/** Petit helper DOM : h('div.cls', { onclick }, ...enfants) */
export function h(tag, props = {}, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Remplace le contenu d'un élément en ignorant null/false (replaceChildren afficherait « null »). */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1L20 20M8.1 15.9L20 4"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  rewind: '<path d="M11 7l-6 5 6 5zM19 7l-6 5 6 5z"/>',
  forward: '<path d="M13 7l6 5-6 5zM5 7l6 5-6 5z"/>',
  prev: '<path d="M18 6l-8 6 8 6zM6 6v12"/>',
  next: '<path d="M6 6l8 6-8 6zM18 6v12"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  discord: '<path d="M8 17c-3 0-5-2-5-2 0-5 2-9 2-9 2-1.5 4-1.5 4-1.5l.5 1h5l.5-1s2 0 4 1.5c0 0 2 4 2 9 0 0-2 2-5 2l-1-1.5M9 12h.01M15 12h.01"/>',
  game: '<path d="M6 9h4M8 7v4M15 10h.01M18 8h.01M4 6h16a2 2 0 0 1 2 2v6a4 4 0 0 1-7 2.6L14 15h-4l-1 1.6A4 4 0 0 1 2 14V8a2 2 0 0 1 2-2z"/>',
  marker: '<path d="M6 3v18M6 4h11l-2 4 2 4H6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  youtube: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10.5 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4"/>',
  drag: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon-svg');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

export function fmtTime(sec, forceHours = false) {
  if (!Number.isFinite(sec)) sec = 0;
  sec = Math.max(0, Math.floor(sec));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh || forceHours ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

export function fmtDuration(sec) {
  const m = Math.round((sec || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

export function fmtBytes(b) {
  if (!b) return '0 Go';
  const gb = b / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} Go` : gb >= 1 ? `${gb.toFixed(1)} Go` : `${Math.round(b / 1024 ** 2)} Mo`;
}

export function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: diff > 300 ? 'numeric' : undefined });
}

export const GAME = {
  lol: { short: 'LoL', name: 'League of Legends' },
  valorant: { short: 'VALO', name: 'Valorant' },
};

export const RESULT = { win: 'Victoire', loss: 'Défaite', draw: 'Égalité' };

export function vodTitle(v) {
  const s = v.stats || {};
  return s.champion || s.agent || GAME[v.game]?.name || 'Partie';
}

export function vodSubtitle(v) {
  const s = v.stats || {};
  const parts = [];
  if (s.map) parts.push(s.map);
  if (s.mode) parts.push(prettyMode(s.mode));
  return parts.join(' · ');
}

export function prettyMode(mode) {
  const map = {
    CLASSIC: 'Faille',
    ARAM: 'ARAM',
    CHERRY: 'Arena',
    URF: 'URF',
    PRACTICETOOL: 'Entraînement',
    competitive: 'Compétitif',
    unrated: 'Non classé',
    swiftplay: 'Vélocité',
    spikerush: 'Spike Rush',
    deathmatch: 'Deathmatch',
    hurm: 'Team Deathmatch',
    premier: 'Premier',
    custom: 'Personnalisée',
  };
  return map[mode] || map[String(mode).toLowerCase()] || mode;
}

export function kda(s) {
  if (!s || s.kills == null) return null;
  return `${s.kills}/${s.deaths}/${s.assists}`;
}

let toastTimer;
export function toast(message, action) {
  const el = document.getElementById('toast');
  // replaceChildren(null) afficherait le texte « null » : on ne passe que des nœuds réels.
  el.replaceChildren(...[h('span', message), action && h('button.btn', { onclick: action.run }, action.label)].filter(Boolean));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 8000 : 3500);
}
