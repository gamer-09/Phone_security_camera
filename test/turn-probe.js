#!/usr/bin/env node
/**
 * turn-probe.js — empirically verify a free TURN server actually yields
 * relay candidates from a browser (the relay piece of "watch from anywhere").
 *
 * Usage:  node test/turn-probe.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEBUG_PORT = 9300 + Math.floor(Math.random() * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return 'chrome';
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'secam-turn-'));
  const chrome = spawn(findChrome(), [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--ignore-certificate-errors',
    '--remote-allow-origins=*', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let ver;
    for (let i = 0; i < 40; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; } catch { await sleep(400); }
    }
    if (!ver) throw new Error('DevTools did not come up');

    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let idc = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++idc; pending.set(id, { res, rej });
      ws.send(JSON.stringify(sessionId ? { id, sessionId, method, params } : { id, method, params }));
    });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const sess = (method, params = {}) => send(method, params, sessionId);

    const results = await sess('Runtime.evaluate', {
      awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const results = {};
        const CONFIGS = {
          'A turn:openrelay.metered.ca:80/443 (openrelayproject)': [
            { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'], username: 'openrelayproject', credential: 'openrelayproject' }
          ],
          'B stun:openrelay.metered.ca:80 (sanity)': [
            { urls: 'stun:openrelay.metered.ca:80' }
          ],
          'C turn:openrelay.metered.ca:80 only': [
            { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
          ]
        };
        for (const [name, iceServers] of Object.entries(CONFIGS)) {
          const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
          const cands = [];
          pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.candidate); };
          const st = new Promise((res) => pc.oniceconnectionstatechange = () => res(pc.iceConnectionState));
          pc.createDataChannel('probe');
          await pc.createOffer().then((o) => pc.setLocalDescription(o));
          await new Promise((r) => setTimeout(r, 12000));
          const relay = cands.filter((c) => c.includes(' typ relay'));
          results[name] = { relayCandidates: relay.length, sample: relay.slice(0, 2), state: pc.iceConnectionState };
          try { pc.close(); } catch {}
        }
        return results;
      })()`,
    });

    console.log(JSON.stringify(results.result.value, null, 2));
    ws.close();
  } finally {
    try { chrome.kill(); } catch {}
    if (process.platform === 'win32') {
      try { require('child_process').execSync(`taskkill /F /T /PID ${chrome.pid} 2>nul`); } catch {}
    }
  }
}

main().catch((e) => { console.error('probe error:', e.message); process.exit(1); });
