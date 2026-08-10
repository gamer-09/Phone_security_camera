/* SEC-CAM — phone camera unit */
'use strict';

const video = $('#preview');
const statusPill = $('#statusPill');
const onAirEl = $('#onAir');
const clockEl = $('#clock');
const batEl = $('#bat');
const selCam = $('#selCam');
const selMic = $('#selMic');
const segRes = $('#segRes');
const viewerIdInput = $('#viewerId');
const pinInput = $('#pin');
const btnFlip = $('#btnFlip');
const btnTorch = $('#btnTorch');
const btnMic = $('#btnMic');
const btnLive = $('#btnLive');
const qChip = $('#qChip');
const offlineBadge = $('#offlineBadge');

const RES_OPTS = [
  { label: 'SD 480p', w: 854, h: 480 },
  { label: 'HD 720p', w: 1280, h: 720 },
  { label: 'FHD 1080p', w: 1920, h: 1080 },
];

// ?fake=1 → simulated camera (canvas + oscillator) so the whole chain can
// be tested from a single PC without a phone: phone.html?fake=1
const FAKE_MODE = new URLSearchParams(location.search).has('fake');

/* Adaptive quality — the viewer's engine tells us which tier to use over a
   PeerJS data channel; we apply it here as an encoder bitrate cap (no
   renegotiation needed) plus capture constraints where the browser allows. */
let AQ = {
  tier: QUALITY_START_TIER,
  applied: QUALITY_START_TIER,
  lastBitrate: QUALITY_TIERS[QUALITY_START_TIER].bitrate,
  dc: null,
  reportTimer: null,
};

let cams = [];
let mics = [];
let camIndex = -1;
let micIndex = -1;
let resIndex = 1;
let faceMode = 'environment'; // fallback for platforms that list a single camera (iOS Safari)

let stream = null;
let peer = null;
let call = null;
let live = false;
let liveStart = 0;
let timerId = null;
let torchOn = false;
let micOn = true;
let wakeLock = null;
let intentionalClose = false;
let reconnectTried = false;

// Auto-reconnect state: when a live link drops unexpectedly the phone
// retries GO LIVE on its own with a capped backoff.
const RECONNECT_DELAYS = [3000, 4000, 6000, 9000, 13000, 18000, 24000, 30000, 30000, 30000];
let reconnectAttempts = 0;
let reconnectTimer = null;
let connectTimer = null;
let testReconnectDelay = null; // e2e hook — widens the viewer's RECONNECTING window

// WAITING mode: when the PC server itself is unreachable (offline phone,
// PC asleep, no internet), keep retrying on a steady cadence instead of
// burning the capped backoff — a security camera should auto-link the
// moment the PC comes back.
const WAIT_INTERVAL = 15000;

function isServerUnreachable(type) {
  return ['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable'].includes(type);
}

function scheduleWait(reason) {
  if (live || intentionalClose) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  setStatus('WAITING');
  dbg('PHONE', 'PC unreachable — waiting', `retry every ${WAIT_INTERVAL / 1000}s`, `(${reason})`);
  toast('PC unreachable — will auto-link when it returns', 'warn', 2600);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    goLive({ auto: true });
  }, WAIT_INTERVAL);
}

/* ---------------------------------------------------------------- */
/*  Media                                                            */
/* ---------------------------------------------------------------- */

function buildFakeStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(24);
  let t = 0;
  const draw = () => {
    t += 1;
    ctx.fillStyle = '#071018';
    ctx.fillRect(0, 0, 640, 360);
    ctx.strokeStyle = 'rgba(0,229,255,.55)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= 640; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 360); ctx.stroke(); }
    for (let y = 0; y <= 360; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(640, y); ctx.stroke(); }
    const bx = (t * 6) % 640;
    const by = 180 + Math.sin(t / 10) * 120;
    ctx.fillStyle = '#8dff5e';
    ctx.beginPath();
    ctx.arc(bx, by, 14, 0, Math.PI * 2);
    ctx.fill();
    // a wide translucent band sweeps across — makes the sim feed clearly
    // "motiony" so the viewer's motion detector has real movement to find
    ctx.fillStyle = 'rgba(141, 255, 94, 0.22)';
    ctx.fillRect(((t * 3) % 760) - 60, 0, 60, 360);
    ctx.fillStyle = '#8dff5e';
    ctx.font = '20px monospace';
    ctx.fillText('SIM CAM — SEC-CAM', 16, 32);
    ctx.fillText(clockNow(), 16, 58);
  };
  draw();
  // interval (not requestAnimationFrame): rAF is fully paused in backgrounded
  // tabs, which would freeze the sim feed and stall the viewer's watchdog
  setInterval(draw, 33); // ~30fps foreground, clamped to ~1fps when hidden
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const dest = ac.createMediaStreamDestination();
    osc.frequency.value = 440;
    gain.gain.value = 0.02;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  } catch { /* audio optional in sim mode */ }
  return stream;
}

async function buildStream() {
  if (FAKE_MODE) return buildFakeStream();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera API unavailable — open this page over HTTPS (tap through the certificate warning).');
  }
  const res = RES_OPTS[resIndex];
  const audioC = mics[micIndex] ? { deviceId: { exact: mics[micIndex].deviceId } } : true;
  const base = { width: { ideal: res.w }, height: { ideal: res.h } };

  // Two+ cameras known (Android): pick the exact device. Single camera
  // (iOS Safari, desktop, or enumeration not ready yet): pick by facingMode.
  const multiCam = cams.length > 1 && !!cams[camIndex];
  if (multiCam) {
    faceMode = /front|user/i.test(cams[camIndex].label || '') ? 'user' : 'environment';
  }

  // Try in order: on Android the exact deviceId is authoritative; on a
  // single-camera device facingMode is authoritative (iOS flips the
  // physical camera behind one logical device). Never combine deviceId
  // with a conflicting facingMode — getUserMedia would throw
  // OverconstrainedError.
  const tries = multiCam
    ? [{ ...base, deviceId: { exact: cams[camIndex].deviceId } }, { ...base, facingMode: faceMode }]
    : [{ ...base, facingMode: faceMode }, ...(cams[camIndex] ? [{ ...base, deviceId: { exact: cams[camIndex].deviceId } }] : [])];

  let lastErr;
  for (const videoC of tries) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoC, audio: audioC });
      const at = s.getAudioTracks()[0];
      if (at) at.enabled = micOn;
      return s;
    } catch (err) {
      lastErr = err;
      dbg('PHONE', 'camera attempt failed', err.name, videoC.deviceId ? 'deviceId' : 'facingMode');
    }
  }
  throw lastErr || new Error('Could not access camera/mic');
}

async function acquire() {
  if (stream) return stream;
  try {
    stream = await buildStream();
  } catch (err) {
    toast(err.message || 'Could not access camera/mic', 'error');
    throw err;
  }
  video.srcObject = stream;
  return stream;
}

async function listDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    cams = devs.filter((d) => d.kind === 'videoinput');
    mics = devs.filter((d) => d.kind === 'audioinput');

    if (camIndex === -1) camIndex = cams.length > 1 ? 1 : 0; // prefer rear camera
    if (micIndex === -1) micIndex = 0;

    selCam.innerHTML = '';
    cams.forEach((c, i) => selCam.appendChild(el('option', { value: i, text: c.label || `Camera ${i + 1}` })));
    selCam.selectedIndex = Math.max(0, camIndex);

    selMic.innerHTML = '';
    mics.forEach((m, i) => selMic.appendChild(el('option', { value: i, text: m.label || `Mic ${i + 1}` })));
    selMic.selectedIndex = Math.max(0, micIndex);
  } catch {
    toast('Could not list camera/mic devices', 'warn');
  }
}

async function swapStream(opts = {}) {
  const prev = { camIndex, faceMode };
  const cameraChange = !!opts.cameraChange;

  // Camera switches release the current camera BEFORE opening the other
  // one — many Android devices share a single camera resource, so requesting
  // the front camera while the back stream is still held fails (the
  // asymmetric back→front bug). Mic/resolution changes don't touch the
  // camera, so the old stream stays alive until the new one is ready.
  const old = stream;
  if (cameraChange) {
    stream = null;
    if (old) old.getTracks().forEach((t) => t.stop());
  }

  let newStream;
  try {
    newStream = await buildStream();
  } catch (err) {
    if (!cameraChange && old) {
      // non-camera swap failed — keep the current feed as-is
      dbg('PHONE', 'stream swap failed — keeping current feed', err.name);
      throw err;
    }
    // camera switch failed — put the previous camera back
    dbg('PHONE', 'camera switch failed — restoring previous camera');
    camIndex = prev.camIndex;
    faceMode = prev.faceMode;
    selCam.selectedIndex = Math.max(0, camIndex);
    try {
      newStream = await buildStream();
    } catch {
      throw err;
    }
  }

  // hot-swap tracks on a live call so the viewer never loses the link
  if (call && call.peerConnection) {
    const senders = call.peerConnection.getSenders();
    const vt = newStream.getVideoTracks()[0];
    const at = newStream.getAudioTracks()[0];
    await Promise.all(
      senders.map((s) => {
        const nt = !s.track ? null : s.track.kind === 'video' ? vt : at;
        return nt ? s.replaceTrack(nt) : null;
      })
    );
  }

  stream = newStream;
  video.srcObject = newStream;
  if (!cameraChange && old) old.getTracks().forEach((t) => t.stop());
}

async function flip() {
  if (!cams.length) return;
  let label;
  if (cams.length > 1) {
    camIndex = (camIndex + 1) % cams.length;
    label = cams[camIndex].label || `Camera ${camIndex + 1}`;
  } else {
    // iOS Safari lists a single camera — toggle facingMode instead
    faceMode = faceMode === 'environment' ? 'user' : 'environment';
    label = faceMode === 'user' ? 'front' : 'rear';
  }
  torchOn = false;
  setTorchBtn();
  dbg('PHONE', 'flip →', label, `cam#${camIndex}`);
  try {
    await swapStream({ cameraChange: true });
    selCam.selectedIndex = Math.max(0, camIndex); // sync after a successful swap
    toast(`Camera → ${label}`, 'info', 1400);
  } catch {
    toast('Camera switch failed', 'error');
  }
}

async function toggleTorch() {
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return;
  torchOn = !torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    setTorchBtn();
  } catch {
    torchOn = !torchOn;
    toast('Torch not supported on this camera', 'warn');
  }
}

function toggleMic() {
  micOn = !micOn;
  const t = stream && stream.getAudioTracks()[0];
  if (t) t.enabled = micOn;
  btnMic.classList.toggle('off', !micOn);
  toast(micOn ? 'Mic ON' : 'Mic MUTED', micOn ? 'info' : 'warn', 1400);
}

/* ---------------------------------------------------------------- */
/*  Streaming                                                        */
/* ---------------------------------------------------------------- */

function resolveViewerId() {
  const fromUrl = new URLSearchParams(location.search).get('v');
  if (fromUrl) return fromUrl;
  const typed = viewerIdInput.value.trim();
  if (typed) return typed;
  // a previously linked viewer survives offline restarts — so a phone that
  // was connected before can wait for the PC and re-link on its own
  try { return localStorage.getItem('secam_target'); } catch { return null; }
}

/* Apply a quality tier: cap the video sender's bitrate (setParameters is
   non-negotiating, so it works mid-call) and, where supported, ask the
   camera for matching capture constraints. The canvas sim camera ignores
   constraints — the bitrate cap still applies. */
async function applyTier(n) {
  n = Math.max(0, Math.min(QUALITY_TIERS.length - 1, Number(n) | 0));
  AQ.tier = n;
  const t = QUALITY_TIERS[n];
  const pc = call && call.peerConnection;
  const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (sender) {
    try {
      const p = sender.getParameters();
      if (p.encodings && p.encodings.length) {
        p.encodings[0].maxBitrate = t.bitrate;
        await sender.setParameters(p);
        AQ.lastBitrate = t.bitrate;
        AQ.applied = n;
      }
    } catch (e) {
      dbg('PHONE', 'setParameters failed', e && e.name);
    }
  }
  const track = stream && stream.getVideoTracks()[0];
  if (track && !FAKE_MODE) {
    try {
      await track.applyConstraints({
        width: { ideal: t.w },
        height: { ideal: t.h },
        frameRate: { ideal: t.fps },
      });
    } catch { /* camera refuses — bitrate cap still applies */ }
  }
  if (qChip) qChip.textContent = `Q ${t.label}`;
  dbg('PHONE', 'quality →', t.label, `cap ${(t.bitrate / 1000) | 0} kbps`);
  sendQualityReport();
}

/* Periodic quality tick: re-sync any pending tier (e.g. after a camera
   swap reset the sender's params), then report what we're encoding. */
function qualityTick() {
  if (AQ.tier !== AQ.applied && call) applyTier(AQ.tier);
  sendQualityReport();
}

/* Tell the viewer what we're actually encoding (tier, capture size, cap). */
function sendQualityReport() {
  if (!AQ.dc || AQ.dc.open !== true) return;
  const track = stream && stream.getVideoTracks()[0];
  const s = track ? track.getSettings() : {};
  const t = QUALITY_TIERS[AQ.applied] || QUALITY_TIERS[0];
  try {
    AQ.dc.send({
      t: 'r',
      tier: AQ.applied,
      label: t.label,
      w: s.width || 0,
      h: s.height || 0,
      fps: Math.round(s.frameRate || 0),
      kbps: Math.round((AQ.lastBitrate || 0) / 1000),
    });
  } catch { /* channel closing */ }
}

/* The viewer opens a data channel to us after the call; it carries quality
   commands ("use tier 2") and we stream status reports back. */
function onDataConn(dc) {
  AQ.dc = dc;
  dc.on('open', () => {
    dbg('PHONE', 'quality channel open');
    sendQualityReport();
  });
  dc.on('data', (d) => {
    let m = d;
    if (typeof d === 'string') { try { m = JSON.parse(d); } catch { return; } }
    if (m && m.t === 'q') applyTier(m.v);
  });
  dc.on('close', () => { if (AQ.dc === dc) AQ.dc = null; });
  dc.on('error', (e) => dbg('PHONE', 'quality channel error', e && e.type));
}

async function fetchLatestViewer() {
  try {
    const data = await (await fetch('/api/viewer')).json();
    if (data.id) {
      viewerIdInput.value = data.id;
      viewerIdInput.dataset.auto = '1';
      if (data.pin) {
        pinInput.value = data.pin;
        pinInput.dataset.auto = '1';
      }
    }
  } catch {
    /* server not reachable — rely on manual entry */
  }
}

async function goLive(opts = {}) {
  if (live) return;
  const auto = !!opts.auto;
  if (!auto) reconnectAttempts = 0; // a manual press starts a fresh retry budget
  clearTimeout(reconnectTimer);     // cancel any pending auto-retry
  reconnectTimer = null;

  if (viewerIdInput.dataset.auto) {
    viewerIdInput.value = '';
    pinInput.value = '';
  }
  await fetchLatestViewer();
  const targetId = resolveViewerId();
  const pin = pinInput.value.trim() || new URLSearchParams(location.search).get('pin') || '';

  if (!targetId) {
    if (auto) {
      // nothing to link to — the viewer page isn't announcing itself
      dbg('PHONE', 'auto-reconnect: no viewer linked — going to standby');
      setStatus('STANDBY');
      return;
    }
    toast('No viewer linked — open the viewer on your PC first', 'warn');
    return;
  }

  try {
    await acquire();
  } catch (err) {
    dbg('PHONE', 'media unavailable', err && err.message);
    if (auto) scheduleReconnect('Camera unavailable'); // keep the retry budget going
    else setStatus('STANDBY');
    return;
  }

  setStatus('CONNECTING');
  cleanupPeerOnly();
  clearTimeout(connectTimer); // don't let a stale attempt's timer fire mid-flight

  // 45s: ICE can legitimately take a while on slow cellular / TURN setups
  // (and this timer must never outrun a slow-but-working negotiation)
  connectTimer = setTimeout(() => {
    if (!live) {
      dbg('PHONE', 'no response from viewer after 45s');
      cleanup();
      scheduleReconnect('No response from viewer');
    }
  }, 45000);

  intentionalClose = false;
  reconnectTried = false;
  // Fresh id on every session — the viewer is the only one that needs a
  // stable id, so the phone can never collide with a stale registration.
  const myId = `pcam-${Math.random().toString(36).slice(2, 8)}`;
  dbg('PHONE', 'peer id', myId);
  peer = new Peer(myId, peerOpts());

  peer.on('connection', onDataConn); // quality-command channel from the viewer

  peer.on('open', (id) => {
    dbg('PHONE', 'open — calling', targetId);
    call = peer.call(targetId, stream, { metadata: { pin } });
    call.on('stream', () => onLinked());
    call.on('close', () => {
      const wasLive = live;
      const wasIntentional = intentionalClose;
      dbg('PHONE', 'call close', wasIntentional ? '(intentional)' : '(unexpected)');
      cleanup();
      if (wasIntentional) { setStatus('STANDBY'); return; }
      if (wasLive) {
        scheduleReconnect('Link lost');
      } else {
        setStatus('STANDBY');
        toast('Link rejected — check the PIN on your PC', 'warn');
      }
    });
    call.on('error', (e) => {
      dbg('PHONE', 'call error', e && e.type);
      const wasLive = live;
      cleanup();
      if (wasLive) scheduleReconnect('Link error');
      else { setStatus('STANDBY'); toast('Link error — press GO LIVE again', 'error'); }
    });
    // The viewer answers with an empty stream, so PeerJS never fires
    // 'stream' on the caller — ICE 'connected' is the reliable 'we are
    // live' signal (call.on('stream') above is kept as a safety net).
    wireIceLog('PHONE', call, () => onLinked());
  });

  peer.on('error', (err) => {
    clearTimeout(connectTimer);
    dbg('PHONE', 'peer error', err && err.type);
    const wasLive = live;
    cleanup();
    if (wasLive) {
      scheduleReconnect('Signal error');
      return;
    }
    if (isServerUnreachable(err && err.type)) {
      // no server at all (offline / PC off) — wait indefinitely instead of
      // burning the capped reconnect budget; the camera auto-links the
      // moment the PC comes back
      scheduleWait(err && err.type);
      return;
    }
    scheduleReconnect(err && err.type === 'peer-unavailable' ? 'Viewer not found' : 'Signal error');
  });

  peer.on('disconnected', () => {
    // A dropped signaling socket does NOT affect the P2P media once the
    // call is live — reconnecting with the same id while the server still
    // holds the old socket causes 'unavailable-id', which would kill the
    // active call. So: reconnect only when idle.
    dbg('PHONE', 'signaling socket dropped', live ? '(live — media keeps flowing)' : '(reconnecting)');
    if (!live && !reconnectTried) {
      reconnectTried = true;
      try { peer.reconnect(); } catch { /* ignore */ }
    }
  });

  function onLinked() {
    clearTimeout(connectTimer);
    reconnectAttempts = 0; // link is up again — fresh retry budget next time
    // remember the viewer so an offline restart can wait and re-link
    try { localStorage.setItem('secam_target', targetId); } catch { /* ignore */ }
    dbg('PHONE', 'LINKED — on air');
    setLive(true);
    setStatus('LIVE');
    lockWake();
    AQ.reportTimer = setInterval(qualityTick, 5000);
    sendQualityReport();
    toast('● ON AIR — streaming to viewer', 'info', 2000);
  }
}

/* Schedule an automatic GO LIVE after an unexpected drop. Capped backoff;
   gives up after RECONNECT_DELAYS.length attempts so the phone isn't
   burning battery forever against a dead viewer. */
function scheduleReconnect(reason) {
  if (live) return;
  if (intentionalClose) return; // user pressed STOP — never fight them
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (reconnectAttempts >= RECONNECT_DELAYS.length) {
    dbg('PHONE', 'auto-reconnect gave up after', reconnectAttempts, 'attempts');
    setStatus('STANDBY');
    toast('Auto-reconnect stopped — press GO LIVE to retry', 'warn');
    return;
  }
  const delay = testReconnectDelay !== null ? testReconnectDelay : RECONNECT_DELAYS[reconnectAttempts];
  reconnectAttempts += 1;
  setStatus('RECONNECTING');
  dbg('PHONE', 'auto-reconnect', `attempt ${reconnectAttempts}/${RECONNECT_DELAYS.length}`, `in ${delay}ms`, `(${reason})`);
  toast(`${reason} — retrying in ${Math.round(delay / 1000)}s`, 'warn', 2200);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    goLive({ auto: true });
  }, delay);
}

function cleanupPeerOnly() {
  try { if (call) call.close(); } catch { /* ignore */ }
  try { if (peer) peer.destroy(); } catch { /* ignore */ }
  call = null;
  peer = null;
  clearTimeout(connectTimer);
}

function stopLive() {
  intentionalClose = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  // tell the viewer this is an intentional STOP (not a dropout) so it skips
  // the reconnect buffering and goes straight to STANDBY. Best-effort: if
  // the signaling socket is down, the viewer's own watchdogs (ICE + stall)
  // still catch up via the buffering budget.
  if (AQ.dc && AQ.dc.open) {
    try { AQ.dc.send({ t: 'bye' }); } catch { /* ignore */ }
  }
  try {
    const sk = peer && peer.socket;
    dbg('PHONE', 'STOP — signaling socket', sk && sk.isOpen ? 'open' : sk && sk.disconnected ? 'down' : 'unknown');
  } catch { /* diagnostic only */ }
  cleanup();
  setStatus('STANDBY');
}

function cleanup() {
  try { if (call) call.close(); } catch { /* ignore */ }
  try { if (peer) peer.destroy(); } catch { /* ignore */ }
  call = null;
  peer = null;
  AQ.dc = null; // peer.destroy() closes the quality channel with the peer
  clearInterval(AQ.reportTimer);
  AQ.reportTimer = null;
  setLive(false);
  releaseWake();
}

/* minimal debug/test hook — used by test/e2e.js to simulate a drop */
window.__secam = {
  get live() { return live; },
  killCall() {
    if (call) { try { call.close(); } catch { /* ignore */ } }
  },
  // adaptive quality introspection + simulation (e2e)
  get quality() {
    return {
      tier: AQ.tier,
      applied: AQ.applied,
      label: QUALITY_TIERS[AQ.tier].label,
      maxBitrate: AQ.lastBitrate,
      dcOpen: !!(AQ.dc && AQ.dc.open),
    };
  },
  sendQuality(n) { applyTier(n); },
  forceWaiting() { if (!live) { scheduleWait('test'); return statusPill.textContent; } return null; },
  cancelReconnect() { clearTimeout(reconnectTimer); reconnectTimer = null; setStatus('STANDBY'); },
  setReconnectDelay(ms) { testReconnectDelay = ms === null ? null : Math.max(0, Number(ms) || 0); },
};

function setLive(on) {
  live = on;
  btnLive.classList.toggle('on', on);
  btnLive.innerHTML = on ? '■ STOP' : '● GO LIVE';
  if (on) {
    liveStart = Date.now();
    timerId = setInterval(() => { onAirEl.textContent = secElapsed(liveStart); }, 1000);
  } else {
    clearInterval(timerId);
    onAirEl.textContent = '00:00';
  }
}

async function lockWake() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not supported */ }
}

function releaseWake() {
  if (wakeLock) { try { wakeLock.release(); } catch { /* ignore */ } wakeLock = null; }
}

function setStatus(s) {
  statusPill.textContent = s;
  statusPill.className = `status-pill ${s.toLowerCase()}`;
  btnLive.disabled = s === 'CONNECTING';
}

/* ---------------------------------------------------------------- */
/*  UI plumbing                                                      */
/* ---------------------------------------------------------------- */

function setTorchBtn() {
  btnTorch.classList.toggle('on', torchOn);
}

function buildResSeg() {
  segRes.innerHTML = '';
  RES_OPTS.forEach((r, i) => {
    const b = el('button', { class: i === resIndex ? 'on' : '', type: 'button', text: r.label });
    b.addEventListener('click', async () => {
      resIndex = i;
      $$('#segRes button').forEach((x, j) => x.classList.toggle('on', j === i));
      if (stream) {
        try { await swapStream(); } catch { toast('Resolution change failed', 'error'); }
      }
    });
    segRes.appendChild(b);
  });
}

async function batteryLoop() {
  if (!navigator.getBattery) {
    batEl.textContent = '◈ --%';
    return;
  }
  try {
    const bat = await navigator.getBattery();
    const render = () => {
      const pct = Math.round(bat.level * 100);
      batEl.textContent = `◈ ${pct}%`;
      batEl.classList.toggle('low', bat.level < 0.2);
    };
    render();
    bat.addEventListener('levelchange', render);
  } catch { /* ignore */ }
}

document.addEventListener('visibilitychange', () => {
  if (live && document.visibilityState === 'visible') lockWake();
});

/* ---------------------------------------------------------------- */
/*  Boot                                                             */
/* ---------------------------------------------------------------- */

async function init() {
  buildResSeg();
  wireDbgToggle();
  const simBadge = document.getElementById('simBadge');
  if (simBadge) simBadge.hidden = !FAKE_MODE;
  const relayBadge = document.getElementById('relayBadge');
  if (relayBadge) relayBadge.hidden = !IS_RELAY;
  if (IS_RELAY) {
    dbg('PHONE', 'RELAY MODE — internet link (media may relay via TURN)');
  }
  if (offlineBadge) {
    let netInited = false;
    onNetChange((off) => {
      offlineBadge.hidden = !off;
      if (netInited) toast(off ? 'Offline — camera waits for the PC to return' : 'Back online', off ? 'warn' : 'info', 2400);
      netInited = true;
    });
  }

  const params = new URLSearchParams(location.search);
  const v = params.get('v');
  const p = params.get('pin');
  if (v) { viewerIdInput.value = v; viewerIdInput.dataset.auto = '1'; }
  if (p) { pinInput.value = p; pinInput.dataset.auto = '1'; }

  btnFlip.addEventListener('click', flip);
  btnTorch.addEventListener('click', toggleTorch);
  btnMic.addEventListener('click', toggleMic);
  btnLive.addEventListener('click', () => {
    // pressing GO LIVE cancels any pending auto-retry and goes now
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    live ? stopLive() : goLive({ auto: false });
  });

  selCam.addEventListener('change', () => {
    camIndex = Number(selCam.value) || 0;
    torchOn = false;
    setTorchBtn();
    if (stream) swapStream({ cameraChange: true }).catch(() => toast('Camera switch failed', 'error'));
  });
  selMic.addEventListener('change', () => {
    micIndex = Number(selMic.value) || 0;
    if (stream) swapStream().catch(() => toast('Mic switch failed', 'error'));
  });

  clockEl.textContent = clockNow();
  setInterval(() => { clockEl.textContent = clockNow(); }, 1000);

  batteryLoop();
  await fetchLatestViewer(); // show the active PC viewer on load, if any

  // start the camera preview right away (asks for permission once)
  try {
    await acquire();
    if (!FAKE_MODE) await listDevices();
  } catch {
    /* permission denied or no camera — user can retry via GO LIVE */
  }
}

init();
