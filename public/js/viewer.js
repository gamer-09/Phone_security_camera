/* SEC-CAM — PC viewer (command centre) */
'use strict';

const feed = $('#feed');
const stage = $('#stage');
const pill = $('#pill');
const waitOverlay = $('#waitOverlay');
const rttEl = $('#rtt');
const fpsEl = $('#fps');
const clockEl = $('#clock');
const recBadge = $('#recBadge');
const stageHud = $('#stageHud');
const unmuteCard = $('#unmuteCard');
const relayBadge = $('#relayBadge');
const offlineBadge = $('#offlineBadge');
const qrImg = $('#qr');
const phoneUrlEl = $('#phoneUrl');
const peerIdEl = $('#peerId');
const pinEl = $('#pin');
const qualityChip = $('#qualityChip');
const bwChip = $('#bwChip');
const segQuality = $('#segQuality');
const linkLost = $('#linkLost');
const linkLostT = $('#linkLostT');
const nvChip = $('#nvChip');
const btnNight = $('#btnNight');
const btnThermal = $('#btnThermal');
const btnTalk = $('#btnTalk');
const btn = {
  unmute: $('#btnUnmute'),
  copy: $('#btnCopy'),
  reconnect: $('#btnReconnect'),
  snapshot: $('#btnSnapshot'),
  record: $('#btnRecord'),
  pip: $('#btnPip'),
  fs: $('#btnFs'),
  mute: $('#btnMute'),
};

const PIN = String(Math.floor(1000 + Math.random() * 9000));

let peer = null;
let call = null;
let live = false;
let remoteStream = null;
let connectUrl = null;

let recorder = null;
let recChunks = [];

let statsTimer = null;
let fpsAcc = 0;
let lastFpsAt = 0;
let lastFrameTime = 0;
let stallTicks = 0;

/* Graceful-dropout state: on a signal loss we keep the last frame visible
   under a RECONNECTING overlay while the phone's auto-reconnect re-links —
   a brief network blip never tears the call down. */
let reconnecting = false;
let reconnectSince = 0;
let reconnectTimer = null;
let callClosedForRelink = false;
let intentionalBye = false; // phone pressed STOP on purpose → no buffering

/* ---------------------------------------------------------------- */
/*  Adaptive quality — the brain of the poor-link handling.           */
/*  Every stats sample (~2s) we measure loss / jitter / RTT /         */
/*  bandwidth from the incoming stream and nudge the phone up or      */
/*  down the QUALITY_TIERS ladder over a data channel.                */
/* ---------------------------------------------------------------- */

const AQ = {
  mode: 'auto',        // 'auto' | 'eco' | 'med' | 'hd'
  tier: QUALITY_START_TIER,
  dc: null,
  dcOpen: false,
  prev: null,          // last inbound-rtp sample {t, bytes, pkts, lost}
  congested: 0,        // consecutive congested samples
  healthy: 0,          // consecutive healthy samples
  lastStep: 0,         // when the tier last changed (anti-oscillation)
  slow: false,         // known-poor link → stall watchdog gets more grace
  forceCongest: false, // test hooks — override the verdicts
  forceHealth: false,
};
const AQ_COOLDOWN = 6000;      // min time between tier changes
const AQ_CONGEST_STREAK = 2;   // 2 bad samples (~4s) before stepping down
const AQ_HEALTH_STREAK = 3;    // 3 good samples (~6s) before stepping up

const LINK_BUFFER_MS = 12000;  // keep the same call open, hope ICE recovers
const LINK_RELINK_MS = 45000;  // total budget incl. the phone auto-reconnecting

function fmtBw(bps) {
  if (!bps || bps <= 0) return '--';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mb/s` : `${Math.round(bps / 1e3)} kb/s`;
}

/* The viewer opens the quality channel to the phone (it knows the phone's
   peer id from the incoming call). Commands: {t:'q',v:tier}; reports come
   back as {t:'r',...}. */
function openDataChannel(phoneId) {
  try {
    const dc = peer.connect(phoneId, { reliable: true, serialization: 'json' });
    AQ.dc = dc;
    dc.on('open', () => {
      AQ.dcOpen = true;
      dbg('VIEWER', 'quality channel open');
      // Deliver the current tier the moment the channel is up — a fresh
      // link must start CAPPED, never encode uncapped while the engine
      // gathers its first stats (a multi-Mbps startup burst is exactly
      // what trips weak WiFi adapters into dropping).
      sendQuality(AQ.tier);
    });
    dc.on('data', (d) => {
      let m = d;
      if (typeof d === 'string') { try { m = JSON.parse(d); } catch { return; } }
      if (!m) return;
      if (m.t === 'bye') {
        intentionalBye = true;
        dbg('VIEWER', 'phone STOP acknowledged — no buffering');
        // the close can beat the bye over the wire (different transports):
        // if we already started buffering, a deliberate STOP ends it now
        if (reconnecting) teardown();
      } else if (m.t === 'r') renderQuality(m);
    });
    // identity guard: a LATE close from the previous phone's channel (which
    // happens exactly during auto-reconnect) must never clobber a newer one
    dc.on('close', () => { if (AQ.dc === dc) { AQ.dcOpen = false; AQ.dc = null; } });
    dc.on('error', (e) => dbg('VIEWER', 'quality channel error', e && e.type));
  } catch (e) {
    dbg('VIEWER', 'quality channel failed', e && e.message);
  }
}

function sendQuality(tier) {
  AQ.tier = Math.max(0, Math.min(QUALITY_TIERS.length - 1, tier));
  AQ.slow = AQ.tier <= 1;
  if (AQ.dcOpen && AQ.dc) {
    try { AQ.dc.send({ t: 'q', v: AQ.tier }); } catch { /* still opening */ }
  }
  renderQuality(null);
}

function renderQuality(report) {
  if (!qualityChip) return;
  const t = QUALITY_TIERS[AQ.tier];
  const mode = AQ.mode === 'auto' ? 'AUTO' : AQ.mode.toUpperCase();
  const label = (report && report.label) || t.label;
  qualityChip.textContent = `Q ${mode} · ${label}`;
  qualityChip.classList.toggle('low', AQ.tier <= 1);
}

/* ---------------------------------------------------------------- */
/*  Graceful dropout — buffer instead of tearing down                */
/* ---------------------------------------------------------------- */

/* Enter the buffering state: the video element keeps its last frame, the
   RECONNECTING overlay + countdown appear, and the call is kept open so
   ICE can re-establish on its own. opts.closeCall closes it immediately
   (ICE 'failed') so the phone notices and its auto-reconnect kicks in. */
function enterReconnecting(reason, opts = {}) {
  if (!live || reconnecting) return;
  // the phone deliberately STOPped (its 'bye' rode the data channel, which
  // survives a dead signaling socket — the common lost-close case): go
  // straight to standby, never buffer an intentional stop
  if (intentionalBye) { teardown(); return; }
  reconnecting = true;
  reconnectSince = Date.now();
  callClosedForRelink = false;
  dbg('VIEWER', 'link lost — buffering', `(${reason})`);
  setStatus('RECONNECTING');
  if (linkLost) linkLost.classList.remove('hidden');
  updateReconnectClock();
  reconnectTimer = setInterval(reconnectTick, 1000);
  if (opts.closeCall && call) {
    callClosedForRelink = true;
    try { call.close(); } catch { /* ignore */ } // phone notices → auto re-link
  }
}

/* Resume: the feed is flowing again (same call recovered or a new call
   arrived) — drop the overlay and go back to LIVE. */
function exitReconnecting() {
  if (!reconnecting) return;
  reconnecting = false;
  clearInterval(reconnectTimer);
  reconnectTimer = null;
  if (linkLost) linkLost.classList.add('hidden');
  if (live) setStatus('LIVE');
}

function updateReconnectClock() {
  const remain = Math.max(0, Math.round((LINK_RELINK_MS - (Date.now() - reconnectSince)) / 1000));
  if (linkLostT) linkLostT.textContent = `${String(Math.floor(remain / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;
}

function reconnectTick() {
  updateReconnectClock();
  const elapsed = Date.now() - reconnectSince;
  if (elapsed >= LINK_RELINK_MS) {
    dbg('VIEWER', 're-link budget exhausted — tearing down');
    teardown();
    return;
  }
  // buffer window over and the same call never recovered → close it so the
  // phone's auto-reconnect (which needs to see the link die) kicks in
  if (!callClosedForRelink && elapsed >= LINK_BUFFER_MS && call) {
    callClosedForRelink = true;
    dbg('VIEWER', 'buffer window over — closing call so the phone re-links');
    try { call.close(); } catch { /* ignore */ }
  }
}

function setQualityMode(mode) {
  if (!(mode in QUALITY_MODES)) return;
  AQ.mode = mode;
  $$('#segQuality button').forEach((b) => b.classList.toggle('on', b.dataset.q === mode));
  AQ.congested = 0;
  AQ.healthy = 0;
  if (mode === 'auto') {
    AQ.lastStep = performance.now(); // don't act on stale cooldown data
    dbg('VIEWER', 'quality mode → AUTO');
  } else {
    const tier = QUALITY_MODES[mode];
    dbg('VIEWER', 'quality mode →', mode.toUpperCase(), `tier ${tier}`);
    sendQuality(tier);
    toast(
      mode === 'stable'
        ? '🛡 STABLE — minimal bandwidth, safest for weak WiFi'
        : `Quality → ${QUALITY_TIERS[tier].label}`,
      mode === 'stable' ? 'warn' : 'info',
      1800
    );
  }
}

/* Decide whether the link is congested or healthy and act with
   hysteresis so we don't oscillate. Caller passes the inbound-rtp video
   sample + current RTT; we keep our own rolling baseline. */
function aqTick(v, rttMs) {
  if (!v) return;
  const now = performance.now();
  const prev = AQ.prev;

  // SSRC changed (camera flip / track swap) → stats reset; re-baseline
  if (!prev || v.packetsReceived < prev.pkts) {
    AQ.prev = { t: v.timestamp, bytes: v.bytesReceived, pkts: v.packetsReceived, lost: v.packetsLost };
    return;
  }
  const dt = (v.timestamp - prev.t) / 1000;
  let lossPct = 0;
  let jitterMs = 0;
  let bitrate = 0;
  if (dt > 0) {
    const dRecv = v.packetsReceived - prev.pkts;
    const dLost = Math.max(0, v.packetsLost - prev.lost);
    const total = dRecv + dLost;
    lossPct = total > 0 ? (dLost / total) * 100 : 0;
    bitrate = ((v.bytesReceived - prev.bytes) * 8) / dt;
    jitterMs = (v.jitter || 0) * 1000;
  }
  AQ.prev = { t: v.timestamp, bytes: v.bytesReceived, pkts: v.packetsReceived, lost: v.packetsLost };

  if (bwChip) {
    bwChip.textContent = `BW ${fmtBw(bitrate)} · ${Math.round(lossPct)}% loss`;
    bwChip.classList.toggle('low', lossPct > 4 || jitterMs > 60);
  }

  if (AQ.mode !== 'auto') return; // manual — the engine stands aside

  const t = QUALITY_TIERS[AQ.tier];
  const floor = t.bitrate * 0.45; // below this the link can't sustain the tier
  // test hooks are mutually exclusive and win over the real verdicts, so a
  // forced state can't fight the live stats (or itself)
  const verdicts = AQ.forceCongest
    ? { congested: true, healthy: false }
    : AQ.forceHealth
      ? { congested: false, healthy: true }
      : {
          congested: lossPct > 4 || jitterMs > 60 || (rttMs > 0 && rttMs > 600) || (bitrate > 0 && bitrate < floor),
          healthy: lossPct < 1.5 && jitterMs < 40 && (rttMs <= 0 || rttMs < 350) && (bitrate === 0 || bitrate >= floor * 0.8),
        };
  const { congested, healthy } = verdicts;

  AQ.congested = congested ? AQ.congested + 1 : 0;
  AQ.healthy = healthy ? AQ.healthy + 1 : 0;

  const since = now - AQ.lastStep;
  if (congested && AQ.congested >= AQ_CONGEST_STREAK && since >= AQ_COOLDOWN && AQ.tier > 0) {
    AQ.lastStep = now;
    AQ.congested = 0;
    AQ.healthy = 0;
    dbg('VIEWER', 'link congested', `loss ${lossPct.toFixed(1)}% jitter ${jitterMs.toFixed(0)}ms bw ${(bitrate / 1000) | 0}kbps → tier ${AQ.tier - 1}`);
    sendQuality(AQ.tier - 1);
    toast('Poor link — quality reduced', 'warn', 1500);
  } else if (healthy && AQ.healthy >= AQ_HEALTH_STREAK && since >= AQ_COOLDOWN && AQ.tier < AUTO_CEIL_TIER) {
    AQ.lastStep = now;
    AQ.congested = 0;
    AQ.healthy = 0;
    dbg('VIEWER', 'link healthy — raising quality', `→ tier ${AQ.tier + 1}`);
    sendQuality(AQ.tier + 1);
  }
}

/* Relay-mode link building (also re-run on network flips). When offline
   the tunnel is dead, so we fall back to the LAN link instead of showing
   a remote link that cannot work. */
function buildRemoteLink() {
  if (!IS_RELAY) return;
  const id = peerIdEl.textContent;
  if (!id || id.length < 3) return;
  if (isOffline()) {
    relayBadge.hidden = true;
    offlineBadge.hidden = false;
    phoneUrlEl.textContent = connectUrl;
    phoneUrlEl.dataset.remote = '0';
    // the QR must never advertise a remote link that can't work
    qrImg.removeAttribute('src');
    const sub = waitOverlay.querySelector('.sub');
    if (sub) sub.textContent = 'Offline — internet link unavailable. Use this LAN link on the same network';
    return;
  }
  relayBadge.hidden = false;
  offlineBadge.hidden = true;
  const remoteUrl = `${location.origin}/phone.html?relay=1&v=${encodeURIComponent(id)}&pin=${PIN}`;
  phoneUrlEl.textContent = remoteUrl;
  phoneUrlEl.dataset.remote = '1';
  const sub = waitOverlay.querySelector('.sub');
  if (sub) sub.textContent = 'Relay mode — this link works from anywhere with internet';
  fetch(`/api/qr?url=${encodeURIComponent(remoteUrl)}`)
    .then((r) => r.json())
    .then((d) => { if (d.qr) qrImg.src = d.qr; else qrImg.removeAttribute('src'); })
    .catch(() => { qrImg.removeAttribute('src'); });
  dbg('VIEWER', 'RELAY MODE — remote link ready');
}

/* A fresh link id on every page load. The previous load's signaling
   socket can outlive the page (the server holds dead sockets for minutes),
   so reusing an id would trip PeerJS's 'unavailable-id' collision — a
   console error + forced reload. The phone auto-discovers the new id via
   the registry on every GO LIVE, so nothing is lost when the id changes. */
function linkIdStore() {
  return `view-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---------------------------------------------------------------- */
/*  Night vision, thermal vision + the talk channel                  */
/* ---------------------------------------------------------------- */

/* Night vision — sample the received feed's luminance every 2s and
   apply the phosphor-green filter when it's dark (AUTO). The canvas
   read is pre-filter, so a brightened NVG image can never feed back
   into the sensor and flicker the filter on/off. */
const NV = {
  mode: 'auto',       // 'auto' | 'on' | 'off'
  active: false,
  light: 100,         // last measured mean luminance (0–255)
  timer: null,
  forceLight: null,   // test hook — override the measured light
};
let thermal = false;

const nvCanvas = document.createElement('canvas');
nvCanvas.width = 8;
nvCanvas.height = 6;
const nvCtx = nvCanvas.getContext('2d', { willReadFrequently: true });

function measureLight() {
  if (NV.forceLight !== null) return NV.forceLight;
  if (!live || feed.readyState < 2 || !feed.videoWidth) return NV.light;
  try {
    nvCtx.drawImage(feed, 0, 0, 8, 6);
    const d = nvCtx.getImageData(0, 0, 8, 6).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    return sum / 48;
  } catch { return NV.light; }
}

function nvTick() {
  NV.light = measureLight();
  if (NV.mode === 'auto') {
    // hysteresis — engage below NVG_ON_LVL, disengage above NVG_OFF_LVL
    if (NV.active && NV.light > NVG_OFF_LVL) NV.active = false;
    else if (!NV.active && NV.light < NVG_ON_LVL) NV.active = true;
  }
  applyViewFilter();
  if (nvChip) {
    nvChip.textContent = `☾ ${NV.mode.toUpperCase()}`;
    nvChip.classList.toggle('on', NV.active);
  }
  if (btnNight) btnNight.textContent = `☾ NIGHT ${NV.mode.toUpperCase()}`;
}

function setNightMode(m) {
  if (!['auto', 'on', 'off'].includes(m)) return;
  NV.mode = m;
  if (m === 'on') NV.active = true;
  else if (m === 'off') NV.active = false;
  nvTick();
  dbg('VIEWER', 'night vision →', m.toUpperCase());
}

function cycleNight() {
  setNightMode(NV.mode === 'auto' ? 'on' : NV.mode === 'on' ? 'off' : 'auto');
}

/* ---------------------------------------------------------------- */
/*  Thermal vision — live auto-ranged relative-heat renderer         */
/* ---------------------------------------------------------------- */

/* A phone camera is a visible-light sensor — it cannot measure temperature.
   This renderer does the closest thing software can: ~8×/s it samples the
   feed's luminance, AUTO-RANGES it (live percentile-clipped min→max, so the
   palette always uses its full scale — like a real thermal cam's auto-
   contrast, and dark scenes don't just wash to blue), maps it onto an
   ironbow palette, temporally smooths it (hot spots glow steadily instead of
   flickering) and marks the hottest/coolest spots. The REL HEAT scale shows
   the live range. This is relative visible-light brightness — NOT real
   temperature (a phone can't sense heat; see README). */

const TH_SAMPLE_W = 96;   // sample grid width (96×54 for 16:9) — tiny CPU cost
const TH_TICK_MS = 120;   // ~8 render passes/sec
const TH_SMOOTH = 0.7;    // temporal smoothing (0 = none, 1 = frozen)
const TH_P_LO = 0.02;     // percentile clip — sensor noise can't blow the scale
const TH_P_HI = 0.98;
const TH_MIN_SPAN = 24;   // never stretch a range smaller than this: a flat
                          // scene maps onto a centred band instead of
                          // stretching sensor noise into a blank/speckled mess
const TH_MARK_MIN_RANGE = 10; // below this the scene is uniform — no markers

const TH_LUT = (() => {
  const stops = [
    [0.0, [0.0, 0.0, 0.35]],
    [0.22, [0.3, 0.0, 0.65]],
    [0.45, [0.9, 0.1, 0.2]],
    [0.68, [1.0, 0.5, 0.0]],
    [0.88, [1.0, 0.95, 0.3]],
    [1.0, [1.0, 1.0, 1.0]],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) s += 1;
    const [t0, c0] = stops[s];
    const [t1, c1] = stops[s + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    lut[i * 3] = Math.round(c0[0] + (c1[0] - c0[0]) * f);
    lut[i * 3 + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * f);
    lut[i * 3 + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * f);
  }
  return lut;
})();

const thCanvas = $('#thermalCanvas');
const thCtx = thCanvas ? thCanvas.getContext('2d') : null;
const thMin = $('#thMin');
const thMax = $('#thMax');
const thScale = $('#thScale');
const thNote = $('#thNote');
const thSample = document.createElement('canvas');
const thSampleCtx = thSample.getContext('2d', { willReadFrequently: true });
const thFrame = document.createElement('canvas');
const thFrameCtx = thFrame.getContext('2d');
let thPrev = null;   // rolling-averaged luminance map {data, w, h}
let thOutImg = null; // reused ImageData output buffer (no per-frame allocs)
let thSort = null;   // reused sort buffer
let thTimer = null;
let thHotCell = -1;  // HOT/COLD marker persistence — a marker only moves when
let thColdCell = -1; // a new cell clearly beats it, so it never jitters on noise
let thDiag = { realRange: 0, markers: false, lo: 0, hi: 0 }; // last-pass diagnostics

/* Centred minimum-span range: keep the scene's true range when there IS
   contrast; otherwise floor it to TH_MIN_SPAN around the midpoint so a flat
   scene still shows a usable gradient instead of stretched noise. */
function thRange(lo, hi) {
  const realRange = Math.max(0, hi - lo);
  const mid = (lo + hi) / 2;
  const span = Math.max(TH_MIN_SPAN, realRange);
  return { lo: mid - span / 2, hi: mid + span / 2, realRange, span };
}

function thRender() {
  if (!thermal || !thCtx) return;
  if (!live || feed.readyState < 2 || !feed.videoWidth) {
    thCtx.clearRect(0, 0, thCanvas.width, thCanvas.height);
    if (thMin) thMin.textContent = '--';
    if (thMax) thMax.textContent = '--';
    if (thNote) thNote.textContent = '';
    return;
  }
  const r = videoContentRect();
  if (!r || r.width < 4 || r.height < 4) return;
  thCanvas.style.left = `${r.left}px`;
  thCanvas.style.top = `${r.top}px`;
  thCanvas.width = Math.round(r.width);
  thCanvas.height = Math.round(r.height);

  const w = TH_SAMPLE_W;
  const h = Math.max(24, Math.round((w * r.height) / r.width));
  thSample.width = w;
  thSample.height = h;
  thSampleCtx.drawImage(feed, 0, 0, w, h);
  const d = thSampleCtx.getImageData(0, 0, w, h).data;

  // temporal smoothing — new maps blend with history. NaN marks the first
  // frame (Float32Array is zero-filled, so fill explicitly) → take full L.
  const n = w * h;
  if (!thPrev || thPrev.w !== w || thPrev.h !== h) {
    thPrev = { data: new Float32Array(n), w, h };
    thPrev.data.fill(NaN);
    thOutImg = thFrameCtx.createImageData(w, h); // reused — no per-frame alloc
    thSort = new Float32Array(n);
    thHotCell = -1; // grid changed — markers re-acquire
    thColdCell = -1;
  }
  const lum = thPrev.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const L = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    lum[i] = Number.isNaN(lum[i]) ? L : lum[i] * TH_SMOOTH + L * (1 - TH_SMOOTH);
  }

  // live auto-range with percentile clipping (reused sort buffer). The
  // centred minimum span keeps flat scenes from stretching noise — the
  // "blank screen + flying markers" failure on uniform walls/dim rooms.
  thSort.set(lum);
  thSort.sort();
  const pLo = thSort[Math.min(n - 1, Math.floor(n * TH_P_LO))];
  const pHi = thSort[Math.max(0, Math.ceil(n * TH_P_HI) - 1)];
  const rng = thRange(pLo, pHi);
  const lo = rng.lo;
  const hi = rng.hi;
  const span = rng.span;
  thDiag = {
    realRange: Math.round(rng.realRange),
    markers: rng.realRange >= TH_MARK_MIN_RANGE,
    lo: Math.round(lo),
    hi: Math.round(hi),
  };

  const data = thOutImg.data;
  let hot = 0;
  let cold = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, (lum[i] - lo) / span));
    const k = (t * 255) | 0;
    data[i * 4] = TH_LUT[k * 3];
    data[i * 4 + 1] = TH_LUT[k * 3 + 1];
    data[i * 4 + 2] = TH_LUT[k * 3 + 2];
    data[i * 4 + 3] = 255;
    if (lum[i] > lum[hot]) hot = i;
    if (lum[i] < lum[cold]) cold = i;
  }

  thFrame.width = w;
  thFrame.height = h;
  thFrameCtx.putImageData(thOutImg, 0, 0);
  thCtx.imageSmoothingEnabled = true;
  thCtx.clearRect(0, 0, thCanvas.width, thCanvas.height);
  thCtx.drawImage(thFrame, 0, 0, thCanvas.width, thCanvas.height);

  // hottest / coolest spot markers (like a real thermal cam's reticles).
  // Only on scenes with real contrast, and with leader persistence so the
  // markers track a moving subject instead of jittering on sensor noise.
  const mark = (idx, label, color) => {
    const mx = ((idx % w) + 0.5) / w * thCanvas.width;
    const my = (((idx / w) | 0) + 0.5) / h * thCanvas.height;
    thCtx.strokeStyle = color;
    thCtx.lineWidth = 1.5;
    thCtx.beginPath();
    thCtx.arc(mx, my, 8, 0, Math.PI * 2);
    thCtx.moveTo(mx - 12, my); thCtx.lineTo(mx + 12, my);
    thCtx.moveTo(mx, my - 12); thCtx.lineTo(mx, my + 12);
    thCtx.stroke();
    thCtx.fillStyle = color;
    thCtx.font = '10px monospace';
    thCtx.fillText(label, mx + 14, my - 8);
  };
  if (thDiag.markers) {
    // release/fade thresholds from the TRUE scene range (not the floored
    // mapping band): a hot leader must stay in the top 40% to keep its
    // reticle, and only loses it to a cell that is clearly hotter
    const hotFloor = pLo + (pHi - pLo) * 0.6;
    const coldCeil = pLo + (pHi - pLo) * 0.4;
    if (thHotCell < 0 || lum[thHotCell] < hotFloor) thHotCell = -1;
    if (thHotCell < 0 || lum[hot] > lum[thHotCell] * 1.1) thHotCell = hot;
    if (thColdCell < 0 || lum[thColdCell] > coldCeil) thColdCell = -1;
    if (thColdCell < 0 || lum[cold] < lum[thColdCell] * 0.9) thColdCell = cold;
    mark(thHotCell, 'HOT', '#ffffff');
    mark(thColdCell, 'COLD', '#7db4ff');
  }
  if (thNote) thNote.textContent = thDiag.markers ? '' : 'FLAT SCENE — NEEDS CONTRAST';

  // display the TRUE percentile range (not the floored mapping band, which
  // can go negative on flat scenes and reads as broken)
  if (thMin) thMin.textContent = String(Math.round(pLo));
  if (thMax) thMax.textContent = String(Math.round(pHi));
}

function toggleThermal() {
  thermal = !thermal;
  if (btnThermal) {
    btnThermal.classList.toggle('on', thermal);
    btnThermal.textContent = thermal ? '♨ THERMAL LIVE' : '♨ THERMAL';
  }
  if (thermal) {
    thPrev = null;
    thHotCell = -1;
    thColdCell = -1;
    if (thCanvas) thCanvas.classList.add('on');
    if (thScale) thScale.classList.remove('hidden');
    thRender();
    thTimer = setInterval(thRender, TH_TICK_MS);
    dbg('VIEWER', 'thermal LIVE — auto-ranged heat render');
    toast('Thermal LIVE — relative heat view (not real °C)', 'info', 1800);
  } else {
    stopThermal();
  }
  applyViewFilter();
}

function stopThermal() {
  clearInterval(thTimer);
  thTimer = null;
  if (thCanvas) { thCanvas.classList.remove('on'); thCtx.clearRect(0, 0, thCanvas.width, thCanvas.height); }
  if (thScale) thScale.classList.add('hidden');
}

/* The feed's own filter is now night vision only — thermal paints its own
   opaque canvas over the feed, so NVG stands aside while it runs. */
function applyViewFilter() {
  feed.classList.remove('nvg');
  if (!thermal && (NV.mode === 'on' || (NV.mode === 'auto' && NV.active))) feed.classList.add('nvg');
}

/* Two-way audio — the viewer's mic is sent over a SECOND PeerJS call
   (PeerJS 1.5.x can't add tracks to a live call), which the phone
   answers and plays on its speaker. TALK is sticky: once armed it
   survives re-links, so a reconnected camera still hears you. */
let micStream = null;  // viewer's talk mic
let talkOn = false;    // user intent — survives teardown/re-link
let talkCall = null;   // viewer→phone audio call
let talkPending = false; // guard against rapid double-clicks

async function toggleTalk() {
  if (talkPending) return;
  talkPending = true;
  try {
    if (!live || !call) return toast('Start the stream before talking', 'warn');
    if (talkOn) {
      stopTalk();
      toast('Talk off', 'info', 1200);
      return;
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      micStream = null;
      return toast('Mic access denied — cannot talk to the phone', 'error');
    }
    const track = micStream.getAudioTracks()[0];
    if (!track) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
      return toast('No microphone found on this PC', 'error');
    }
    talkOn = true;
    setTalkBtn(true);
    dbg('VIEWER', 'talk ON — mic streaming to phone');
    openTalkChannel(call.peer);
  } finally {
    talkPending = false;
  }
}

/* Open (or re-open after a re-link) the talk channel to the current phone. */
function openTalkChannel(phoneId) {
  if (!talkOn || !peer || !live) return;
  closeTalkChannel();
  if (!micStream) return;
  const track = micStream.getAudioTracks()[0];
  if (!track || track.readyState === 'ended') {
    // the previous mic was stopped at teardown — re-acquire for this link
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        // talk may have been toggled off / link torn down while we waited —
        // never orphan a freshly-acquired mic stream
        if (!talkOn || !live) { s.getTracks().forEach((t) => t.stop()); return; }
        micStream = s;
        openTalkChannel(phoneId);
      })
      .catch(() => dbg('VIEWER', 'talk mic re-acquire failed'));
    return;
  }
  try {
    const tc = peer.call(phoneId, micStream, { metadata: { pin: PIN, talk: true } });
    talkCall = tc;
    tc.on('close', () => { if (talkCall === tc) talkCall = null; });
    tc.on('error', (e) => { dbg('VIEWER', 'talk channel error', e && e.type); if (talkCall === tc) talkCall = null; });
    dbg('VIEWER', 'talk channel opened →', phoneId);
  } catch (e) {
    dbg('VIEWER', 'talk channel failed', e && e.message);
  }
}

function closeTalkChannel() {
  if (talkCall) { try { talkCall.close(); } catch { /* ignore */ } }
  talkCall = null;
}

function stopTalk() {
  talkOn = false;
  closeTalkChannel();
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  setTalkBtn(false);
  dbg('VIEWER', 'talk OFF');
}

function setTalkBtn(on) {
  if (btnTalk) {
    btnTalk.classList.toggle('on', on);
    btnTalk.textContent = on ? '◉ TALK ON' : '◉ TALK';
  }
}

/* ---------------------------------------------------------------- */
/*  Init                                                             */
/* ---------------------------------------------------------------- */

async function init() {
  try {
    const info = await (await fetch('/api/info')).json();
    qrImg.src = info.qr;
    phoneUrlEl.textContent = info.phoneUrl;
  } catch { /* fine — QR shown once peer opens */ }

  clockEl.textContent = clockNow();
  setInterval(() => { clockEl.textContent = clockNow(); }, 1000);

  updateReconnectClock(); // seed the countdown from LINK_RELINK_MS (not the HTML)

  peer = new Peer(linkIdStore(), peerOpts());

  peer.on('open', async (id) => {
    peerIdEl.textContent = id;
    pinEl.textContent = PIN;
    // build the phone link from the page's own origin — the API fetch is
    // only used to display it, so this never depends on it succeeding
    connectUrl = `${location.origin}/phone.html?v=${encodeURIComponent(id)}&pin=${PIN}`;
    buildRemoteLink(); // relay mode: QR + link become the internet link
    try {
      await fetch('/api/viewer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, pin: PIN }),
      });
    } catch { /* viewer registry is best-effort */ }
  });

  peer.on('call', onIncomingCall);
  peer.on('error', (err) => {
    dbg('VIEWER', 'peer error', err && err.type);
    if (err && err.type === 'unavailable-id') {
      // a rare genuine collision (e.g. two viewer tabs). The active P2P
      // call survives, but new calls need a fresh id — reload.
      if (!live) {
        toast('Relinking viewer…', 'info', 1500);
        setTimeout(() => location.reload(), 600);
      } else {
        toast('Link id conflict — press RECONNECT after this session', 'warn');
      }
    } else if (err && err.type !== 'peer-unavailable') {
      toast(`Signal: ${err.type}`, 'error');
    }
  });
  peer.on('disconnected', () => {
    // A dropped signaling socket does not break the live P2P media; only
    // reconnect when idle to avoid an 'unavailable-id' self-inflicted kill.
    dbg('VIEWER', 'signaling socket dropped', live ? '(live — media keeps flowing)' : '(reconnecting)');
    if (!live) {
      try { peer.reconnect(); } catch { /* ignore */ }
    }
  });

  btn.unmute.addEventListener('click', enableAudio);
  btn.copy.addEventListener('click', copyLink);
  btn.reconnect.addEventListener('click', () => location.reload());
  btn.snapshot.addEventListener('click', snapshot);
  btn.record.addEventListener('click', toggleRecord);
  btn.pip.addEventListener('click', togglePip);
  btn.fs.addEventListener('click', toggleFullscreen);
  btn.mute.addEventListener('click', toggleMute);
  if (btnNight) btnNight.addEventListener('click', cycleNight);
  if (btnThermal) btnThermal.addEventListener('click', toggleThermal);
  if (btnTalk) btnTalk.addEventListener('click', toggleTalk);
  NV.timer = setInterval(nvTick, 2000);
  nvTick();
  wireMotion();

  if (segQuality) {
    $$('#segQuality button').forEach((b) => b.addEventListener('click', () => setQualityMode(b.dataset.q)));
  }

  // offline/online flips: badge + (in relay mode) link re-render
  let netInited = false;
  onNetChange((off) => {
    if (!IS_RELAY) offlineBadge.hidden = !off;
    if (IS_RELAY) buildRemoteLink(); // handles both states
    if (!netInited) { netInited = true; return; } // silent initial sync
    if (off && !live) toast('Offline — direct LAN link only', 'warn', 2400);
    else if (!off) toast('Back online', 'info', 1400);
  });

  wireDbgToggle();

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 's') snapshot();
    else if (k === 'r') toggleRecord();
    else if (k === 'm') toggleMute();
    else if (k === 'f') toggleFullscreen();
    else if (k === 'p') togglePip();
    else if (k === 'n') setMotionEnabled(!MD.enabled);
    else if (k === 'v') cycleNight();
    else if (k === 'h') toggleThermal();
    else if (k === 't') toggleTalk();
    else if (k === 'g') setQualityMode(AQ.mode === 'stable' ? 'auto' : 'stable');
  });
}

/* ---------------------------------------------------------------- */
/*  Call handling                                                    */
/* ---------------------------------------------------------------- */

function onIncomingCall(c) {
  dbg('VIEWER', 'incoming call from', c.peer);
  if (call) { try { call.close(); } catch { /* ignore */ } }

  if (!(c.metadata && c.metadata.pin && String(c.metadata.pin) === PIN)) {
    dbg('VIEWER', 'rejected — wrong or missing PIN');
    toast('Rejected — wrong or missing PIN from phone', 'error');
    try { c.close(); } catch { /* ignore */ }
    return;
  }

  call = c;
  c.answer();
  dbg('VIEWER', 'answered');
  // quality-command channel to this phone (and drop the previous one)
  if (AQ.dc) { try { AQ.dc.close(); } catch { /* ignore */ } }
  AQ.dc = null;
  AQ.dcOpen = false;
  openDataChannel(c.peer);
  if (AQ.mode !== 'auto') sendQuality(QUALITY_MODES[AQ.mode]); // re-assert manual choice
  if (talkOn) openTalkChannel(c.peer); // a fresh link still hears you
  c.on('stream', attachStream);
  c.on('close', () => {
    dbg('VIEWER', 'call close');
    if (call !== c) return;
    if (live && !intentionalBye) enterReconnecting('link lost'); // phone dropped → buffer
    else teardown();
  });
  c.on('error', (e) => {
    dbg('VIEWER', 'call error', e && e.type);
    if (call !== c) return;
    if (live && !intentionalBye) enterReconnecting('link error');
    else teardown();
  });
  wireIceLog('VIEWER', c);
  watchRemote(c);
  setStatus('LINKED');
}

/* ICE watchdog. 'failed' means the remote is definitively gone → close the
   call so the phone notices and auto-reconnects, but BUFFER (frozen frame +
   overlay) rather than tearing down — the phone re-links in seconds.
   'disconnected' is recoverable: keep the call open and buffer; if ICE
   returns to connected the same call just resumes. */
function watchRemote(c) {
  const pc = c.peerConnection;
  if (!pc) return;
  pc.addEventListener('iceconnectionstatechange', () => {
    const st = pc.iceConnectionState;
    if (st === 'failed') {
      dbg('VIEWER', 'remote gone — ice failed, buffering for re-link');
      enterReconnecting('ice failed', { closeCall: true });
    } else if (st === 'disconnected') {
      dbg('VIEWER', 'remote unreachable — buffering (frozen frame)');
      enterReconnecting('ice disconnected');
    } else if (st === 'connected' || st === 'completed') {
      if (reconnecting) dbg('VIEWER', 'link recovered — resuming');
      exitReconnecting();
    }
  });
}

async function attachStream(stream) {
  dbg('VIEWER', 'stream attached —', `${stream.getVideoTracks().length} video, ${stream.getAudioTracks().length} audio track(s)`);
  const prevStream = remoteStream;
  exitReconnecting(); // fresh feed (or resumed) → drop the overlay
  intentionalBye = false;
  live = true;
  remoteStream = stream;
  waitOverlay.classList.add('hidden');
  feed.srcObject = stream;
  try {
    await feed.play();
    feed.muted = false;
    unmuteCard.classList.add('hidden');
  } catch {
    feed.muted = true;
    unmuteCard.classList.remove('hidden');
  }
  // a recorder still holding the previous (dead) stream must roll onto the
  // new feed so a re-link never leaves a frozen, dead recording segment.
  // Guard on an actual stream change — PeerJS can fire 'stream' twice for
  // one call, which must not discard the freshly restarted recording.
  if (recorder && stream !== prevStream) {
    stopRecord(true, true); // discard the dead segment silently
    startRecording(stream);
    toast('● Recording continued', 'info', 1600);
  }
  const showRes = () => {
    stageHud.textContent = `CAM LINKED · ${feed.videoWidth}×${feed.videoHeight}`;
  };
  feed.onloadedmetadata = () => { showRes(); syncOverlayRect(); };
  if (feed.videoWidth > 0) { showRes(); syncOverlayRect(); } // metadata may already be loaded
  stageHud.classList.add('on');
  recBadge.classList.add('on');
  setStatus('LIVE');
  startStats();
  toast('● LIVE — receiving camera feed', 'info', 2200);
}

function enableAudio() {
  feed.muted = false;
  feed.play().catch(() => { /* ignore */ });
  unmuteCard.classList.add('hidden');
  toast('Audio enabled', 'info', 1500);
}

function teardown() {
  dbg('VIEWER', 'teardown — back to standby');
  live = false;
  // Close the call so the phone notices we're gone and its auto-reconnect
  // re-links — critical when THIS side tore down (reconnect budget) while
  // the phone still thinks the link is live. Safe if the phone already
  // closed (PeerJS close is idempotent).
  if (call) { try { call.close(); } catch { /* ignore */ } }
  call = null;
  remoteStream = null;
  reconnecting = false;
  clearInterval(reconnectTimer);
  reconnectTimer = null;
  callClosedForRelink = false;
  intentionalBye = false;
  if (linkLost) linkLost.classList.add('hidden');
  stallTicks = 0;
  lastFrameTime = 0;
  if (AQ.dc) { try { AQ.dc.close(); } catch { /* ignore */ } }
  AQ.dc = null;
  AQ.dcOpen = false;
  AQ.prev = null;
  AQ.congested = 0;
  AQ.healthy = 0;
  AQ.tier = QUALITY_START_TIER;
  AQ.slow = false;
  if (qualityChip) qualityChip.textContent = `Q ${AQ.mode === 'auto' ? 'AUTO' : AQ.mode.toUpperCase()} · --`;
  if (bwChip) bwChip.textContent = 'BW --';
  stopStats();
  stopRecord(true);
  feed.srcObject = null;
  // close the talk channel and release the mic; talkOn stays armed so a
  // re-linking camera still hears you (the mic is re-requested per link)
  closeTalkChannel();
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  stopThermal(); // halt the live heat renderer + hide its canvas
  feed.classList.remove('nvg');
  thermal = false;
  NV.active = false;
  NV.light = 100;
  if (nvChip) { nvChip.textContent = `☾ ${NV.mode.toUpperCase()}`; nvChip.classList.remove('on'); }
  if (btnNight) btnNight.textContent = `☾ NIGHT ${NV.mode.toUpperCase()}`;
  if (btnThermal) { btnThermal.classList.remove('on'); btnThermal.textContent = '♨ THERMAL'; }
  stageHud.classList.remove('on');
  recBadge.classList.remove('on');
  motionReset();
  unmuteCard.classList.add('hidden');
  waitOverlay.classList.remove('hidden');
  setStatus('STANDBY');
  toast('Camera link lost', 'warn', 2200);
}

function setStatus(s) {
  pill.textContent = s;
  pill.className = `pill ${s.toLowerCase()}`;
}

/* ---------------------------------------------------------------- */
/*  Stats HUD                                                        */
/* ---------------------------------------------------------------- */

function startStats() {
  lastFpsAt = performance.now();
  fpsAcc = 0;
  lastFrameTime = feed.currentTime;
  stallTicks = 0;
  statsTimer = setInterval(sampleStats, 2000);

  if ('requestVideoFrameCallback' in feed) {
    const loop = (now) => {
      fpsAcc += 1;
      if (now - lastFpsAt >= 1000) {
        fpsEl.textContent = `FPS ${fpsAcc}`;
        fpsAcc = 0;
        lastFpsAt = now;
      }
      feed.requestVideoFrameCallback(loop);
    };
    feed.requestVideoFrameCallback(loop);
  }
}

function stopStats() {
  clearInterval(statsTimer);
  rttEl.textContent = 'RTT --';
  fpsEl.textContent = 'FPS --';
}

async function sampleStats() {
  // Frame-stall watchdog: if the feed stops advancing while we're live, the
  // remote has stopped sending (STOP lost over a dead signaling socket, phone
  // killed, network death). Track 'ended' would misfire on camera flips, so
  // use video progress — frames keep flowing through flip track-swaps. On a
  // known-poor link the grace is longer so congestion isn't mistaken for death.
  if (live && lastFrameTime > 0) {
    if (feed.currentTime - lastFrameTime < 0.1) {
      stallTicks += 1;
      if (!reconnecting && stallTicks >= (AQ.slow ? 6 : 3)) { // ~12s / ~6s frozen
        dbg('VIEWER', 'feed stalled — buffering while the link recovers');
        enterReconnecting('feed stalled');
      }
    } else {
      stallTicks = 0;
      lastFrameTime = feed.currentTime;
      if (reconnecting) exitReconnecting(); // frames flowing again → resume
    }
  }
  if (!call || !call.peerConnection) return;
  try {
    const stats = await call.peerConnection.getStats();
    let rttMs = -1;
    let inboundVideo = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        const ms = Math.round(r.currentRoundTripTime * 1000);
        if (ms >= 0) rttMs = ms;
      }
      if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video') && !inboundVideo) {
        inboundVideo = r;
      }
    });
    if (rttMs >= 0) rttEl.textContent = `RTT ${rttMs}ms`;
    if (live) aqTick(inboundVideo, rttMs);
  } catch { /* stats not ready yet */ }
}

/* ---------------------------------------------------------------- */
/*  Motion detection                                                 */
/* ---------------------------------------------------------------- */

const motionOverlay = $('#motionOverlay');
const motionTrack = $('#motionTrack');
const motionBar = $('#motionBar');
const motionChip = $('#motionChip');
const btnMotion = $('#btnMotion');
const btnBeep = $('#btnBeep');
const motionSens = $('#motionSens');
const motionSensVal = $('#motionSensVal');

const MD = {
  enabled: false,
  beep: true,
  sens: 45,
  level: 0,
  motionNow: false,
  smooth: 0,
  prev: null,
  timer: null,
  audio: null,
  remindAt: 0,
  cellsW: 32,
  cellsH: 24,
};

const anCanvas = document.createElement('canvas');
anCanvas.width = MD.cellsW;
anCanvas.height = MD.cellsH;
const anCtx = anCanvas.getContext('2d', { willReadFrequently: true });
const ovCtx = motionOverlay.getContext('2d');

const sensThreshold = () => Math.round(6 + (100 - MD.sens) * 0.5);

/* Rect of the *visible* video content inside the stage (object-fit: contain
   letterboxes non-16:9 feeds) — the overlay is aligned to it, not the stage. */
function videoContentRect() {
  const sr = stage.getBoundingClientRect();
  const vw = feed.videoWidth;
  const vh = feed.videoHeight;
  if (!vw || !vh || !sr.width || !sr.height) return null;
  const scale = Math.min(sr.width / vw, sr.height / vh);
  return {
    left: (sr.width - vw * scale) / 2,
    top: (sr.height - vh * scale) / 2,
    width: vw * scale,
    height: vh * scale,
  };
}

function syncOverlayRect() {
  const r = videoContentRect();
  if (!r) return;
  motionOverlay.style.left = `${r.left}px`;
  motionOverlay.style.top = `${r.top}px`;
  motionOverlay.style.width = `${r.width}px`;
  motionOverlay.style.height = `${r.height}px`;
}

/* Analyse the feed ~8×/s on a 32×24 luminance grid; cells whose brightness
   changed more than the sensitivity threshold are 'moving'. */
function motionTick() {
  if (!MD.enabled || !live) return;
  if (feed.readyState < 2 || feed.paused || !feed.videoWidth) return;
  try {
    anCtx.drawImage(feed, 0, 0, MD.cellsW, MD.cellsH);
    const data = anCtx.getImageData(0, 0, MD.cellsW, MD.cellsH).data;
    const lum = new Uint8ClampedArray(MD.cellsW * MD.cellsH);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      lum[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
    const thr = sensThreshold();
    const mv = new Uint8Array(MD.cellsW * MD.cellsH);
    let moving = 0;
    if (MD.prev) {
      for (let j = 0; j < lum.length; j++) {
        if (Math.abs(lum[j] - MD.prev[j]) > thr) { mv[j] = 1; moving++; }
      }
    }
    MD.prev = lum;
    const raw = (moving / (MD.cellsW * MD.cellsH)) * 100;
    MD.smooth = MD.smooth * 0.6 + raw * 0.4; // dampen single-frame flicker
    MD.level = Math.round(MD.smooth * 10) / 10;

    const was = MD.motionNow;
    MD.motionNow = MD.smooth >= 2; // ~2% of the frame changing = motion
    if (MD.motionNow && !was) {
      dbg('VIEWER', 'MOTION', `detected — ${MD.level}%`);
      motionChip.classList.add('active');
      stage.classList.add('motion');
      if (MD.beep) alertBeep();
      MD.remindAt = Date.now() + 3000;
    } else if (!MD.motionNow && was) {
      dbg('VIEWER', 'motion cleared', `${MD.level}%`);
      motionChip.classList.remove('active');
      stage.classList.remove('motion');
    } else if (MD.motionNow && MD.beep && Date.now() >= MD.remindAt) {
      // keep alerting (quietly) while movement persists — it's a camera
      MD.remindAt = Date.now() + 3000;
      remindBeep();
    }
    drawMotionOverlay(mv, feed.videoWidth, feed.videoHeight);
    updateMotionUI();
  } catch { /* a frame failed to read — skip this tick */ }
}

/* Paint the moving cells as translucent red blocks on the overlay canvas. */
function drawMotionOverlay(mv, vw, vh) {
  if (motionOverlay.width !== vw || motionOverlay.height !== vh) {
    motionOverlay.width = vw;
    motionOverlay.height = vh;
  }
  ovCtx.clearRect(0, 0, vw, vh);
  if (!MD.motionNow) return;
  const cw = vw / MD.cellsW;
  const ch = vh / MD.cellsH;
  ovCtx.fillStyle = 'rgba(255, 59, 92, 0.38)';
  ovCtx.strokeStyle = 'rgba(255, 59, 92, 0.85)';
  ovCtx.lineWidth = 1;
  for (let j = 0; j < mv.length; j++) {
    if (!mv[j]) continue;
    const x = (j % MD.cellsW) * cw;
    const y = ((j / MD.cellsW) | 0) * ch;
    ovCtx.fillRect(x, y, cw, ch);
    ovCtx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
  }
}

function updateMotionUI() {
  motionChip.textContent = !MD.enabled ? 'MOTION OFF' : live ? `MOTION ${MD.level}%` : 'MOTION --';
  const w = Math.min(100, MD.level);
  motionBar.style.width = `${w}%`;
  motionBar.style.background = MD.level > 30 ? 'var(--red)' : MD.level > 10 ? 'var(--amber)' : 'var(--lime)';
}

/* Beeps go through Web Audio (independent of the feed's own mute state). */
function ensureAudio() {
  try {
    if (!MD.audio) MD.audio = new (window.AudioContext || window.webkitAudioContext)();
    if (MD.audio.state === 'suspended') MD.audio.resume();
  } catch { /* audio unavailable */ }
}

function tone(freq, dur, vol = 0.3, when = 0) {
  try {
    ensureAudio();
    const ctx = MD.audio;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch { /* ignore */ }
}

function alertBeep() { tone(1250, 0.14, 0.32); tone(880, 0.2, 0.3, 0.16); }
function remindBeep() { tone(660, 0.12, 0.22); }

function setMotionEnabled(on) {
  MD.enabled = !!on;
  btnMotion.classList.toggle('on', MD.enabled);
  btnMotion.textContent = MD.enabled ? '◈ MOTION ON' : '◈ MOTION';
  motionTrack.classList.toggle('on', MD.enabled);
  if (MD.enabled) {
    ensureAudio(); // unlock the AudioContext inside the click gesture
    if (!MD.timer) MD.timer = setInterval(motionTick, 120);
  } else {
    clearInterval(MD.timer);
    MD.timer = null;
    motionReset();
  }
  dbg('VIEWER', 'motion detection', MD.enabled ? 'enabled' : 'disabled');
}

function motionReset() {
  MD.prev = null;
  MD.smooth = 0;
  MD.level = 0;
  MD.motionNow = false;
  ovCtx.clearRect(0, 0, motionOverlay.width, motionOverlay.height);
  motionChip.classList.remove('active');
  stage.classList.remove('motion');
  updateMotionUI();
}

function wireMotion() {
  btnMotion.addEventListener('click', () => setMotionEnabled(!MD.enabled));
  btnBeep.addEventListener('click', () => {
    MD.beep = !MD.beep;
    btnBeep.textContent = MD.beep ? '♪ BEEP ON' : '♪ BEEP OFF';
    btnBeep.classList.toggle('on', MD.beep);
    ensureAudio();
    dbg('VIEWER', 'motion beep', MD.beep ? 'on' : 'off');
  });
  motionSens.addEventListener('input', () => {
    MD.sens = Number(motionSens.value) || 45;
    motionSensVal.textContent = MD.sens;
    dbg('VIEWER', 'motion sensitivity', MD.sens);
  });
  window.addEventListener('resize', syncOverlayRect);
}

/* test hook — live RTCPeerConnection introspection for e2e diagnostics */
window.__secamCall = {
  get peerConnection() { return call && call.peerConnection; },
};

/* test hook — used by test/e2e.js to drive the adaptive-quality engine */
window.__secamQuality = {
  get mode() { return AQ.mode; },
  get stable() { return AQ.mode === 'stable'; },
  get tier() { return AQ.tier; },
  get slow() { return AQ.slow; },
  get dcOpen() { return AQ.dcOpen; },
  get stall() { return stallTicks; },
  get lastFrame() { return lastFrameTime; },
  get reconnecting() { return reconnecting; },
  setMode: setQualityMode,
  forceCongest: (b) => { AQ.forceCongest = !!b; },
  forceHealth: (b) => { AQ.forceHealth = !!b; },
  sendQuality: (n) => sendQuality(n),
};

/* test hook — night vision + thermal introspection (e2e) */
window.__secamVision = {
  get mode() { return NV.mode; },
  get active() { return NV.active; },
  get thermal() { return thermal; },
  get thRunning() { return !!thTimer; },
  get thDiag() { return thDiag; },
  thRange,
  get light() { return Math.round(NV.light); },
  get feedClass() { return feed.className; },
  cycleNight,
  setNight: setNightMode,
  toggleThermal,
  forceLight: (l) => {
    NV.forceLight = l === null ? null : Math.max(0, Math.min(255, Number(l) || 0));
    if (l !== null) nvTick();
  },
};

/* test hook — talk channel introspection (e2e) */
window.__secamTalk = {
  get on() { return talkOn; },
  get callActive() { return !!(talkCall && talkCall.peerConnection); },
  get audioTracks() {
    return talkCall && talkCall.peerConnection
      ? talkCall.peerConnection.getSenders().filter((s) => s.track && s.track.kind === 'audio').map((s) => s.track.readyState)
      : [];
  },
  toggle: toggleTalk,
};

/* test hook — used by test/e2e.js */
window.__secamMotion = {
  get enabled() { return MD.enabled; },
  get level() { return MD.level; },
  get motionNow() { return MD.motionNow; },
  setEnabled: setMotionEnabled,
  setBeep: (b) => { MD.beep = !!b; },
  setSens: (s) => { MD.sens = Math.max(1, Math.min(100, Number(s) || 45)); },
};

/* ---------------------------------------------------------------- */
/*  Dock controls                                                    */
/* ---------------------------------------------------------------- */

function snapshot() {
  if (feed.readyState < 2 && !(thermal && thCanvas && thCanvas.width > 4)) return toast('No frame available yet', 'warn');
  const c = document.createElement('canvas');
  c.width = feed.videoWidth;
  c.height = feed.videoHeight;
  const ctx = c.getContext('2d');
  if (thermal && thCanvas && thCanvas.width > 4) {
    // capture the live heat map, not the raw feed
    ctx.drawImage(thCanvas, 0, 0, c.width, c.height);
  } else {
    // preserve the active night-vision mode in the capture
    const flt = getComputedStyle(feed).filter;
    if (flt && flt !== 'none') ctx.filter = flt;
    ctx.drawImage(feed, 0, 0);
  }
  c.toBlob((b) => {
    if (b) {
      downloadBlob(b, `sec-cam-snap-${stamp()}.png`);
      toast('Snapshot saved', 'info', 1600);
    }
  }, 'image/png');
}

function pickMime() {
  const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return opts.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function toggleRecord() {
  if (!live || !remoteStream) return toast('No live feed to record', 'warn');
  if (typeof MediaRecorder === 'undefined') return toast('Recording not supported in this browser', 'error');

  if (recorder) {
    recorder.stop();
    return;
  }

  startRecording(remoteStream);
  toast('● Recording started', 'info', 1600);
}

function startRecording(stream) {
  const mime = pickMime();
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: (recorder && recorder.mimeType) || 'video/webm' });
    downloadBlob(blob, `sec-cam-${stamp()}.webm`);
    recorder = null;
    setRecordBtn(false);
    toast('Recording saved', 'info', 2000);
  };
  recorder.start(1000);
  setRecordBtn(true);
}

function setRecordBtn(on) {
  btn.record.classList.toggle('on', on);
  btn.record.textContent = on ? '■ STOP REC' : '● RECORD';
}

function stopRecord(silent, quiet) {
  if (recorder) {
    recorder.onstop = null; // suppress the auto-download when discarding
    try { recorder.stop(); } catch { /* ignore */ }
    recorder = null;
    recChunks = [];
    setRecordBtn(false);
    if (silent && !quiet) toast('Recording discarded', 'warn', 1500);
  }
}

function togglePip() {
  const ready = feed.readyState >= 2 || (thermal && thCanvas && thCanvas.width > 4);
  if (!live || !ready) return toast('No live feed yet', 'warn');
  if (!document.pictureInPictureEnabled) return toast('Picture-in-picture not supported', 'error');
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => { /* ignore */ });
  } else {
    // thermal paints an overlay canvas, not the feed element — PiP the heat
    // map itself so the PiP window matches the stage
    const src = thermal && thCanvas && thCanvas.width > 4 ? thCanvas : feed;
    src.requestPictureInPicture().catch(() => toast('PiP failed', 'error'));
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => { /* ignore */ });
  } else {
    stage.requestFullscreen().catch(() => toast('Fullscreen blocked', 'error'));
  }
}

function toggleMute() {
  feed.muted = !feed.muted;
  btn.mute.classList.toggle('on', feed.muted);
  toast(feed.muted ? 'Audio muted' : 'Audio unmuted', 'info', 1200);
}

async function copyLink() {
  const target = IS_RELAY ? (phoneUrlEl.dataset.remote === '1' ? phoneUrlEl.textContent : null) : connectUrl;
  if (!target || !/^https?:\/\//.test(target)) return toast('Link not ready yet', 'warn');
  try {
    await navigator.clipboard.writeText(target);
    toast(IS_RELAY ? 'Remote link copied — works from anywhere' : 'Link copied — send it to your phone', 'info', 2000);
  } catch {
    toast('Copy failed', 'error');
  }
}

/* ---------------------------------------------------------------- */

init();
