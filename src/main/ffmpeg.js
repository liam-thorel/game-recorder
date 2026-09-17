const { spawn } = require('child_process');

function ffmpegPath() {
  // Dans l'app packagée, le binaire est extrait hors de l'archive asar.
  return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
}

/**
 * Lance ffmpeg. onProgress reçoit le temps traité (s).
 * @returns {Promise<string>} stderr
 */
function run(args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-y', ...args], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr = (stderr + s).slice(-20000);
      if (onProgress) {
        const m = s.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) onProgress(+m[1] * 3600 + +m[2] * 60 + +m[3]);
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve(stderr);
      const err = new Error(`ffmpeg a échoué (code ${code}) : ${stderr.split('\n').slice(-6).join('\n')}`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

/** Infos d'un fichier : durée (s) et nombre de pistes audio. */
async function probe(file) {
  let out = '';
  try {
    await run(['-i', file]);
  } catch (e) {
    out = e.stderr || e.message; // ffmpeg sans sortie renvoie toujours une erreur, mais affiche les infos
  }
  const d = out.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return {
    duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0,
    audioStreams: (out.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio/g) || []).length,
  };
}

module.exports = { run, probe, ffmpegPath };
