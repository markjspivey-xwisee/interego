/**
 * IS THE RELAY OUT OF THE ENVELOPE, AND DID IT EVER SEE THE WORDS?
 *
 * ── ★★ THE TWO CLAIMS, AND WHY NEITHER IS OBVIOUS FROM ANYTHING ELSE ────────
 *
 * Every other test of private workspaces — B opens it, a stranger is refused, the roster resolves,
 * the chain holds — passes exactly as well when the relay is ALSO a recipient. It was, for the
 * whole first day of this work: `authorEncryptionKey` is hardcoded to `relayAgentKey.publicKey`,
 * and `drive-private-workspace-live.ts` still asserts that as today's truth on the unsealed path.
 * So the sealed path needs its own proof, and it is exactly two statements:
 *
 *   1. THE RELAY IS NOT A RECIPIENT of the envelope that landed on the pod.
 *   2. THE RELAY NEVER RECEIVED THE PLAINTEXT in the first place.
 *
 * The second matters independently. An envelope the relay is absent from is worthless if the relay
 * read the words on the way past — and the old path did precisely that, which is why "just remove
 * the relay's key from the recipient list" would not have been a fix.
 *
 * ── ★ HOW EACH IS ESTABLISHED SO IT CANNOT PASS FOR THE WRONG REASON ────────
 *
 * (1) needs the relay's public key from a source that is not the envelope, or "not present" and
 * "we looked for nothing" are the same green tick. It comes from the `/render` 403 `NotARecipient`
 * body, which names `relayAgentPublicKey` — a refusal the relay can only give for an envelope it
 * is genuinely absent from, so the response both provides the key and corroborates the claim. The
 * probe fails if that lookup comes back empty.
 *
 * (2) is asserted on the REQUEST, before it is sent: a high-entropy marker generated in-process,
 * embedded in the entry, and searched for in the exact bytes handed to the relay. Then searched
 * for again in everything the relay hands back. The honest limit is stated in the run: this proves
 * the tool was not GIVEN the plaintext and cannot afterwards produce it; only a wire capture
 * proves an absolute negative.
 *
 * Run it bundled, like its siblings (see `probe-e2e-live.ts` for why tsx cannot):
 *   npx esbuild applications/shared-workspace/tools/probe-sealed-live.ts \
 *     --bundle --format=cjs --platform=node --target=es2022 --outfile=/tmp/probe-sealed.cjs
 *   node /tmp/probe-sealed.cjs
 */

import { Wallet } from 'ethers';
import { deriveEncryptionKeyPair, openEncryptedEnvelope, type EncryptedEnvelope } from '@interego/core';
import { sealForRoster } from '@interego/workspace-client/sealer';
import { mintBearer } from './live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

let bad = 0;
const log = (...a: unknown[]): void => { process.stdout.write(a.join(' ') + '\n'); };
const head = (t: string): void => { log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 74 - t.length))); };
const must = (what: string, ok: boolean, detail = ''): void => {
  if (!ok) bad++;
  log((ok ? '  PASS  ' : '  FAIL  ') + what + (!ok && detail ? '\n        ' + detail : ''));
};

/** One MCP call. Returns the parsed result AND the exact body that was sent. */
async function callTool(bearer: string, name: string, args: Record<string, unknown>): Promise<{ result: unknown; sentBody: string }> {
  const sentBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const r = await fetch(RELAY + '/mcp', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + bearer, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: sentBody,
  });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
  const body = JSON.parse(line.replace(/^data: /, '')) as { result?: { content?: { text?: string }[] } };
  const inner = body.result?.content?.[0]?.text;
  let result: unknown;
  try { result = inner ? JSON.parse(inner) : body; } catch { result = inner ?? body; }
  return { result, sentBody };
}

async function main(): Promise<number> {
  head('one throwaway identity, holding its own key');
  const w = Wallet.createRandom();
  const bearer = await mintBearer(RELAY, IDENTITY, { address: w.address, signMessage: (m: string) => w.signMessage(m) });
  const me = deriveEncryptionKeyPair(w.privateKey);
  log('  ' + w.address.slice(0, 12) + '… · key ' + me.publicKey.slice(0, 12) + '…');

  /**
   * ★ SEALED WITH THE SHIPPING SEALER, NOT A COPY. A probe that built its own envelope would prove
   * something about the probe. This is the exact function the desktop's main process calls.
   */
  head('seal locally — the words never enter a request');
  const marker = 'MARKER-' + w.address.slice(2, 22).toUpperCase();
  const graphIri = 'urn:graph:sealedprobe:' + Date.now();
  const payload = '@prefix dct: <http://purl.org/dc/terms/> .\n'
    + '<' + graphIri + '> dct:description "' + marker + '" .';
  const sealed = sealForRoster({ graphIri, payloadTurtle: payload, recipientKeys: [me.publicKey], sender: me });
  must('the sealer produced an envelope', sealed.ok, sealed.ok ? '' : sealed.why);
  if (!sealed.ok) return bad;
  must('★ and the ciphertext does not contain the words, which is what sealing means',
    !sealed.graphContent.includes(marker), 'the marker survived into the envelope in the clear');

  head('★★ publish it — and prove the relay was never given the plaintext');
  const pub = await callTool(bearer.accessToken, 'publish_context', {
    graph_iri: graphIri,
    graph_content: sealed.graphContent,
    sealed_payload: true,
    content_digest: sealed.contentDigest,
    cleartext_mirror: sealed.cleartextMirror,
    visibility: 'shared',
    context_summary: 'sealed-path probe',
  });
  /**
   * ★★ ASSERTED ON THE BYTES THAT WERE SENT. Not on a flag, not on the response — on the actual
   * request. Every flag can be right while `graph_content` still carries the words; that mistake
   * was made once during this work and only this shape of assertion caught it.
   */
  must('★★ the marker appears NOWHERE in the request the relay received',
    !pub.sentBody.includes(marker),
    'the plaintext was in the request body, so the relay saw it whatever the envelope says');

  const res = pub.result as { published?: boolean; descriptorUrl?: string; encrypted?: boolean; sealedByPublisher?: boolean; error?: string; message?: string };
  must('the relay accepted it', !!res.descriptorUrl, JSON.stringify(res).slice(0, 300));
  if (!res.descriptorUrl) return bad;
  must('★ and the marker is not in what it answered either',
    !JSON.stringify(res).includes(marker), 'the response echoed the plaintext back');

  head('★★ is the relay a recipient of what landed?');
  let envelopeJson = '';
  for (const deadline = Date.now() + 60_000; ;) {
    const got = await callTool(bearer.accessToken, 'get_encrypted_graph', { url: res.descriptorUrl });
    const g = got.result as { envelope?: string; error?: string; content?: string };
    if (g.envelope) { envelopeJson = g.envelope; break; }
    /**
     * ★ PLAINTEXT HERE WOULD BE A FAILURE, NOT A CONVENIENCE. If the relay can hand back the words
     * it opened the envelope, which is the whole thing being disproved.
     */
    if (typeof g.content === 'string' && g.content.includes(marker)) {
      must('★★ the relay handed back PLAINTEXT for a sealed graph', false, 'it opened the envelope');
      return bad;
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  must('the sealed bytes came back', envelopeJson !== '', 'get_encrypted_graph never produced an envelope');
  if (!envelopeJson) return bad;

  /**
   * ★★ THE RELAY'S KEY FROM A SOURCE THAT IS NOT THIS ENVELOPE. `/render` answers 403
   * `NotARecipient` and names `relayAgentPublicKey` — a refusal it can only give for an envelope it
   * is genuinely absent from, so the response supplies the key AND corroborates the claim. An empty
   * lookup is failed explicitly: otherwise "the relay is not in the list" passes identically when
   * there was no key to look for.
   */
  const renderResp = await fetch(RELAY + '/render/' + encodeURIComponent(res.descriptorUrl), {
    headers: { 'Accept': 'application/ld+json', 'Authorization': 'Bearer ' + bearer.accessToken },
  });
  const renderBody = await renderResp.json().catch(() => ({})) as { relayAgentPublicKey?: string; '@type'?: unknown };
  const relayKey = String(renderBody.relayAgentPublicKey ?? '');
  must('★ /render named the relay\'s own key, so this check can fail', relayKey !== '',
    'GET /render answered ' + renderResp.status + ' without relayAgentPublicKey: ' + JSON.stringify(renderBody).slice(0, 200));
  must('★★ /render REFUSED — the relay cannot project what it cannot read', renderResp.status === 403,
    'it answered ' + renderResp.status + ', so it opened the envelope');

  const envelope = JSON.parse(envelopeJson) as EncryptedEnvelope;
  const recipients = envelope.wrappedKeys.map((k) => k.recipientPublicKey);
  log('    recipients: ' + recipients.map((k) => (k === me.publicKey ? 'ME' : k === relayKey ? 'THE RELAY' : 'UNKNOWN') + ' ' + k.slice(0, 12) + '…').join(', '));
  must('★★ THE RELAY IS NOT A RECIPIENT — this is the claim the whole change exists for',
    relayKey !== '' && !recipients.includes(relayKey),
    'the relay is still in the envelope, so this is escrow and the word "end-to-end" does not apply');
  must('★ and the only recipient is the one that was sealed to',
    recipients.length === 1 && recipients[0] === me.publicKey, recipients.join(', '));

  head('★ and it is still readable by the person who sealed it');
  const opened = openEncryptedEnvelope(envelope, me);
  must('the holder opens it', opened !== null, 'the envelope would not open with the key that sealed it');
  must('★ and the words are the words', (opened ?? '').includes(marker), 'opened, but the marker is not in it');
  const stranger = deriveEncryptionKeyPair(Wallet.createRandom().privateKey);
  must('★ a stranger does not', openEncryptedEnvelope(envelope, stranger) === null, 'an unrelated key opened it');

  head('★ the descriptor says which side of the line this record is on');
  must('it declares iep:sealedByPublisher', res.sealedByPublisher === true || res.encrypted === true,
    JSON.stringify({ sealedByPublisher: res.sealedByPublisher, encrypted: res.encrypted }));

  return bad;
}

main().then((n) => {
  log(n
    ? '\n' + n + ' problem(s) — the sealed path does NOT hold'
    : '\nthe relay stored bytes it never saw the inside of and is not a recipient of.\n'
      + 'Honest limit: this proves the relay was not GIVEN the plaintext and cannot produce it\n'
      + 'afterwards. Only a wire capture proves an absolute negative.');
  process.exit(n ? 1 : 0);
}).catch((e: unknown) => {
  log('\nthe probe could not complete: ' + ((e as Error)?.stack ?? String(e)));
  process.exit(1);
});
