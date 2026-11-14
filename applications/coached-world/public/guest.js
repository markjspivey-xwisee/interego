/**
 * Provisional-play guest, the same proof templates identity already checks.
 * The key stays in this browser. The identity token, if one comes back, is not kept:
 * the world session is a separate bearer this page asks for with a fresh proof.
 */
const text = value => new TextEncoder().encode(value);
const b64 = bytes => {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function store() {
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open('coached-world-guest', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (mode, work) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('keys', mode);
        const request = work(tx.objectStore('keys'));
        tx.oncomplete = () => resolve(request.result ?? null);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  };
  return {
    get: () => run('readonly', s => s.get('key')),
    put: value => run('readwrite', s => s.put(value, 'key')),
  };
}

async function thumbprint(jwk, subtle) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64(await subtle.digest('SHA-256', text(canonical)));
}

async function sign(key, payload, subtle) {
  return b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, text(payload)));
}

async function post(url, body, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(parsed.error || `request failed (${response.status})`);
  return parsed;
}

/** Sign this browser in as a provisional guest and return the world session token. */
export async function signIn() {
  const subtle = crypto.subtle;
  const kept = store();
  let record = await kept.get().catch(() => null);
  if (!record?.privateKey || !record.publicKeyJwk) {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const jwk = await subtle.exportKey('jwk', pair.publicKey);
    record = { privateKey: pair.privateKey, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
    await kept.put(record);
  }
  const offer = await (await fetch('/play/guest', { headers: { Accept: 'application/json' } })).json();
  if (!offer.enabled) throw new Error('guests are not offered here');
  const enter = async attestation => {
    const challenged = await post('/session/challenge', {});
    const proof = await sign(record.privateKey, `interego-play-proof-v1\n${attestation}\n${offer.audience}\n${challenged.challenge}`, subtle);
    return post('/session', { attestation, challenge: challenged.challenge, proof });
  };
  if (typeof record.attestation === 'string') {
    try { return await enter(record.attestation); } catch { /* a fresh grant below */ }
  }
  const challenge = b64(crypto.getRandomValues(new Uint8Array(32)));
  const granted = await post('/play/grant', { publicKeyThumbprint: await thumbprint(record.publicKeyJwk, subtle), challenge });
  const playGrant = granted.playGrant;
  const proof = await sign(record.privateKey, `interego-play-provisional-v1\n${playGrant._signed_payload}\n${playGrant._signature}`, subtle);
  const admitted = await post(offer.bootstrapUrl, { playGrant, publicKeyJwk: record.publicKeyJwk, proof });
  if (typeof admitted.attestation !== 'string') throw new Error('guest was not admitted');
  record.attestation = admitted.attestation;
  await kept.put(record);
  return enter(admitted.attestation);
}
