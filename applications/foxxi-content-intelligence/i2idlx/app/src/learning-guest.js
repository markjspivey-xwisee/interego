// Guest learning account: a P-256 key this browser generates and cannot export, kept in IndexedDB.
// The key proves possession only. It does not identify a person. Nothing here is a bearer credential:
// the identity token the bootstrap returns is dropped unread, and the attestation is public proof
// material that is useless without a fresh signature from the key.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'learning_guest_unavailable', extra = {}) => Object.assign(new Error(message), { code }, extra);
const utf8 = value => new TextEncoder().encode(value);
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const DB = 'i2idlx-learning-guest', STORE = 'keys', RECORD = 'p256';

/** The default store: one record in IndexedDB. A CryptoKey is stored by structured clone, never as bytes. */
export function guestKeyStore(indexedDB = globalThis.indexedDB) {
  const open = () => new Promise((resolve, reject) => {
    if (!indexedDB) { reject(fail('This browser cannot keep a guest key.')); return; }
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(fail('This browser cannot keep a guest key.'));
  });
  const run = async (mode, work) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode), request = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result ?? null); tx.onerror = tx.onabort = () => reject(fail('This browser cannot keep a guest key.'));
      });
    } finally { db.close(); }
  };
  return { get: () => run('readonly', store => store.get(RECORD)), put: value => run('readwrite', store => store.put(value, RECORD)),
    clear: () => run('readwrite', store => store.delete(RECORD)) };
}

/** RFC 7638 thumbprint of a P-256 public JWK, as identity computes it. */
export async function guestKeyThumbprint(jwk, subtle = globalThis.crypto.subtle) {
  return base64url(await subtle.digest('SHA-256', utf8(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))));
}

function sameOriginPath(raw, origin, path) {
  let url; try { url = new URL(raw, origin); } catch { throw fail('The workbench returned an unsupported guest configuration.'); }
  if (url.origin !== new URL(origin).origin || url.pathname !== path || url.search || url.hash || url.username || url.password) throw fail('The workbench returned an unsupported guest configuration.');
  return url.href;
}

/** Validates the `guest_sign_in` block of the learning session status. Null when guests are not offered. */
export function learningGuestSignIn(value, origin) {
  if (value === undefined || value === null) return null;
  if (!object(value)) throw fail('The workbench returned an unsupported guest configuration.');
  let bootstrap; try { bootstrap = new URL(value.bootstrap_url); } catch { throw fail('The workbench returned an unsupported guest configuration.'); }
  if (bootstrap.protocol !== 'https:' || bootstrap.pathname !== '/play/provisional' || bootstrap.search || bootstrap.hash || bootstrap.username || bootstrap.password
    || value.audience !== new URL(origin).origin) throw fail('The workbench returned an unsupported guest configuration.');
  return { grant_url: sameOriginPath(value.grant_url, origin, '/i2idlx/learning/guest/grant'), challenge_url: sameOriginPath(value.challenge_url, origin, '/i2idlx/learning/guest/challenge'),
    session_url: sameOriginPath(value.session_url, origin, '/i2idlx/learning/guest/session'), bootstrap_url: bootstrap.href, audience: value.audience };
}

/**
 * Signs this browser in as a guest learner. `config` is learningGuestSignIn()'s result.
 * `confirmTerms(terms)` is asked only when the identity service requires agreement to its hosted
 * terms before creating a guest; it resolves true when the person agrees.
 */
export async function guestLearningSignIn(config, options = {}) {
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis), subtle = options.subtle || globalThis.crypto.subtle;
  const store = options.store || guestKeyStore(), signal = options.signal;
  const post = async (url, body, sameOrigin) => {
    let response;
    try { response = await fetcher(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      credentials: sameOrigin ? 'same-origin' : 'omit', cache: 'no-store', redirect: 'error', signal }); }
    catch { throw fail('Guest sign-in is not reachable right now. Try again.'); }
    let value = null; try { value = await response.json(); } catch { /* answered below */ }
    return { status: response.status, ok: response.ok, value: object(value) ? value : {} };
  };
  const sign = async (key, text) => base64url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(text)));

  let record = await store.get();
  if (!record || !record.privateKey || !object(record.publicKeyJwk)) {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const jwk = await subtle.exportKey('jwk', pair.publicKey);
    record = { privateKey: pair.privateKey, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
    await store.put(record);
  }
  const enter = async attestation => {
    const challenge = await post(config.challenge_url, {}, true);
    if (!challenge.ok || typeof challenge.value.challenge !== 'string') throw fail('Guest sign-in is not available right now. Try again.');
    const proof = await sign(record.privateKey, `interego-play-proof-v1\n${attestation}\n${config.audience}\n${challenge.value.challenge}`);
    return post(config.session_url, { attestation, challenge: challenge.value.challenge, proof }, true);
  };
  // A returning guest: the attestation it already holds, with a fresh proof. No new grant is spent.
  if (typeof record.attestation === 'string') {
    const entered = await enter(record.attestation);
    if (entered.ok) return { guest: true, resumed: true };
    if (entered.status !== 401) throw fail('Guest sign-in is not available right now. Try again.', entered.value.error || undefined);
  }
  const bootstrap = async termsVersion => {
    const grant = await post(config.grant_url, { publicKeyThumbprint: await guestKeyThumbprint(record.publicKeyJwk, subtle) }, true);
    const playGrant = grant.value.playGrant;
    if (!grant.ok || !object(playGrant) || typeof playGrant._signed_payload !== 'string' || typeof playGrant._signature !== 'string')
      throw fail(grant.status === 429 ? 'Too many guest sign-ins from here. Try again in a few minutes.' : 'Guest sign-in is not available on this workbench right now.');
    const proof = await sign(record.privateKey, `interego-play-provisional-v1\n${playGrant._signed_payload}\n${playGrant._signature}`
      + (termsVersion ? `\nHosted-Interego-Terms: ${termsVersion}` : ''));
    return post(config.bootstrap_url, { playGrant, publicKeyJwk: record.publicKeyJwk, proof, ...(termsVersion ? { termsVersion } : {}) }, false);
  };
  let created = await bootstrap();
  if (created.status === 428 && object(created.value.terms) && typeof created.value.terms.version === 'string') {
    if (!options.confirmTerms || await options.confirmTerms(created.value.terms) !== true) throw fail('A guest account needs agreement to the hosted terms.', 'learning_guest_terms_required', { terms: created.value.terms });
    created = await bootstrap(created.value.terms.version);
  }
  if (created.ok && typeof created.value.attestation === 'string' && options.onProvisioned) await options.onProvisioned(created.value);
  if (!created.ok || typeof created.value.attestation !== 'string') {
    const code = typeof created.value.error === 'string' ? created.value.error : '';
    throw fail(/capacity/.test(code) ? 'No guest places are left right now. Sign in with a passkey or wallet instead.'
      : created.status === 429 ? 'Too many guest sign-ins from here. Try again later.' : 'A guest account could not be created right now.', code || undefined);
  }
  // Only the attestation is kept. The identity token in this response is never read or stored.
  record = { ...record, attestation: created.value.attestation }; await store.put(record);
  const entered = await enter(record.attestation);
  if (!entered.ok) throw fail('The guest account was created but could not be signed in. Try again.', entered.value.error || undefined);
  return { guest: true, resumed: false, ...(typeof created.value.guestExpiresAt === 'string' ? { guest_expires_at: created.value.guestExpiresAt } : {}) };
}

/**
 * A new identity token for the guest this browser already keeps. Identity resumes the same
 * owner for the same key. The token is returned and not written next to the key, so a later
 * visit can ask again after the page that held one has been left. Null is not returned: a
 * browser with no guest key fails.
 */
export async function guestFreshCredential(config, options = {}) {
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis), subtle = options.subtle || globalThis.crypto.subtle;
  const store = options.store || guestKeyStore(), signal = options.signal;
  const post = async (url, body, sameOrigin) => {
    let response;
    try { response = await fetcher(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      credentials: sameOrigin ? 'same-origin' : 'omit', cache: 'no-store', redirect: 'error', signal }); }
    catch { throw fail('Guest sign-in is not reachable right now. Try again.'); }
    let value = null; try { value = await response.json(); } catch { /* answered below */ }
    return { status: response.status, ok: response.ok, value: object(value) ? value : {} };
  };
  const sign = async (key, text) => base64url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(text)));
  const record = await store.get();
  if (!record || !record.privateKey || !object(record.publicKeyJwk)) throw fail('This browser is not keeping a guest.');
  const bootstrap = async termsVersion => {
    const grant = await post(config.grant_url, { publicKeyThumbprint: await guestKeyThumbprint(record.publicKeyJwk, subtle) }, true);
    const playGrant = grant.value.playGrant;
    if (!grant.ok || !object(playGrant) || typeof playGrant._signed_payload !== 'string' || typeof playGrant._signature !== 'string')
      throw fail(grant.status === 429 ? 'Too many guest sign-ins from here. Try again in a few minutes.' : 'Guest sign-in is not available on this workbench right now.');
    const proof = await sign(record.privateKey, `interego-play-provisional-v1\n${playGrant._signed_payload}\n${playGrant._signature}`
      + (termsVersion ? `\nHosted-Interego-Terms: ${termsVersion}` : ''));
    return post(config.bootstrap_url, { playGrant, publicKeyJwk: record.publicKeyJwk, proof, ...(termsVersion ? { termsVersion } : {}) }, false);
  };
  let created = await bootstrap();
  if (created.status === 428 && object(created.value.terms) && typeof created.value.terms.version === 'string') {
    if (!options.confirmTerms || await options.confirmTerms(created.value.terms) !== true) throw fail('A guest account needs agreement to the hosted terms.', 'learning_guest_terms_required', { terms: created.value.terms });
    created = await bootstrap(created.value.terms.version);
  }
  if (!created.ok || typeof created.value.token !== 'string' || typeof created.value.attestation !== 'string') {
    throw fail('A guest account could not be opened just now.', typeof created.value.error === 'string' ? created.value.error : undefined);
  }
  await store.put({ ...record, attestation: created.value.attestation });
  return { token: created.value.token, ...(typeof created.value.guestExpiresAt === 'string' ? { guestExpiresAt: created.value.guestExpiresAt } : {}) };
}

/**
 * A fresh proof that this browser still holds the guest key, without opening a guest session.
 * Used when the person is signed in as another owner and is linking that guest's record.
 * Null when this browser has no guest attestation yet.
 */
export async function guestPossessionProof(config, options = {}) {
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis), subtle = options.subtle || globalThis.crypto.subtle;
  const store = options.store || guestKeyStore(), signal = options.signal;
  const record = await store.get();
  if (!record || !record.privateKey || typeof record.attestation !== 'string') return null;
  let response;
  try { response = await fetcher(config.challenge_url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}',
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }); }
  catch { throw fail('Guest sign-in is not reachable right now. Try again.'); }
  let value = null; try { value = await response.json(); } catch { /* answered below */ }
  if (!response.ok || !object(value) || typeof value.challenge !== 'string') throw fail('Guest sign-in is not available right now. Try again.');
  const proof = base64url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, record.privateKey, utf8(`interego-play-proof-v1\n${record.attestation}\n${config.audience}\n${value.challenge}`)));
  return { attestation: record.attestation, challenge: value.challenge, proof };
}
