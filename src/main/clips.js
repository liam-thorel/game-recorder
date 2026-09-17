// Export d'un extrait en MP4 partageable, avec le mixage audio choisi dans le lecteur.
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');

// Index des pistes dans video.mp4 : a:0 = mix, a:1 = micro, a:2 = discord, a:3 = jeu
const TRACK_INDEX = { mic: 1, discord: 2, game: 3 };

function safeName(s) {
  const name = String(s || 'clip')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f·]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return name || 'clip';
}

/** Nom de fichier lisible pour le partage : "R4 Clutch 1v2 - Sova Haven 16-09". */
function clipFileBase(meta, label) {
  const s = meta.stats || {};
  const d = new Date(meta.startedAt || Date.now());
  const date = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const who = [s.champion || s.agent, s.map].filter(Boolean).join(' ');
  return safeName(`${label || 'Clip'} - ${who ? `${who} ` : ''}${date}`);
}

/**
 * @param {object} p
 * @param {object} p.meta
 * @param {string} p.videoPath
 * @param {number} p.start
 * @param {number} p.end
 * @param {{mic:number,discord:number,game:number}} p.volumes  0..2 (0 = coupé)
 * @param {string} p.label
 * @param {string} p.outDir
 * @param {(ratio:number)=>void} [p.onProgress]
 */
async function exportClip({ meta, videoPath, start, end, volumes, label, outDir, onProgress }) {
  const duration = Math.max(0.5, end - start);
  fs.mkdirSync(outDir, { recursive: true });
  const base = clipFileBase(meta, label);
  let out = path.join(outDir, `${base}.mp4`);
  for (let i = 2; fs.existsSync(out); i++) out = path.join(outDir, `${base} (${i}).mp4`);

  const hasTracks = Object.keys(meta.files?.tracks || {}).length > 0;
  const active = hasTracks ? Object.entries(TRACK_INDEX).filter(([k]) => (volumes?.[k] ?? 1) > 0) : [];
  const audioArgs = [];
  if (!hasTracks) {
    audioArgs.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k');
  } else if (active.length) {
    const chains = active.map(([k, idx], i) => `[0:a:${idx}]volume=${Number(volumes[k] ?? 1).toFixed(2)}[a${i}]`);
    const mix =
      active.length === 1 ? `[a0]anull[aout]` : `${active.map((_, i) => `[a${i}]`).join('')}amix=inputs=${active.length}:normalize=0[aout]`;
    audioArgs.push('-filter_complex', [...chains, mix].join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  }

  const common = ['-ss', start.toFixed(3), '-i', videoPath, '-t', duration.toFixed(3), '-map', '0:v:0', ...audioArgs];
  const progress = (t) => onProgress && onProgress(Math.min(1, t / duration));
  try {
    await ffmpeg.run([...common, '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-movflags', '+faststart', out], {
      onProgress: progress,
    });
  } catch {
    // Pas de NVENC disponible : encodage logiciel.
    await ffmpeg.run([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', out], {
      onProgress: progress,
    });
  }
  onProgress && onProgress(1);
  return out;
}

module.exports = { exportClip };
