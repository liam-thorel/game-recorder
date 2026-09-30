// Envoi d'un clip sur YouTube (API Data v3) avec connexion Google OAuth "application installée".
// Les identifiants viennent de l'utilisateur (projet Google Cloud personnel) : rien n'est embarqué ici.
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_HOST = 'oauth2.googleapis.com';
const UPLOAD_HOST = 'www.googleapis.com';
const CATEGORY_GAMING = '20';

function postForm(host, pathname, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          if (res.statusCode !== 200) {
            return reject(new Error(json?.error_description || json?.error || `HTTP ${res.statusCode}`));
          }
          resolve(json);
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

class YouTube {
  /**
   * @param {() => object} getSettings
   * @param {(patch: object) => object} updateSettings
   * @param {(msg: string) => void} log
   */
  constructor(getSettings, updateSettings, log = () => {}) {
    this.getSettings = getSettings;
    this.updateSettings = updateSettings;
    this.log = log;
    this.accessToken = null;
    this.accessExpiresAt = 0;
  }

  status() {
    const s = this.getSettings();
    return {
      configured: !!(s.youtubeClientId && s.youtubeClientSecret),
      connected: !!s.youtubeRefreshToken,
      clientId: s.youtubeClientId || '',
      privacy: s.youtubePrivacy || 'unlisted',
    };
  }

  disconnect() {
    this.accessToken = null;
    this.updateSettings({ youtubeRefreshToken: '' });
  }

  /** Ouvre la page de consentement Google et récupère le jeton de rafraîchissement. */
  async connect(openExternal) {
    const s = this.getSettings();
    if (!s.youtubeClientId || !s.youtubeClientSecret) throw new Error('Identifiants Google manquants');
    const state = crypto.randomBytes(16).toString('hex');

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      let redirect = '';
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, redirect);
        const answer = (msg) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><html lang="fr"><body style="font-family:Segoe UI,sans-serif;background:#0e1014;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${msg}</h2><p>Tu peux fermer cet onglet et revenir à Game Recorder.</p></div></body></html>`);
        };
        if (url.searchParams.get('state') !== state) {
          answer('Requête inattendue');
          return;
        }
        const err = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        answer(err ? 'Connexion refusée' : 'Compte YouTube connecté ✅');
        server.close();
        clearTimeout(timer);
        if (err) reject(new Error(err === 'access_denied' ? 'Connexion refusée' : err));
        else if (code) resolve({ code, redirectUri: redirect });
        else reject(new Error('Réponse Google incomplète'));
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('Délai dépassé : aucune réponse de Google (5 min)'));
      }, 5 * 60 * 1000);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        redirect = `http://127.0.0.1:${server.address().port}`;
        const params = new URLSearchParams({
          client_id: s.youtubeClientId,
          redirect_uri: redirect,
          response_type: 'code',
          scope: SCOPE,
          access_type: 'offline',
          prompt: 'consent',
          state,
        });
        openExternal(`${AUTH_URL}?${params}`);
      });
    });

    const tokens = await postForm(TOKEN_HOST, '/token', {
      code,
      client_id: s.youtubeClientId,
      client_secret: s.youtubeClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (!tokens.refresh_token) throw new Error('Google n\'a pas renvoyé de jeton durable');
    this.updateSettings({ youtubeRefreshToken: tokens.refresh_token });
    this.accessToken = tokens.access_token;
    this.accessExpiresAt = Date.now() + (tokens.expires_in || 3500) * 1000 - 60000;
    this.log('Compte YouTube connecté');
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessExpiresAt) return this.accessToken;
    const s = this.getSettings();
    if (!s.youtubeRefreshToken) throw new Error('Aucun compte YouTube connecté');
    const tokens = await postForm(TOKEN_HOST, '/token', {
      refresh_token: s.youtubeRefreshToken,
      client_id: s.youtubeClientId,
      client_secret: s.youtubeClientSecret,
      grant_type: 'refresh_token',
    }).catch((e) => {
      if (/invalid_grant/i.test(e.message)) {
        this.disconnect();
        throw new Error('Connexion YouTube expirée : reconnecte ton compte');
      }
      throw e;
    });
    this.accessToken = tokens.access_token;
    this.accessExpiresAt = Date.now() + (tokens.expires_in || 3500) * 1000 - 60000;
    return this.accessToken;
  }

  /**
   * Envoi en plusieurs morceaux (upload "resumable"), avec progression.
   * @returns {Promise<{videoId:string,url:string,privacy:string}>}
   */
  async upload({ file, title, description, tags, privacy, onProgress }) {
    const token = await this.getAccessToken();
    const size = fs.statSync(file).size;
    const metadata = {
      snippet: {
        title: (title || path.basename(file, '.mp4')).slice(0, 100),
        description: (description || '').slice(0, 4000),
        tags: (tags || []).filter(Boolean).slice(0, 20),
        categoryId: CATEGORY_GAMING,
      },
      status: { privacyStatus: privacy || 'unlisted', selfDeclaredMadeForKids: false },
    };

    const location = await new Promise((resolve, reject) => {
      const body = JSON.stringify(metadata);
      const req = https.request(
        {
          host: UPLOAD_HOST,
          path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'X-Upload-Content-Length': size,
            'X-Upload-Content-Type': 'video/mp4',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode === 200 && res.headers.location) return resolve(res.headers.location);
            let msg = `HTTP ${res.statusCode}`;
            try {
              msg = JSON.parse(data)?.error?.message || msg;
            } catch {}
            reject(new Error(msg));
          });
        }
      );
      req.on('error', reject);
      req.end(body);
    });

    const video = await new Promise((resolve, reject) => {
      const url = new URL(location);
      const req = https.request(
        {
          host: url.host,
          path: url.pathname + url.search,
          method: 'PUT',
          headers: { 'Content-Length': size, 'Content-Type': 'video/mp4' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(data);
            } catch {}
            if (res.statusCode === 200 && json?.id) return resolve(json);
            reject(new Error(json?.error?.message || `HTTP ${res.statusCode}`));
          });
        }
      );
      req.on('error', reject);
      let sent = 0;
      const stream = fs.createReadStream(file);
      stream.on('data', (chunk) => {
        sent += chunk.length;
        onProgress && onProgress(Math.min(1, sent / size));
      });
      stream.on('error', reject);
      stream.pipe(req);
    });

    const privacyStatus = video.status?.privacyStatus || metadata.status.privacyStatus;
    this.log(`Clip envoyé sur YouTube : ${video.id} (${privacyStatus})`);
    return { videoId: video.id, url: `https://youtu.be/${video.id}`, privacy: privacyStatus };
  }
}

module.exports = { YouTube };
