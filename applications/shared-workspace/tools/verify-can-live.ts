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
 * ★ AND SECTION 6 STILL DID NOT BIND A RECORD TO THE FIELDS CLAIMED FOR IT. It publishes
 * three records carrying a single `dct:description` and then hands the fold `Grant` and
 * `Acceptance` object literals typed twelve lines above — so what it establishes is who
 * signed each URL, and nothing at all about what those records SAY. Hand the same policy one
 * of bee's ordinary published log entries with `member: bee` typed beside it and she becomes
 * a member of a workspace she never joined. Section 8 is the half that was missing: real
 * `wsp:MembershipGrant` and `wsp:MembershipAcceptance` documents, shape-validated, signed,
 * read back and PARSED, with the manufactured-participant attack run live against both the
 * new policy and the old one so the gap is shown to have been real.
 *
 * ── WHAT IS HERE, AND WHAT HAS ACTUALLY BEEN RUN ─────────────────────────────
 *
 * ★ THE LIST IS HERE SO THE CLAIM BESIDE IT CAN BE CHECKED. The sentence that stood here read
 * "Nothing here is unrun", and it was false the moment §10 was added — by a different round,
 * which corrected the README's eight copies of the claim and left the source file's. The
 * header never mentioned §10 at all, so nothing about the file made the omission visible. A
 * roster of sections does: adding one without touching this block leaves a gap a reader can
 * see, and the run line below states a count that stops matching.
 *
 *    1  the delegated scope comes from the substrate's own agent registry
 *    2  the substrate refuses a write to another principal's pod (403 scope_violation)
 *    3  an Observer's own-pod write succeeds and is not COUNTED
 *    4  the view is composed from what the roster admits
 *    5  a revoked grant stops conferring
 *    6  a forged acceptance is refused and the genuine one admitted, on real proofs
 *    7  the delegation ceiling narrows a role that permits more
 *    8  the FIELDS come from the record — real grant/acceptance documents, parsed
 *    9  the CONVENER comes from the workspace (residual gap 6), and gap 9 shown OPEN
 *   10  the ROLE PROFILE comes from the workspace (residual gap 8)
 *   11  the EVIDENCE must be the record <WS> dereferences to (residual gap 9, closed)
 *
 * ★ RUN AGAINST PRODUCTION on 2026-08-03 UTC with two real bearers: §§1–8 = 45 assertions,
 * §9 = 18, §10 = 7, §11 = 7 — 77 of 77. Everything in the list above has been executed against
 * the live substrate. Two sections were fixed by being run rather than by being read:
 *
 *   §9 was written around a `WS` constant of `${RELAY}/ns/maintainer/…`, and <WS> answered 404
 *   for every run this file had ever done, because the /ns owner segment selects a POD and
 *   neither principal can write to the one named `maintainer` (403 scope_violation, measured
 *   both ways). §9's comment asserted that dereference in prose and excused itself from
 *   checking it. The workspace URL is now built from the convener's own pod, <WS> resolves for
 *   an anonymous reader, and the property is asserted rather than described.
 *
 *   §10 did not merely go unrun — it FAILED when run, and for a reason its own doubles get
 *   right. Its rogue role profile declared `#Contributor` while §8's published grant to bee
 *   names `#Observer`, so the rogue table had no row for bee's role, conferred nothing, and the
 *   escalation comparison was `0 > 1`. A section written to show a widening, failing because
 *   its rogue document never mentioned the role it was widening.
 *
 * ★ AND RESIDUAL GAP 9 IS NOW CLOSED IN §11 RATHER THAN REPORTED IN §9. `refuseConvenerAuthority`
 * asked whether the evidence names this workspace, names this convener, and holds up as a
 * record — and never asked where the evidence came from. A `wsp:Workspace` bee writes for
 * alice's workspace on her own pod answers all three, and §9 measures the fold admitting her at
 * `convenerBinding: 'bound'`. §11 asks the workspace instead: `dereferenceWorkspaceRecord`
 * resolves <WS> through the pod its own owner segment names, `requireEvidenceProvenance`
 * refuses evidence that does not claim to have come from there, and bee's record — still live,
 * still signed, still naming <WS> as its subject — confers nothing.
 *
 * Usage:
 *   IEP_BEARER=<token-a> IEP_BEARER_B=<token-b> \
 *     npx tsx applications/shared-workspace/tools/verify-can-live.ts [run-id]
 */

import { appendEntry, readAttestation, type StreamDeps } from '../src/stream.js';
import { composeWorkspace, type ComposableMember } from '../src/compose.js';
import {
  grantTurtle, acceptanceTurtle, workspaceTurtle, publishMembershipRecord,
  readGrantRecord, readAcceptanceRecord, readWorkspaceRecord, convenerEvidenceOf,
  dereferenceWorkspaceRecord,
} from '../src/membership.js';
import type { Acceptance } from '../src/roster.js';
import {
  authorizeView, scopesFromRegistry, signerIndexFromRegistry, canAct, CAPS, foldRoster,
  type RoleProfile, type Attestation, type ConvenerEvidence,
} from '../src/can.js';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';

/**
 * An environment variable this script cannot run without, narrowed to `string`.
 *
 * ★ The guard used to be one `if (!BEARER || !BEARER_B) process.exit(2)` beside the two
 * `process.env` reads, which reads as sufficient and is not: control-flow narrowing does not
 * cross into a nested function body, so every use inside `main()` was still
 * `string | undefined` and every `callAs(BEARER, …)` was a type error. Nothing said so — this
 * file was in no tsconfig's program until `tsconfig.check.json`. Returning the narrowed value
 * from the guard is what makes the check and the type agree.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`${name} is required.`);
    process.exit(2);
  }
  return value;
}
const BEARER = requiredEnv('IEP_BEARER');
const BEARER_B = requiredEnv('IEP_BEARER_B');

const RUN = process.argv[2] ?? String(Date.now());
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
  // §11's dependency, and the only one of the four that is not about a URL somebody handed
  // this file. `get_current_head` takes the /ns owner segment as `pod_name`, so
  // `dereferenceWorkspaceRecord` asks the pod the workspace IRI itself names.
  currentHead: a => callAs(bearer, 'get_current_head', a),
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

  // ★ THE WORKSPACE URL LIVES IN THE CONVENER'S OWN /ns NAMESPACE, AND IT USED TO BE A CONSTANT
  // THAT NAMED SOMEBODY ELSE'S. This was `${RELAY}/ns/maintainer/wsp-can-${RUN}`, and §9's
  // comment said that graph IRI is what makes <WS> dereference to the workspace record. Run
  // against production, it does not: `resolveNsGraph` (deploy/mcp-relay/server.ts:11655) reads
  // `podUrl = CSS_URL + <owner segment> + '/'`, so /ns/maintainer/… serves the pod literally
  // named `maintainer` — which is not alice's `u-eth-8f3b8e939600`, and which BOTH principals
  // are refused write to (403 scope_violation on `pod_name: 'maintainer'`, measured both ways).
  // So <WS> answered 404 for every run this file has ever done, and the one thing a third party
  // needs in order to check who convenes here did not exist.
  //
  // Deriving the owner segment from the convener's own pod is what makes the claim true rather
  // than deleting it, and the property is now asserted below instead of asserted in prose.
  const ownerA = podA.replace(/.*\/([^/]+)\/$/, '$1');
  const WS = `${RELAY}/ns/${ownerA}/wsp-can-${RUN}`;

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
    visibility: 'public', auto_supersede_prior: false, pod_name: ownerA,
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
  // `=== true`, not the optional chain's `boolean | undefined`: an ABSENT row must read as a
  // failure here, and `ok(undefined)` would have been a falsy pass-through nobody chose.
  ok(view.disallowed[0]?.because.includes('does not permit') === true, 'with a reason a person can act on');
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

  // ── 8. the half section 6 could NOT establish: the record's own FIELDS ──
  //
  // ★ WHAT SECTION 6 PROVED AND WHERE IT STOPPED. It published three records and read their
  // authorship back through the relay's verifier, so it really did establish who signed
  // what. But the `Grant` and `Acceptance` it handed the fold were object literals typed
  // TWELVE LINES ABOVE — `member: bee, accepts: grantUrl, stream: ...` — and the published
  // records carried a single `dct:description`. So the roster's fields and the signed bytes
  // had nothing to do with each other: the section's own comment says "the record body is
  // deliberately minimal; what is under test is the PROVENANCE the substrate attaches".
  //
  // The consequence was measurable and it is the residual gap this section closes. Hand the
  // fold one of bee's ordinary published log entries — genuinely hers, genuinely signed,
  // genuinely content-bound — with `member: bee` typed beside it, and section 6's policy
  // admits her as a member of a workspace she never joined, at whatever role was typed.
  //
  // Here both halves are REAL wsp:MembershipGrant / wsp:MembershipAcceptance documents,
  // shape-validated at publish, signed, read back, and PARSED. Nothing below types a field.
  console.log('\n8. the fields come from the RECORD — a grant and an acceptance, published and parsed');

  // ★ NO `pod_name`, DELIBERATELY. Every write below is a principal writing to their OWN
  // pod through their OWN session, which is the default target — the same thing section 3's
  // `appendEntry` does. Naming the pod explicitly would be the one way to turn a valid
  // own-pod write into a 403 and make the section fail for a reason it is not about.
  const wsDeps = (bearer: string): StreamDeps => deps(bearer);

  // The convener publishes the grant on HER pod…
  const grantIri = `${WS}/mg/bee`;
  const grantPub = await publishMembershipRecord({
    graphIri: grantIri,
    graphContent: grantTurtle({
      grantIri, workspace: WS, grantedTo: bee, role: `${P}#Observer`,
      title: 'alice, convening, offers bee Observer',
    }),
  }, wsDeps(BEARER));
  ok(grantPub.outcome === 'published', '★ the convener publishes a wsp:MembershipGrant on her own pod', JSON.stringify(grantPub).slice(0, 240));
  if (grantPub.outcome !== 'published') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  const mgUrl = grantPub.descriptorUrl;

  // …and the MEMBER publishes the acceptance on HERS, naming the grant by its own URL.
  const acceptIri = `${WS}/ma/bee`;
  const acceptPub = await publishMembershipRecord({
    graphIri: acceptIri,
    graphContent: acceptanceTurtle({
      acceptanceIri: acceptIri, workspace: WS, member: bee, accepts: mgUrl,
      stream: `${WS}/stream/bee`, title: 'bee accepts, from her own session',
    }),
  }, wsDeps(BEARER_B));
  ok(acceptPub.outcome === 'published', '★ the member publishes a wsp:MembershipAcceptance on HER OWN pod', JSON.stringify(acceptPub).slice(0, 240));
  if (acceptPub.outcome !== 'published') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

  // ★ AND THE CONVENER FORGES ONE. Same bytes, same shape, same workspace — published from
  // ALICE'S session onto ALICE'S pod. This is the record that must be refused, and it is a
  // sharper forgery than section 6's: its fields are perfect and parsed, so nothing but the
  // signature distinguishes it.
  const forgedIri = `${WS}/ma/bee-forged`;
  const forgedPub = await publishMembershipRecord({
    graphIri: forgedIri,
    graphContent: acceptanceTurtle({
      acceptanceIri: forgedIri, workspace: WS, member: bee, accepts: mgUrl,
      stream: `${WS}/stream/bee`, title: 'alice writing bee\'s acceptance',
    }),
  }, wsDeps(BEARER));
  ok(forgedPub.outcome === 'published', 'and the convener publishes a forged one for bee on her own pod', JSON.stringify(forgedPub).slice(0, 240));
  if (forgedPub.outcome !== 'published') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

  // ── read all three back and PARSE them. No field below was typed by this file. ──
  const readGrant = await readGrantRecord(mgUrl, wsDeps(BEARER));
  const readAccept = await readAcceptanceRecord(acceptPub.descriptorUrl, wsDeps(BEARER));
  const readForged = await readAcceptanceRecord(forgedPub.descriptorUrl, wsDeps(BEARER));
  ok(
    readGrant.record !== null && readAccept.record !== null && readForged.record !== null,
    'all three records read back and parsed into membership rows',
    JSON.stringify({ g: readGrant.problems, a: readAccept.problems, f: readForged.problems }),
  );
  if (!readGrant.record || !readAccept.record || !readForged.record) {
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(1);
  }
  // The fields really came from the bytes, and the substrate really re-digested those bytes.
  ok(
    readGrant.record.grantedTo === bee && readGrant.record.role === `${P}#Observer`,
    `★ the grantee and the role were READ FROM THE GRANT (${readGrant.record.role})`,
    JSON.stringify(readGrant.record),
  );
  ok(
    readAccept.record.accepts === mgUrl && readAccept.record.member === bee,
    '★ and the acceptance names that grant by its own URL, from its own bytes',
    JSON.stringify(readAccept.record),
  );
  ok(
    readGrant.record.attestation?.contentBinding === 'bound'
    && readAccept.record.attestation?.contentBinding === 'bound',
    '★ and the substrate re-digested the payload it served for each and MATCHED — so the '
    + 'parsed fields are the triples that were signed',
    JSON.stringify({ g: readGrant.record.attestation, a: readAccept.record.attestation }),
  );

  const fieldBound = (acceptance: Acceptance) => foldRoster({
    workspace: WS, profile: PROFILE, scopes,
    grants: [readGrant.record!],
    acceptances: [acceptance],
    attestation: { convener: alice, signerOf, requireFieldBinding: true },
  });

  // ★ THE CONTROL, FIRST AND OUT LOUD. §6's two headline assertions once passed because
  // every record was unreadable and the fold refused both halves. A refusal only
  // discriminates if the genuine article is admitted, so that is asserted before the
  // refusal, not after it.
  const genuineRoster = fieldBound(readAccept.record);
  ok(
    genuineRoster.members.length === 1 && genuineRoster.members[0]!.principal === bee,
    '★★ the CONTROL holds: bee, who really accepted, IS a member under requireFieldBinding',
    JSON.stringify({ members: genuineRoster.members, unattested: genuineRoster.unattested }),
  );
  ok(
    genuineRoster.recordFieldBinding === 'bound' && genuineRoster.recordContentBinding === 'bound',
    'and the roster reports both bindings as ENFORCED',
    JSON.stringify({ f: genuineRoster.recordFieldBinding, c: genuineRoster.recordContentBinding }),
  );

  const forgedRoster = fieldBound(readForged.record);
  ok(forgedRoster.members.length === 0, '★★ and the acceptance ALICE wrote for bee produces NO member');
  const forgedWhy = forgedRoster.unattested.find(u => u.kind === 'acceptance')?.because ?? '';
  ok(
    /acts for/.test(forgedWhy),
    '★ refused for the RIGHT REASON — the signer acts for someone other than bee',
    `because = ${forgedWhy}`,
  );
  ok(
    !/could not be retrieved|no graph payload|did not verify/.test(forgedWhy),
    'and NOT because the record was unreadable, which would prove nothing',
    `because = ${forgedWhy}`,
  );

  // ★ THE ATTACK THAT SURVIVED EVERY PREVIOUS ROUND, run live. One of bee's OWN entries —
  // published by her, in section 3, signed by her key, content-bound — offered as her
  // acceptance. Every signature check passes. Only reading the record refuses it.
  const beeEntryUrl = beePut.outcome === 'appended' ? beePut.entry.descriptorUrl : null;
  if (beeEntryUrl === null) {
    ok(false, 'bee\'s own entry from section 3 was needed here and is not available');
  } else {
    const asAcceptance = await readAcceptanceRecord(beeEntryUrl, wsDeps(BEARER));
    ok(
      asAcceptance.record === null && /declares no/.test(asAcceptance.problems.join(' ')),
      '★★ bee\'s own signed log entry is NOT readable as her acceptance — the manufactured '
      + 'participant, refused by reading the record',
      JSON.stringify(asAcceptance.problems).slice(0, 300),
    );
    // …and it really is a perfect record otherwise, which is why nothing weaker caught it.
    ok(
      asAcceptance.attestation.authorshipVerified && asAcceptance.attestation.signedBy !== null,
      'and that same entry carries a valid authorship proof — signatures were never the '
      + 'discriminator here',
      JSON.stringify(asAcceptance.attestation),
    );
    // The previously-strongest policy still admits it, with the fields typed by hand. Stated
    // so the gap is shown to have been REAL rather than described as having been.
    const beforeRoster = foldRoster({
      workspace: WS, profile: PROFILE, scopes,
      grants: [readGrant.record],
      acceptances: [{
        head: beeEntryUrl, workspace: WS, member: bee, accepts: mgUrl,
        stream: `${WS}/stream/bee`, attestation: asAcceptance.attestation,
      }],
      attestation: { convener: alice, signerOf, requireContentBinding: true },
    });
    ok(
      beforeRoster.members.length === 1,
      '★★ and requireContentBinding ALONE still admits it — the gap was real, and this is it',
      JSON.stringify(beforeRoster.unattested),
    );
  }

  // ── 9. the convener, checked against the WORKSPACE instead of against the caller ──
  //
  // ★ WHAT §8 USED TO END ON. The block here asserted the gap rather than closing it: a
  // policy naming BEE as convener produced a field-bound roster of the wrong memberships,
  // `recordFieldBinding: 'bound'` either way, because `AttestationPolicy.convener` was a value
  // this file typed and nothing read <WS> to check `wsp:convener` against it. That assertion
  // passed live, which is what made the gap a measurement rather than a worry.
  //
  // It is closed the same way gap 0 was, and the blocker was the same one twice: the published
  // `wspsh:WorkspaceShape` has always required exactly one `wsp:convener`, and no code in the
  // repo had ever WRITTEN a `wsp:Workspace`. Below, alice publishes one at the workspace's own
  // URL, it is read back and parsed, and the fold is given it as evidence.
  console.log('\n9. the convener comes from the WORKSPACE — the record that says who may grant');

  // ★ THE GRAPH IRI IS <WS> ITSELF, and so is the subject. Both matter and for different
  // reasons: the subject is what makes this a record OF this workspace rather than one ABOUT
  // it (the fold compares it), and the graph IRI is what makes <WS> dereference to this record
  // through the relay's /ns/:owner/:slug route — which is the half a reader needs.
  //
  // ★ AND THAT SECOND HALF USED TO BE PROSE, AND THE PROSE WAS FALSE. It said "no assertion
  // here can make it on its own behalf", which excused never checking it; the first live run of
  // this section measured <WS> at 404, for the reason recorded where `WS` is built. It is
  // asserted below now, over plain HTTP with no bearer, because a reader who cannot resolve
  // <WS> has no way to obtain the evidence the rest of this section turns on.
  const wsPub = await publishMembershipRecord({
    graphIri: WS,
    graphContent: workspaceTurtle({
      workspaceIri: WS, convener: alice, roleProfile: P,
      title: `wsp-can-${RUN}, convened by alice`,
    }),
  }, wsDeps(BEARER));
  ok(
    wsPub.outcome === 'published',
    '★ the convener publishes a wsp:Workspace at the workspace\'s own URL',
    JSON.stringify(wsPub).slice(0, 240),
  );
  if (wsPub.outcome !== 'published') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

  const readWs = await readWorkspaceRecord(wsPub.descriptorUrl, wsDeps(BEARER_B));
  ok(
    readWs.record !== null,
    'the workspace record reads back and parses',
    JSON.stringify(readWs.problems),
  );
  if (!readWs.record) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  // ★ READ BY BEE, NOT BY ALICE. A convener declaration only settles anything if the other
  // party can read it: alice reading her own record back establishes nothing a second copy of
  // alice's opinion would not. `wsDeps(BEARER_B)` above is the whole of that point.
  ok(
    readWs.record.convener === alice && readWs.record.workspace === WS,
    `★ the convener was READ FROM THE WORKSPACE, by the OTHER party (${readWs.record.convener})`,
    JSON.stringify(readWs.record),
  );
  ok(
    readWs.record.attestation?.contentBinding === 'bound',
    '★ and the substrate re-digested the bytes it served and MATCHED — so the convener above '
    + 'is the convener alice signed',
    JSON.stringify(readWs.record.attestation),
  );
  // ★ AND THE SECOND FIELD ON THE SAME RECORD, WHICH THIS ASSERTION USED TO END ON. It read
  // "which this fold does NOT check against `profile` — parsed and handed over, and named as a
  // residual gap". That was residual gap 8, and §10 below closes it: the same record declares
  // the governance, and `refuseRoleProfileAuthority` now compares it.
  ok(
    readWs.record.roleProfile === P,
    '★ and the workspace declares its ROLE PROFILE in the same signed record — the value §10 '
    + 'folds against',
    `roleProfile = ${readWs.record.roleProfile}`,
  );

  // ★ AND THE HALF A STRANGER NEEDS: <WS> RESOLVES, WITH NO BEARER AT ALL. Every read above
  // went through `get_descriptor` with a token, which is a member's path. Someone who holds
  // nothing but the workspace URL — the auditor this whole design is addressed to — has only
  // the IRI, and if it does not resolve then "the workspace names alice" is a sentence about a
  // document only members can find. Retried against the same budget the publishes use, because
  // the /ns route reads the pod's manifest and that lands after the descriptor does.
  const dereference = async (): Promise<{ status: number; body: string }> => {
    const started = Date.now();
    for (;;) {
      const r = await fetch(WS, { headers: { Accept: 'text/turtle' } });
      const body = await r.text();
      if (r.status === 200 || Date.now() - started >= VISIBILITY_BUDGET_MS) return { status: r.status, body };
      await new Promise(res => setTimeout(res, 1000));
    }
  };
  const deref = await dereference();
  ok(
    deref.status === 200 && deref.body.includes(alice),
    '★★ <WS> DEREFERENCES for an anonymous reader, and the bytes name alice as convener — the '
    + 'half that was prose until this section was first run, and false when it was',
    `status = ${deref.status}, ${deref.body.slice(0, 200)}`,
  );

  const evidence: ConvenerEvidence = convenerEvidenceOf(readWs);
  const convened = (convener: string) => foldRoster({
    workspace: WS, profile: PROFILE, scopes,
    grants: [readGrant.record!],
    acceptances: [readAccept.record!],
    attestation: { convener, signerOf, requireFieldBinding: true, workspaceEvidence: evidence },
  });

  // ★ THE CONTROL, FIRST AND OUT LOUD, for the third time in this file and for the same
  // reason: a refusal only discriminates if the genuine article is admitted. A run where the
  // workspace record failed to publish, or read back empty, would refuse both conveners and
  // the two assertions after this one would establish nothing at all.
  const rightConvener = convened(alice);
  ok(
    rightConvener.members.length === 1 && rightConvener.convenerBinding === 'bound'
    // ★ AND THE PROFILE VERDICT IS PART OF THE CONTROL, because both refusals now sit in the
    // same grant chain: a roster emptied by the ROLE PROFILE would satisfy every "refused"
    // assertion below while this control failed for a reason nothing here names. `PROFILE.profile`
    // is `P`, which is what alice published, so agreement is the expected answer.
    && rightConvener.roleProfileBinding === 'bound',
    '★★ the CONTROL holds: naming the convener the WORKSPACE names admits bee as a member, and '
    + 'the fold reports BOTH the convener and the role profile as checked against the record',
    JSON.stringify({
      members: rightConvener.members.length, binding: rightConvener.convenerBinding,
      profile: rightConvener.roleProfileBinding, unattested: rightConvener.unattested,
    }),
  );

  // ── the attack gap 6 actually permitted: BEE CONVENES ALICE'S WORKSPACE ──
  //
  // ★ FOLDING §8'S RECORDS UNDER `convener: bee` IS THE WEAK VERSION, AND WRITING IT FIRST WAS
  // A MISTAKE THIS FILE HAS MADE BEFORE. Those records are signed by ALICE, so under a policy
  // naming bee they are refused by `refuseAttestation` — the convener check never runs, and an
  // assertion that the refusal cites the disagreement would fail for a reason that has nothing
  // to do with what is under test. Worse, the roster would be empty either way, so a reader
  // would see a passing section that had established nothing. It is the vacuous-assertion
  // shape §6 was rewritten to remove.
  //
  // The sharp version is bee writing BOTH HALVES ON HER OWN POD and naming HERSELF convener.
  // Every check below the convener passes at full strength: bee's key signed both records,
  // both are content-bound, both were parsed. Nothing but the workspace's own declaration
  // stands between that and a membership in a workspace alice convenes.
  const selfGrantIri = `${WS}/mg/bee-self`;
  const selfGrantPub = await publishMembershipRecord({
    graphIri: selfGrantIri,
    graphContent: grantTurtle({
      grantIri: selfGrantIri, workspace: WS, grantedTo: bee, role: `${P}#Contributor`,
      title: 'bee, convening alice\'s workspace, grants herself Contributor',
    }),
  }, wsDeps(BEARER_B));
  const selfAcceptIri = `${WS}/ma/bee-self`;
  const selfAcceptPub = selfGrantPub.outcome !== 'published' ? null : await publishMembershipRecord({
    graphIri: selfAcceptIri,
    graphContent: acceptanceTurtle({
      acceptanceIri: selfAcceptIri, workspace: WS, member: bee,
      accepts: selfGrantPub.descriptorUrl, stream: `${WS}/stream/bee`,
      title: 'bee accepts her own grant',
    }),
  }, wsDeps(BEARER_B));
  ok(
    selfGrantPub.outcome === 'published' && selfAcceptPub?.outcome === 'published',
    'bee publishes BOTH halves on her own pod, naming herself convener',
    JSON.stringify({ g: selfGrantPub, a: selfAcceptPub }).slice(0, 240),
  );
  if (selfGrantPub.outcome !== 'published' || selfAcceptPub?.outcome !== 'published') {
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(1);
  }
  const selfGrant = await readGrantRecord(selfGrantPub.descriptorUrl, wsDeps(BEARER));
  const selfAccept = await readAcceptanceRecord(selfAcceptPub.descriptorUrl, wsDeps(BEARER));
  ok(
    selfGrant.record !== null && selfAccept.record !== null,
    'and both parse — the attack is made of well-formed, signed, content-bound records',
    JSON.stringify({ g: selfGrant.problems, a: selfAccept.problems }),
  );
  if (!selfGrant.record || !selfAccept.record) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

  const selfArgs = {
    workspace: WS, profile: PROFILE, scopes,
    grants: [selfGrant.record], acceptances: [selfAccept.record],
  };
  // ★ THE GAP, LIVE, AT FULL STRENGTH. Every guard this layer had before this round passes.
  const gapOpen = foldRoster({
    ...selfArgs,
    attestation: { convener: bee, signerOf, requireFieldBinding: true },
  });
  ok(
    gapOpen.members.length === 1 && gapOpen.recordFieldBinding === 'bound'
    && gapOpen.convenerBinding === 'unchecked',
    '★★ RESIDUAL GAP 6, at full strength: with no workspace evidence, bee CONVENES ALICE\'S '
    + 'WORKSPACE — a field-bound, content-bound, signer-checked membership nobody in it agreed to',
    JSON.stringify({ members: gapOpen.members.length, f: gapOpen.recordFieldBinding, c: gapOpen.convenerBinding }),
  );

  // ★ AND CLOSED. Same records, same policy, one field added.
  const gapClosed = foldRoster({
    ...selfArgs,
    attestation: { convener: bee, signerOf, requireFieldBinding: true, workspaceEvidence: evidence },
  });
  ok(
    gapClosed.members.length === 0 && gapClosed.convenerBinding === 'refused',
    '★★ RESIDUAL GAP 6, CLOSED: <' + WS + '> names alice, so bee\'s self-convened membership '
    + 'confers nothing',
    JSON.stringify({ members: gapClosed.members.length, binding: gapClosed.convenerBinding }),
  );
  const conveneWhy = gapClosed.unattested.find(u => u.kind === 'grant')?.because ?? '';
  ok(
    /The two disagree/.test(conveneWhy),
    '★ and refused for the RIGHT REASON — the policy and the workspace name different conveners',
    `because = ${conveneWhy}`,
  );
  ok(
    !/could not be read|does not hold up|another workspace|acts for/.test(conveneWhy),
    'and NOT because the record was unreadable, malformed, or signed by the wrong party — '
    + 'every one of those checks PASSED, which is what makes this the convener\'s refusal',
    `because = ${conveneWhy}`,
  );

  // ★ THE INVERSION, LIVE. Reading the convener out of the workspace and USING it is the
  // obvious implementation, and it is an escalation: this policy names bee, the workspace names
  // alice, and alice signed §8's grant — so a substituting fold would ADMIT the §8 membership
  // that this same policy refuses without the evidence. Asserted as a comparison, because that
  // is what the claim is: supplying evidence must never widen.
  const inversionWith = convened(bee);
  const inversionWithout = foldRoster({
    workspace: WS, profile: PROFILE, scopes,
    grants: [readGrant.record], acceptances: [readAccept.record],
    attestation: { convener: bee, signerOf, requireFieldBinding: true },
  });
  ok(
    inversionWith.members.length <= inversionWithout.members.length
    && inversionWith.members.length === 0,
    '★★ and supplying the evidence never GRANTS: the workspace\'s convener is not substituted '
    + 'for the policy\'s, so a policy naming bee stays empty even when the workspace names alice',
    JSON.stringify({ with: inversionWith.members.length, without: inversionWithout.members.length }),
  );
  ok(
    inversionWithout.convenerBinding === 'unchecked'
    && /is the workspace's convener/.test(inversionWithout.attributionNote),
    '★ and a policy that passes no evidence still says so — the gap is reported open, not '
    + 'silently closed by a field somebody forgot to set',
    `binding = ${inversionWithout.convenerBinding}`,
  );

  // ── RESIDUAL GAP 9: the fold checks the evidence, and nothing checks the EVIDENCE'S SOURCE ──
  //
  // Numbered 9 because 7 is taken and closed (the `wsp:member` shape gap) and 8 is the open
  // role-profile one. A gap that reuses a closed gap's number reads, to anyone grepping, as the
  // closed one having reopened.
  //
  // ★ THE ATTACK THE ASSERTIONS ABOVE DO NOT REACH, MEASURED RATHER THAN WORRIED ABOUT.
  // `refuseConvenerAuthority` (src/roster.ts:731) asks three questions of a `ConvenerEvidence`:
  // is its subject THIS workspace, does it name THIS policy's convener, and does it hold up as
  // a signed, content-bound record. A `wsp:Workspace` bee writes for alice's workspace, on her
  // own pod, naming HERSELF, answers all three — the subject is a triple she chose, and the
  // signature is hers over her own claim. Nothing in the fold relates the descriptor URL the
  // evidence was read from to <WS>. The caller picks that URL, and this file picks it honestly.
  //
  // So the closure above is real but its scope is narrower than it reads: it holds for a reader
  // who obtained the evidence by DEREFERENCING <WS>, and the assertion two blocks up is what
  // makes that route exist. Shown here at full strength, in the shape §8 and §9 already use for
  // gaps that are open, and CLOSED in §11 — which is the same records, the same policy and one
  // more flag.
  const usurpPub = await publishMembershipRecord({
    graphIri: WS,
    graphContent: workspaceTurtle({
      workspaceIri: WS, convener: bee, roleProfile: P,
      title: 'bee, claiming to convene alice\'s workspace',
    }),
  }, wsDeps(BEARER_B));
  ok(
    usurpPub.outcome === 'published',
    'bee publishes a competing wsp:Workspace for alice\'s workspace IRI, on HER OWN pod',
    JSON.stringify(usurpPub).slice(0, 240),
  );
  // Hoisted so §11 can close the gap against the SAME forged record this section opened it
  // with. Re-publishing a second one there would leave two heads on the workspace's chain and
  // let §11 pass against a record §9 never showed to be dangerous.
  let usurpEvidence: ConvenerEvidence | null = null;
  if (usurpPub.outcome === 'published') {
    const usurpRead = await readWorkspaceRecord(usurpPub.descriptorUrl, wsDeps(BEARER));
    usurpEvidence = convenerEvidenceOf(usurpRead);
    const usurped = foldRoster({
      ...selfArgs,
      attestation: {
        convener: bee, signerOf, requireFieldBinding: true,
        workspaceEvidence: convenerEvidenceOf(usurpRead),
      },
    });
    ok(
      usurpRead.record?.convener === bee && usurped.members.length === 1
      && usurped.convenerBinding === 'bound',
      '★★ RESIDUAL GAP 9: handed bee\'s OWN workspace record as evidence, the same fold that '
      + 'refused her two blocks up reports the convener as BOUND and admits her — the fold '
      + 'checks the evidence and never asks where it came from (src/roster.ts:731)',
      JSON.stringify({ convener: usurpRead.record?.convener, members: usurped.members.length, binding: usurped.convenerBinding }),
    );
    // …and the one thing that does discriminate is the URL, not the record. Same IRI, same
    // shape, same strength of signature — and <WS> still answers with alice's, because the
    // owner segment of a /ns IRI is a pod bee cannot write to (403, measured).
    const after = await fetch(WS, { headers: { Accept: 'text/turtle' } });
    const afterBody = await after.text();
    ok(
      after.status === 200 && afterBody.includes(alice) && !afterBody.includes(bee),
      '★★ but <WS> STILL dereferences to ALICE\'s record — the owner segment binds the IRI to a '
      + 'pod bee cannot write to, which is what makes gap 9 closable by sourcing rather than by '
      + 'trusting the record',
      `status = ${after.status}, alice? ${afterBody.includes(alice)}, bee? ${afterBody.includes(bee)}`,
    );
  }

  // ── 10. the ROLE PROFILE, checked against the workspace instead of against the caller ──
  //
  // ★ WHAT §9 USED TO HAND OVER AND NOT USE. The same signed record declares `wsp:roleProfile`,
  // and `foldRoster` took its `RoleProfile` from `PROFILE` at the top of this file. That is
  // residual gap 8, and it decides more than the convener does: `permitsOf` is built from the
  // caller's profile, so the caller's document names every capability in the roster. A roster
  // could report `convenerBinding: 'bound'` and `recordFieldBinding: 'bound'` with an empty
  // `unattested` over an Observer who could revoke.
  //
  // ★ AND THE ROGUE PROFILE REDECLARES THE DECLARED PROFILE'S OWN ROLE IRI, which is what makes
  // this an escalation rather than a mismatch. Role IRIs are strings; nothing stops a rival
  // document from declaring `<…wsp-roles-default#Contributor>` with `grant` and `revoke` on it.
  // The grant §8 published names exactly that role, is signed by alice, content-bound and
  // parsed — so every check this layer had before this round passes at full strength and the
  // capabilities come out of a document alice never published.
  console.log('\n10. the role profile comes from the WORKSPACE — the record that says what a role permits');

  // ★ `#Observer`, AND THE ROLE HAS TO BE THE ONE §8 ACTUALLY GRANTED. This read `#Contributor`
  // and §8's published grant to bee (above) names `#Observer`, so the rogue table had no row
  // for bee's role, conferred nothing, and the comparison below was `0 > 1`. Measured live:
  //   FAIL ★★ RESIDUAL GAP 8, at full strength … {"rogue":[],"declared":["…#read"]}
  // — a section written to demonstrate an escalation, failing because its rogue document did
  // not mention the role it was supposed to widen. The doubles get this right
  // (`tests/workspace-adversarial.test.ts` uses `#Observer` and rewrites the grant to match);
  // the live section copied the shape and named the other role.
  const ROGUE_PROFILE: RoleProfile = {
    profile: `${RELAY}/ns/rogue/wsp-roles-${RUN}`,
    roles: [{ role: `${P}#Observer`, permits: [CAPS.read, CAPS.append, CAPS.grant, CAPS.revoke] }],
  };
  const foldWithProfile = (profile: RoleProfile, evidenceOn: boolean) => foldRoster({
    workspace: WS, profile, scopes,
    grants: [readGrant.record!],
    acceptances: [readAccept.record!],
    attestation: {
      convener: alice, signerOf, requireFieldBinding: true,
      ...(evidenceOn ? { workspaceEvidence: evidence } : {}),
    },
  });

  // ★ THE GAP, LIVE, AT FULL STRENGTH — and reported honestly by the roster that permits it.
  //
  // ★★ THE ASSERTION IS A COMPARISON, NOT `includes(revoke)`, AND THE REASON IS THE CEILING.
  // Effective capability is `role.permits ∩ delegatedScope`, and the delegation comes from the
  // LIVE registry — this file does not choose it. Written as "bee holds revoke", this assertion
  // would fail on a run where bee's agent happens to be `PublishOnly`, for a reason that has
  // nothing whatever to do with residual gap 8, and a reader would be told the gap was closed.
  // What the gap actually is, at any ceiling, is that the caller's document WIDENED what the
  // workspace's own governance allows — so that is what is measured, and the ceiling is printed
  // beside it. If the two ever come out equal the run FAILS and says the demonstration was
  // inert, which is the honest report and the one §6 had to learn to make.
  const profileGapOpen = foldWithProfile(ROGUE_PROFILE, false);
  const declaredCaps = foldWithProfile(PROFILE, false).members[0]?.effective ?? [];
  const rogueCaps = profileGapOpen.members[0]?.effective ?? [];
  ok(
    profileGapOpen.members.length === 1
    && rogueCaps.length > declaredCaps.length
    && profileGapOpen.recordFieldBinding === 'bound'
    && profileGapOpen.roleProfileBinding === 'unchecked',
    '★★ RESIDUAL GAP 8, at full strength: with no workspace evidence, bee holds MORE in alice\'s '
    + 'workspace than alice\'s own governance permits, on the strength of a role profile alice '
    + 'never declared — a field-bound, content-bound, convener-checked membership governed by '
    + 'the caller\'s own document',
    JSON.stringify({
      members: profileGapOpen.members.length, rogue: rogueCaps, declared: declaredCaps,
      f: profileGapOpen.recordFieldBinding, p: profileGapOpen.roleProfileBinding,
    }),
  );

  // ★ AND CLOSED. Same records, same policy, the evidence §9 already read.
  const profileGapClosed = foldWithProfile(ROGUE_PROFILE, true);
  ok(
    profileGapClosed.members.length === 0 && profileGapClosed.roleProfileBinding === 'refused',
    '★★ RESIDUAL GAP 8, CLOSED: <' + WS + '> declares a different role profile, so nothing the '
    + 'rogue document permits CONFERS',
    JSON.stringify({ members: profileGapClosed.members.length, binding: profileGapClosed.roleProfileBinding }),
  );
  const profileWhy = profileGapClosed.unattested.find(u => u.kind === 'grant')?.because ?? '';
  ok(
    /The two disagree/.test(profileWhy) && profileWhy.includes(ROGUE_PROFILE.profile),
    '★ and refused for the RIGHT REASON — the fold names both profiles and says they differ',
    `because = ${profileWhy}`,
  );
  ok(
    // ★ THE HALF THAT MAKES IT A MEASUREMENT RATHER THAN A REFUSAL. The convener on this fold is
    // correct and its record is beyond reproach, so `convenerBinding` must still read `'bound'`.
    // If it did not, this section would be pinning gap 6's check a second time under a new name
    // and the profile comparison would never have run.
    profileGapClosed.convenerBinding === 'bound'
    && !/entitled to grant|could not be read|another workspace|acts for/.test(profileWhy),
    '★ and NOT because the convener, the record or the signature failed — every one of those '
    + 'checks PASSED, which is what makes this the role profile\'s own refusal',
    `convener = ${profileGapClosed.convenerBinding}, because = ${profileWhy}`,
  );

  // ★ THE CONTROL, LAST AND EXPLICIT. Every assertion above is satisfied by a fold that refuses
  // whenever evidence is present, and this file has shipped exactly that shape before — §6's
  // two headline assertions once passed because NOTHING was readable. The genuine profile,
  // against the same evidence, must be ADMITTED.
  const profileAgrees = foldWithProfile(PROFILE, true);
  ok(
    profileAgrees.members.length === 1 && profileAgrees.roleProfileBinding === 'bound',
    '★★ the CONTROL holds: folding against the profile the WORKSPACE declares admits bee, and '
    + 'the fold reports the governance as checked',
    JSON.stringify({
      members: profileAgrees.members.length, binding: profileAgrees.roleProfileBinding,
      unattested: profileAgrees.unattested,
    }),
  );
  ok(
    // A second control, in the direction a subset assertion cannot see: agreeing evidence must
    // change the REPORT and nothing else. Same members, same capabilities as the rung below.
    JSON.stringify(profileAgrees.members) === JSON.stringify(foldWithProfile(PROFILE, false).members),
    '★ and agreeing evidence changed nothing but the report — same members, same capabilities '
    + 'as the same fold without it',
    JSON.stringify(profileAgrees.members),
  );

  // ★ AND THE INVERSION, ONE FIELD OVER. Adopting the workspace's declared profile would be the
  // convener substitution in the field that decides capabilities. It cannot even be written
  // honestly here — the fold holds an IRI, not the document — so what is asserted is the
  // observable consequence: supplying the evidence never adds a member or a capability.
  const rogueWithout = foldWithProfile(ROGUE_PROFILE, false);
  ok(
    profileGapClosed.members.length <= rogueWithout.members.length
    && profileGapClosed.members.every(m => rogueWithout.members.some(
      w => w.principal === m.principal && m.effective.every(c => w.effective.includes(c)),
    )),
    '★★ and supplying the evidence never GRANTS: every member and every capability under the '
    + 'checked fold is present under the unchecked one',
    JSON.stringify({ with: profileGapClosed.members.length, without: rogueWithout.members.length }),
  );

  // ── 11. residual gap 9, closed: the evidence must be the record <WS> DEREFERENCES TO ──
  //
  // ★ WHAT §9 SHOWED AND COULD NOT FIX AT THE TIME. §§8–10 check what the workspace record
  // SAYS; nothing checked whether it is the workspace's record. Bee's own `wsp:Workspace` for
  // alice's IRI answers every one of those questions, because its subject is a triple she
  // wrote — §9 measured it admitting her at `convenerBinding: 'bound'`.
  //
  // The closure is that a workspace IS a dereferenceable URL and exactly one party decides
  // what it returns. `<relay>/ns/<owner>/<slug>` resolves against the pod its OWNER SEGMENT
  // names (`resolveNsGraph`, deploy/mcp-relay/server.ts:11657) and against no other, and §2
  // above has already measured the substrate refusing a cross-pod write. So
  // `dereferenceWorkspaceRecord` asks THAT pod, and `requireEvidenceProvenance` refuses
  // anything that does not claim to have come from there.
  console.log('\n11. the evidence must be the record the WORKSPACE dereferences to');

  const derefEvidence = await dereferenceWorkspaceRecord(WS, wsDeps(BEARER));
  ok(
    derefEvidence.kind === 'declared' && derefEvidence.record.convener === alice
    && derefEvidence.provenance?.dereferenced === WS
    && derefEvidence.provenance?.resolvedTo === derefEvidence.record.head,
    '★ dereferencing <WS> through its own owner segment returns ALICE\'s record, and the '
    + 'evidence carries where it came from',
    JSON.stringify(derefEvidence).slice(0, 300),
  );
  // ★ AND IT IS NOT THE SAME DOCUMENT BEE PUBLISHED, asserted rather than assumed. Both records
  // exist on the substrate right now, both are signed, both parse, both name <WS> as their
  // subject — so "the dereference returned a record" establishes nothing until it is shown to
  // have returned the OTHER one.
  const usurpHead = usurpEvidence?.kind === 'declared' ? usurpEvidence.record.head : '';
  ok(
    usurpHead !== '' && derefEvidence.kind === 'declared'
    && derefEvidence.record.head !== usurpHead,
    '★★ and it is a DIFFERENT document from the one bee published for the same IRI — both are '
    + 'live, and only one of them is what the workspace answers with',
    JSON.stringify({
      dereferenced: derefEvidence.kind === 'declared' ? derefEvidence.record.head : null,
      bee: usurpHead,
    }),
  );

  if (usurpEvidence !== null) {
    // THE ATTACK, refused. Same forged record §9 admitted, same policy naming bee, one flag.
    const gap9Closed = foldRoster({
      ...selfArgs,
      attestation: {
        convener: bee, signerOf, requireFieldBinding: true,
        workspaceEvidence: usurpEvidence, requireEvidenceProvenance: true,
      },
    });
    const gap9Why = gap9Closed.unattested.find(u => u.kind === 'grant')?.because ?? '';
    ok(
      gap9Closed.members.length === 0
      && gap9Closed.evidenceProvenanceBinding === 'refused'
      && /no statement of where it came from/.test(gap9Why),
      '★★ RESIDUAL GAP 9, CLOSED: bee\'s own record for alice\'s workspace IRI confers nothing '
      + 'once the fold asks where the evidence came from',
      JSON.stringify({
        members: gap9Closed.members.length, binding: gap9Closed.evidenceProvenanceBinding,
        because: gap9Why.slice(0, 160),
      }),
    );
    ok(
      // ★ THE HALF THAT MAKES IT A MEASUREMENT. The convener and profile answers on this fold
      // are `'bound'` — bee's record agrees with a policy naming bee, exactly as §9 showed —
      // so if this refusal were coming from either of them, §11 would be re-pinning §9's
      // check under a new name and the provenance question would never have been asked.
      gap9Closed.convenerBinding === 'bound' && gap9Closed.roleProfileBinding === 'bound',
      '★ and NOT because the convener or the profile failed — bee\'s record agrees with bee\'s '
      + 'policy on both, which is what made gap 9 a gap',
      JSON.stringify({ c: gap9Closed.convenerBinding, p: gap9Closed.roleProfileBinding }),
    );
  }

  // ★ THE CONTROL, and §6's lesson: every assertion above is satisfied by a fold that refuses
  // whenever the flag is set. The honestly dereferenced evidence, under a policy naming the
  // convener that record declares, must ADMIT — and admit exactly what the rung below it does.
  const sourcedArgs = {
    workspace: WS, profile: PROFILE, scopes,
    grants: [readGrant.record!], acceptances: [readAccept.record!],
  };
  const sourcedOn = foldRoster({
    ...sourcedArgs,
    attestation: {
      convener: alice, signerOf, requireFieldBinding: true,
      workspaceEvidence: derefEvidence, requireEvidenceProvenance: true,
    },
  });
  const sourcedOff = foldRoster({
    ...sourcedArgs,
    attestation: {
      convener: alice, signerOf, requireFieldBinding: true, workspaceEvidence: derefEvidence,
    },
  });
  ok(
    sourcedOn.members.length === 1 && sourcedOn.evidenceProvenanceBinding === 'bound',
    '★★ the CONTROL holds: the record <WS> actually dereferences to admits bee, and the fold '
    + 'reports the evidence\'s own provenance as checked',
    JSON.stringify({
      members: sourcedOn.members.length, binding: sourcedOn.evidenceProvenanceBinding,
      unattested: sourcedOn.unattested,
    }),
  );
  ok(
    JSON.stringify(sourcedOn.members) === JSON.stringify(sourcedOff.members),
    '★ and asking the question changed nothing but the report — same members, same '
    + 'capabilities as the same fold without the flag',
    JSON.stringify({ on: sourcedOn.members, off: sourcedOff.members }),
  );
  ok(
    // The report must distinguish "nobody asked" from "asked and the answer was no". Without
    // this, a caller could read the closed configuration and the residual-gap-9 one as the
    // same roster — which is the whole reason the field is non-omittable.
    sourcedOff.evidenceProvenanceBinding === 'unchecked'
    && /RESIDUAL, and it is the one the two sentences above rest on/.test(sourcedOff.attributionNote),
    '★ and a fold that did NOT ask says so, in a value distinct from `refused` — the gap is '
    + 'reported open, not silently closed by a flag somebody forgot to set',
    `binding = ${sourcedOff.evidenceProvenanceBinding}`,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
