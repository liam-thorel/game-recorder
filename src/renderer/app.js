import { renderLibrary } from './views/library.js';
import { renderPlayer } from './views/player.js';
import { renderSettings } from './views/settings.js';
import { GAME, fmtTime } from './util.js';

const view = document.getElementById('view');
let cleanup = null;

function parseRoute() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'library', arg: arg ? decodeURIComponent(arg) : null };
}

export function navigate(hash) {
  location.hash = hash;
}

async function render() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  const route = parseRoute();
  document.querySelectorAll('.rail-btn[data-route]').forEach((b) => {
    b.classList.toggle('active', b.dataset.route === route.name || (route.name === 'vod' && b.dataset.route === 'library'));
  });
  view.replaceChildren();
  view.scrollTop = 0;
  if (route.name === 'vod' && route.arg) cleanup = await renderPlayer(view, route.arg);
  else if (route.name === 'settings') cleanup = await renderSettings(view);
  else cleanup = await renderLibrary(view);
}

window.addEventListener('hashchange', render);

document.querySelectorAll('.rail-btn[data-route]').forEach((b) =>
  b.addEventListener('click', () => navigate(`#/${b.dataset.route}`))
);
document.querySelector('[data-action="clips"]').addEventListener('click', () => window.api.clips.openFolder());

// ---------- Barre de statut ----------
const bar = document.getElementById('statusbar');
let status = null;

function paintStatus() {
  if (!status) return;
  const text = bar.querySelector('.status-text');
  const extra = bar.querySelector('.status-extra');
  bar.className = 'statusbar';
  if (status.state === 'recording') {
    bar.classList.add('recording');
    const elapsed = (Date.now() - status.startedAtMs) / 1000;
    text.textContent = `Enregistrement · ${GAME[status.game]?.name} · ${fmtTime(elapsed)}`;
  } else if (status.state === 'starting') {
    bar.classList.add('processing');
    text.textContent = 'Démarrage de l\'enregistrement…';
  } else if (status.state === 'stopping') {
    bar.classList.add('processing');
    text.textContent = 'Finalisation de l\'enregistrement…';
  } else if (status.processing) {
    bar.classList.add('processing');
    text.textContent = `Traitement de ${status.processing} partie${status.processing > 1 ? 's' : ''}…`;
  } else {
    text.textContent = status.obsConnected ? 'Jeu détecté — prêt à enregistrer' : 'En attente d\'une partie de LoL ou Valorant';
  }
  const parts = [];
  if (status.state === 'recording' && status.markers) parts.push(`${status.markers} marqueur${status.markers > 1 ? 's' : ''}`);
  if (status.lastError) {
    bar.classList.add('error');
    parts.push(status.lastError.message);
  }
  extra.textContent = parts.join(' · ');
  extra.title = extra.textContent;
}

window.api.status.get().then((s) => {
  status = s;
  paintStatus();
});
window.api.status.onChange((s) => {
  status = s;
  paintStatus();
});
setInterval(() => status?.state === 'recording' && paintStatus(), 1000);

render();
