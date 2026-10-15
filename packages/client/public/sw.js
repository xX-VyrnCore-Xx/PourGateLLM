// Minimal service worker so browsers offer "Install app". It deliberately caches nothing: the dashboard talks to a live
// gateway and must never show stale keys, usage or tokens.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
