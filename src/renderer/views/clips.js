import { h, icon, fmtTime, fmtBytes, GAME, RESULT, toast } from '../util.js';

const state = { q: '', game: 'all', sort: 'recent' };

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' +
    new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function subtitle(c) {
  const s = c.source || {};
  return [s.champion, s.map].filter(Boolean).join(' · ');
}

export async function renderClips(root, openName) {
  const page = h('div.page.clips-page');
  root.append(page);

  let clips = [];
  let selecting = false;
  const selected = new Set();
  let viewer = null;
  const uploading = new Set();

  const grid = h('div.clip-grid');
  const countEl = h('span.dim.tnum');
  const selBar = h('div.sel-bar', { hidden: true });
  const selectBtn = h('button.btn', { onclick: () => setSelecting(!selecting) }, 'Sélectionner');

  const chips = (key, options) => {
    const wrap = h('div.chips');
    for (const [value, label] of options) {
      wrap.append(
        h(`button.chip${state[key] === value ? '.on' : ''}`, {
          onclick: () => {
            state[key] = value;
            wrap.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('on', options[i][0] === value));
            paint();
          },
        }, label)
      );
    }
    return wrap;
  };

  page.append(
    h(
      'div.page-head',
      h('h1', 'Mes clips'),
      countEl,
      h('div', { style: { flex: 1 } }),
      h('button.btn', { onclick: () => window.api.clips.openFolder() }, icon('folder'), 'Ouvrir le dossier')
    ),
    h(
      'div.lib-toolbar',
      h('input.input.search', {
        type: 'search',
        placeholder: 'Rechercher un clip…',
        value: state.q,
        oninput: (e) => {
          state.q = e.target.value;
          paint();
        },
      }),
      chips('game', [['all', 'Tous'], ['lol', 'LoL'], ['valorant', 'Valorant']]),
      h(
        'select.input',
        { onchange: (e) => ((state.sort = e.target.value), paint()) },
        [['recent', 'Plus récents'], ['old', 'Plus anciens'], ['long', 'Plus longs'], ['short', 'Plus courts']].map(([v, l]) =>
          h('option', { value: v, selected: state.sort === v }, l)
        )
      ),
      h('div.spacer'),
      selectBtn
    ),
    selBar,
    grid
  );

  const visible = () => {
    const q = state.q.trim().toLowerCase();
    const list = clips.filter((c) => {
      if (state.game !== 'all' && c.game !== state.game) return false;
      if (!q) return true;
      return [c.title, c.name, c.source?.champion, c.source?.map].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    const by = {
      recent: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
      old: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
      long: (a, b) => (b.duration || 0) - (a.duration || 0),
      short: (a, b) => (a.duration || 0) - (b.duration || 0),
    };
    return list.sort(by[state.sort]);
  };

  // ---------- Actions ----------
  async function copy(c) {
    const ok = await window.api.clips.copy(c.name);
    toast(ok ? 'Clip copié : colle-le dans Discord avec Ctrl+V' : 'Copie impossible');
  }

  async function upload(c, onProgress) {
    const st = await window.api.youtube.status();
    if (!st.configured || !st.connected) {
      toast(st.configured ? 'Connecte ton compte YouTube dans les réglages' : 'Configure YouTube dans les réglages', {
        label: 'Réglages',
        run: () => (location.hash = '#/settings'),
      });
      return null;
    }
    if (uploading.has(c.name)) return null;
    uploading.add(c.name);
    const off = window.api.clips.onUploadProgress((p) => p.name === c.name && onProgress && onProgress(p.ratio));
    toast(`Envoi de « ${c.title} » sur YouTube…`);
    const res = await window.api.clips.upload(c.name);
    off();
    uploading.delete(c.name);
    if (!res.ok) {
      toast(`Envoi impossible : ${res.message}`);
      return null;
    }
    toast(
      res.privacy === 'private' ? "Envoyé, mais YouTube l'a mis en privé" : 'Clip en ligne, lien copié',
      { label: 'Ouvrir', run: () => window.api.app.openExternal(res.url) }
    );
    navigator.clipboard?.writeText(res.url).catch(() => {});
    await load();
    return res;
  }

  async function remove(names) {
    if (!names.length || !(await window.api.clips.confirmDelete(names))) return;
    if (viewer && names.includes(viewer.clip.name)) viewer.close();
    const res = await window.api.clips.delete(names);
    toast(res.failed.length ? `${res.failed.length} clip(s) non supprimé(s) (fichier utilisé)` : res.deleted > 1 ? `${res.deleted} clips supprimés` : 'Clip supprimé');
    if (selecting) setSelecting(false);
    await load();
  }

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
    const ids = visible().map((c) => c.name);
    const allOn = ids.length > 0 && ids.every((n) => selected.has(n));
    const bytes = clips.filter((c) => selected.has(c.name)).reduce((a, c) => a + c.sizeBytes, 0);
    selBar.replaceChildren(
      h('span', selected.size ? `${selected.size} sélectionné${selected.size > 1 ? 's' : ''} · ${fmtBytes(bytes)}` : 'Clique sur les clips à supprimer'),
      h('div.spacer'),
      h('button.btn.ghost', {
        onclick: () => {
          ids.forEach((n) => (allOn ? selected.delete(n) : selected.add(n)));
          paint();
        },
      }, allOn ? 'Tout désélectionner' : 'Tout sélectionner'),
      h('button.btn.danger-solid', { disabled: !selected.size, onclick: () => remove([...selected]) }, icon('trash'), 'Supprimer'),
      h('button.btn.ghost', { onclick: () => setSelecting(false) }, 'Annuler')
    );
  }

  // ---------- Grille ----------
  function card(c) {
    const isSel = selected.has(c.name);
    const thumb = h('div.thumb');
    if (c.urls.thumb) thumb.append(h('img', { src: c.urls.thumb, alt: '', draggable: false }));
    else thumb.append(h('div.placeholder', 'Miniature…'));
    thumb.append(
      c.game ? h('div.tl', h(`span.game-badge.${c.game}`, GAME[c.game]?.short)) : null,
      h('span.br.tnum', fmtTime(c.duration || 0)),
      h('div.play-hint', icon('play'))
    );

    // Aperçu vidéo au survol
    let hoverTimer;
    let preview = null;
    const startPreview = () => {
      if (selecting) return;
      hoverTimer = setTimeout(() => {
        preview = h('video.preview', { src: c.urls.video, muted: true, autoplay: true, loop: true, playsInline: true });
        preview.muted = true;
        thumb.append(preview);
      }, 350);
    };
    const stopPreview = () => {
      clearTimeout(hoverTimer);
      if (preview) {
        preview.pause();
        preview.removeAttribute('src');
        preview.load();
        preview.remove();
        preview = null;
      }
    };

    const el = h(
      `div.card.clip-card${selecting ? '.selecting' : ''}${isSel ? '.selected' : ''}`,
      {
        draggable: !selecting,
        title: selecting ? null : 'Clic : regarder · Glisser : envoyer dans Discord ou un dossier',
        onmouseenter: startPreview,
        onmouseleave: stopPreview,
        ondragstart: (e) => {
          e.preventDefault();
          stopPreview();
          window.api.clips.startDrag(c.name);
        },
        onclick: () => {
          if (!selecting) {
            stopPreview();
            return openViewer(c.name);
          }
          if (selected.has(c.name)) selected.delete(c.name);
          else selected.add(c.name);
          el.classList.toggle('selected', selected.has(c.name));
          paintSelBar();
        },
      },
      thumb,
      selecting
        ? h('span.check', icon('check'))
        : h(
            'div.card-actions',
            h('button', { title: 'Copier (pour coller dans Discord)', onclick: (e) => (e.stopPropagation(), copy(c)) }, icon('copy')),
            c.youtube
              ? h('button.yt.on', { title: 'Ouvrir sur YouTube', onclick: (e) => (e.stopPropagation(), window.api.app.openExternal(c.youtube.url)) }, icon('youtube'))
              : h('button.yt', { title: 'Envoyer sur YouTube', onclick: (e) => (e.stopPropagation(), upload(c)) }, icon('youtube')),
            h('button.danger', { title: 'Supprimer', onclick: (e) => (e.stopPropagation(), remove([c.name])) }, icon('trash'))
          ),
      h(
        'div.card-body',
        h('div.card-title', h('span.name', { title: c.title }, c.title)),
        h('div.card-meta', h('span', subtitle(c) || (GAME[c.game]?.name ?? 'Clip')), h('span.time.tnum', fmtDate(c.createdAt)))
      )
    );
    return el;
  }

  function paint() {
    const list = visible();
    for (const n of [...selected]) if (!clips.some((c) => c.name === n)) selected.delete(n);
    const total = clips.reduce((a, c) => a + c.sizeBytes, 0);
    countEl.textContent = clips.length ? `${clips.length} clip${clips.length > 1 ? 's' : ''} · ${fmtBytes(total)}` : '';
    paintSelBar();
    grid.replaceChildren();
    if (!clips.length) {
      grid.append(
        h(
          'div.empty',
          h('h2', 'Aucun clip pour le moment'),
          h('p', 'Ouvre une partie et clique sur ✂ à côté d\'un highlight, ou sur « Clip » sous la vidéo.'),
          h('button.btn', { style: { marginTop: '14px' }, onclick: () => (location.hash = '#/library') }, 'Voir mes parties')
        )
      );
      return;
    }
    if (!list.length) {
      grid.append(h('div.empty', h('h2', 'Aucun résultat'), h('p', 'Essaie une autre recherche.')));
      return;
    }
    grid.append(...list.map(card));
  }

  // ---------- Lecteur ----------
  function openViewer(name) {
    const list = visible();
    let index = list.findIndex((c) => c.name === name);
    if (index < 0) return;
    viewer?.close(true);

    const video = h('video', { controls: true, autoplay: true, playsInline: true });
    const titleEl = h('h2.viewer-title');
    const infoEl = h('div.viewer-info');
    const actionsEl = h('div.viewer-actions');
    const counter = h('span.dim.tnum');
    const uploadFill = h('div');
    const uploadBar = h('div.upload-bar', { hidden: true }, uploadFill);
    const prevBtn = h('button.viewer-nav.prev', { title: 'Précédent (←)', onclick: () => go(-1) }, icon('back'));
    const nextBtn = h('button.viewer-nav.next', { title: 'Suivant (→)', onclick: () => go(1) }, icon('chevron'));

    const back = h(
      'div.viewer',
      { onclick: (e) => e.target === back && close() },
      h(
        'div.viewer-top',
        titleEl,
        counter,
        h('div', { style: { flex: 1 } }),
        h('button.btn.icon.ghost', { title: 'Fermer (Échap)', onclick: () => close() }, icon('close'))
      ),
      h('div.viewer-stage', prevBtn, h('div.viewer-video', video), nextBtn),
      h('div.viewer-bottom', infoEl, uploadBar, actionsEl)
    );

    function show() {
      const c = list[index];
      viewer.clip = c;
      history.replaceState(null, '', `#/clips/${encodeURIComponent(c.name)}`);
      video.src = c.urls.video;
      video.play().catch(() => {});
      counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === list.length - 1;

      titleEl.replaceChildren(
        h('span', { title: 'Renommer' }, c.title),
        h('button.btn.icon.ghost.rename', { title: 'Renommer', onclick: () => editTitle(c) }, icon('edit'))
      );
      const s = c.source || {};
      infoEl.replaceChildren(
        c.game ? h(`span.game-badge.${c.game}`, GAME[c.game]?.short) : null,
        s.champion ? h('strong', s.champion) : null,
        s.map ? h('span', s.map) : null,
        s.result ? h(`span.pill.${s.result}`, RESULT[s.result]) : null,
        h('span.dim.tnum', `${fmtTime(c.duration || 0)} · ${fmtBytes(c.sizeBytes)} · ${fmtDate(c.createdAt)}`)
      );
      const drag = h('button.btn.drag-handle', {
        draggable: true,
        title: 'Glisse ce bouton dans Discord, un dossier ou un navigateur',
        ondragstart: (e) => {
          e.preventDefault();
          window.api.clips.startDrag(c.name);
        },
      }, icon('drag'), 'Glisser');
      actionsEl.replaceChildren(
        c.youtube
          ? h('button.btn.yt-on', { title: c.youtube.url, onclick: () => window.api.app.openExternal(c.youtube.url) }, icon('youtube'), 'Voir sur YouTube')
          : h('button.btn.yt-btn', { title: 'Envoyer sur YouTube (Y)', onclick: () => uploadCurrent() }, icon('youtube'), 'YouTube'),
        h('button.btn.primary', { onclick: () => copy(c) }, icon('copy'), 'Copier'),
        drag,
        c.sourceExists
          ? h('button.btn', {
              title: 'Ouvrir la partie à ce moment',
              onclick: () => {
                close(true);
                location.hash = `#/vod/${c.sourceId}?t=${Math.max(0, Math.floor(c.start || 0))}`;
              },
            }, icon('film'), 'Voir dans la partie')
          : null,
        h('button.btn', { onclick: () => window.api.clips.revealByName(c.name) }, icon('folder'), 'Dossier'),
        h('button.btn.danger', { onclick: () => remove([c.name]) }, icon('trash'), 'Supprimer')
      );
    }

    function editTitle(c) {
      const input = h('input.input.title-input', { value: c.title, maxLength: 80 });
      const commit = async () => {
        const title = input.value.trim();
        if (!title || title === c.title) return show();
        try {
          const newName = await window.api.clips.rename(c.name, title);
          await load();
          // Retrouve le clip renommé dans la liste rafraîchie
          const fresh = visible();
          list.splice(0, list.length, ...fresh);
          index = Math.max(0, list.findIndex((x) => x.name === newName));
          show();
          toast('Clip renommé');
        } catch (e) {
          toast(`Renommage impossible : ${e.message}`);
          show();
        }
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          input.value = c.title;
          input.blur();
        }
      });
      input.addEventListener('blur', commit, { once: true });
      titleEl.replaceChildren(input);
      input.focus();
      input.select();
    }

    async function uploadCurrent() {
      const c = list[index];
      if (c.youtube) return window.api.app.openExternal(c.youtube.url);
      uploadBar.hidden = false;
      uploadFill.style.width = '0%';
      const res = await upload(c, (ratio) => (uploadFill.style.width = `${Math.round(ratio * 100)}%`));
      uploadBar.hidden = true;
      if (res) {
        Object.assign(c, { youtube: res });
        show();
      }
    }

    function go(d) {
      const next = index + d;
      if (next < 0 || next >= list.length) return;
      index = next;
      show();
    }

    function onKey(e) {
      if (e.target.closest('input')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') (e.preventDefault(), go(-1));
      else if (e.key === 'ArrowRight') (e.preventDefault(), go(1));
      else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        uploadCurrent();
      } else if (e.key === ' ') {
        e.preventDefault();
        video.paused ? video.play() : video.pause();
      }
    }

    function close(silent) {
      document.removeEventListener('keydown', onKey, true);
      video.pause();
      video.removeAttribute('src');
      video.load();
      back.remove();
      viewer = null;
      if (!silent) history.replaceState(null, '', '#/clips');
    }

    viewer = { close, clip: list[index] };
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    show();
  }

  async function load(repaint = true) {
    clips = await window.api.clips.list();
    if (repaint) paint();
  }

  await load();
  if (openName) openViewer(openName);
  const off = window.api.clips.onChanged(() => load());
  const onKey = (e) => e.key === 'Escape' && selecting && !viewer && setSelecting(false);
  document.addEventListener('keydown', onKey);
  return () => {
    off();
    document.removeEventListener('keydown', onKey);
    viewer?.close(true);
  };
}
