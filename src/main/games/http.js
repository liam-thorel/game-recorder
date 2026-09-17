const https = require('https');

/** GET JSON sur une API locale en HTTPS auto-signé. Renvoie null si indisponible. */
function getLocalJson({ port, path, headers = {}, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: '127.0.0.1', port, path, headers, rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

module.exports = { getLocalJson };
