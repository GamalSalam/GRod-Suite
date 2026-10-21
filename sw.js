/* GRod Suite service worker: network-first for pages, cache-first for assets.
 * Bump CACHE_VERSION on every deploy. Add the other tools' files to PRECACHE
 * when they join (grod.html, gbtorque.html, rodbook.html, their GRSrc / GbtSrc / RbkSrc files). */
const CACHE_VERSION = 'grod-suite-v1.5.1';
const PRECACHE = [
    // main app (root)
    './', 'index.html', 'grod.html', 'gbtorque.html', 'rodbook.html', 'manifest.json',
    'shared/common.css', 'shared/license.js',
    'icon.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon.png',
    // GRod
    'GRSrc/icon.png', 'GRSrc/title.jpg', 'GRSrc/data.json',
    // GBTorque
    'GbtSrc/icon.png', 'GbtSrc/favicon.png', 'GbtSrc/header-logo.png', 'GbtSrc/company-logo.png',
    'GbtSrc/four-bar-linkage.png', 'GbtSrc/units_pro.json',
    // RodBook
    'RbkSrc/icon.png', 'RbkSrc/rods.json', 'RbkSrc/tubing.json', 'RbkSrc/surface-unit.json', 'RbkSrc/tac.json',
    'RbkSrc/seating-nipple.json', 'RbkSrc/fishing-tools.json', 'RbkSrc/pumpSetting-depth.json'
];

self.addEventListener('install', function (e) {
    e.waitUntil(caches.open(CACHE_VERSION).then(function (c) {
        // Missing optional files must not break the install.
        return Promise.all(PRECACHE.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
    e.waitUntil(caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE_VERSION; })
            .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;          // Worker/API calls are never cached

    const isPage = req.mode === 'navigate' || /\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith('/');
    if (isPage) {
        e.respondWith(fetch(req).then(function (r) {
            if (r.ok) { const copy = r.clone(); caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); }); }
            return r;
        }).catch(function () {
            return caches.match(req, { ignoreSearch: true }).then(function (m) { return m || caches.match('index.html'); });
        }));
        return;
    }
    // Images and other static files: show the cached copy at once, refresh it in the background.
    e.respondWith(caches.match(req).then(function (m) {
        var net = fetch(req).then(function (r) {
            if (r.ok) { const copy = r.clone(); caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); }); }
            return r;
        });
        if (m) { net.catch(function () {}); return m; }
        return net;
    }));
});
