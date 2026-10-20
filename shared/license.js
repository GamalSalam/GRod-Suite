/* GRod Suite shared license module (Phase 1)
 * API: GLicense.activate(key) · refresh() · status() · require(app) · pack() · clear() · key()
 * Token = base64url(payload) + "." + base64url(ES256 signature, raw r||s).
 * Verified offline with the public key below. The private key lives only in the Worker.
 */
(function (root) {
    'use strict';

    var DAY = 86400000;
    var FREE_APPS = { rodbook: true };
    var STORE_KEY = 'grod.license.v1';

    var CFG = {
        workerUrl: 'https://gearbox-calculator-api.gamal-salama86.workers.dev',
        // Paste the PUBLIC key printed by worker/gen-keys.mjs (x and y only).
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'Tf4wc7rGNq3MsYx5kaEoBCmKucGZXCzojWcIfxpY1Wc', y: 'pXJI30AixhInFhPe18oeOcLwnvuZr3KDncQUokr_t5I' },
        homeUrl: 'index.html',
        helpUrl: 'index.html#help',
        refreshAfterDays: 3,
        // Test hooks (null in production)
        store: null, fetch: null, now: null
    };

    var mem = {};
    function defaultStore() {
        return {
            get: function (k) { try { return root.localStorage.getItem(k); } catch (e) { return mem[k] || null; } },
            set: function (k, v) { try { root.localStorage.setItem(k, v); } catch (e) { mem[k] = v; } },
            remove: function (k) { try { root.localStorage.removeItem(k); } catch (e) { delete mem[k]; } }
        };
    }
    function store() { return CFG.store || (CFG.store = defaultStore()); }
    function now() { return CFG.now ? CFG.now() : Date.now(); }
    function doFetch(url, opts) {
        var f = CFG.fetch || root.fetch.bind(root);
        if (typeof AbortController === 'undefined') return f(url, opts);
        var ac = new AbortController();
        var t = setTimeout(function () { ac.abort(); }, 10000);
        opts = Object.assign({ signal: ac.signal }, opts);
        return f(url, opts).then(function (r) { clearTimeout(t); return r; },
            function (e) { clearTimeout(t); throw e; });
    }
    function subtle() { return (root.crypto || require('node:crypto').webcrypto).subtle; }

    function load() {
        try { return JSON.parse(store().get(STORE_KEY)) || {}; } catch (e) { return {}; }
    }
    function save(d) { store().set(STORE_KEY, JSON.stringify(d)); }

    function b64uToBytes(s) {
        s = s.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        var bin = atob(s), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function sha256Hex(text) {
        return subtle().digest('SHA-256', new TextEncoder().encode(text)).then(function (d) {
            return Array.prototype.map.call(new Uint8Array(d), function (b) {
                return ('0' + b.toString(16)).slice(-2);
            }).join('');
        });
    }
    function keyConfigured() {
        var j = CFG.publicJwk;
        return !!(j && j.x && j.y && String(j.x).indexOf('PASTE_') !== 0);
    }

    // Resolves to the payload, or null if the token is malformed or the signature is wrong.
    function verifyToken(token) {
        if (!token || !keyConfigured()) return Promise.resolve(null);
        var parts = String(token).split('.');
        if (parts.length !== 2) return Promise.resolve(null);
        return Promise.resolve().then(function () {
            return subtle().importKey('jwk', CFG.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        }).then(function (k) {
            return subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, k,
                b64uToBytes(parts[1]), new TextEncoder().encode(parts[0]));
        }).then(function (ok) {
            if (!ok) return null;
            var p = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[0])));
            return p && p.v === 1 && Array.isArray(p.apps) ? p : null;
        }).catch(function () { return null; });
    }

    var packCache = null;

    // Local, offline evaluation of the stored token.
    function evaluate() {
        var d = load();
        packCache = null;
        var base = { state: 'none', allowed: false, apps: [], hasKey: !!d.key };
        if (!d.token) return Promise.resolve(base);
        return verifyToken(d.token).then(function (p) {
            if (!p) { base.state = 'invalid'; return base; }
            var t = now();
            var r = {
                state: 'active', allowed: true, hasKey: !!d.key, apps: p.apps,
                expiresAt: p.exp, checkedAt: p.iat, recheckBy: p.recheckBy,
                daysLeft: Math.max(0, Math.ceil((p.exp - t) / DAY)),
                graceLeftDays: Math.max(0, Math.ceil((Math.min(p.recheckBy, p.exp) - t) / DAY))
            };
            var done = function () { r.allowed = r.state === 'active'; return r; };
            if (t >= p.exp) { r.state = 'expired'; r.daysLeft = 0; r.graceLeftDays = 0; return done(); }
            if ((d.lastSeen && t < d.lastSeen - DAY) || p.iat > t + DAY) { r.state = 'clock'; return done(); }
            if (t > p.recheckBy) { r.state = 'needs_refresh'; r.graceLeftDays = 0; return done(); }
            if (p.ph) {
                if (!d.packJson) { r.state = 'invalid'; return done(); }
                return sha256Hex(d.packJson).then(function (h) {
                    if (h !== p.ph) { r.state = 'invalid'; return done(); }
                    try { packCache = JSON.parse(d.packJson); } catch (e) { r.state = 'invalid'; }
                    if (r.state === 'active' && (!d.lastSeen || t > d.lastSeen)) { d.lastSeen = t; save(d); }
                    return done();
                });
            }
            if (!d.lastSeen || t > d.lastSeen) { d.lastSeen = t; save(d); }
            return done();
        });
    }

    function online() { return typeof navigator === 'undefined' || navigator.onLine !== false; }

    // Calls the Worker; stores the token on success.
    function call(path, key) {
        return doFetch(CFG.workerUrl.replace(/\/+$/, '') + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: key })
        }).then(function (resp) {
            return resp.json().catch(function () { return {}; }).then(function (j) {
                return { status: resp.status, json: j };
            });
        });
    }

    function applyResponse(key, res) {
        var j = res.json || {};
        if (res.status === 200 && j.ok && j.token) {
            var d = load();
            d.key = key; d.token = j.token; d.packJson = j.packJson || null;
            d.lastSeen = now(); // fresh online check resets the clock-rollback reference
            save(d);
            return evaluate().then(function (s) {
                if (!s.allowed) {
                    return { ok: false, message: 'The server token could not be verified. Check the public key in shared/license.js.', status: s };
                }
                return { ok: true, status: s };
            });
        }
        // Server answered and said no: key invalid, expired or revoked -> lock this device.
        if (res.status === 403 || res.status === 400) {
            var d2 = load();
            delete d2.token; delete d2.packJson;
            if (res.status === 403) d2.key = key;
            save(d2);
            return evaluate().then(function (s) {
                return { ok: false, code: j.code, message: j.message || 'License was refused.', status: s };
            });
        }
        return evaluate().then(function (s) {
            return { ok: false, message: j.message || 'Server error. Try again later.', status: s };
        });
    }

    function networkFail() {
        return evaluate().then(function (s) {
            return { ok: false, offline: true, message: 'No connection to the license server.', status: s };
        });
    }

    var api = {
        configure: function (o) { Object.assign(CFG, o || {}); packCache = null; },
        status: evaluate,
        key: function () { return load().key || ''; },

        activate: function (key) {
            key = String(key || '').trim();
            if (!key) return Promise.resolve({ ok: false, message: 'Please enter a license key.' });
            return call('/license/activate', key).then(function (res) { return applyResponse(key, res); }, networkFail);
        },

        refresh: function () {
            var key = load().key;
            if (!key) return Promise.resolve({ ok: false, message: 'No license key on this device.' });
            return call('/license/refresh', key).then(function (res) { return applyResponse(key, res); }, networkFail);
        },

        // Quiet background refresh when the token is a few days old or the grace window is over.
        maybeRefresh: function () {
            return evaluate().then(function (s) {
                if (!s.hasKey || !online()) return s;
                var stale = s.state === 'needs_refresh' || s.state === 'clock' ||
                    (s.state === 'active' && now() - s.checkedAt > CFG.refreshAfterDays * DAY);
                if (!stale) return s;
                return api.refresh().then(function (r) { return r.status; });
            });
        },

        // Gate for an app page. Resolves true if allowed, otherwise shows the lock screen.
        require: function (app) {
            if (FREE_APPS[app]) return Promise.resolve(true);
            return api.maybeRefresh().then(function (s) {
                var ok = s.allowed && s.apps.indexOf(app) !== -1;
                if (!ok) showLock(app, s);
                return ok;
            });
        },

        // Calibration constants delivered by the Worker (null if none / not allowed).
        pack: function () {
            return evaluate().then(function (s) { return s.allowed ? packCache : null; });
        },

        clear: function () { store().remove(STORE_KEY); packCache = null; },
        showLock: showLock,
        _verifyToken: verifyToken
    };

    var LOCK_TEXT = {
        none: 'Enter your license key in Help to use this tool.',
        invalid: 'The license on this device is not valid. Enter your key again in Help.',
        expired: 'Your license has expired. Contact the developer to renew it.',
        clock: 'The device clock looks wrong. Fix the date and time, then go online once.',
        needs_refresh: 'The license needs an online check (30 days offline). Connect to the internet and reopen this page.',
        noapp: 'Your license does not include this tool.'
    };
    var NAMES = { grod: 'GRod', gbtorque: 'GBTorque', rodbook: 'RodBook' };

    function showLock(app, s, text) {
        if (typeof document === 'undefined') return;
        var reason = s.allowed ? 'noapp' : s.state;
        var el = document.getElementById('gl-lock');
        if (!el) {
            el = document.createElement('div');
            el.id = 'gl-lock';
            el.className = 'gl-lock';
            document.body.appendChild(el);
        }
        el.innerHTML = '';
        var box = document.createElement('div'); box.className = 'gl-lock-box';
        var h = document.createElement('h2'); h.textContent = (NAMES[app] || app) + ' is locked';
        var p = document.createElement('p'); p.textContent = text || LOCK_TEXT[reason] || LOCK_TEXT.none;
        var a = document.createElement('a'); a.className = 'btn'; a.href = CFG.helpUrl; a.textContent = 'Open Help';
        var b = document.createElement('a'); b.className = 'btn ghost'; b.href = CFG.homeUrl; b.textContent = 'Home';
        box.appendChild(h); box.appendChild(p);
        var row = document.createElement('div'); row.className = 'gl-lock-row';
        row.appendChild(a); row.appendChild(b); box.appendChild(row);
        el.appendChild(box);
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.GLicense = api;
})(typeof window !== 'undefined' ? window : globalThis);
