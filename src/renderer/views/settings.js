import { h, toast } from '../util.js';

const QUALITY = [
  { id: '720p30', label: '720p · 30 fps (~2 Go/h)', width: 1280, height: 720, fps: 30, bitrateKbps: 5000 },
  { id: '1080p30', label: '1080p · 30 fps (~4 Go/h, plus léger)', width: 1920, height: 1080, fps: 30, bitrateKbps: 9000 },
  { id: '1080p60', label: '1080p · 60 fps (~7 Go/h)', width: 1920, height: 1080, fps: 60, bitrateKbps: 15000 },
  { id: '1440p60', label: '1440p · 60 fps (~11 Go/h)', width: 2560, height: 1440, fps: 60, bitrateKbps: 25000 },
];

const ENCODERS = [
  ['obs_nvenc_h264_tex', 'Carte graphique NVIDIA (NVENC)'],
  ['h264_texture_amf', 'Puce graphique AMD du processeur (AMF)'],
  ['obs_x264', 'Processeur (x264, peut coûter des FPS)'],
];

export async function renderSettings(root) {
  let s = await window.api.settings.get();
  const page = h('div.page.settings');
  root.append(page);

  const save = async (patch, msg = 'Enregistré') => {
    s = { ...s, ...(await window.api.settings.update(patch)) };
    toast(msg);
  };

  const row = (label, help, ...ctl) => h('div.set-row', h('div', h('div.lbl', label), help ? h('div.help', help) : null), h('div.ctl', ...ctl));
  const toggle = (key, opts = {}) =>
    h('label.switch', h('input', { type: 'checkbox', checked: !!s[key], disabled: opts.disabled, onchange: (e) => save({ [key]: e.target.checked }) }), h('span'));
  const number = (key, { min, max, step = 1, suffix }) => [
    h('input.input.tnum', {
      type: 'number',
      min,
      max,
      step,
      value: s[key],
      style: { maxWidth: '110px', textAlign: 'right' },
      onchange: (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= min && v <= max) save({ [key]: v });
        else e.target.value = s[key];
      },
    }),
    suffix ? h('span.dim', suffix) : null,
  ];

  // ---------- Enregistrement ----------
  const dirInput = h('input.input', { value: s.recordingsDir, readOnly: true, title: s.recordingsDir });
  const currentQuality = QUALITY.find((q) => q.width === s.width && q.fps === s.fps && q.bitrateKbps === s.bitrateKbps);
  const qualitySelect = h(
    'select.input',
    {
      onchange: (e) => {
        const q = QUALITY.find((x) => x.id === e.target.value);
        if (q) save({ width: q.width, height: q.height, fps: q.fps, bitrateKbps: q.bitrateKbps }, 'Qualité mise à jour (prochaine partie)');
      },
    },
    QUALITY.map((q) => h('option', { value: q.id, selected: q === currentQuality }, q.label)),
    currentQuality ? null : h('option', { selected: true, disabled: true }, `Personnalisé (${s.width}×${s.height} · ${s.fps} fps)`)
  );

  // ---------- Audio ----------
  const micSelect = h('select.input', { onchange: (e) => save({ micDevice: e.target.value }) }, h('option', { value: s.micDevice }, s.micDevice === 'default' ? 'Par défaut (Windows)' : s.micDevice));
  const micBtn = h('button.btn', {
    onclick: async () => {
      micBtn.disabled = true;
      micBtn.textContent = 'Chargement…';
      const res = await window.api.settings.micDevices();
      micBtn.disabled = false;
      micBtn.textContent = 'Actualiser';
      if (res.error) return toast(`Impossible de lister les micros : ${res.error}`);
      micSelect.replaceChildren(
        ...res.map((d) => h('option', { value: d.id, selected: d.id === s.micDevice }, d.id === 'default' ? 'Par défaut (Windows)' : d.name))
      );
    },
  }, 'Lister');

  // ---------- Hotkey ----------
  const hotkey = h('input.input.kbd-input', { value: s.markerHotkey, readOnly: true, style: { maxWidth: '160px' } });
  hotkey.addEventListener('click', () => {
    hotkey.classList.add('listening');
    hotkey.value = 'Appuie sur une touche…';
    const onKey = (e) => {
      e.preventDefault();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      document.removeEventListener('keydown', onKey, true);
      hotkey.classList.remove('listening');
      if (e.key === 'Escape') {
        hotkey.value = s.markerHotkey;
        return;
      }
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
      let key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (key.startsWith('Numpad')) key = `num${key.slice(6).toLowerCase()}`;
      const accel = [...mods, key].join('+');
      hotkey.value = accel;
      save({ markerHotkey: accel }, `Raccourci : ${accel}`);
    };
    document.addEventListener('keydown', onKey, true);
  });

  // ---------- HenrikDev ----------
  const keyInput = h('input.input', { type: 'password', value: s.henrikApiKey, placeholder: 'HDEV-xxxxxxxx-…', spellcheck: false });
  const keyResult = h('div.result');
  const testBtn = h('button.btn', {
    onclick: async () => {
      const key = keyInput.value.trim();
      await save({ henrikApiKey: key }, 'Clé enregistrée');
      if (!key) return;
      testBtn.disabled = true;
      keyResult.textContent = 'Test…';
      keyResult.className = 'result';
      const r = await window.api.settings.testHenrik(key);
      testBtn.disabled = false;
      keyResult.textContent = r.message;
      keyResult.className = `result ${r.ok ? 'ok' : 'bad'}`;
    },
  }, 'Enregistrer et tester');
  const link = (label, url) => h('a', { onclick: () => window.api.app.openExternal(url) }, label);

  // ---------- YouTube ----------
  function youtubeSection() {
    const section = h('section.set-section');
    const idIn = h('input.input', { value: '', placeholder: '…apps.googleusercontent.com', spellcheck: false });
    const secretIn = h('input.input', { type: 'password', value: '', placeholder: 'Code secret du client', spellcheck: false });
    const stateEl = h('div.result');

    const paint = (st) => {
      idIn.value = st.clientId || '';
      if (st.youtubeHasSecret || st.configured) secretIn.placeholder = '•••••••• (enregistré)';
      const connectBtn = h('button.btn', {
        disabled: !st.configured,
        onclick: async () => {
          connectBtn.disabled = true;
          connectBtn.textContent = 'Fenêtre Google ouverte…';
          const r = await window.api.youtube.connect();
          if (!r.ok) {
            stateEl.textContent = r.message;
            stateEl.className = 'result bad';
            paint(await window.api.youtube.status());
            return;
          }
          stateEl.textContent = 'Compte connecté';
          stateEl.className = 'result ok';
          paint(r.status);
        },
      }, st.connected ? 'Reconnecter' : 'Connecter mon compte');

      section.replaceChildren(
        h('h2', 'YouTube'),
        h('div.set-row', h('div', h('div.lbl', st.connected ? 'Compte connecté' : 'Compte non connecté'),
          h('div.help',
            'Envoi d\'un clip en un clic (bouton YouTube ou touche Y dans la galerie). Il faut un identifiant Google gratuit : ',
            link('console Google Cloud', 'https://console.cloud.google.com/apis/credentials'),
            ' → activer « YouTube Data API v3 », puis créer un ID client OAuth de type « Application de bureau ». Tant que ce projet n\'est pas audité par YouTube, les vidéos envoyées peuvent arriver en privé.'
          )),
          h('div.ctl', connectBtn, st.connected ? h('button.btn.danger', { onclick: async () => paint(await window.api.youtube.disconnect()) }, 'Déconnecter') : null)
        ),
        h('div.set-row', h('div', h('div.lbl', 'ID client'), h('div.help', 'Depuis ton identifiant OAuth Google.')), h('div.ctl', idIn)),
        h('div.set-row', h('div', h('div.lbl', 'Code secret du client'), h('div.help', 'Stocké en clair dans les réglages de l\'appli, sur ce PC.')),
          h('div.ctl', secretIn, h('button.btn', {
            onclick: async () => {
              const next = await window.api.youtube.saveCredentials({ clientId: idIn.value, clientSecret: secretIn.value || undefined });
              secretIn.value = '';
              stateEl.textContent = next.configured ? 'Identifiants enregistrés' : 'ID client ou code secret manquant';
              stateEl.className = `result ${next.configured ? 'ok' : 'bad'}`;
              paint(next);
            },
          }, 'Enregistrer'))),
        h('div.set-row', { style: { paddingTop: 0, borderTop: 0 } }, stateEl),
        row('Confidentialité', 'Visibilité des vidéos envoyées.', h(
          'select.input',
          { onchange: (e) => save({ youtubePrivacy: e.target.value }) },
          [['unlisted', 'Non répertorié (lien)'], ['private', 'Privé'], ['public', 'Public']].map(([v, l]) =>
            h('option', { value: v, selected: (s.youtubePrivacy || 'unlisted') === v }, l)
          )
        ))
      );
    };
    window.api.youtube.status().then((st) => paint({ ...st, youtubeHasSecret: s.youtubeHasSecret }));
    return section;
  }

  page.append(
    h('div.page-head', h('h1', 'Réglages')),
    h(
      'section.set-section',
      h('h2', 'Enregistrement'),
      row('League of Legends', 'Enregistre automatiquement chaque partie.', toggle('recordLol')),
      row('Valorant', 'Enregistre automatiquement chaque partie (hors Range).', toggle('recordValorant')),
      row(
        'Dossier des VODs',
        null,
        dirInput,
        h('button.btn', {
          onclick: async () => {
            const dir = await window.api.settings.pickDir();
            if (dir) {
              dirInput.value = dir;
              await save({ recordingsDir: dir }, 'Dossier mis à jour (les anciennes VODs restent dans l\'ancien dossier)');
            }
          },
        }, 'Changer')
      ),
      row('Espace maximum', 'Au-delà, les parties les plus anciennes sont supprimées. Les favoris ★ ne sont jamais supprimés.', ...number('maxStorageGB', { min: 10, max: 10000, step: 10, suffix: 'Go' })),
      row('Qualité', 'S\'applique à la prochaine partie.', qualitySelect),
      row(
        'Encodeur',
        'Si la barre du haut signale des images perdues (ex. partage d\'écran Discord en même temps), essaie la puce graphique AMD du processeur : elle laisse l\'encodeur de la carte NVIDIA à Discord.',
        h(
          'select.input',
          { onchange: (e) => save({ encoder: e.target.value }, 'Encodeur mis à jour (prochaine partie)') },
          ENCODERS.map(([id, label]) => h('option', { value: id, selected: s.encoder === id }, label))
        )
      )
    ),
    h(
      'section.set-section',
      h('h2', 'Audio'),
      row(
        'Pistes enregistrées',
        'Chaque VOD contient 4 pistes : mix complet, ton micro, Discord (tes mates) et le son du jeu. Tu règles le volume de chacune dans le lecteur.',
        h('span.dim', 'Micro · Discord · Jeu')
      ),
      row('Micro', 'Le micro enregistré en continu pendant la partie (indépendamment du push-to-talk Discord).', micSelect, micBtn)
    ),
    h(
      'section.set-section',
      h('h2', 'Highlights'),
      row(
        'Clé API HenrikDev (Valorant)',
        h('span', 'Nécessaire pour les highlights Valorant (kills, multikills, clutchs). Gratuite : ', link('obtenir une clé', 'https://docs.henrikdev.xyz/general/auth'), '.'),
        keyInput,
        testBtn
      ),
      h('div.set-row', { style: { paddingTop: 0, borderTop: 0 } }, keyResult),
      row('Région Valorant', 'Détectée automatiquement.', h('span.dim', s.valorantRegion ? s.valorantRegion.toUpperCase() : 'non détectée')),
      row('Raccourci marqueur', 'Pendant la partie, marque un moment à revoir.', hotkey)
    ),
    h(
      'section.set-section',
      h('h2', 'Clips'),
      row(
        'Temps avant l\'action',
        'Début du clip : combien de secondes avant le highlight (bouton ✂) ou avant le moment affiché (bouton « Clip » / touche C).',
        ...number('clipPaddingBefore', { min: 0, max: 120, suffix: 's' })
      ),
      row(
        'Temps après l\'action',
        'Fin du clip : combien de secondes après la fin du highlight ou le moment affiché. Tu peux toujours ajuster avant d\'exporter.',
        ...number('clipPaddingAfter', { min: 0, max: 120, suffix: 's' })
      )
    ),
    youtubeSection(),
    h(
      'section.set-section',
      h('h2', 'Général'),
      row(
        'Lancer au démarrage de Windows',
        s.isPackaged ? 'L\'application démarre discrètement dans la zone de notification.' : 'Actif uniquement dans la version installée (pas en mode développement).',
        toggle('openAtLogin', { disabled: !s.isPackaged })
      ),
      row('Notifications', 'Début d\'enregistrement et fin de traitement.', toggle('notifications')),
      row('OBS Studio', 'Une instance OBS séparée est pilotée en arrière-plan ; ta config OBS perso n\'est pas modifiée.', h('input.input', { value: s.obsInstallDir, onchange: (e) => save({ obsInstallDir: e.target.value }) })),
      row('Journal', null, h('button.btn', { onclick: () => window.api.app.openLog() }, 'Ouvrir le journal'))
    )
  );
  return null;
}
