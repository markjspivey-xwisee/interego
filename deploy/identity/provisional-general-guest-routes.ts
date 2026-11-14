/**
 * The general guest door's routes and its page (provisional-general-guest.ts). Mounted only while
 * the door is on: a deployment without PROVISIONAL_GENERAL_GUEST=1 has none of these paths.
 *
 *   GET  /guest/door          the door page (this origin holds the guest's key in IndexedDB)
 *   POST /guest/door          the page's request: admit or find the key's guest for an application
 *   POST /guest/door/claim    the page's request: open the claim flow for the key's guest
 *   POST /guest/door/link     the page's request: say which account a link code names, then link
 *                             the key's guest to it (provisional-guest-link.ts)
 *   POST /guest/exchange      an application backend's exchange of a door code
 *
 * A DEDICATED DOOR ORIGIN (GENERAL_GUEST_DOOR_ORIGIN) is what production should set. The same
 * process then answers two host names. On the door's host it serves the door page and its two
 * requests and NOTHING else (doorHostGuard: every other path is a 404, the sign-in pages included,
 * so no page with a looser Content-Security-Policy ever runs on the origin that holds the keys). On
 * identity's own host the door's three paths do not exist, so identity's origin never holds a
 * guest key. Identity sets no cookie, so the two origins share none. Unset, the door is served on
 * identity's own origin, which is for development.
 *
 * The page is a top-level document only (frame-ancestors 'none'), runs one inline script named by
 * its hash in the Content-Security-Policy, connects nowhere but this origin, and navigates only to
 * the address this server answered, which it checks against the application the grant names.
 */
import * as crypto from 'node:crypto';
import type express from 'express';
import { PlayError, type ProvisionalPlay } from './provisional-play.js';

/** The door's own paths: the only ones answered on a dedicated door origin's host. */
const DOOR_PATHS: ReadonlySet<string> = new Set(['/guest/door', '/guest/door/claim', '/guest/door/link']);

/**
 * GENERAL_GUEST_DOOR_ORIGIN as an origin, or undefined where it is unset. It must be an HTTPS origin
 * (http only on localhost or 127.0.0.1) with no path, and not identity's own: a value that is
 * anything else stops the server at start.
 */
export function parseDoorOrigin(raw: string | undefined, issuer: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('GENERAL_GUEST_DOOR_ORIGIN is not a URL'); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.origin !== value || (url.protocol !== 'https:' && !local)) throw new Error('GENERAL_GUEST_DOOR_ORIGIN must be an HTTPS origin with no path');
  if (url.origin === new URL(issuer).origin) throw new Error('GENERAL_GUEST_DOOR_ORIGIN must not be the identity server\'s own origin: leave it unset to serve the door there');
  return url.origin;
}

/**
 * On the door origin's host, nothing but the door: every other path answers 404 before any route
 * sees it. Mounted before every route whenever a door origin is configured, whether or not the door
 * is on (with it off, that host serves nothing at all).
 */
export function doorHostGuard(doorOrigin: string): express.RequestHandler {
  const host = new URL(doorOrigin).host;
  return (req, res, next) => {
    if ((req.get('host') ?? '').toLowerCase() !== host || DOOR_PATHS.has(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: 'not_found' });
  };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** The door page's script. `__CONFIG__` is replaced with JSON that holds no `<`. */
const DOOR_SCRIPT = `'use strict';
(function () {
  var config = __CONFIG__;
  var $ = function (id) { return document.getElementById(id); };
  var status = function (text) { $('status').textContent = text; };
  var b64url = function (bytes) {
    var s = ''; var view = new Uint8Array(bytes);
    for (var i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
  var fromB64url = function (text) {
    var s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return new TextDecoder().decode(out);
  };
  var fragment = location.hash.slice(1);
  // The grant leaves the address bar at once: it is not left in history or sent as a referrer.
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* the page still works */ }

  function store(mode, work) {
    return new Promise(function (resolve, reject) {
      var open = indexedDB.open('interego-general-guest', 1);
      open.onupgradeneeded = function () { open.result.createObjectStore('keys'); };
      open.onerror = function () { reject(open.error); };
      open.onsuccess = function () {
        var db = open.result; var tx = db.transaction('keys', mode); var request = work(tx.objectStore('keys'));
        tx.oncomplete = function () { db.close(); resolve(request && request.result); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
      };
    });
  }
  var readKey = function () { return store('readonly', function (keys) { return keys.get('guest'); }); };
  function newKey() {
    // extractable: false. The private key can sign here and can never be exported, by this page or any other.
    return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']).then(function (pair) {
      return store('readwrite', function (keys) { return keys.put(pair, 'guest'); }).then(function () { return pair; });
    });
  }
  var publicJwk = function (pair) {
    return crypto.subtle.exportKey('jwk', pair.publicKey).then(function (jwk) { return { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y }; });
  };
  var sign = function (pair, text) {
    return crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text)).then(b64url);
  };
  function post(path, body) {
    return fetch(path, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (response) { return response.json().then(function (answer) { return { ok: response.ok, answer: answer }; }); });
  }

  function enter(grant, audience, rotated) {
    return readKey().then(function (pair) { return pair || newKey(); }).then(function (pair) {
      return publicJwk(pair).then(function (jwk) {
        var text = 'interego-general-guest-door-v1\\n' + grant._signed_payload + '\\n' + grant._signature;
        if (config.terms) text += '\\nHosted-Interego-Terms: ' + config.terms.version;
        return sign(pair, text).then(function (proof) {
          return post('/guest/door', { playGrant: grant, publicKeyJwk: jwk, proof: proof, termsVersion: config.terms ? config.terms.version : undefined });
        });
      });
    }).then(function (result) {
      if (result.ok && typeof result.answer.redirect === 'string') {
        // Only ever to the application the grant names.
        if (new URL(result.answer.redirect).origin !== audience) throw new Error('unexpected return address');
        location.replace(result.answer.redirect);
        return;
      }
      // This browser's guest has reached its deadline: a new key is a new guest. Once.
      if (result.answer.error === 'provisional_owner_expired' && !rotated) return newKey().then(function () { return enter(grant, audience, true); });
      throw new Error(result.answer.error || 'the guest could not be continued');
    });
  }

  var thumbprintOf = function (jwk) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))).then(b64url);
  };

  function keep() {
    return readKey().then(function (pair) {
      if (!pair) throw new Error('there is no guest in this browser');
      return publicJwk(pair).then(function (jwk) {
        return thumbprintOf(jwk).then(function (thumbprint) {
          var expiresAt = Math.floor(Date.now() / 1000) + 60;
          return sign(pair, 'interego-general-guest-claim-v1\\n' + config.issuer + '\\n' + thumbprint + '\\n' + expiresAt).then(function (proof) {
            return post('/guest/door/claim', { publicKeyJwk: jwk, expiresAt: expiresAt, proof: proof });
          });
        });
      });
    }).then(function (result) {
      if (!result.ok || typeof result.answer.token !== 'string') throw new Error(result.answer.error || 'the guest could not be found');
      // The claim itself is identity's own page, on identity's origin (which may not be this one).
      location.assign(config.issuer + '/connect?claim=' + encodeURIComponent(result.answer.token));
    });
  }

  // Linking this browser's guest to an account the visitor already has. The code comes from that
  // account's dashboard, on a device signed in to it. The key signs twice: once to be told which
  // account the code names, and once, with that account in the signed bytes, to link.
  function askLink(code, account) {
    return readKey().then(function (pair) {
      if (!pair) throw new Error('there is no guest in this browser');
      return publicJwk(pair).then(function (jwk) {
        return thumbprintOf(jwk).then(function (thumbprint) {
          var expiresAt = Math.floor(Date.now() / 1000) + 60;
          var text = (account ? 'interego-general-guest-link-v1' : 'interego-general-guest-link-preview-v1')
            + '\\n' + config.issuer + '\\n' + thumbprint + '\\n' + code + '\\n' + expiresAt + (account ? '\\n' + account : '');
          return sign(pair, text).then(function (proof) {
            var body = { publicKeyJwk: jwk, code: code, expiresAt: expiresAt, proof: proof };
            if (account) body.account = account;
            return post('/guest/door/link', body);
          });
        });
      });
    }).then(function (result) {
      if (!result.ok || !result.answer.account || typeof result.answer.account.did !== 'string') throw new Error(result.answer.error || 'the code could not be checked');
      return result.answer;
    });
  }
  // What a person typed, in the one form the server takes: the account as written, the secret in
  // capitals without spaces or hyphens, and the letters this alphabet leaves out read as the digits they resemble.
  function canonicalCode(text) {
    text = text.trim(); var at = text.lastIndexOf(':');
    if (at < 1) return null;
    return text.slice(0, at).trim() + ':' + text.slice(at + 1).toUpperCase().replace(/[\\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  }

  var button = $('go');
  var run = function (work, again) {
    button.disabled = true; status('Working...');
    work().catch(function (error) { status('Not done: ' + (error && error.message ? error.message : 'unknown error') + '.'); button.disabled = !again; });
  };
  if (fragment === 'link' || fragment.indexOf('link=') === 0) {
    var field = $('code'); var shown = null;
    $('who').textContent = 'Link the guest this browser holds to an account you already have. On a device where you are signed in to that account, ask its dashboard for a guest link code, and enter it here.';
    $('coderow').hidden = false;
    try { field.value = decodeURIComponent(fragment.slice(5)); } catch (e) { /* typed instead */ }
    button.textContent = 'Check this code'; button.disabled = false;
    var linked = function (account) {
      $('account').hidden = true; field.disabled = true; button.disabled = true;
      status('Linked. The guest in this browser now acts as the account ' + account.name + ' (' + account.did + '). You can close this page.');
    };
    field.addEventListener('input', function () { shown = null; $('account').hidden = true; button.textContent = 'Check this code'; });
    button.addEventListener('click', function () {
      var code = canonicalCode(field.value);
      if (!code) { status('Enter the whole code, as the dashboard shows it.'); return; }
      if (shown && shown.code === code) {
        // The second click: the account on the screen is in the bytes the key signs.
        run(function () { return askLink(code, shown.account.did).then(function (answer) { linked(answer.account); }); }, true);
        return;
      }
      run(function () {
        return askLink(code).then(function (answer) {
          if (answer.linked) { linked(answer.account); return; }
          shown = { code: code, account: answer.account };
          $('account').textContent = 'This code is for the account "' + answer.account.name + '" (' + answer.account.did + '). Linking makes the guest in this browser act as that account in every application that offers guest access, and what the guest does there becomes that account\\'s. Continue only if this is your own account and you asked for this code yourself, just now. If someone else gave you this code, stop.';
          $('account').hidden = false;
          button.textContent = 'Link this guest to ' + answer.account.name;
          button.disabled = false; status('');
        });
      }, true);
    });
    return;
  }
  if (fragment === 'claim') {
    $('who').textContent = 'Keep the guest this browser holds by adding a passkey or wallet to it.';
    button.textContent = 'Keep this guest';
    button.disabled = false;
    button.addEventListener('click', function () { run(keep, true); });
    return;
  }
  var grant, audience;
  try {
    grant = JSON.parse(fromB64url(new URLSearchParams(fragment).get('grant') || ''));
    audience = new URL(JSON.parse(grant._signed_payload).audience).origin;
    if (typeof grant._signature !== 'string') throw new Error('grant');
  } catch (e) {
    $('who').textContent = 'This page is opened by an application that offers guest access. Return to it and choose to continue as a guest.';
    return;
  }
  $('who').textContent = audience + ' asks to continue with the guest this browser holds. The same guest is used by every application that offers this, so each of them sees the same guest identifier and pod address.';
  if (config.terms) $('terms').hidden = false;
  button.disabled = false;
  // A click, never a silent pass-through: linking this browser's guest to an application is the visitor's act.
  button.addEventListener('click', function () { run(function () { return enter(grant, audience, false); }, false); });
})();`;

const DOOR_STYLE = 'body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#111;color:#eee}main{max-width:34rem;margin:12vh auto;padding:0 1.25rem}'
  + 'button{font:inherit;padding:.6rem 1.1rem;border-radius:.4rem;border:1px solid #6ae66a;background:#173417;color:#eee;cursor:pointer}'
  + 'button:disabled{opacity:.5;cursor:default}a{color:#8ecbff}#status{min-height:1.5em;color:#bbb}'
  + 'input{font:inherit;width:100%;box-sizing:border-box;margin-top:.3rem;padding:.5rem;border-radius:.4rem;border:1px solid #555;background:#1b1b1b;color:#eee}'
  + '#account{border-left:3px solid #e6c36a;padding-left:.8rem}';

/** The door page and the Content-Security-Policy that names its one script and one style sheet by hash. */
export function generalGuestDoorPage(config: { issuer: string; terms?: { version: string; url: string; privacyUrl: string } }): { html: string; csp: string } {
  const script = DOOR_SCRIPT.replace('__CONFIG__', () => JSON.stringify(config).replace(/</g, '\\u003c'));
  const hash = (text: string) => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;
  const terms = config.terms
    ? `<p id="terms" hidden>By continuing you agree to the <a href="${escapeHtml(config.terms.url)}" target="_blank" rel="noopener noreferrer">Terms</a> and the <a href="${escapeHtml(config.terms.privacyUrl)}" target="_blank" rel="noopener noreferrer">Privacy Notice</a>.</p>`
    : '<p id="terms" hidden></p>';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Continue as a guest</title><style>${DOOR_STYLE}</style></head>
<body><main><h1>Continue as a guest</h1>
<p id="who">Checking...</p>
${terms}
<p id="coderow" hidden><label for="code">Guest link code</label><input id="code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="100"></p>
<p id="account" hidden></p>
<p>A guest is temporary. It is held by this browser, it identifies no person, and it ends at its deadline unless you keep it.</p>
<p><button id="go" type="button" disabled>Continue as a guest</button></p>
<p id="status" role="status"></p>
</main><script>${script}</script></body></html>`;
  const csp = `default-src 'none'; script-src ${hash(script)}; style-src ${hash(DOOR_STYLE)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return { html, csp };
}

/**
 * Mount the door. Does nothing, and adds no route, unless the door is on. `limiters`: the page, its
 * requests (the door's is the one that can admit a guest; the link's is the one a code is guessed
 * through), and the exchange (counted against an application backend's address).
 */
export function mountGeneralGuest(app: express.Express, play: ProvisionalPlay,
  limiters: { page: express.RequestHandler; door: express.RequestHandler; claim: express.RequestHandler; link: express.RequestHandler; exchange: express.RequestHandler },
  log: (message: string) => void): boolean {
  const general = play.general;
  if (!general?.enabled) return false;
  // Where the door has an origin of its own, its paths exist on that host alone.
  const doorHost = new URL(general.doorOrigin).host;
  const dedicated = general.doorOrigin !== new URL(play.metadata().issuer).origin;
  const onDoor: express.RequestHandler = (req, _res, next) => {
    if (dedicated && (req.get('host') ?? '').toLowerCase() !== doorHost) { next('route'); return; }
    next();
  };
  const policy = play.metadata().terms;
  const page = generalGuestDoorPage({ issuer: play.metadata().issuer, ...(policy ? { terms: policy } : {}) });
  app.get('/guest/door', onDoor, limiters.page, (_req, res) => {
    res.setHeader('Content-Security-Policy', page.csp);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(page.html);
  });
  const route = (fn: (req: express.Request) => Promise<unknown>): express.RequestHandler => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await fn(req)); }
    catch (error) {
      if (error instanceof PlayError) {
        res.status(error.status).json({ valid: false, error: error.code, ...(error.code === 'hosted_terms_required' ? { terms: policy } : {}) });
        return;
      }
      log(`General guest dependency unavailable: ${(error as Error).name}`);
      res.status(503).json({ valid: false, error: 'general_guest_unavailable' });
    }
  };
  app.post('/guest/door', onDoor, limiters.door, route(req => general.door(req.body, req.get('origin'))));
  app.post('/guest/door/claim', onDoor, limiters.claim, route(req => general.claim(req.body, req.get('origin'))));
  app.post('/guest/door/link', onDoor, limiters.link, route(req => general.link.link(req.body, req.get('origin'))));
  app.post('/guest/exchange', limiters.exchange, route(req => general.exchange(req.body)));
  return true;
}
