/**
 * sw.js — Rod Pump Field Handbook offline support.
 *
 * Strategy: network-first, cache-fallback, cache-as-you-go.
 *   - Online:  every request goes to the network first. A successful
 *              response is saved to the cache, replacing whatever was
 *              there before (this is the "auto-update when online" part).
 *   - Offline: if the network request fails, the last cached copy is
 *              served instead so the app keeps working with no signal.
 *
 * Bump CACHE_VERSION whenever you want to force all old cached files
 * to be dropped on the next load (not required for normal JSON edits —
 * those are picked up automatically the next time the user is online).
 */

var CACHE_VERSION = 'rodbook-cache-v1';

var CORE_ASSETS = [
  './',
  './index.html',
  './rods.json',
  './tubing.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache){
      // Add what we can; don't let one missing optional file block install.
      return Promise.all(
        CORE_ASSETS.map(function(url){
          return cache.add(url).catch(function(){ /* optional file not present yet — fine */ });
        })
      );
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_VERSION; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.method !== 'GET') return;
  // Only handle same-origin requests (our HTML/JSON files).
  if(new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req, { cache: 'no-store' }).then(function(res){
      if(res && res.ok){
        var resClone = res.clone();
        caches.open(CACHE_VERSION).then(function(cache){ cache.put(req, resClone); });
      }
      return res;
    }).catch(function(){
      return caches.match(req).then(function(cached){
        return cached || caches.match('./index.html');
      });
    })
  );
});
