// Bibliothèque des clips exportés : fichiers MP4 dans <VODs>/Clips, métadonnées et miniatures
// rangées à part dans Clips/.meta pour garder le dossier propre à partager.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const ffmpeg = require('./ffmpeg');

const NAME_RE = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_(lol|valorant))_(.+?)_(\d+)s(?:_\d+)?$/;

class ClipLibrary extends EventEmitter {
  constructor(getSettings, library, log = () => {}) {
    super();
    this.getSettings = getSettings;
    this.library = library;
    this.log = log;
    this.generating = new Set();
    this.watcher = null;
  }

  get dir() {
    return path.join(this.getSettings().recordingsDir, 'Clips');
  }

  get metaDir() {
    return path.join(this.dir, '.meta');
  }

  ensureDirs() {
    fs.mkdirSync(this.metaDir, { recursive: true });
    // Dossier caché sous Windows
    execFile('attrib', ['+h', this.metaDir], { windowsHide: true }, () => {});
  }

  /** Surveille le dossier (clips ajoutés/supprimés à la main dans l'explorateur). */
  watch() {
    this.unwatch();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      let timer;
      this.watcher = fs.watch(this.dir, (_ev, name) => {
        if (!name || name.startsWith('.meta')) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.emit('changed'), 500);
      });
      this.watcher.on('error', () => {});
    } catch (e) {
      this.log(`Surveillance des clips : ${e.message}`);
    }
  }

  unwatch() {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Résout un nom de fichier de clip en chemin absolu (sans sortir du dossier). */
  resolve(name) {
    if (typeof name !== 'string' || name !== path.basename(name) || !name.toLowerCase().endsWith('.mp4')) {
      throw new Error('Nom de clip invalide');
    }
    return path.join(this.dir, name);
  }

  metaPath(name) {
    return path.join(this.metaDir, `${name}.json`);
  }

  thumbPath(name) {
    return path.join(this.metaDir, `${name}.jpg`);
  }

  readMeta(name) {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(name), 'utf8'));
    } catch {
      return null;
    }
  }

  writeMeta(name, meta) {
    this.ensureDirs();
    fs.writeFileSync(this.metaPath(name), JSON.stringify(meta, null, 2));
  }

  /** Métadonnées déduites du nom pour les clips sans fichier .json (anciens exports). */
  guessMeta(name, stat) {
    const base = name.replace(/\.mp4$/i, '');
    const m = base.match(NAME_RE);
    const meta = { title: base, createdAt: stat.birthtime.toISOString() };
    if (m) {
      meta.sourceId = m[1];
      meta.game = m[2];
      meta.title = m[3].replace(/_/g, ' ');
      meta.start = Number(m[4]);
    }
    return meta;
  }

  /** Complète avec les infos de la partie source (champion/agent, map, résultat). */
  withSource(meta) {
    if (!meta.sourceId || meta.source) return meta;
    const vod = this.library.read(meta.sourceId);
    if (!vod) return meta;
    const s = vod.stats || {};
    return {
      ...meta,
      game: meta.game || vod.game,
      source: { champion: s.champion || s.agent || null, map: s.map || null, mode: s.mode || null, result: s.result || null, startedAt: vod.startedAt },
    };
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.toLowerCase().endsWith('.mp4')) continue;
      let stat;
      try {
        stat = fs.statSync(path.join(this.dir, name));
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      let meta = this.readMeta(name);
      if (!meta) {
        meta = this.guessMeta(name, stat);
        this.writeMeta(name, meta);
      }
      if (!meta.source && meta.sourceId) {
        const enriched = this.withSource(meta);
        if (enriched.source) {
          meta = enriched;
          this.writeMeta(name, meta);
        }
      }
      const hasThumb = fs.existsSync(this.thumbPath(name));
      if (!hasThumb || meta.duration == null) this.generate(name, meta);
      out.push({
        name,
        ...meta,
        sizeBytes: stat.size,
        createdAt: meta.createdAt || stat.birthtime.toISOString(),
        sourceExists: meta.sourceId ? !!this.library.read(meta.sourceId) : false,
        urls: {
          video: `gr://clip/${encodeURIComponent(name)}`,
          thumb: hasThumb ? `gr://clip/.meta/${encodeURIComponent(`${name}.jpg`)}?v=${Math.round(stat.mtimeMs)}` : null,
        },
      });
    }
    return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  /** Miniature + durée en tâche de fond pour les clips qui n'en ont pas. */
  async generate(name, meta) {
    if (this.generating.has(name)) return;
    this.generating.add(name);
    try {
      this.ensureDirs();
      const file = this.resolve(name);
      if (meta.duration == null) {
        const info = await ffmpeg.probe(file);
        meta.duration = Math.round(info.duration * 100) / 100;
        this.writeMeta(name, { ...(this.readMeta(name) || meta), duration: meta.duration });
      }
      if (!fs.existsSync(this.thumbPath(name))) {
        const at = Math.min(Math.max(0, (meta.duration || 0) / 2), 30);
        await ffmpeg.run(['-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', this.thumbPath(name)]);
      }
      this.emit('changed');
    } catch (e) {
      this.log(`Miniature du clip ${name} : ${e.message}`);
    } finally {
      this.generating.delete(name);
    }
  }

  /** Appelé juste après un export depuis le lecteur. */
  async register(file, { vod, start, end, label }) {
    const name = path.basename(file);
    const s = vod.stats || {};
    const meta = {
      title: label || 'Clip',
      createdAt: new Date().toISOString(),
      sourceId: vod.id,
      game: vod.game,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      duration: Math.round((end - start) * 100) / 100,
      source: { champion: s.champion || s.agent || null, map: s.map || null, mode: s.mode || null, result: s.result || null, startedAt: vod.startedAt },
    };
    this.writeMeta(name, meta);
    await this.generate(name, meta);
    return name;
  }

  /** Mémorise le lien YouTube d'un clip. */
  setYoutube(name, youtube) {
    const meta = this.readMeta(name) || {};
    this.writeMeta(name, { ...meta, youtube });
    this.emit('changed');
  }

  rename(name, title) {
    const meta = this.readMeta(name) || {};
    const clean = String(title || '').trim().slice(0, 80);
    if (!clean) throw new Error('Nom vide');
    // Nom de fichier lisible, basé sur le titre (utile quand on partage le fichier)
    const safe = clean.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim() || 'clip';
    let newName = `${safe}.mp4`;
    for (let i = 2; newName.toLowerCase() !== name.toLowerCase() && fs.existsSync(path.join(this.dir, newName)); i++) {
      newName = `${safe} (${i}).mp4`;
    }
    if (newName !== name) {
      fs.renameSync(this.resolve(name), path.join(this.dir, newName));
      for (const ext of ['.json', '.jpg']) {
        const from = path.join(this.metaDir, name + ext);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(this.metaDir, newName + ext));
      }
    }
    this.writeMeta(newName, { ...meta, title: clean });
    this.emit('changed');
    return newName;
  }

  delete(names) {
    const failed = [];
    for (const name of names) {
      try {
        fs.rmSync(this.resolve(name), { force: true, maxRetries: 10, retryDelay: 200 });
        fs.rmSync(this.metaPath(name), { force: true });
        fs.rmSync(this.thumbPath(name), { force: true });
      } catch (e) {
        this.log(`Suppression du clip ${name} : ${e.message}`);
        failed.push(name);
      }
    }
    this.emit('changed');
    return { deleted: names.length - failed.length, failed };
  }
}

module.exports = { ClipLibrary };
