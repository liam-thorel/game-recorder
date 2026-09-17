const { execFile } = require('child_process');

const EXE = {
  lol: 'league of legends.exe',
  valorant: 'valorant-win64-shipping.exe',
};

/** @returns {Promise<Set<string>>} noms d'exécutables en minuscules */
function listProcesses() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(new Set());
      const names = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/);
        if (m) names.add(m[1].toLowerCase());
      }
      resolve(names);
    });
  });
}

module.exports = { listProcesses, EXE };
