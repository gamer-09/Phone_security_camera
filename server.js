#!/usr/bin/env node
/**
 * SEC-CAM — Phone → PC security camera
 * ------------------------------------
 * Serves two pages over HTTPS on your local network:
 *   /viewer.html  → the PC "command centre" (watch + listen)
 *   /phone.html   → the phone "camera unit" (capture + transmit)
 *
 * Why HTTPS? Browsers only allow camera/mic access (getUserMedia) from
 * secure contexts. A self-signed cert is generated on first run so the
 * phone can open this over HTTPS on your LAN (tap through the one-time
 * certificate warning). For localhost-only testing use:  node server.js --http
 *
 * Streaming uses WebRTC (PeerJS) with a self-hosted signaling server, so
 * video + audio flow directly phone→PC and never leave your network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const express = require('express');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');
const { ExpressPeerServer } = require('peer');

/* ------------------------------------------------------------------ */
/*  Config                                                            */
/* ------------------------------------------------------------------ */

const HTTP_MODE = process.argv.includes('--http') || !!process.env.SECAM_HTTP;
const HTTPS_PORT = parseInt(process.env.PORT, 10) || 3443;
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 3000;
const REDIRECT_PORT = parseInt(process.env.REDIRECT_PORT, 10) || 3080;
const PEERJS_MOUNT = '/peerjs';
const ROOT = __dirname;
const LAN = getLanIp() || '127.0.0.1';

/* ------------------------------------------------------------------ */
/*  Self-signed certificate (HTTPS mode only)                         */
/* ------------------------------------------------------------------ */

let httpsOptions = null;
if (!HTTP_MODE) httpsOptions = loadOrCreateCert();

/* ------------------------------------------------------------------ */
/*  Express app                                                       */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
// Serve the PeerJS client library locally (no CDN / internet needed)
app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'peerjs', 'dist')));

app.get('/', (_req, res) => res.redirect('/viewer.html'));

/* ------------------------------------------------------------------ */
/*  Tiny registry: the PC viewer announces its link id + PIN, the     */
/*  phone picks it up automatically so setup is nearly zero-config.   */
/* ------------------------------------------------------------------ */

let viewer = null; // { id, pin, seen }

app.post('/api/viewer', (req, res) => {
  const id = String((req.body && req.body.id) || '').trim();
  const pin = String((req.body && req.body.pin) || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  viewer = { id, pin, seen: Date.now() };
  res.json({ ok: true });
});

app.get('/api/viewer', (_req, res) => {
  res.json({ id: viewer ? viewer.id : null, pin: viewer ? viewer.pin : null });
});

// QR for an arbitrary URL — used by the viewer in relay mode so the code
// it shows encodes the internet (tunnel) link instead of the LAN one.
app.get('/api/qr', async (req, res) => {
  const url = String(req.query.url || '').slice(0, 500);
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url required' });
  try {
    const qr = await QRCode.toDataURL(url, {
      margin: 1,
      width: 320,
      color: { dark: '#04070d', light: '#ffffff' },
    });
    res.json({ qr });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/info', async (_req, res) => {
  const port = HTTP_MODE ? HTTP_PORT : HTTPS_PORT;
  const scheme = HTTP_MODE ? 'http' : 'https';
  const base = `${scheme}://${LAN}:${port}`;
  const phoneUrl = `${base}/phone.html`;
  try {
    const qr = await QRCode.toDataURL(phoneUrl, {
      margin: 1,
      width: 320,
      color: { dark: '#04070d', light: '#ffffff' },
    });
    res.json({
      lanIp: LAN,
      port,
      scheme,
      base,
      phoneUrl,
      viewerUrl: `${base}/viewer.html`,
      qr,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/* ------------------------------------------------------------------ */
/*  PeerJS signaling server (WebRTC handshake only — media flows      */
/*  directly between the two devices)                                 */
/* ------------------------------------------------------------------ */

let server;
if (HTTP_MODE) {
  server = http.createServer(app);
} else {
  server = https.createServer(httpsOptions, app);
}
// alive_timeout: the PeerJS server otherwise kills a signaling socket after
// 60s of silence — but a security camera naturally streams for minutes with
// zero signaling traffic, and a dead socket silently drops the phone's STOP
// message. 10 minutes keeps the link healthy for a normal watch session.
app.use(PEERJS_MOUNT, ExpressPeerServer(server, { path: '/', alive_timeout: 600000 }));

server.on('error', handleListenError);
server.listen(HTTP_MODE ? HTTP_PORT : HTTPS_PORT, '0.0.0.0', () => {
  bootLog();
});

// HTTP → HTTPS redirect helper (so a phone that lands on the http URL
// gets bounced to the secure page where the camera API works). Uses its
// own dedicated port so it can never collide with another app. This is a
// convenience only — if the port is busy we warn and keep running, because
// the QR code and printed links already point straight at the https URL.
if (!HTTP_MODE) {
  const redirectServer = http.createServer((req, res) => {
    const host = req.headers.host ? req.headers.host.split(':')[0] : LAN;
    res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
    res.end();
  });
  redirectServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n  ⚠ Port ${err.port} is in use — skipping the http→https redirect (optional).`);
      console.error('    The viewer/phone pages are unaffected; use the https links below.\n');
      return; // non-essential — never take the app down for this
    }
    throw err;
  });
  redirectServer.listen(REDIRECT_PORT);
}

function handleListenError(err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  ✖ Port ${err.port} is already in use — another app is running on it.`);
    console.error('    Pick a free port and try again:\n');
    console.error('      HTTPS mode :  set PORT=4443 && npm start');
    console.error('      HTTP mode  :  set HTTP_PORT=4444 && npm start -- --http\n');
    process.exit(1);
  }
  throw err;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function loadOrCreateCert() {
  const certDir = path.join(ROOT, 'cert');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.mkdirSync(certDir, { recursive: true });
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: LAN }],
      {
        days: 3650,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
          {
            name: 'subjectAltName',
            altNames: [
              { type: 7, ip: LAN },
              { type: 2, value: 'localhost' },
            ],
          },
        ],
      }
    );
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function listLanIps() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out.length ? out : ['127.0.0.1'];
}

async function bootLog() {
  const scheme = HTTP_MODE ? 'http' : 'https';
  const port = HTTP_MODE ? HTTP_PORT : HTTPS_PORT;
  const urls = listLanIps().map((ip) => `${scheme}://${ip}:${port}`);

  const banner = `
  ┌──────────────────────────────────────────────────────────┐
  │  ███████╗███████╗ ██████╗      ██████╗ █████╗ ███╗   ███╗ │
  │  ██╔════╝██╔════╝██╔════╝     ██╔════╝██╔══██╗████╗ ████║ │
  │  ███████╗█████╗  ██║          ██║     ███████║██╔████╔██║ │
  │  ╚════██║██╔══╝  ██║          ██║     ██╔══██║██║╚██╔╝██║ │
  │  ███████║███████╗╚██████╗     ╚██████╗██║  ██║██║ ╚═╝ ██║ │
  │  ╚══════╝╚══════╝ ╚═════╝      ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝ │
  └──────────────────────────────────────────────────────────┘
  SEC-CAM online — phone security camera
  --------------------------------------
  PC VIEWER   ${urls[0]}/viewer.html
  PHONE UNIT  ${urls[0]}/phone.html
  ${HTTP_MODE ? '' : 'http redirect on :' + REDIRECT_PORT + '  →  https://lan-ip:' + HTTPS_PORT + '\n'}
  Connect the phone by scanning the QR shown on the viewer page.
  `;

  console.log(banner.replace(/^\s+$/gm, ''));

  if (!HTTP_MODE) {
    console.log('  Self-signed HTTPS in use — tap through the certificate warning once on your phone.');
  }

  try {
    const qrStr = await QRCode.toString(`${scheme}://${LAN}:${port}/phone.html`, {
      type: 'terminal',
      small: true,
    });
    console.log('\n  Scan this with your phone camera to open the PHONE UNIT:\n');
    console.log(qrStr + '\n');
  } catch {
    // terminal QR is a nice-to-have; ignore if the terminal can't render it
  }
}
