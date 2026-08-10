/* SEC-CAM — offline service worker
 * --------------------------------
 * Caches the entire app shell so the phone unit (and the viewer) open even
 * with NO connectivity at all. The pages then wait in "WAITING" mode and
 * auto-link the moment the PC server comes back on the network — useful when
 * the phone is offline or the PC is briefly unreachable.
 *
 * Bump CACHE below (e.g. 'secam-v2') to force a refresh after an update.
 */

'use strict';

const CACHE = 'secam-v1';
const ASSETS = [
  '/',
  '/viewer.html',
  '/phone.html',
  '/css/style.css',
  '/js/common.js',
  '/js/viewer.js',
  '/js/phone.js',
  '/vendor/peerjs.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // cache-first for app-shell assets (query strings are fine — the page's
  // JS reads location.search at runtime); everything else (API calls, …)
  // goes straight to the network.
  if (!ASSETS.includes(url.pathname)) return;
  e.respondWith(
    caches.match(url.pathname).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname, clone));
        }
        return res;
      });
    })
  );
});
