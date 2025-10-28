import express from 'express';
import Unblocker from 'unblocker';
import http from 'http';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 8080;

/* ────────────────────────────────
   HTTP / HTTPS
────────────────────────────────── */
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: false
});

/* ────────────────────────────────
   CORS
────────────────────────────────── */
function ensureCorsAndExpose(data) {
  data.headers = data.headers || {};
  data.headers['access-control-allow-origin'] = '*';
  data.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  data.headers['access-control-allow-headers'] = '*';
  data.headers['access-control-expose-headers'] =
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, Location';
  data.headers['accept-ranges'] = 'bytes';
}

/* ────────────────────────────────
   Location header rewrite
────────────────────────────────── */
function rewriteLocationHeader(data) {
  const headers = data.headers || {};
  let loc = headers['location'] || headers['Location'];
  if (!loc) return;

  const proxyPrefix = '/proxy/';
  if (loc.includes(proxyPrefix)) return; // already proxied

  try {
    if (/^https?:\/\//i.test(loc)) {
      headers['Location'] = proxyPrefix + loc;
    } else {
      const base = data.requestUrl ? new URL(data.requestUrl) : null;
      const abs = base ? new URL(loc, base).href : loc;
      headers['Location'] = proxyPrefix + abs;
    }
  } catch (e) {
    console.error('[rewriteLocationHeader] err:', e.message);
    return;
  }

  if (headers['location'] && headers['Location']) {
      delete headers['location'];
  }

  data.headers = headers;
}

/* ────────────────────────────────
   HLS manifest (.m3u8) rewrite
────────────────────────────────── */
function rewriteM3U8(data) {
  const headers = data.headers || {};
  const ct = (headers['content-type'] || headers['Content-type'] || '').toLowerCase();
  if (!ct.includes('mpegurl')) return;

  let body = data.body;
  if (!body) return;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');

  const proxyPrefix = '/proxy/';
  const baseUrl = data.requestUrl ? new URL(data.requestUrl) : null;

  const lines = body.split(/\r?\n/).map(line => {
    if (!line || line.startsWith('#')) return line;
    if (/^https?:\/\//i.test(line)) {
      return proxyPrefix + line;
    }
    if (baseUrl) {
      try {
          const abs = new URL(line, baseUrl).href;
          return proxyPrefix + abs;
      } catch (e) {
          console.error('[rewriteM3U8] Err', e.message);
          return line;
      }
    }
    return line;
  });

  const newBody = lines.join('\n');
  data.body = Buffer.from(newBody, 'utf8');
  if (headers['content-length'] || headers['Content-Length']) {
    const key = headers['content-length'] ? 'content-length' : 'Content-Length';
    headers[key] = Buffer.byteLength(data.body).toString();
  }
  data.headers = headers;
}

/* ────────────────────────────────
   Unblocker
────────────────────────────────── */
const unblocker = new Unblocker({
  prefix: '/proxy/',

  requestMiddleware: [
    function (data) {
      try {
        const raw = data.url || '';
        const url = new URL(raw);

        if (url.port) {
            console.warn(`[PORT-STRIP] Port ${url.port} removed, using standard port for ${url.protocol}`);
            url.port = '';
        }

        data.options = data.options || {};

        if (url.protocol === 'https:') {
          data.options.agent = httpsAgent;
          data.options.rejectUnauthorized = false;
        } else {
          data.options.agent = httpAgent;
        }

        data.url = url.href;

        if (!process.env.SILENT_PROXY_LOGS) {
          console.log(`[proxy] → ${url.href}`);
        }
      } catch (err) {
        console.error('[requestMiddleware] URL parse err', err.message);
      }
    }
  ],

  responseMiddleware: [
    function (data) {
      try {
        ensureCorsAndExpose(data);
        rewriteLocationHeader(data);
        rewriteM3U8(data);

        delete data.headers['x-frame-options'];
        delete data.headers['content-security-policy'];
        delete data.headers['strict-transport-security'];
        delete data.headers['public-key-pins'];
      } catch (err) {
        console.error('[responseMiddleware] err:', err.message);
      }
    }
  ]
});

/* ────────────────────────────────
   Web UI
────────────────────────────────── */
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Web Proxy</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .box {
      background: white;
      padding: 40px;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      max-width: 700px;
      width: 90%;
      text-align: center;
    }
    input {
      padding: 12px;
      width: 80%;
      border-radius: 8px;
      border: 2px solid #ccc;
      font-size: 16px;
    }
    button {
      padding: 12px 20px;
      background: #667eea;
      border: none;
      border-radius: 8px;
      color: white;
      cursor: pointer;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>Web Proxy</h1>
    <form id="proxyForm">
      <input type="text" name="url" placeholder="example: https://example.com" required />
      <button type="submit">Git ➔</button>
    </form>
  </div>
  <script>
    document.getElementById('proxyForm').addEventListener('submit', e => {
      e.preventDefault();
      let url = e.target.url.value.trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
      window.location.href = '/proxy/' + url;
    });
  </script>
</body>
</html>
  `);
});

/* ────────────────────────────────
   Proxy middleware
────────────────────────────────── */
app.use(unblocker);

/* ────────────────────────────────
   Debugging
────────────────────────────────── */
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).send('Error' + (err?.message || err));
});

/* ────────────────────────────────
   Launch
────────────────────────────────── */
const server = app.listen(PORT, () => {
  console.log('Launched');
});

server.on('upgrade', unblocker.onUpgrade);

process.on('SIGTERM', () => {
  console.log('Leaving...');
  server.close(() => {
    process.exit(0);
  });
});
