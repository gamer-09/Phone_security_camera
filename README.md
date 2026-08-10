# SEC-CAM 📷 — Phone Security Camera

Turn your **phone** into a security camera: your phone captures **video + audio** and streams it straight to your **PC**, where you watch and listen live over your local network.

- 🎥 **Zero-config setup** — the PC viewer shows a QR code; scan it with your phone's camera app and tap **GO LIVE**.
- ⚡ **WebRTC** — media flows directly phone → PC. Low latency, and it never leaves your network (no cloud, no accounts).
- 🔐 **PIN-gated** — the phone must present the 4-digit PIN shown on the viewer, so only you can watch.
- 🔄 **Auto-reconnect** — if the live link drops, the phone retries GO LIVE on its own with a capped backoff (and shows a RECONNECTING status) until it's back up, so a Wi-Fi blip doesn't take the camera down. If the PC itself is unreachable it switches to **WAITING** mode and keeps trying until the PC returns.
- 🚨 **Motion detection** — the viewer highlights moving regions on the feed in red and can beep when something changes, with a sensitivity slider and a live activity meter.
- 🌍 **Internet relay** — serve the pages from a public URL (e.g. a Cloudflare quick tunnel) and the app auto-switches to relay mode: the QR/link becomes an internet link and video can flow through a free TURN relay when direct P2P fails, so you can watch from anywhere.
- 📶 **Offline-ready** — a service worker caches the whole app, so the phone page opens with **zero connectivity** and waits for the PC; when offline, external STUN/TURN is skipped so LAN links connect instantly (no internet needed).
- ⏳ **Dropout buffering** — when the signal dips, the viewer **freezes the last frame** under a “SIGNAL LOST — RECONNECTING” countdown instead of dropping to standby, while the phone's auto-reconnect re-links; a new call resumes seamlessly (and an active recording rolls onto the new feed).
- 📉 **Adaptive quality** — on poor links the viewer measures loss/jitter/latency/bandwidth every 2s and automatically steps the stream down (1080p → 240p, bitrate-capped) to keep it watchable, then steps back up when the link recovers. Manual **QUALITY** control: AUTO / ECO / MED / HD.
- 📼 **Built-in recorder** — record the feed to `.webm`, grab snapshots, PiP, fullscreen.
- 🖥️ **Neon surveillance HUD** — scanlines, radar, corner brackets, live RTT/FPS telemetry, battery + torch controls on the phone unit.

---

## Quick start

```bash
npm install
npm start
```

You'll see the LAN URLs and a QR code in the terminal.

1. **On your PC**: open `https://<your-lan-ip>:3443/viewer.html` (or click the link in the terminal).
2. **On your phone**: scan the QR code shown on the viewer page with your phone's camera app. It opens the *phone unit* page.
3. Tap through the one-time **certificate warning** (see below).
4. Tap **● GO LIVE** on the phone. The PC viewer unlocks and shows the feed. 🎉

> Both devices must be on the **same Wi-Fi network**. Streaming is peer-to-peer between them.

---

## Why the certificate warning? (read this — it's important)

Browsers only allow camera/mic access on **secure (HTTPS) pages**. To let your phone use its camera without renting a domain + cert, the server generates a **self-signed certificate** on first run and serves HTTPS on the LAN.

The first time your phone opens the page, Chrome/Safari will show "Your connection is not private". That's expected — the cert is self-signed, but the traffic is still encrypted. Tap:

- **Chrome (Android)**: *Advanced → Proceed to <ip>:3443*
- **Safari (iPhone)**: *Show Details → visit this website → Visit Website*

After that the camera works and the phone can bookmark the page. Nothing is sent to the internet.

## Localhost testing (no phone / no cert warning)

The camera API also works on plain `http://localhost`, so for quick testing:

```bash
npm start -- --http     # serves http://localhost:3000
```

Useful if you want to test the viewer/phone UI in a desktop browser with your webcam.

### Simulated camera (test the whole chain from one PC)

Open the phone unit with `?fake=1` and it generates a simulated camera feed
(animated test pattern + tone) — no phone or camera permission needed:

```text
http://localhost:3000/phone.html?fake=1
```

Open the viewer in one tab and the fake phone in another, then GO LIVE. Great
for checking your firewall and the full WebRTC flow before involving a phone.

### Automated end-to-end test

With the server running, verify the whole call flow (connect → 60s stability →
stop → re-live) headlessly:

```bash
npm run test:e2e
```

This launches headless Chrome (requires Google Chrome installed), opens the
viewer + a simulated phone, connects them over real WebRTC and reports PASS/FAIL
for every stage, including that the link survives a 60-second idle wait without
dropping. The pages are loaded with `?nostun=1` so the localhost test doesn't
depend on external STUN servers; the suite also verifies relay-mode plumbing
(TURN configured, internet link built, relay call establishes), the adaptive
quality engine (manual tiers, forced-congestion downgrade + recovery), and
offline mode (no external ICE, badges, WAITING pill, service-worker cache).

---

## Watch from anywhere (internet relay)

Normally the phone and PC connect over your Wi-Fi. To view the feed from **outside** your home network, expose the app with a free Cloudflare quick tunnel (no account needed):

1. **Install cloudflared** — `winget install cloudflare/cloudflared` (Windows), `brew install cloudflared` (macOS), or download from developers.cloudflare.com/cloudflared.
2. **Start the server** — `npm start -- --http` (it listens on `http://localhost:3000`).
3. **Open the tunnel** — `cloudflared tunnel --url http://localhost:3000`

   You get an HTTPS URL like `https://something-random.trycloudflare.com`.
4. **Open the viewer** there: `https://something-random.trycloudflare.com/viewer.html` — a pulsing **RELAY** badge appears, and the QR/link on the page now encodes the *internet* link.
5. **Scan the QR (or send the link) to your phone** — it works from anywhere with internet. Hit GO LIVE as usual.

> The home PC must stay on (and the tunnel running) for this to work. Quick-tunnel URLs change on every restart — for a permanent address, upgrade to a named tunnel with your own domain.

**How the relay works:** the pages + signaling still come from your own server (through the tunnel). The *media* is the part that can't always cross NATs peer-to-peer, so relay mode adds a free **TURN relay** (`openrelay.metered.ca` — free tier, ~20 GB/month) that forwards video/audio when direct P2P fails. Direct P2P is always tried first.

- **Use your own TURN?** Edit `relayIceServers()` in `public/js/common.js` and put in your provider's host/username/credential.
- **Verify TURN from your network:** `node test/turn-probe.js` opens a headless browser and reports whether relay candidates are actually obtained (handy if the feed connects but shows black/frozen from outside — it usually means TURN is unreachable from your network).
- **No server at all?** You can host just the `public/` folder on any static HTTPS host (e.g. Netlify Drop) and open the pages with `?cloud=1` — that switches signaling to PeerJS's free public cloud (`0.peerjs.com`). The auto-link registry won't exist, so open the phone page via the exact link the viewer shows (it already contains the viewer ID + PIN).
- **Privacy:** the link contains your 4-digit PIN — anyone who has it can watch while the camera is live. When P2P is impossible, media passes through the TURN provider's servers (encrypted by WebRTC).

## Offline & poor connections

### No internet? Still works.

The app is **fully LAN-capable with zero internet**: on load (or the moment your
connection drops) it detects it's offline, skips external STUN/TURN (which would
otherwise stall ICE for ~30s waiting for timeouts), and connects with instant
host-only candidates. A red **OFFLINE** badge appears on both pages.

Bonus: a **service worker** caches the entire app shell the first time you open
the pages. If your phone is later somewhere with no connectivity at all, the
camera page still opens from cache, and pressing GO LIVE puts it in **WAITING**
mode — it quietly retries every 15s and **auto-links the moment the PC comes
back** (it also remembers the last viewer, so it knows where to connect). The PC
viewer page caches too, so it opens while the server is still starting.

- Force offline mode for testing: `?offline=1` (e.g. `…/phone.html?fake=1&offline=1`).
- To push an app update past the cache, bump `CACHE` in `public/sw.js` (e.g. to `secam-v2`).
- Offline + relay: the internet link can't work without internet, so the viewer
  falls back to showing the LAN link until you're back online.

### Weak connection? The stream adapts.

A security camera shouldn't freeze or die when your Wi-Fi or mobile data gets
shaky — so the viewer runs an **adaptive quality engine**. Every 2 seconds it
reads the WebRTC stats (packet loss, jitter, round-trip time, received bitrate)
and, when the link is struggling, tells the phone to step down one of five
quality tiers — each a capture resolution + encoder **bitrate cap** (applied
without renegotiation, so there's no freeze-frame during the switch):

| Tier | Size | FPS | Bitrate cap |
|---|---|---|---|
| ECO | 240p | 12 | 120 kbps |
| SD | 360p | 15 | 250 kbps |
| MED | 480p | 18 | 500 kbps |
| HD | 720p | 24 | 1.1 Mbps |
| (auto-only) | 1080p | 24 | 2.5 Mbps |

When the link recovers it steps back up. You can override the engine with the
**QUALITY** control in the viewer dock: **AUTO** (recommended), **ECO** (max
battery/data savings), **MED**, or **HD**. The phone shows its current tier in
the `Q` chip; the viewer shows `Q AUTO · SD 480p` and a live **BW** chip
(bandwidth + loss %). The frame-stall watchdog also gives a known-poor link
extra grace so a congestion hiccup isn't mistaken for a dead camera.

### A brief dropout doesn't kill the view

When the signal drops, the viewer **buffers instead of tearing down**: the
last frame stays frozen on screen under a **SIGNAL LOST — RECONNECTING**
overlay with a countdown. The call is kept open for ~12s in case ICE
re-establishes on its own; if not, the viewer closes it so the phone notices
and its auto-reconnect re-links — and the moment a new call arrives the feed
resumes and the overlay clears. If the phone is genuinely gone (off, out of
range), the viewer falls back to STANDBY after ~45s. Pressing **STOP** on the
phone tells the viewer *not* to buffer (via a quick data-channel signal), so
an intentional stop still goes straight to standby. If you're recording during
a dropout, the recording rolls onto the re-linked feed automatically.

## How it works

```
┌──────────────┐   HTTPS + QR + registry   ┌──────────────┐
│   PC viewer  │ ◄────────────────────────► │ phone unit   │
│ /viewer.html │                            │ /phone.html  │
└──────┬───────┘                            └──────┬───────┘
       │          WebRTC (PeerJS, direct P2P)      │
       └────────────── video + audio ──────────────┘
```

- `server.js` — Express + a **self-hosted PeerJS signaling server** (port 3443). Signaling is only used for the initial handshake; the media goes directly between devices.
- The viewer registers its link id + PIN; the phone auto-picks them up (`/api/viewer`).
- The phone is the WebRTC **caller** (it has the camera), the PC viewer is the **callee** and validates the PIN from the call metadata.

## Controls

| Phone unit | Viewer |
|---|---|
| ⇄ flip camera · ⌁ torch · ◉ mic mute | ▣ snapshot · ● record · ⧉ PiP · ⛶ fullscreen · mute |
| CAM / MIC device pickers · Q quality chip | ◈ motion detect · ♪ beep · SENS slider · QUALITY AUTO/ECO/MED/HD |
| RES: 480p / 720p / 1080p (capture ceiling) | live telemetry: resolution, FPS, RTT, BW + loss, Q tier |
| offline badge · WAITING mode | OFFLINE badge · SW-cached app shell |

## Motion detection

Hit **◈ MOTION** in the viewer dock (or press `N`) to arm the detector. It compares
successive feed frames on a low-res grid and paints the moving regions as red
blocks over the video, plus:

- **BEEP** — a two-tone alert sounds the moment movement starts, then a quiet
  reminder every ~3s while it continues (toggle with **♪ BEEP**; the tone plays
  through your PC speakers even if the feed's own audio is muted).
- **SENS** slider — lower = more sensitive (1 catches almost anything, 100 only
  large brightness changes).
- **MOTION chip + activity bar** — the top-bar chip flashes and a level bar at
  the bottom of the stage shows how much of the frame is moving.
- The detector runs entirely in the viewer's browser — nothing leaves your PC.

## Troubleshooting

- **"Camera API unavailable"** on the phone → the page must be opened over **HTTPS** (or `localhost`). Make sure you opened the `https://…` URL and tapped through the warning.
- **"Viewer not found"** → both devices on the same network, viewer page still open, and the VIEWER ID field matches the one on the PC screen (it auto-fills when you open via QR).
- **No video but audio works / camera black** → your PC firewall may be blocking the peer connection; allow Node.js through, or try the 480p resolution.
- **Port in use** → set another port: `PORT=4443 npm start`.
- **Wrong PIN toast on viewer** → the phone must type the exact 4-digit PIN shown on the viewer screen.
- **Feed connects, then drops again** → the phone now **auto-reconnects**: when a live link drops it retries GO LIVE itself (watch the pill turn RECONNECTING; up to 10 attempts with growing delays, ~3 minutes). If it gives up, the viewer page may be closed — reopen it and the next retry... otherwise press GO LIVE once the viewer is back. For real drop causes, open the **LOG** drawer (bottom-right of either page) and look for `ice` / `rtc` / `call close` lines. Keep the phone tab foregrounded and the screen awake (wake lock is requested while live); if the phone's Wi-Fi drops, the media dies with it until the network returns.
- **Connect is slow / "finally connects"** → if the phone can't reach Google's STUN server, ICE gathering waits for timeouts (~10s). Both devices on the same Wi-Fi usually connect fine without it; you can point `iceServers` at your router if needed. If you're offline (or on a LAN with no internet), the app now detects it and skips STUN entirely — instant host-only connection.
- **Phone shows WAITING** → the PC/server isn't reachable right now (offline phone, PC asleep). The camera retries every 15s and auto-links when the PC comes back; press GO LIVE to retry immediately.
- **Viewer shows SIGNAL LOST / RECONNECTING** → a network blip dropped the link; the viewer is holding the last frame and waiting for the phone to re-link automatically (up to ~45s). If it stays like that, the phone is really gone — it will drop to STANDBY and pick up again when the phone returns.
- **Viewer stays LIVE after STOP on the phone** → the phone's signaling socket can silently drop (idle, iOS backgrounding), so its STOP message is lost. The viewer now auto-detects a vanished link via ICE within ~8s and drops to STANDBY on its own — the phone's auto-reconnect will re-link when you GO LIVE again.

## Roadmap ideas

- Record directly to disk on the PC server
- Multiple camera units on one viewer
- Night-vision (brightness/gain boost) toggle
