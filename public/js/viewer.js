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
    dc.on('open', () => { AQ.dcOpen = true; dbg('VIEWER', 'quality channel open'); });
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
    toast(`Quality → ${QUALITY_TIERS[tier].label}`, 'info', 1500);
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
  } else if (healthy && AQ.healthy >= AQ_HEALTH_STREAK && since >= AQ_COOLDOWN && AQ.tier < QUALITY_TIERS.length - 1) {
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
  if (qualityChip) qualityChip.textContent = 'Q AUTO · --';
  if (bwChip) bwChip.textContent = 'BW --';
  stopStats();
  stopRecord(true);
  feed.srcObject = null;
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
  if (feed.readyState < 2) return toast('No frame available yet', 'warn');
  const c = document.createElement('canvas');
  c.width = feed.videoWidth;
  c.height = feed.videoHeight;
  c.getContext('2d').drawImage(feed, 0, 0);
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
  if (!live || feed.readyState < 2) return toast('No live feed yet', 'warn');
  if (!document.pictureInPictureEnabled) return toast('Picture-in-picture not supported', 'error');
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => { /* ignore */ });
  } else {
    feed.requestPictureInPicture().catch(() => toast('PiP failed', 'error'));
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
