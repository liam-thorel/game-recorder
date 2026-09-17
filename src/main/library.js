// Bibliothèque des VODs : un dossier par partie contenant meta.json + fichiers média.
const fs = require('fs');
const path = require('path');

const META = 'meta.json';
const RESERVED = new Set(['_raw', '_logs', 'Clips']);

class Library {
  constructor(getSettings, log = () => {}) {
    this.getSettings = getSettings;
    this.log = log;
  }

  get root() {
    return this.getSettings().recordingsDir;
  }

  dir(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Identifiant invalide');
    return path.join(this.root, id);
  }

  read(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(id), META), 'utf8'));
    } catch {
      return null;
    }
  }

  write(meta) {
    const d = this.dir(meta.id);
    fs.mkdirSync(d, { recursive: true });
    const tmp = path.join(d, META + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, path.join(d, META));
    return meta;
  }

  update(id, patch) {
    const meta = this.read(id);
    if (!meta) throw new Error('VOD introuvable');
    const allowed = ['favorite', 'syncOffset', 'markers', 'title'];
    for (const k of allowed) if (k in patch) meta[k] = patch[k];
    return this.write(meta);
  }

  list() {
    if (!fs.existsSync(this.root)) return [];
    const out = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || RESERVED.has(entry.name)) continue;
      const meta = this.read(entry.name);
      if (meta && meta.status !== 'processing') out.push(meta);
    }
    return out.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  }

  delete(id) {
    // Réessaie : un fichier encore ouvert par le lecteur peut être brièvement verrouillé sous Windows.
    fs.rmSync(this.dir(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  /** Chemin absolu d'un fichier d'une VOD (sécurisé contre les "../"). */
  resolveFile(id, file) {
    const d = this.dir(id);
    const p = path.resolve(d, file);
    if (!p.startsWith(d + path.sep)) throw new Error('Chemin invalide');
    return p;
  }

  folderSize(id) {
    let total = 0;
    const d = this.dir(id);
    for (const f of fs.readdirSync(d)) {
      try {
        total += fs.statSync(path.join(d, f)).size;
      } catch {}
    }
    return total;
  }

  /** Supprime les VODs les plus anciennes (hors favoris) pour rester sous la limite. */
  enforceRetention() {
    const maxBytes = (this.getSettings().maxStorageGB || 0) * 1024 ** 3;
    if (!maxBytes) return [];
    const vods = this.list().map((m) => ({ meta: m, size: m.sizeBytes || this.folderSize(m.id) }));
    let total = vods.reduce((s, v) => s + v.size, 0);
    const removed = [];
    for (const v of [...vods].reverse()) {
      if (total <= maxBytes) break;
      if (v.meta.favorite) continue;
      this.log(`Rétention : suppression de ${v.meta.id}`);
      this.delete(v.meta.id);
      total -= v.size;
      removed.push(v.meta.id);
    }
    return removed;
  }

  usage() {
    const vods = this.list();
    return {
      count: vods.length,
      bytes: vods.reduce((s, m) => s + (m.sizeBytes || 0), 0),
      maxBytes: (this.getSettings().maxStorageGB || 0) * 1024 ** 3,
    };
  }
}

module.exports = { Library };
