/**
 * IS END-TO-END ENCRYPTION ACTUALLY REACHABLE ON THE LIVE FLEET?
 *
 * Everything else in this work is unit-tested against real cryptography, and none of it proves the
 * DEPLOYED relay does what the repository says. This does the whole round trip against production:
 * register a key the relay does not hold the secret to, publish something sealed to it, fetch the
 * sealed bytes back, and open them here.
 *
 * ── ★★ WHY IT OPENS THE BYTES RATHER THAN READING A REGISTRY FIELD ──────────
 *
 * The first version of this probe asked `get_pod_status` whether the registry had kept the supplied
 * key. That assertion could never fail for the right reason: the pod-status projection emits
 * `agentId, scope, label, validFrom` and NO `encryptionPublicKey`, so a clobbered key and a kept key
 * produce byte-identical responses. It reported FAIL against a relay that was fine.
 *
 * Opening the envelope is the falsifiable form. If the relay stamps its own key over the supplied
 * one — which every registration site used to do — then no `wrappedKeys` entry names this client and
 * the open comes back `not-for-you`. There is no way for that to pass by accident.
 *
 * Three facts, and only a live run can establish them:
 *
 *   1. `get_encrypted_graph` is ADVERTISED — an agent discovers what it may do from `tools/list`,
 *      so a tool nothing lists is a tool that does not exist. This was already wrong once: the
 *      handler and dispatch entry shipped without the declaration.
 *   2. the graph comes back as SEALED BYTES, not plaintext and not a refusal.
 *   3. this client opens them with a secret the relay never saw — and a DIFFERENT identity does not.
 *
 * ★ It runs entirely on a throwaway wallet's own pod: one publish, to a pod that did not exist a
 * second earlier, naming no other pod and no other person.
 *
 * ── RUNNING IT ──────────────────────────────────────────────────────────────
 *
 * Bundled first, unlike its `npx tsx` siblings, and that is forced rather than chosen: it imports
 * the desktop app's real `openGraph` — testing the SHIPPING opener rather than a copy of it is the
 * whole point — and the desktop package is CommonJS. Under tsx that makes it `require()`
 * `@interego/core`, whose exports map is import-only, and the run dies before it starts. esbuild
 * to CJS is also what the desktop itself does, so this exercises the same composition the app has.
 * (Bundling to ESM instead fails differently: tweetnacl needs a real `require('crypto')`.)
 *
 * From the repo root:
 *   npx esbuild applications/shared-workspace/tools/probe-e2e-live.ts \
 *     --bundle --format=cjs --platform=node --target=es2022 --outfile=/tmp/probe-e2e.cjs
 *   node /tmp/probe-e2e.cjs
 *
 * `PROBE_DEBUG=1` additionally dumps the publish response and the descriptor it wrote.
 */
import { Wallet } from 'ethers';
import { deriveEncryptionKeyPair } from '@interego/core';
import { openGraph } from '../../../packages/workspace-client/src/opener.js';
import { mintBearer } from './live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

let bad = 0;
const check = (ok: boolean, what: string, detail?: string): void => {
  if (!ok) bad++;
  // Detail is the evidence for a FAILURE. Printing it under a pass reads as a complaint about a
  // check that succeeded — the marker assertion did exactly that.
  process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + what + (!ok && detail ? '\n        ' + detail : '') + '\n');
};

/** One MCP call, unwrapping the SSE framing the relay answers with. */
async function callTool(bearer: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(RELAY + '/mcp', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + bearer,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
  const body = JSON.parse(line.replace(/^data: /, '')) as { result?: { content?: { text?: string }[] } };
  const inner = body.result?.content?.[0]?.text;
  try { return inner ? JSON.parse(inner) : body; } catch { return inner ?? body; }
}

async function main(): Promise<void> {
  const wallet = Wallet.createRandom();
  process.stdout.write('\nminting a throwaway identity on the live fleet…\n');
  const bearer = await mintBearer(RELAY, IDENTITY, {
    address: wallet.address,
    signMessage: (m: string) => wallet.signMessage(m),
  });
  process.stdout.write('  identity: ' + wallet.address.slice(0, 12) + '…\n\n');

  // 1 · advertised
  const listResp = await fetch(RELAY + '/mcp', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + bearer.accessToken, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const listText = await listResp.text();
  check(listText.includes('get_encrypted_graph'),
    '★ get_encrypted_graph is ADVERTISED, so an agent can discover it',
    listResp.ok ? undefined : 'tools/list answered ' + listResp.status);

  // 2 · register a key whose secret stays in this process
  const mine = deriveEncryptionKeyPair(wallet.privateKey, 'did:probe:e2e');
  const agentId = 'urn:agent:probe:e2e-' + Date.now();
  await callTool(bearer.accessToken, 'register_agent', {
    agent_id: agentId, scope: 'ReadWrite', encryption_public_key: mine.publicKey,
  });

  // 3 · publish sealed. `shared` encrypts to this pod's own authorized agents, which is now the
  // agent registered above — no other pod is named and nothing is shared with anyone.
  const marker = 'probe-secret-' + wallet.address.slice(2, 14);
  const graphIri = 'urn:graph:probe:e2e:' + Date.now();
  const published = await callTool(bearer.accessToken, 'publish_context', {
    graph_iri: graphIri,
    graph_content: '<' + graphIri + '> <http://purl.org/dc/terms/title> "' + marker + '" .',
    visibility: 'shared',
    context_summary: 'end-to-end encryption probe',
  }) as { descriptorUrl?: string; error?: string; message?: string };
  if (process.env['PROBE_DEBUG']) process.stdout.write('  published: ' + JSON.stringify(published).slice(0, 400) + '\n');

  if (!published.descriptorUrl) {
    check(false, '★ a sealed graph was published to the throwaway pod',
      'publish_context returned no descriptorUrl: ' + JSON.stringify(published).slice(0, 240));
    return done();
  }

  /**
   * 4 · fetch the sealed bytes and open them here.
   *
   * ★ THE PUBLISH IS DEFERRED. It answers `status: "pending"` with the descriptor URL it WILL
   * write, and the pod write commits after the tool call returns. Fetching immediately reads a 404
   * and reports it as `descriptor could not be retrieved` — which looks exactly like a broken
   * end-to-end path and is really just a race. So this waits for the descriptor to land, and says
   * so if it never does rather than blaming the encryption.
   */
  let sealed: unknown = null;
  const deadline = Date.now() + 60_000;
  for (;;) {
    sealed = await callTool(bearer.accessToken, 'get_encrypted_graph', { url: published.descriptorUrl });
    const err = (sealed as { error?: string } | null)?.error;
    if (!err || !/could not be retrieved/.test(err) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (process.env['PROBE_DEBUG']) {
    const gd = await callTool(bearer.accessToken, 'get_descriptor', { url: published.descriptorUrl }) as Record<string, unknown>;
    process.stdout.write('  descriptor keys: ' + Object.keys(gd).join(', ') + '\n');
    process.stdout.write('  graph: ' + JSON.stringify(gd['graph']).slice(0, 300) + '\n');
    const ttl = String(gd['turtle'] ?? '');
    for (const line of ttl.split('\n')) {
      if (/accessURL|distribution|jose|payload|envelope|trig/i.test(line)) process.stdout.write('  ttl| ' + line.trim() + '\n');
    }
  }

  const opened = openGraph(sealed, mine);
  check(opened.kind === 'opened',
    '★★ the sealed graph OPENED with a secret the relay never saw — this is the end-to-end claim',
    opened.kind === 'opened' ? undefined
      : opened.kind + ': ' + ('why' in opened ? opened.why : '')
        + (opened.kind === 'plaintext' ? ' — the relay served PLAINTEXT for a shared graph' : ''));
  check(opened.kind === 'opened' && opened.content.includes(marker),
    '  and what came out is what went in',
    opened.kind === 'opened' ? 'no marker in ' + opened.content.slice(0, 120) : 'nothing opened');

  /**
   * ★ AND IT IS ADDRESSED, NOT MERELY ENCRYPTED. An envelope every key opens would pass every
   * assertion above. A key belonging to nobody on this pod must be refused — and refused as a
   * permission rather than reported as damage.
   */
  const stranger = deriveEncryptionKeyPair(Wallet.createRandom().privateKey, 'did:probe:stranger');
  const strangerSees = openGraph(sealed, stranger);
  check(strangerSees.kind === 'not-for-you',
    '★ an unrelated identity is refused, so the envelope is addressed rather than open',
    strangerSees.kind);

  return done();
}

function done(): void {
  process.stdout.write(bad
    ? '\n' + bad + ' problem(s) — end-to-end is NOT reachable as deployed\n'
    : '\nend-to-end holds on the live fleet: sealed by the relay, opened only by the holder\n');
  process.exit(bad ? 1 : 0);
}

main().catch((e: unknown) => {
  process.stdout.write('\nthe probe could not complete: ' + ((e as Error)?.message ?? String(e)) + '\n');
  process.exit(1);
});
