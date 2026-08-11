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
const nvChip = $('#nvChip');
const talkChip = $('#talkChip');
const segNight = $('#segNight');
const talkUnlock = $('#talkUnlock');

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
    // near-black scene — the sim is a "night" feed, so the viewer's
    // night-vision AUTO mode has a real dark scene to react to
    ctx.fillStyle = '#020408';
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
  torchUnsupported = false; // a fresh camera gets a fresh chance at the torch
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
  torchUnsupported = false; // the other camera may have a flash this one lacked
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

/* Set the torch to on/off. silent=true suppresses the 'not supported' toast
   (used by the auto-torch follower — it should never nag while tracking the
   light level). Returns whether the camera accepted the constraint. */
async function setTorch(on, silent = false) {
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    torchOn = on;
    torchUnsupported = false;
    setTorchBtn();
    return true;
  } catch {
    torchUnsupported = true; // any failure (on OR off) means no reliable torch
    if (!silent) toast('Torch not supported on this camera', 'warn');
    setTorchBtn();
    return false;
  }
}

async function toggleTorch() {
  if (!stream) return;
  torchAuto = false;
  torchManual = true; // manual control overrides the auto behaviour
  await setTorch(!torchOn, false);
}

/* Follow the night-vision state with the flashlight. Runs after every NV
   tick: dark (or forced ON) → torch on; light returns → torch back off.
   Never fights a torch the user set by hand. */
async function syncAutoTorch() {
  if (!NV.torch) { NV.torchIntent = null; return; }
  const wantOn = NV.mode === 'on' || (NV.mode === 'auto' && NV.active);
  NV.torchIntent = wantOn ? 'on' : 'off';
  if (FAKE_MODE) return; // the sim camera has no real flash
  if (wantOn) {
    // torchManual: the user set the torch by hand — never fight their choice
    if (torchOn || torchAuto || torchUnsupported || torchManual) return;
    torchAuto = true;
    if (!(await setTorch(true, true))) { torchAuto = false; torchUnsupported = true; }
  } else {
    if (torchAuto) { torchAuto = false; await setTorch(false, true); }
    torchManual = false; // light returned — the next dark cycle may auto-arm again
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
  peer.on('call', handleIncomingCall); // the viewer's talk (mic) channel

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
  if (talkCall) { try { talkCall.close(); } catch { /* ignore */ } }
  talkCall = null;
  stopTalkPlayback();
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
  // night vision + talkback introspection (e2e)
  get nv() { return { mode: NV.mode, active: video.classList.contains('nvg'), light: Math.round(NV.light), torchIntent: NV.torchIntent }; },
  setNight(m) { setNightMode(m); },
  forceLight(l) { NV.forceLight = l === null ? null : Math.max(0, Math.min(255, Number(l) || 0)); if (l !== null) nvTick(); },
  get torch() { return torchOn; },
  get torchAuto() { return torchAuto; },
  setAutoTorch(b) {
    NV.torch = !!b;
    try { localStorage.setItem('secam_auto_torch', NV.torch ? '1' : '0'); } catch { /* ignore */ }
    NV.torchIntent = null;
    if (!NV.torch && torchAuto) { torchAuto = false; setTorch(false, true); }
    const btnAutoTorch = $('#btnAutoTorch');
    if (btnAutoTorch) btnAutoTorch.classList.toggle('on', NV.torch);
    syncAutoTorch();
  },
  // e2e: simulate the torch being lit (the sim camera has no real LED) so
  // the torch-hold hysteresis can be exercised
  debugSimTorch(b) {
    torchAuto = !!b;
    torchOn = !!b;
    torchManual = false;
    setTorchBtn();
    if (!b) NV.brightStreak = 0;
  },
  get talkActive() {
    return !!(talkStream && talkAudio && talkAudio.srcObject &&
      talkAudio.srcObject.getAudioTracks().some((t) => t.readyState === 'live'));
  },
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
/*  Night vision — watch the camera's own luminance and engage the   */
/*  phosphor-green filter on the local preview when it gets dark.    */
/*  The canvas read is pre-filter, so the brightened NVG image can   */
/*  never feed back into the sensor and flicker.                     */
/* ---------------------------------------------------------------- */

const NV = {
  mode: 'auto',       // 'auto' | 'on' | 'off'
  active: false,
  light: 100,         // last measured mean luminance (0–255)
  timer: null,
  forceLight: null,   // test hook — override the measured light
  // AUTO TORCH: fire the flashlight whenever night vision is on, so the
  // camera has REAL light to capture (software gain can only amplify what
  // the sensor records — in total darkness that's nothing). Default on;
  // remembered across sessions.
  torch: (() => { try { return localStorage.getItem('secam_auto_torch') !== '0'; } catch { return true; } })(),
  torchIntent: null,  // last auto-torch decision — 'on' | 'off' | null (e2e + diagnostics)
  brightStreak: 0,    // consecutive samples that look "too bright"
  probeCooldown: 0,   // until when the ambient probe is paused (after a dark result)
};

let torchAuto = false;        // is the torch currently on because NV turned it on?
let torchUnsupported = false; // this camera has no flash — don't retry every tick
let torchManual = false;      // the user set the torch by hand — auto never fights it

/* Torch-hold hysteresis. Once the auto-torch is on, the light reading is
   dominated by the torch's own glow — a naive "too bright → off" test
   would disengage night vision the moment the torch fires, the room goes
   dark, NVG re-engages, the torch fires again… an endless flicker loop.
   Instead: a torch-lit reading must stay FAR above ambient-dark for
   several samples, and even then we PROBE the true ambient light with the
   torch briefly off before trusting it. The probe only triggers on
   readings that really look like daylight, so the torch never blinks in a
   normal dark room. */
const NVG_HOLD_LVL = 95;          // torch-lit readings above this look "bright"
const NVG_HOLD_STREAK = 3;        // …and must stay there this many samples (2s each)
const NVG_PROBE_MS = 1400;        // torch-off time for the probe (exposure settle)
const NVG_PROBE_COOLDOWN = 60000; // after a "still dark" probe, pause probing for 1 min

const nvCanvas = document.createElement('canvas');
nvCanvas.width = 8;
nvCanvas.height = 6;
const nvCtx = nvCanvas.getContext('2d', { willReadFrequently: true });

async function measureLight() {
  if (NV.forceLight !== null) return NV.forceLight;
  // The sim is a dark "night" scene by design, so report a dark level
  // directly. (Headless Chrome's canvas.captureStream glitches the LOCAL
  // preview/track frames to teal under SwiftShader — the encoder path used
  // by the viewer is correct — so reading the sim canvas is unreliable.)
  if (FAKE_MODE) return 12;
  // Try ImageCapture first — reads the raw frame from the camera track,
  // bypassing any rendering glitches in the preview video element (e.g.
  // Chrome's canvas.captureStream producing teal frames in headless).
  const track = stream && stream.getVideoTracks()[0];
  if (track && typeof ImageCapture !== 'undefined') {
    try {
      const cap = new ImageCapture(track);
      const frame = await cap.grabFrame();
      nvCtx.drawImage(frame, 0, 0, 8, 6);
      frame.close();
      const d = nvCtx.getImageData(0, 0, 8, 6).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      return sum / 48;
    } catch { /* fall through to the preview */ }
  }
  // Fallback: sample the preview video element directly
  if (!video || video.readyState < 2 || !video.videoWidth) return NV.light;
  try {
    nvCtx.drawImage(video, 0, 0, 8, 6);
    const d = nvCtx.getImageData(0, 0, 8, 6).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    return sum / 48;
  } catch { return NV.light; }
}

async function nvTick() {
  NV.light = await measureLight();
  if (NV.mode === 'auto') {
    if (torchAuto) {
      // Torch-lit: the reading is dominated by the torch's own glow — hold
      // night vision on unless the brightness persists well above ambient
      // dark for several samples, and even then probe the true ambient.
      if (NV.active && NV.light > NVG_HOLD_LVL) {
        if (NV.probeCooldown > Date.now()) {
          NV.brightStreak = 0; // a recent probe said the room is genuinely dark — stop counting
        } else {
          NV.brightStreak += 1;
          if (NV.brightStreak >= NVG_HOLD_STREAK) {
            NV.brightStreak = 0;
            const ambient = await probeAmbient();
            if (ambient > NVG_OFF_LVL) NV.active = false;                  // real daylight
            else NV.probeCooldown = Date.now() + NVG_PROBE_COOLDOWN;        // torch was faking it
          }
        }
      } else {
        NV.brightStreak = 0;
        if (!NV.active && NV.light < NVG_ON_LVL) NV.active = true;
      }
    } else if (NV.active && NV.light > NVG_OFF_LVL) {
      NV.active = false; // no torch involved — plain instant hysteresis
    } else if (!NV.active && NV.light < NVG_ON_LVL) {
      NV.active = true;
    }
  }
  applyNightVision();
}

/* Briefly kill the torch to read the room's TRUE ambient brightness (the
   torch itself lights the frame, so its glow can't be trusted as daylight).
   The brief blink only happens when the reading really looks bright — see
   NVG_HOLD_LVL above. If the torch can't be turned off the reading is
   meaningless — assume the room is still dark and keep night vision lit
   (safe direction). In FAKE_MODE the sim torch always "fails" but the
   forceLight hook drives the read instead. */
async function probeAmbient() {
  const hadTorch = torchOn;
  const offOk = await setTorch(false, true);
  await new Promise((r) => setTimeout(r, NVG_PROBE_MS));
  const ambient = !offOk && !FAKE_MODE ? NVG_ON_LVL - 1 : await measureLight();
  if (hadTorch) await setTorch(true, true);
  dbg('PHONE', 'torch probe — ambient', Math.round(ambient), hadTorch ? '(torch was on)' : '(torch was off)');
  return ambient;
}

function applyNightVision() {
  const on = NV.mode === 'on' || (NV.mode === 'auto' && NV.active);
  video.classList.toggle('nvg', on);
  if (nvChip) {
    nvChip.textContent = `☾ ${NV.mode.toUpperCase()}`;
    nvChip.classList.toggle('on', on);
  }
  if (segNight) {
    $$('#segNight button').forEach((b) => b.classList.toggle('on', b.dataset.nv === NV.mode));
  }
  syncAutoTorch(); // dark + night vision on → flashlight on (if available)
}

function setNightMode(m) {
  if (!['auto', 'on', 'off'].includes(m)) return;
  NV.mode = m;
  NV.brightStreak = 0; // a mode switch never inherits a half-counted streak
  if (m === 'on') NV.active = true;
  else if (m === 'off') NV.active = false;
  applyNightVision();
  dbg('PHONE', 'night vision →', m.toUpperCase());
}

/* ---------------------------------------------------------------- */
/*  Two-way audio — the viewer opens a second PeerJS call carrying   */
/*  its microphone; we answer it and play it through this phone's    */
/*  speaker (walkie-talkie style).                                   */
/* ---------------------------------------------------------------- */

let talkCall = null;   // the viewer→phone audio call
let talkAudio = null;  // <audio> element for the viewer's voice
let talkStream = null;

function handleIncomingCall(c) {
  const md = c.metadata || {};
  const phonePin = pinInput.value.trim() || new URLSearchParams(location.search).get('pin') || '';
  // defense-in-depth: never accept a talk call without a known PIN
  if (!md.talk || !phonePin || String(md.pin) !== String(phonePin)) {
    dbg('PHONE', 'rejected incoming call', md.talk ? 'wrong pin' : 'not a talk call');
    try { c.close(); } catch { /* ignore */ }
    return;
  }
  dbg('PHONE', 'viewer talk channel — answering');
  if (talkCall) { try { talkCall.close(); } catch { /* ignore */ } }
  talkCall = c;
  c.answer();
  c.on('stream', (s) => playTalk(s));
  c.on('close', () => { if (talkCall === c) { talkCall = null; stopTalkPlayback(); } });
  c.on('error', (e) => { dbg('PHONE', 'talk channel error', e && e.type); if (talkCall === c) talkCall = null; });
}

function playTalk(s) {
  // detach the previous track's ended handler — a stale 'ended' from a
  // replaced talk channel must not kill the current playback
  if (talkStream) {
    const oldTrack = talkStream.getAudioTracks()[0];
    if (oldTrack) oldTrack.removeEventListener('ended', stopTalkPlayback);
  }
  talkStream = s;
  dbg('PHONE', 'viewer is speaking — playing on speaker');
  if (!talkAudio) {
    talkAudio = new Audio();
    talkAudio.autoplay = true;
    talkAudio.setAttribute('playsinline', '');
    document.body.appendChild(talkAudio);
  }
  talkAudio.srcObject = s;
  setTalkUI(true);
  const p = talkAudio.play();
  if (p && p.catch) p.catch(() => { if (talkUnlock) talkUnlock.classList.remove('hidden'); });
  const t = s.getAudioTracks()[0];
  // named reference (not an anonymous wrapper) so the next playTalk() can
  // removeEventListener it when the channel is replaced
  if (t) t.addEventListener('ended', stopTalkPlayback);
}

function stopTalkPlayback() {
  if (talkAudio) {
    try { talkAudio.pause(); } catch { /* ignore */ }
    talkAudio.srcObject = null;
  }
  setTalkUI(false);
}

function setTalkUI(on) {
  if (talkChip) {
    talkChip.textContent = on ? 'TALK ●' : 'TALK --';
    talkChip.classList.toggle('on', on);
  }
  if (!on && talkUnlock) talkUnlock.classList.add('hidden');
  if (on) toast('🔊 Viewer is speaking through this phone', 'info', 2000);
}

/* ---------------------------------------------------------------- */
/*  Boot                                                             */
/* ---------------------------------------------------------------- */

async function init() {
  buildResSeg();
  wireDbgToggle();
  if (segNight) {
    $$('#segNight button').forEach((b) => b.addEventListener('click', () => setNightMode(b.dataset.nv)));
  }
  const btnAutoTorch = $('#btnAutoTorch');
  const renderAutoTorchBtn = () => {
    if (!btnAutoTorch) return;
    btnAutoTorch.classList.toggle('on', NV.torch);
    btnAutoTorch.textContent = NV.torch ? '⌁ AUTO TORCH' : '⌁ MANUAL TORCH';
  };
  if (btnAutoTorch) {
    btnAutoTorch.addEventListener('click', () => {
      NV.torch = !NV.torch;
      try { localStorage.setItem('secam_auto_torch', NV.torch ? '1' : '0'); } catch { /* ignore */ }
      NV.torchIntent = null;
      // disabling must not leave an auto-lit torch stuck on
      if (!NV.torch && torchAuto) { torchAuto = false; setTorch(false, true); }
      renderAutoTorchBtn();
      syncAutoTorch();
      toast(NV.torch ? 'Auto torch ON — flashlight fires when it gets dark' : 'Auto torch OFF', 'info', 1600);
    });
  }
  renderAutoTorchBtn();
  if (talkUnlock) {
    talkUnlock.addEventListener('click', () => {
      talkUnlock.classList.add('hidden');
      if (talkAudio && talkAudio.srcObject) talkAudio.play().catch(() => { /* still blocked */ });
    });
  }
  NV.timer = setInterval(() => nvTick(), 2000);
  nvTick();
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
  nvTick(); // sample the real light level once the camera is live
}

init();
