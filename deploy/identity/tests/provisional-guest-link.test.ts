/**
 * Linking a general guest to a registered account (provisional-guest-link.ts): the ceremony's two
 * conditional writes, what each party can and cannot make happen, and when the link is stated.
 *
 * The real provider over fake conditional storage, with generated local keys. The accounts are
 * fictional records written straight into that storage; no identity, pod or relay is called. The
 * account owner's fresh credential proof is the routes' (provisional-guest-link-routes.test.ts):
 * here `issueCode` and `unlink` are called as the routes call them once that proof has verified.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { createProvisionalPlayProvider } from '../provisional-play-provider.js';
import { PlayError, generalGuestUserId, playKeyThumbprint, publicPlayKey, type PlayClaims } from '../provisional-play.js';
import { GENERAL_GUEST_PURPOSE, claimProofPayload, doorProofPayload } from '../provisional-general-guest.js';
import { LINK_CODE_MAX_ATTEMPTS, MAX_LINKED_GUESTS, linkPreviewPayload, linkProofPayload, parseLinkCode } from '../provisional-guest-link.js';
import { publicJwk } from './public-jwk.js';

const ISSUER = 'https://identity.example';
const CSS = 'https://css.internal.example/';
const game = 'https://play.example';
const gameAgent = { agentDid: 'did:web:identity.example:agents:game', podUrl: 'https://pods.example/game/' };
const signer = `0x${'11'.repeat(20)}`;
const refused = (expected: string, status?: number) => (error: unknown) =>
  error instanceof PlayError && error.code === expected && (status === undefined || error.status === status);
const sha = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
type Pair = crypto.KeyPairKeyObjectResult;
const newPair = (): Pair => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwkOf = (pair: Pair) => publicPlayKey(publicJwk(pair.publicKey));
const thumbprintOf = (pair: Pair) => playKeyThumbprint(jwkOf(pair));
const guestIdOf = (pair: Pair) => generalGuestUserId(thumbprintOf(pair));
const sign = (pair: Pair, text: string) => crypto.sign('sha256', Buffer.from(text), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const didOf = (userId: string) => `did:web:identity.example:users:${userId}`;
const soon = () => Math.floor(Date.now() / 1000) + 60;

/** A fictional registered account's record, as identity writes one: a wallet is its credential. */
const accountRecord = (userId: string, name: string) => JSON.stringify({
  '@id': `#auth-${userId}`, '@type': 'iep:AuthMethods', userId, name, walletAddresses: [`0x${crypto.randomBytes(20).toString('hex')}`],
  webAuthnCredentials: [], didKeys: [], sessionEpoch: 0,
});

function deployment(opts: { generalGuest?: boolean } = {}) {
  const documents = new Map<string, { body: string; revision: number }>();
  /** A write to a URL containing this is answered 500 once, and nothing is stored. */
  const failing: string[] = [];
  const play = createProvisionalPlayProvider({
    issuer: ISSUER, cssUrl: CSS, publicPodBase: 'https://pods.example/', relayUrl: 'https://relay.example',
    signingKey: Buffer.alloc(32, 3), stableSigningKey: true, generalGuest: opts.generalGuest ?? true,
    clientsJson: JSON.stringify({ [game]: { ...gameAgent, generalGuest: true, generalGuestReturnPath: '/guest/return' } }),
    withOwnerLock: <T>(_userId: string, work: () => Promise<T>) => work(),
    empty: (c: PlayClaims) => ({ userId: c.userId, agentId: c.authenticatedAgentId }), committed: () => {},
    issueCredential: async () => ({ token: 'unused' }),
    issueGuestToken: async () => ({ token: 'guest-token', expiresAt: '2030-01-01T00:00:00.000Z' }),
    recoverSigner: async () => signer,
    fetcher: (async (input, init) => {
      const url = String(input);
      if (url === 'https://relay.example/tool/verify_agent') {
        const asked = JSON.parse(String(init?.body)) as { pod_url: string };
        return Response.json({ verified: true, subject_pod_url: asked.pod_url, signing: { relayAnchor: signer, canSignDelegatedRequests: true } });
      }
      if (init?.method === 'PUT') {
        if (url.endsWith('/')) return new Response(null, { status: 201 });
        const fail = failing.findIndex(part => url.includes(part));
        if (fail >= 0) { failing.splice(fail, 1); return new Response(null, { status: 500 }); }
        const current = documents.get(url); const headers = init.headers as Record<string, string>;
        if ((headers['If-None-Match'] === '*' && current) || (headers['If-Match'] && headers['If-Match'] !== String(current?.revision)))
          return new Response(null, { status: 412 });
        documents.set(url, { body: String(init.body), revision: (current?.revision ?? 0) + 1 });
        return new Response(null, { status: 201 });
      }
      const current = documents.get(url);
      return current ? new Response(current.body, { headers: { etag: String(current.revision) } }) : new Response(null, { status: 404 });
    }) as typeof fetch,
  });
  const door = play.general!;
  const link = door.link;
  const url = (userId: string) => `${CSS}${userId}/auth-methods.jsonld`;
  const body = (userId: string) => documents.get(url(userId))!.body;
  const record = (userId: string) => JSON.parse(body(userId)) as Record<string, unknown>;
  const edit = (userId: string, change: (document: Record<string, unknown>) => void) => {
    const current = documents.get(url(userId))!; const document = JSON.parse(current.body) as Record<string, unknown>;
    change(document); documents.set(url(userId), { body: JSON.stringify(document), revision: current.revision + 1 });
  };
  /** A registered account, by its record alone. */
  const account = (userId: string, name: string) => { documents.set(url(userId), { body: accountRecord(userId, name), revision: 1 }); return userId; };
  /** The door page's part of an application visit: admits `pair`'s guest, and answers the exchange. */
  const enter = async (pair: Pair) => {
    const now = Math.floor(Date.now() / 1000);
    const state = crypto.randomBytes(24).toString('base64url'); const verifier = crypto.randomBytes(32).toString('base64url');
    const playGrant = { _signed_payload: JSON.stringify({ purpose: GENERAL_GUEST_PURPOSE, audience: game, state, codeChallenge: sha(verifier),
      expiresAt: now + 60, agent_id: gameAgent.agentDid, subject_pod_url: gameAgent.podUrl, timestamp: new Date(now * 1000).toISOString(), nonce: crypto.randomUUID() }),
      _signature: `0x${'12'.repeat(65)}` };
    const answer = await door.door({ playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(playGrant)) }, ISSUER);
    const back = new URL(answer.redirect);
    return await door.exchange({ code: back.searchParams.get('code'), codeVerifier: verifier, audience: game, state }) as { subjectAttributes: Record<string, unknown>; ownerDid: string };
  };
  /** The door page's link request for `pair`: without `named` it asks which account the code is for. */
  const ask = (pair: Pair, code: string, named?: string, over: Record<string, unknown> = {}, origin: unknown = ISSUER) => {
    const expiresAt = soon();
    const text = named === undefined ? linkPreviewPayload(ISSUER, thumbprintOf(pair), code, expiresAt) : linkProofPayload(ISSUER, thumbprintOf(pair), code, expiresAt, named);
    return link.link({ publicKeyJwk: jwkOf(pair), code, expiresAt, proof: sign(pair, text), ...(named !== undefined ? { account: named } : {}), ...over }, origin);
  };
  /** Both clicks of the page: ask which account, then link to the account it answered. */
  const linkTo = async (pair: Pair, code: string) => {
    const shown = await ask(pair, code);
    return ask(pair, code, shown.account.did);
  };
  return { play, door, link, documents, failing, record, body, edit, account, enter, ask, linkTo };
}

test('one ceremony links a guest to an account: the page is told the account first, both records are written, and only then is the link stated', async () => {
  const d = deployment();
  const owner = d.account('u-eth-aaaa00000001', 'Mira Vantongeren');
  const before = d.body(owner);
  const pair = newPair(); const guestId = guestIdOf(pair);
  const first = await d.enter(pair);
  assert.equal(first.subjectAttributes['linkedTo'], undefined, 'an unlinked guest states no link');

  const issued = await d.link.issueCode(owner);
  assert.deepEqual(parseLinkCode(issued.code)?.userId, owner);
  assert.match(issued.code, /^u-eth-aaaa00000001:[0-9A-HJKMNP-TV-Z]{12}$/);
  assert.deepEqual(issued.account, { did: didOf(owner), userId: owner, name: 'Mira Vantongeren' });
  const stored = d.record(owner)['guestLinkCode'] as { hash: string; attempts: number; expiresAt: number };
  assert.equal(stored.attempts, 0);
  assert.ok(!JSON.stringify(d.record(owner)).includes(parseLinkCode(issued.code)!.secret), 'the record holds the code\'s hash, never the code');

  // The first click: which account is this code for? Nothing is linked, and the code is not spent.
  const shown = await d.ask(pair, issued.code);
  assert.deepEqual(shown, { linked: false, account: { did: didOf(owner), userId: owner, name: 'Mira Vantongeren' } });
  assert.equal(d.record(guestId)['provisionalGuestLinkedTo'], undefined);
  assert.equal(d.record(owner)['linkedGuests'], undefined);
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], undefined);

  // The second click names the account in the signed bytes.
  const linked = await d.ask(pair, issued.code, shown.account.did);
  assert.equal(linked.linked, true);
  assert.equal((d.record(guestId)['provisionalGuestLinkedTo'] as { userId: string }).userId, owner);
  const listed = d.record(owner)['linkedGuests'] as Array<Record<string, unknown>>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!['userId'], guestId);
  assert.equal(listed[0]!['proofKeyThumbprint'], thumbprintOf(pair));
  assert.equal(d.record(owner)['guestLinkCode'], undefined, 'the code is spent in the write that lists the guest');

  const after = await d.enter(pair);
  assert.equal(after.subjectAttributes['linkedTo'], didOf(owner));
  assert.equal(after.subjectAttributes['subject'], didOf(guestId), 'the guest is still the acting subject');
  assert.equal(after.subjectAttributes['claimed'], false);
  assert.deepEqual(await d.link.list(owner), [{ userId: guestId, did: didOf(guestId), linkedAt: listed[0]!['linkedAt'], standingUntil: listed[0]!['standingUntil'] }]);

  // Unlinking removes both sides, the link is no longer stated, and the account's record is the bytes it was.
  assert.deepEqual(await d.link.unlink(owner, guestId), { unlinked: true, wasLinked: true });
  assert.equal(d.record(guestId)['provisionalGuestLinkedTo'], undefined);
  assert.equal(d.body(owner), before, 'an account with no guest and no code carries no trace of either');
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], undefined);
  assert.deepEqual(await d.link.unlink(owner, guestId), { unlinked: true, wasLinked: false }, 'unlinking again changes nothing');
  await assert.rejects(d.link.unlink(owner, 'u-eth-aaaa00000001'), refused('invalid_link_request'), 'only a general guest is unlinked');
});

test('a victim\'s guest is not linked to an attacker\'s account without the victim seeing and signing that account', async () => {
  const d = deployment();
  const attacker = d.account('u-eth-bad000000001', 'Your account');
  const own = d.account('u-eth-aaaa00000002', 'Teodor Maliszewski');
  const victim = newPair(); const victimGuest = guestIdOf(victim);
  await d.enter(victim);
  const phished = (await d.link.issueCode(attacker)).code;

  // The page is told whose code this is, by DID and id as well as by the name the attacker chose.
  const shown = await d.ask(victim, phished);
  assert.equal(shown.linked, false);
  assert.equal(shown.account.did, didOf(attacker));
  assert.equal(shown.account.userId, attacker);
  // A signature that asked "which account?" is not a signature that links.
  const expiresAt = soon();
  const previewProof = sign(victim, linkPreviewPayload(ISSUER, thumbprintOf(victim), phished, expiresAt));
  await assert.rejects(d.link.link({ publicKeyJwk: jwkOf(victim), code: phished, expiresAt, proof: previewProof, account: didOf(attacker) }, ISSUER), refused('invalid_browser_proof', 401));
  // A page that signed for the victim's own account is not moved to the attacker's by the attacker's code.
  await assert.rejects(d.ask(victim, phished, didOf(own)), refused('link_account_mismatch', 409));
  // Nor does a link proof for one account carry to a request naming another.
  const forOwn = sign(victim, linkProofPayload(ISSUER, thumbprintOf(victim), phished, expiresAt, didOf(own)));
  await assert.rejects(d.link.link({ publicKeyJwk: jwkOf(victim), code: phished, expiresAt, proof: forOwn, account: didOf(attacker) }, ISSUER), refused('invalid_browser_proof', 401));
  assert.equal(d.record(victimGuest)['provisionalGuestLinkedTo'], undefined);
  assert.equal(d.record(attacker)['linkedGuests'], undefined);
  assert.equal((await d.enter(victim)).subjectAttributes['linkedTo'], undefined);
  // The attacker cannot do it from elsewhere either: the request must come from the door's origin, and be signed by the guest's key.
  await assert.rejects(d.ask(victim, phished, didOf(attacker), {}, 'https://attacker.example'), refused('general_guest_door_origin', 403));
  await assert.rejects(d.ask(victim, phished, didOf(attacker), {}, null), refused('general_guest_door_origin', 403), 'no Origin header');
  const stranger = newPair();
  await assert.rejects(d.link.link({ publicKeyJwk: jwkOf(victim), code: phished, expiresAt, account: didOf(attacker),
    proof: sign(stranger, linkProofPayload(ISSUER, thumbprintOf(victim), phished, expiresAt, didOf(attacker))) }, ISSUER), refused('invalid_browser_proof', 401));
});

test('an attacker\'s guest is not linked to a victim\'s account: not without the victim\'s code, not with another account\'s, not by guessing', async () => {
  const d = deployment();
  const victim = d.account('u-eth-aaaa00000003', 'Ilse Brandvold');
  const attackerAccount = d.account('u-eth-bad000000002', 'Somebody');
  const attacker = newPair(); const attackerGuest = guestIdOf(attacker);
  await d.enter(attacker);
  const untouched = d.body(victim);

  // No code was ever issued for the victim's account: nothing is held to anything, and nothing is written.
  await assert.rejects(d.ask(attacker, `${victim}:000000000000`, didOf(victim)), refused('invalid_link_code', 401));
  assert.equal(d.body(victim), untouched, 'an account with no live code is not written by a stranger\'s request');
  // The attacker's own account's code does not open the victim's account: the hash is over the account's id too.
  const mine = parseLinkCode((await d.link.issueCode(attackerAccount)).code)!;
  await assert.rejects(d.ask(attacker, `${victim}:${mine.secret}`, didOf(victim)), refused('invalid_link_code', 401));
  assert.equal(d.body(victim), untouched);
  // Accounts that are not there, are deleted, or hold no credential answer as a wrong code does.
  d.account('u-eth-dead00000001', 'Gone'); d.edit('u-eth-dead00000001', document => { document['deletedAt'] = '2026-01-01'; document['walletAddresses'] = []; });
  for (const id of ['u-eth-none00000001', 'u-eth-dead00000001', attackerGuest]) {
    await assert.rejects(d.ask(attacker, `${id}:000000000000`), refused('invalid_link_code', 401), id);
  }
  for (const malformed of ['', victim, `${victim}:short`, `${victim}:OOOOOOOOOOOO`, `../x:000000000000`, `${victim}:0000-0000-0000`, 7]) {
    await assert.rejects(d.ask(attacker, malformed as string), refused('invalid_link_code', 401), String(malformed));
  }

  // The victim asks for a code. The attacker guesses: each wrong guess is counted on the record, and
  // after LINK_CODE_MAX_ATTEMPTS the code is over, the right code included.
  const real = (await d.link.issueCode(victim)).code;
  for (let attempt = 1; attempt <= LINK_CODE_MAX_ATTEMPTS; attempt++) {
    await assert.rejects(d.ask(attacker, `${victim}:00000000000${attempt}`, didOf(victim)), refused('invalid_link_code', 401));
    assert.equal((d.record(victim)['guestLinkCode'] as { attempts: number }).attempts, attempt);
  }
  await assert.rejects(d.ask(attacker, `${victim}:000000000009`), refused('link_code_attempts_exceeded', 429));
  await assert.rejects(d.ask(attacker, real, didOf(victim)), refused('link_code_attempts_exceeded', 429), 'the right code no longer links once the guesses are spent');
  assert.equal((d.record(victim)['guestLinkCode'] as { attempts: number }).attempts, LINK_CODE_MAX_ATTEMPTS, 'nothing more is written');
  assert.equal(d.record(victim)['linkedGuests'], undefined);
  assert.equal(d.record(attackerGuest)['provisionalGuestLinkedTo'], undefined);
  // A new code from the owner starts again, and ends the old one.
  const pair = newPair(); await d.enter(pair);
  const fresh = (await d.link.issueCode(victim)).code;
  await assert.rejects(d.linkTo(pair, real), refused('invalid_link_code', 401));
  assert.equal((await d.linkTo(pair, fresh)).linked, true);
});

test('a code links one guest once: replay, a second guest, and an expired code are refused', async () => {
  const d = deployment();
  const owner = d.account('u-eth-aaaa00000004', 'Onur Halvorsrud');
  const pair = newPair(); const guestId = guestIdOf(pair);
  await d.enter(pair);
  const code = (await d.link.issueCode(owner)).code;
  const expiresAt = soon();
  const request = { publicKeyJwk: jwkOf(pair), code, expiresAt, account: didOf(owner), proof: sign(pair, linkProofPayload(ISSUER, thumbprintOf(pair), code, expiresAt, didOf(owner))) };
  assert.equal((await d.link.link(request, ISSUER)).linked, true);
  // The same guest asking again is told it is linked (the answer to a lost response), and nothing changes.
  const written = d.body(owner);
  assert.deepEqual(await d.link.link(request, ISSUER), { linked: true, account: { did: didOf(owner), userId: owner, name: 'Onur Halvorsrud' } });
  assert.equal(d.body(owner), written);
  // Another guest holding the same code gets nothing: it was spent.
  const second = newPair(); await d.enter(second);
  await assert.rejects(d.linkTo(second, code), refused('invalid_link_code', 401));
  assert.equal((d.record(owner)['linkedGuests'] as unknown[]).length, 1);
  // After an unlink, the recorded request is not a way back in.
  await d.link.unlink(owner, guestId);
  await assert.rejects(d.link.link(request, ISSUER), refused('invalid_link_code', 401));
  assert.equal(d.record(guestId)['provisionalGuestLinkedTo'], undefined);

  // An expired code is a wrong code, and is not counted against.
  const late = (await d.link.issueCode(owner)).code;
  d.edit(owner, document => { (document['guestLinkCode'] as { expiresAt: number }).expiresAt = Math.floor(Date.now() / 1000) - 1; });
  const stale = d.body(owner);
  await assert.rejects(d.linkTo(pair, late), refused('invalid_link_code', 401));
  assert.equal(d.body(owner), stale);
  // A proof that is too old, or too far ahead, is refused before anything is read.
  for (const at of [Math.floor(Date.now() / 1000) - 1, Math.floor(Date.now() / 1000) + 600, 1.5, '1']) {
    await assert.rejects(d.link.link({ publicKeyJwk: jwkOf(pair), code: late, expiresAt: at, proof: 'x' }, ISSUER), refused('invalid_browser_proof', 401), String(at));
  }
});

test('a guest that is claimed, or linked to another account, is not linked; a linked guest is not claimed', async () => {
  const d = deployment();
  const first = d.account('u-eth-aaaa00000005', 'Sunniva Okonjo');
  const second = d.account('u-eth-aaaa00000006', 'Bartek Lindqvist');
  const pair = newPair(); const guestId = guestIdOf(pair);
  await d.enter(pair);
  await d.linkTo(pair, (await d.link.issueCode(first)).code);
  // Linked to the first account: the second account's code does not take it, and stays unspent.
  const other = (await d.link.issueCode(second)).code;
  await assert.rejects(d.linkTo(pair, other), refused('guest_already_linked', 409));
  assert.equal((d.record(guestId)['provisionalGuestLinkedTo'] as { userId: string }).userId, first);
  assert.equal(d.record(second)['linkedGuests'], undefined);
  assert.ok(d.record(second)['guestLinkCode']);
  // The door does not open the claim flow for a linked guest.
  const claimAt = soon();
  const claimWith = (at: number) => d.door.claim({ publicKeyJwk: jwkOf(pair), expiresAt: at, proof: sign(pair, claimProofPayload(ISSUER, thumbprintOf(pair), at)) }, ISSUER);
  await assert.rejects(claimWith(claimAt), refused('guest_linked', 409));
  // Unlinked, it can be claimed; and should a credential reach a linked guest all the same, the link is no longer stated.
  await d.link.unlink(first, guestId);
  assert.equal((await claimWith(claimAt + 1)).token, 'guest-token');
  await d.linkTo(pair, (await d.link.issueCode(first)).code);
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], didOf(first));
  d.edit(guestId, document => { document['walletAddresses'] = [`0x${'ab'.repeat(20)}`]; });
  const claimed = await d.enter(pair);
  assert.equal(claimed.subjectAttributes['claimed'], true);
  assert.equal(claimed.subjectAttributes['linkedTo'], undefined, 'a claimed guest is an account of its own');
  // A claimed guest is not linked.
  await assert.rejects(d.linkTo(pair, other), refused('guest_already_claimed', 409));
  // A key with no guest has nothing to link.
  await assert.rejects(d.linkTo(newPair(), other), refused('provisional_owner_unavailable', 401));
});

test('a link whose second write failed states nothing, and the retry completes it', async () => {
  const d = deployment();
  const owner = d.account('u-eth-aaaa00000007', 'Ragnhild Abernethy');
  const pair = newPair(); const guestId = guestIdOf(pair);
  await d.enter(pair);
  const code = (await d.link.issueCode(owner)).code;
  const shown = await d.ask(pair, code);
  // The guest's record is written, then the account's write is refused by the pod.
  const ownerBefore = d.body(owner);
  d.failing.push(`${owner}/`);
  await assert.rejects(d.ask(pair, code, shown.account.did), (error: unknown) => !(error instanceof PlayError));
  assert.equal((d.record(guestId)['provisionalGuestLinkedTo'] as { userId: string }).userId, owner, 'the guest\'s side was written');
  assert.equal(d.body(owner), ownerBefore, 'the account\'s was not, and its code is unspent');
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], undefined, 'one side alone is not a link');
  assert.deepEqual(await d.link.list(owner), []);
  // The same request again completes the link.
  assert.equal((await d.ask(pair, code, shown.account.did)).linked, true);
  assert.equal((d.record(owner)['linkedGuests'] as Array<{ userId: string }>)[0]!.userId, guestId);
  assert.equal(d.record(owner)['guestLinkCode'], undefined);
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], didOf(owner));

  // A guest left with one side only (the code expired before any retry) is not stuck with it: another account's link replaces it.
  const stuck = newPair(); const stuckId = guestIdOf(stuck);
  await d.enter(stuck);
  const lost = (await d.link.issueCode(owner)).code;
  d.failing.push(`${owner}/`);
  await assert.rejects(d.linkTo(stuck, lost));
  const elsewhere = d.account('u-eth-aaaa00000008', 'Casimir Thorvaldsen');
  assert.equal((await d.linkTo(stuck, (await d.link.issueCode(elsewhere)).code)).linked, true);
  assert.equal((d.record(stuckId)['provisionalGuestLinkedTo'] as { userId: string }).userId, elsewhere);
  assert.equal((await d.enter(stuck)).subjectAttributes['linkedTo'], didOf(elsewhere));
  assert.equal((d.record(owner)['linkedGuests'] as unknown[]).length, 1, 'the first account lists only the guest it confirmed');

  // An unlink whose second write failed leaves nothing stated, and its retry clears the guest's side.
  d.failing.push(`${guestId}/`);
  await assert.rejects(d.link.unlink(owner, guestId));
  assert.equal(d.record(owner)['linkedGuests'], undefined);
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], undefined);
  assert.ok(d.record(guestId)['provisionalGuestLinkedTo']);
  assert.deepEqual(await d.link.unlink(owner, guestId), { unlinked: true, wasLinked: true });
  assert.equal(d.record(guestId)['provisionalGuestLinkedTo'], undefined);
});

test('the link is stated only while the account stands: its deletion, or the loss of its last credential, ends it', async () => {
  const d = deployment();
  const owner = d.account('u-eth-aaaa00000009', 'Halldora Mbeki');
  const pair = newPair(); const guestId = guestIdOf(pair);
  await d.enter(pair);
  await d.linkTo(pair, (await d.link.issueCode(owner)).code);
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], didOf(owner));
  // The guest's own record cannot make itself linked: an account that does not list it confirms nothing.
  const elsewhere = d.account('u-eth-aaaa0000000a', 'Not listing anyone');
  d.edit(guestId, document => { document['provisionalGuestLinkedTo'] = { userId: elsewhere, linkedAt: 1 }; });
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], undefined);
  d.edit(guestId, document => { document['provisionalGuestLinkedTo'] = { userId: guestId, linkedAt: 1 }; });
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], undefined, 'a guest is not linked to itself');
  d.edit(guestId, document => { document['provisionalGuestLinkedTo'] = { userId: owner, linkedAt: 1 }; });
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], didOf(owner));
  // An entry for another key under this guest's id confirms nothing.
  d.edit(owner, document => { (document['linkedGuests'] as Array<{ proofKeyThumbprint: string }>)[0]!.proofKeyThumbprint = 'another-key'; });
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], undefined);
  d.edit(owner, document => { (document['linkedGuests'] as Array<{ proofKeyThumbprint: string }>)[0]!.proofKeyThumbprint = thumbprintOf(pair); });
  // An account that no longer holds a credential is nobody's main account.
  const wallets = d.record(owner)['walletAddresses'];
  d.edit(owner, document => { document['walletAddresses'] = []; });
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], undefined);
  d.edit(owner, document => { document['walletAddresses'] = wallets; });
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], didOf(owner));
  // The account is deleted: its tombstone lists nobody.
  d.edit(owner, document => { for (const key of Object.keys(document)) if (key !== 'userId') delete document[key]; document['deletedAt'] = '2026-11-14'; });
  assert.equal((await d.enter(pair)).subjectAttributes['linkedTo'], undefined);
  await assert.rejects(d.link.issueCode(owner), refused('link_account_unavailable', 409));
  await assert.rejects(d.link.unlink(owner, guestId), refused('link_account_unavailable', 409));
  await assert.rejects(d.link.issueCode(guestId), refused('link_account_unavailable', 409), 'an unclaimed guest is not an account a guest is linked to');
});

test('an account holds a bounded number of live guests, and a new code drops the ones whose standing has ended', async () => {
  const d = deployment();
  const owner = d.account('u-eth-aaaa0000000b', 'Wojciech Adeyemi');
  const now = Math.floor(Date.now() / 1000);
  const row = (index: number, standingUntil: number) => ({ userId: `u-try-guest-${index.toString(16).padStart(32, '0')}`, proofKeyThumbprint: `key-${index}`, linkedAt: now - 10, standingUntil });
  d.edit(owner, document => { document['linkedGuests'] = Array.from({ length: MAX_LINKED_GUESTS }, (_, index) => row(index, now + 3600)); });
  const pair = newPair(); await d.enter(pair);
  const code = (await d.link.issueCode(owner)).code;
  await assert.rejects(d.linkTo(pair, code), refused('linked_guest_capacity', 429));
  assert.equal(d.record(guestIdOf(pair))['provisionalGuestLinkedTo'], undefined, 'refused before the guest\'s record is written');
  // Two of them have ended: the next code drops them, and there is room.
  d.edit(owner, document => { const rows = document['linkedGuests'] as Array<{ standingUntil: number }>; rows[0]!.standingUntil = now - 1; rows[1]!.standingUntil = now - 1; });
  assert.equal((await d.link.list(owner)).length, MAX_LINKED_GUESTS - 2);
  const next = (await d.link.issueCode(owner)).code;
  assert.equal((d.record(owner)['linkedGuests'] as unknown[]).length, MAX_LINKED_GUESTS - 2);
  assert.equal((await d.linkTo(pair, next)).linked, true);
});

test('with the general guest off there is no link: no code, no door request, no unlink', async () => {
  const d = deployment({ generalGuest: false });
  const owner = d.account('u-eth-aaaa0000000c', 'Ottoline Nakashima');
  const before = d.body(owner);
  const pair = newPair();
  await assert.rejects(d.link.issueCode(owner), refused('general_guest_disabled', 404));
  await assert.rejects(d.ask(pair, `${owner}:000000000000`), refused('general_guest_disabled', 404));
  await assert.rejects(d.link.unlink(owner, guestIdOf(pair)), refused('general_guest_disabled', 404));
  await assert.rejects(d.link.list(owner), refused('general_guest_disabled', 404));
  assert.equal(d.body(owner), before);
  assert.equal((d.play.metadata() as Record<string, unknown>)['generalGuest'], undefined);
});
