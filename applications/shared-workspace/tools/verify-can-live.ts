#!/usr/bin/env tsx
/**
 * Increment 4 against the live substrate: authority, refused for real.
 *
 * Two layers refuse, and they refuse different things. Showing both together is the point,
 * because each on its own would misrepresent what this design can promise.
 *
 *   THE SUBSTRATE refuses a caller writing to someone else's pod. A hard, preventive
 *   refusal — 403 scope_violation, nothing lands.
 *
 *   THE WORKSPACE cannot refuse a member writing to their OWN pod, and does not pretend
 *   to. It is their pod. What it refuses is to COUNT the entry: an Observer's write
 *   succeeds at the substrate and is then not folded in, and the view says why.
 *
 * The second is the honest shape of authority in a federated design. Unauthorised writes
 * are not prevented; they are inert. That is auditable by anyone who can read the records,
 * including someone who is not a member and does not trust us — which a promise about a
 * server's behaviour is not.
 *
 * ★ SECTIONS 1–5 BUILD THE ROSTER BY HAND, AND THAT IS WHY THEY COULD NEVER HAVE ESTABLISHED
 * TWO-SIDEDNESS. An independent review pointed out that this file writes both halves of every
 * membership itself, so 13/13 demonstrated the property by construction: there was no forgery
 * for the fold to refuse, because the harness was the only author of anything.
 *
 * Section 6 exists to close that. It publishes an acceptance from BEE'S OWN SESSION and a
 * forged one for bee from ALICE'S, reads each record's `iep:authorshipProof` back through
 * `get_descriptor` — the relay's verifier, not this harness's opinion — and requires the fold
 * to admit the first and refuse the second. Neither attestation is written here; both are
 * whatever the substrate says.
 *
 * ★ AND SECTION 6'S TWO HEADLINE ASSERTIONS USED TO PASS VACUOUSLY. `publish_context` is
 * deferred unless `compliance`, `sync` or `if_match` is set — `sign_authorship` does NOT
 * force the synchronous path — so all three records were read back with zero wait, every
 * read failed, and the fold refused BOTH acceptances. "The forgery is refused" passed
 * because nothing was readable. An assertion that cannot fail is worse than no assertion,
 * and this pair certified the property the section exists for. It now waits for each record
 * to become readable, asserts the refusal REASON rather than logging it, and states a
 * CONTROL — the genuine half must be ADMITTED — so a run where everything is refused reports
 * itself as having established nothing.
 *
 * ★ SECTIONS 6 AND 7 HAVE STILL NOT BEEN RUN AGAINST THE LIVE SUBSTRATE. No bearer pair has
 * been available. Whether the assertions hold now that they CAN fail is therefore unknown,
 * and nothing in this file or the README claims otherwise.
 *
 * Usage:
 *   IEP_BEARER=<token-a> IEP_BEARER_B=<token-b> \
 *     npx tsx applications/shared-workspace/tools/verify-can-live.ts [run-id]
 */

import { appendEntry, readAttestation, type StreamDeps } from '../src/stream.js';
import { composeWorkspace, type ComposableMember } from '../src/compose.js';
import {
  authorizeView, scopesFromRegistry, signerIndexFromRegistry, canAct, CAPS, foldRoster,
  type RoleProfile, type Attestation,
} from '../src/can.js';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const BEARER = process.env.IEP_BEARER;
const BEARER_B = process.env.IEP_BEARER_B;
if (!BEARER || !BEARER_B) { console.error('IEP_BEARER and IEP_BEARER_B are both required.'); process.exit(2); }

const RUN = process.argv[2] ?? String(Date.now());
const WS = `${RELAY}/ns/maintainer/wsp-can-${RUN}`;
const P = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default';

let pass = 0, fail = 0;
const ok = (c: boolean, n: string, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `\n         ${d}` : ''}`); }
};

let id = 400;
async function callAs(bearer: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(raw); } catch {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    try { j = JSON.parse(data); } catch { /* neither */ }
  }
  const text = (j as { result?: { content?: { text?: string }[] } })?.result?.content?.[0]?.text;
  try { return JSON.parse(text ?? '{}'); } catch { return { raw: text ?? raw }; }
}
const deps = (bearer: string): StreamDeps => ({
  publish: a => callAs(bearer, 'publish_context', a),
  discover: a => callAs(bearer, 'discover_context', a),
  getDescriptor: a => callAs(bearer, 'get_descriptor', a),
});

const PROFILE: RoleProfile = {
  profile: P,
  roles: [
    { role: `${P}#Contributor`, permits: [CAPS.read, CAPS.append] },
    { role: `${P}#Observer`, permits: [CAPS.read] },
  ],
};

async function main(): Promise<void> {
  const sa = await callAs(BEARER, 'get_pod_status', {});
  const sb = await callAs(BEARER_B, 'get_pod_status', {});
  const podA = String(sa.pod ?? sa.podUrl ?? '');
  const podB = String(sb.pod ?? sb.podUrl ?? '');
  const alice = String(sa.webId);
  const bee = String(sb.webId);
  if (podA === podB) { console.error('same pod — proves nothing'); process.exit(2); }

  console.log(`\nworkspace: ${WS}\nalice: ${alice}\n  pod: ${podA}\nbee:   ${bee}\n  pod: ${podB}\n`);

  // ── the real registry supplies the ceiling, not this test ──
  console.log('1. the delegated scope comes from the substrate\'s own agent registry');
  const agentsA = (sa.agents ?? []) as { did?: string; scope?: string }[];
  const agentsB = (sb.agents ?? []) as { did?: string; scope?: string }[];
  ok(agentsA.length > 0 && agentsB.length > 0, 'both principals have registered agents with scopes');
  const scopes = scopesFromRegistry([
    { principal: alice, agents: agentsA },
    { principal: bee, agents: agentsB },
  ]);
  ok(
    scopes.every(s => s.capabilities.length > 0),
    `scopes resolved live: ${agentsA[0]?.scope} / ${agentsB[0]?.scope}`,
  );

  // ── bee is an OBSERVER: the role permits read only ──
  const g = (p: string, role: string) => ({ head: `${WS}/grant/${encodeURIComponent(p)}`, workspace: WS, grantedTo: p, role: `${P}#${role}` });
  const a = (p: string) => ({
    head: `${WS}/accept/${encodeURIComponent(p)}`, workspace: WS, member: p,
    accepts: `${WS}/grant/${encodeURIComponent(p)}`, stream: `${WS}/stream/${p === alice ? 'alice' : 'bee'}`,
  });
  const roster = foldRoster({
    workspace: WS, profile: PROFILE,
    grants: [g(alice, 'Contributor'), g(bee, 'Observer')],
    acceptances: [a(alice), a(bee)],
    scopes,
  });
  ok(roster.members.length === 2, 'both are members');
  ok(!canAct(roster, bee, CAPS.append).allowed, '★ bee is an Observer, so wsp.can refuses append');
  console.log(`     because: ${canAct(roster, bee, CAPS.append).because.slice(0, 120)}…`);

  // ── 2. the substrate's refusal: writing to SOMEONE ELSE'S pod ──
  console.log('\n2. the substrate refuses a write to another principal\'s pod');
  const crossPod = await callAs(BEARER_B, 'publish_context', {
    graph_iri: `${WS}/stream/alice`,
    graph_content: `<${WS}/stream/alice/e/0> <http://purl.org/dc/terms/description> "bee writing into alice's pod" .`,
    visibility: 'public', auto_supersede_prior: false, pod_name: podA.replace(/.*\/([^/]+)\/$/, '$1'),
  });
  ok(
    crossPod.code === 403 || crossPod.error !== undefined,
    `★ refused, and nothing landed (${crossPod.code ?? crossPod.error ?? 'ALLOWED — that would be a hole'})`,
    JSON.stringify(crossPod).slice(0, 200),
  );

  // ── 3. what the substrate CANNOT refuse: bee writing to her OWN pod ──
  console.log('\n3. bee writes to her OWN pod — and it succeeds, because it is her pod');
  const alicePut = await appendEntry(
    { graphIri: `${WS}/stream/alice`, workspace: WS, podUrl: podA }, { body: 'alice, a Contributor' }, deps(BEARER),
  );
  ok(alicePut.outcome === 'appended', 'alice appends to her own stream', JSON.stringify(alicePut).slice(0, 200));

  const beePut = await appendEntry(
    { graphIri: `${WS}/stream/bee`, workspace: WS, podUrl: podB }, { body: 'bee, an Observer, writing anyway' }, deps(BEARER_B),
  );
  ok(
    beePut.outcome === 'appended',
    '★ bee\'s write SUCCEEDS at the substrate — no chokepoint can stop it, and the design says so',
    JSON.stringify(beePut).slice(0, 200),
  );
  // Section 7 verifies these entries' authorship, so whether the relay actually signed them
  // is a precondition of that section meaning anything. `sign_authorship: true` is a request:
  // the relay may catch a signing failure, warn, and publish regardless.
  for (const [who, res] of [['alice', alicePut], ['bee', beePut]] as const) {
    const signing = res.outcome === 'appended' || res.outcome === 'pending' ? res.signing : 'n/a';
    ok(signing !== 'NOT-SIGNED', `${who}'s entry was not published unsigned`, `signing = ${signing}`);
    if (signing === 'unreported') console.log(`     note: the relay did not report signing for ${who}`);
  }

  // ── 4. and the fold refuses to count it ──
  console.log('\n4. the fold refuses to COUNT it — enforcement where it can actually happen');
  const members: ComposableMember[] = [
    { principal: alice, stream: `${WS}/stream/alice`, podUrl: podA },
    { principal: bee, stream: `${WS}/stream/bee`, podUrl: podB },
  ];
  const raw = await composeWorkspace({ workspace: WS, members }, deps(BEARER));
  ok(raw.entries.length === 2, `both entries are readable on the pods (${raw.entries.length})`);

  const view = authorizeView(raw, roster);
  ok(view.entries.length === 1, `★ only one is workspace content (${view.entries.length})`);
  ok(view.entries[0]?.principal === alice, '★ and it is the Contributor\'s');
  ok(view.disallowed.length === 1, 'the Observer\'s entry is REPORTED, not silently filtered');
  ok(view.disallowed[0]?.because.includes('does not permit'), 'with a reason a person can act on');
  console.log(`     ${view.disallowed[0]?.because.slice(0, 150)}…`);

  // ── 5. the excluded entry is still THERE, at its own URL ──
  console.log('\n5. the excluded entry still exists, signed, at its own URL');
  const url = view.disallowed[0]!.entry.descriptorUrl;
  const got = await callAs(BEARER, 'get_descriptor', { url });
  ok(
    got.error === undefined && String((got.graph as { content?: unknown })?.content ?? '').includes('Observer, writing anyway'),
    '★ custody is intact — being excluded is not being deleted',
    JSON.stringify(got).slice(0, 160),
  );

  // ── 6. the half nothing above could establish: WHO WROTE EACH RECORD ──
  //
  // Everything to this point was folded from records this file invented. Here each membership
  // record is really published, by the party it claims to come from, and its authorship is
  // read back through the relay's own verifier.
  console.log('\n6. two-sidedness as a FACT — each half published by whoever it claims to be from');

  const attestationOf = async (bearer: string, url: string): Promise<Attestation> =>
    readAttestation(url, deps(bearer));

  // The record body is deliberately minimal: what is under test is the PROVENANCE the
  // substrate attaches, not the shape of a membership graph.
  //
  // ★ AND IT WAITS, BECAUSE WITHOUT THE WAIT THE TWO ASSERTIONS BELOW CANNOT FAIL.
  //
  // `publish_context` is DEFERRED unless `compliance`, `sync` or `if_match` is set —
  // `sign_authorship` does not force the synchronous path — so all three publishes returned
  // `status: "pending"` with a PREDICTED descriptorUrl, and the reads that followed fired
  // with zero wait. A not-yet-written descriptor answers `{error: 'descriptor could not be
  // retrieved'}`, `readAttestation` turns that into `authorshipVerified: false`, and the fold
  // then refuses BOTH the genuine and the forged acceptance. The two ★ assertions —
  // "manufactured has no members" and "the forgery is in `unattested`" — passed for entirely
  // the wrong reason, with nothing distinguishing "refused because alice signed bee's
  // acceptance" from "refused because nothing was readable yet".
  //
  // An assertion that cannot fail is worse than no assertion, and this pair certified the
  // very property section 6 exists to establish. `appendEntry` already models the wait; this
  // is the same shape, against `get_descriptor` because that is what the reads use.
  const VISIBILITY_BUDGET_MS = 30_000;
  const publishRecord = async (bearer: string, iri: string, label: string): Promise<string | null> => {
    const res = await callAs(bearer, 'publish_context', {
      graph_iri: iri,
      graph_content: `<${iri}> <http://purl.org/dc/terms/description> "${label}" .`,
      visibility: 'public',
      auto_supersede_prior: false,
      sign_authorship: true,
    });
    const url = typeof res.descriptorUrl === 'string' ? res.descriptorUrl : null;
    if (url === null) return null;
    const started = Date.now();
    for (;;) {
      const got = await callAs(bearer, 'get_descriptor', { url });
      if (got.error === undefined) return url;
      if (Date.now() - started >= VISIBILITY_BUDGET_MS) {
        console.log(`     NOT READABLE after ${VISIBILITY_BUDGET_MS}ms: ${url} (${String(got.error)})`);
        return null; // refuse to draw a conclusion from a record nobody can read
      }
      await new Promise(r => setTimeout(r, 500));
    }
  };

  const genuineUrl = await publishRecord(BEARER_B, `${WS}/accept/bee`, 'bee accepts, from her own session');
  const forgedUrl = await publishRecord(BEARER, `${WS}/accept/bee-forged`, 'alice writing bee\'s acceptance');
  const grantUrl = await publishRecord(BEARER, `${WS}/grant/bee`, 'alice, the convener, grants bee Observer');
  ok(
    genuineUrl !== null && forgedUrl !== null && grantUrl !== null,
    'all three membership records landed AND became readable',
    JSON.stringify({ genuineUrl, forgedUrl, grantUrl }),
  );
  if (genuineUrl === null || forgedUrl === null || grantUrl === null) {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }

  const [genuine, forged, grantAtt] = await Promise.all([
    attestationOf(BEARER, genuineUrl),
    attestationOf(BEARER, forgedUrl),
    attestationOf(BEARER, grantUrl),
  ]);
  ok(genuine.authorshipVerified, '★ the relay verifies bee\'s acceptance proof', JSON.stringify(genuine));
  ok(forged.authorshipVerified, 'the forged acceptance ALSO carries a valid proof — signatures are not the discriminator', JSON.stringify(forged));
  ok(
    genuine.signedBy !== forged.signedBy,
    `★ and they name DIFFERENT signers (${genuine.signedBy} vs ${forged.signedBy}) — which is`,
    JSON.stringify({ genuine, forged }),
  );

  // The mapping from signer to principal is each pod's OWN agent registry, which is what
  // makes it evidence: alice cannot add her agent to bee's registry.
  const signerOf = signerIndexFromRegistry([
    { principal: alice, agents: agentsA },
    { principal: bee, agents: agentsB },
  ]);
  const attestedRoster = (acceptanceHead: string, acceptanceAtt: Attestation) => foldRoster({
    workspace: WS, profile: PROFILE, scopes,
    grants: [{ ...g(bee, 'Observer'), head: grantUrl, attestation: grantAtt }],
    acceptances: [{
      head: acceptanceHead, workspace: WS, member: bee,
      accepts: grantUrl, stream: `${WS}/stream/bee`, attestation: acceptanceAtt,
    }],
    attestation: { convener: alice, signerOf },
  });

  const honest = attestedRoster(genuineUrl, genuine);
  ok(honest.membershipGrade === 'attested', 'the roster states that it CHECKED');
  ok(honest.members.length === 1, '★ bee, who really accepted, is a member', JSON.stringify(honest.unattested));

  // ★ THE CONTROL. If the honest half is refused, everything below is refused too and the
  // two assertions after it say nothing at all — which is precisely how they used to pass.
  // Stated as its own line so a reader of the output can see the discrimination was possible.
  ok(
    honest.members.length === 1,
    '★ the CONTROL holds: the genuine acceptance was ADMITTED, so a refusal below discriminates',
    'if this fails, the two assertions that follow prove nothing — every record was refused',
  );

  const manufactured = attestedRoster(forgedUrl, forged);
  ok(manufactured.members.length === 0, '★ bee, whose acceptance alice wrote, is NOT a member');
  const forgeryReported = manufactured.unattested.find(u => u.kind === 'acceptance');
  ok(
    forgeryReported !== undefined,
    'and the forgery is REPORTED, naming who actually signed it',
    JSON.stringify(manufactured.unattested),
  );
  // ★ THE REASON, ASSERTED RATHER THAN LOGGED. The refusal string used to be console.logged
  // and never checked, so "refused because alice signed bee's acceptance" and "refused
  // because nothing was readable" were the same pass. Only the first establishes anything.
  ok(
    /acts for/.test(forgeryReported?.because ?? ''),
    '★★ and refused for the RIGHT REASON — the signer acts for someone other than bee',
    `because = ${forgeryReported?.because ?? '(none)'}`,
  );
  ok(
    !/did not verify|could not be retrieved/.test(forgeryReported?.because ?? ''),
    'and NOT because the record was merely unreadable, which would prove nothing',
    `because = ${forgeryReported?.because ?? '(none)'}`,
  );
  if (manufactured.unattested[0]) console.log(`     ${manufactured.unattested[0].because.slice(0, 160)}…`);

  // ── 7. the same evidence, applied per entry on the read path ──
  console.log('\n7. attribution on the composed view, verified per entry');
  const attestedView = await composeWorkspace(
    { workspace: WS, members, verifyAuthorship: true, signerOf }, deps(BEARER),
  );
  ok(attestedView.attributionGrade === 'attested', 'the view states which grade of attribution it carries');
  ok(
    attestedView.descriptorReads === raw.entries.length,
    `★ and reports the bill: ${attestedView.descriptorReads} get_descriptor calls for ${raw.entries.length} entries`,
  );
  ok(
    attestedView.entries.length + attestedView.unattested.reduce((n, u) => n + u.entries.length, 0)
      === raw.entries.length,
    'every entry is either attributed or withheld-and-named — none silently vanish',
    JSON.stringify({ kept: attestedView.entries.length, withheld: attestedView.unattested }),
  );
  // ★ Both assertions above hold trivially when EVERY entry is withheld — 0 + 2 === 2, and
  // the reads happen either way. Section 6's control has the same shape, so it gets the same
  // treatment: say out loud whether the attested path admitted anything at all.
  ok(
    attestedView.entries.length > 0,
    '★ the CONTROL holds here too: at least one entry was ADMITTED at the attested grade',
    'if this fails, the two assertions above are arithmetic on zero and establish nothing — '
    + `withheld: ${JSON.stringify(attestedView.unattested).slice(0, 300)}`,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
