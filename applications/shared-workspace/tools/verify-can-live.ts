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
 * ★ SECTIONS 6, 7 AND 8 HAVE STILL NOT BEEN RUN AGAINST THE LIVE SUBSTRATE. No bearer pair
 * has been available. Whether the assertions hold now that they CAN fail is therefore
 * unknown, and nothing in this file or the README claims otherwise.
 *
 * Usage:
 *   IEP_BEARER=<token-a> IEP_BEARER_B=<token-b> \
 *     npx tsx applications/shared-workspace/tools/verify-can-live.ts [run-id]
 */

import { appendEntry, readAttestation, type StreamDeps } from '../src/stream.js';
import { composeWorkspace, type ComposableMember } from '../src/compose.js';
import {
  grantTurtle, acceptanceTurtle, publishMembershipRecord,
  readGrantRecord, readAcceptanceRecord,
} from '../src/membership.js';
import type { Acceptance } from '../src/roster.js';
import {
  authorizeView, scopesFromRegistry, signerIndexFromRegistry, canAct, CAPS, foldRoster,
  type RoleProfile, type Attestation,
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

  // ★ WHAT IS STILL NOT ESTABLISHED, asserted rather than left to the README. The convener
  // is whoever this file named. Nothing above read <WS> and checked wsp:convener, so a
  // policy naming BEE as convener produces a field-bound roster of the wrong memberships.
  const wrongConvener = foldRoster({
    workspace: WS, profile: PROFILE, scopes,
    grants: [readGrant.record],
    acceptances: [readAccept.record],
    attestation: { convener: bee, signerOf, requireFieldBinding: true },
  });
  ok(
    wrongConvener.members.length === 0 && wrongConvener.recordFieldBinding === 'bound',
    '★ RESIDUAL GAP 6, demonstrated not described: naming the wrong convener changes the '
    + 'roster and the fold reports field binding as bound either way — the policy\'s '
    + 'convener is caller-supplied and nothing here checks it against <' + WS + '>',
    JSON.stringify({ members: wrongConvener.members.length, binding: wrongConvener.recordFieldBinding }),
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
