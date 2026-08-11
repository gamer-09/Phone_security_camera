/* SEC-CAM — shared helpers */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter(Boolean));
  return node;
}

function toast(message, type = 'info', ms = 3200) {
  const wrap = $('.toast-wrap');
  if (!wrap) return;
  const t = el('div', { class: `toast ${type}`, text: message });
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 350);
  }, ms);
}

const clockNow = () =>
  new Date().toLocaleTimeString('en-GB', { hour12: false });

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function secElapsed(start) {
  const s = Math.floor((Date.now() - start) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* Timestamped event logger — writes to the console and, if a debug
   drawer exists on the page, to an on-screen list you can inspect. */
function dbg(tag, ...args) {
  const line = `[${clockNow()}] ${tag} ${args.join(' ')}`;
  console.log(line);
  const list = document.getElementById('dbgList');
  if (list) {
    const li = document.createElement('li');
    li.textContent = line;
    list.prepend(li);
    while (list.children.length > 60) list.lastChild.remove();
  }
}

/* ---------------------------------------------------------------- */
/*  Relay mode — internet "watch from anywhere"                       */
/* ---------------------------------------------------------------- */

/* Relay mode is auto-enabled when the pages are served from a public
   hostname (e.g. a Cloudflare quick-tunnel URL), or forced with ?relay=1.
   In relay mode we add a TURN media relay so video/audio can flow through
   a server when direct peer-to-peer fails across NATs — the phone and the
   viewer can be anywhere with internet. */
function isRelay() {
  const params = new URLSearchParams(location.search);
  if (params.has('relay')) return params.get('relay') !== '0';
  const h = (location.hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
  // mDNS / Bonjour hostnames (mypc.local) and LAN TLDs — still the LAN
  if (/\.(local|lan|home|internal)$/.test(h)) return false;
  // IPv6 link-local / unique-local addresses
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    // private / link-local IPv4 ranges → still the LAN
    const [a, b] = h.split('.').map(Number);
    if (a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  return true; // a real domain name → served publicly → relay
}

/* ?cloud=1 forces PeerJS's public cloud signaling server instead of the
   self-hosted one — used when the pages are hosted statically (no server). */
function isCloudMode() {
  return new URLSearchParams(location.search).has('cloud');
}

/* ?nostun=1 drops STUN servers (keeps TURN in relay mode) — used by the
   localhost e2e so ICE doesn't wait on external STUN timeouts. */
const NO_STUN = new URLSearchParams(location.search).has('nostun');

/* ---------------------------------------------------------------- */
/*  Offline awareness + adaptive quality                             */
/* ---------------------------------------------------------------- */

/* ?offline=1 forces offline mode (test/emergency knob); otherwise the
   browser's online status decides. When offline we drop external
   STUN/TURN entirely — on a LAN without internet they would only stall
   ICE for ~30s; host candidates alone connect instantly. */
const OFFLINE_FORCE = new URLSearchParams(location.search).has('offline');

function isOffline() {
  if (OFFLINE_FORCE) return true;
  return typeof navigator.onLine === 'boolean' ? !navigator.onLine : false;
}

/* Tiny change-notifier so both pages can react to network flips.
   Handlers are invoked immediately with the current state, and again on
   every 'online'/'offline' event. Returns an unsubscribe function. */
const netHandlers = [];
function onNetChange(cb) {
  netHandlers.push(cb);
  cb(isOffline());
  return () => {
    const i = netHandlers.indexOf(cb);
    if (i >= 0) netHandlers.splice(i, 1);
  };
}
window.addEventListener('online', () => netHandlers.forEach((h) => h(false)));
window.addEventListener('offline', () => netHandlers.forEach((h) => h(true)));

/* Shared adaptive-quality ladder, index 0 = most economical. The viewer's
   engine picks a tier from live WebRTC stats and tells the phone; the phone
   applies it as an encoder bitrate cap + capture constraints — no SDP
   renegotiation needed, so it works mid-call on any network. */
/* Night-vision thresholds — mean frame luminance (0–255). Hysteresis
   so the filter never flickers at the boundary: engage below NVG_ON_LVL,
   disengage only above NVG_OFF_LVL. Both pages use these so the phone's
   preview and the PC viewer agree on when it's "dark". */
const NVG_ON_LVL = 22;
const NVG_OFF_LVL = 34;

const QUALITY_TIERS = [
  { label: 'ECO 240p', w: 426, h: 240, fps: 12, bitrate: 120000 },   // 0
  { label: 'SD 360p', w: 640, h: 360, fps: 15, bitrate: 250000 },    // 1
  { label: 'SD 480p', w: 854, h: 480, fps: 18, bitrate: 500000 },    // 2
  { label: 'HD 720p', w: 1280, h: 720, fps: 24, bitrate: 1100000 },  // 3
  { label: 'FHD 1080p', w: 1920, h: 1080, fps: 24, bitrate: 2500000 }, // 4
];

/* Manual quality modes (viewer dock): AUTO = adaptive engine; STABLE pins
   the stream to the gentle SD 360p tier (≈250 kbps) so weak or flaky WiFi
   adapters are never stressed into dropping the link; the others force a
   fixed tier. The FHD 1080p tier (index 4) is intentionally unreachable —
   neither the engine (AUTO_CEIL_TIER) nor any manual mode selects it — so
   a multi-Mbps burst can never be demanded from a weak link. */
const QUALITY_MODES = { auto: -1, stable: 1, eco: 0, med: 2, hd: 3 };

/* The AUTO engine starts on SD 480p (gentle on weak WiFi) and never
   escalates past HD 720p on its own — sustained FHD-class RTP traffic is
   the fastest way to push a buggy adapter over the edge. If the link still
   drops, the user pins STABLE mode as a hard cap. */
const QUALITY_START_TIER = 2; // SD 480p default
const AUTO_CEIL_TIER = 3;     // HD 720p — AUTO never goes beyond this

const IS_RELAY = isRelay();

/* Free TURN relay (Open Relay Project, no account). Media is relayed
   through their servers only when direct P2P fails. Swap these entries for
   your own TURN if you prefer (see README). */
function relayIceServers() {
  const list = [];
  if (!NO_STUN) list.push({ urls: 'stun:stun.l.google.com:19302' });
  list.push({
    urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  });
  return list;
}

/* PeerJS connection options derived from the current page. Works for the
   HTTP localhost mode, the HTTPS LAN mode, and relay mode (tunnel/cloud). */
function peerOpts() {
  const opts = {
    debug: 1,
    config: {
      // offline: host candidates only — external STUN/TURN would just
      // stall ICE waiting for timeouts that never come
      iceServers: isOffline()
        ? []
        : IS_RELAY
          ? relayIceServers()
          : NO_STUN ? [] : [{ urls: 'stun:stun.l.google.com:19302' }],
    },
  };
  if (isCloudMode()) {
    // public PeerJS cloud — no self-hosted server needed
    opts.host = '0.peerjs.com';
    opts.port = 443;
    opts.path = '/';
    opts.secure = true;
  } else {
    opts.host = location.hostname;
    opts.port = Number(location.port) || (location.protocol === 'https:' ? 443 : 80);
    opts.path = '/peerjs';
    opts.secure = location.protocol === 'https:';
  }
  return opts;
}

/* test/console hook — lets test/e2e.js and the LOG drawer verify the
   network mode actually in use */
const __netOpts = peerOpts();
window.__secamNet = {
  get relay() { return isRelay(); },
  get cloud() { return isCloudMode(); },
  iceServers: __netOpts.config.iceServers,
  signaling: { host: __netOpts.host, port: __netOpts.port, path: __netOpts.path, secure: __netOpts.secure },
};

/* Attach ICE / connection-state logging to a live call (uses
   addEventListener so we never clobber PeerJS's own handlers).
   onConnected fires once when the media path is actually up. */
function wireIceLog(prefix, c, onConnected) {
  try {
    const pc = c.peerConnection;
    if (!pc) return;
    let linked = false;
    const mark = () => {
      const st = pc.iceConnectionState;
      dbg(prefix, 'ice', st);
      if (!linked && (st === 'connected' || st === 'completed')) {
        linked = true;
        if (onConnected) onConnected();
      }
      if (st === 'failed' || st === 'disconnected') dbg(prefix, '⚠ ice', st);
    };
    pc.addEventListener('iceconnectionstatechange', mark);
    // ICE can already be 'connected' before this listener attaches (very
    // fast LAN links) — catch that state so onConnected still fires.
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') mark();
    pc.addEventListener('connectionstatechange', () => dbg(prefix, 'rtc', pc.connectionState));
    pc.addEventListener('icegatheringstatechange', () => dbg(prefix, 'gathering', pc.iceGatheringState));
  } catch { /* older browser — ignore */ }
}

/* Wire the on-screen debug drawer toggle (present on both pages). */
function wireDbgToggle() {
  const open = document.getElementById('btnDbg');
  const close = document.getElementById('btnDbgClose');
  const panel = document.getElementById('dbgPanel');
  if (!open || !close || !panel) return;
  open.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  close.addEventListener('click', () => { panel.hidden = true; });
}
