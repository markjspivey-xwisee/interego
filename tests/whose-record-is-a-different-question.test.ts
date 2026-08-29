/**
 * "WHOSE POD AM I" AND "WHOSE RECORD AM I ASKING FOR" WERE ONE FIELD, SO ONLY ONE COULD BE ASKED.
 *
 * `sign_request` stamps `subject_pod_url` from the caller's own session. That is correct and stays:
 * every WRITE binds to it, and a caller who can name the pod a write lands in can write into
 * somebody else's record. But the READ paths consulted the same field for the target, so on the
 * relay route — the only route a relay-mediated agent has — the target was always the caller's own
 * pod however `subject_did` was set. The handler then answered with the caller's data under another
 * subject's name: not an error, not a refusal, a well-formed answer to a question nobody asked.
 *
 * ★ THE UNAUTHENTICATED ROUTE IS THE ONE THAT WAS RIGHT. `GET /agent/:did/affordances` accepts no
 * pod at all — it derives one from the identity and asserts the result is in its own pod space.
 * Having no signature to lean on forced the honest design; the signed routes accepted a caller's
 * pod because a valid signature felt like authority, and a signature says who is asking, never
 * whose pod they may name.
 *
 * These assertions cover the RULE (src/read-target.ts, exercised directly) and the WIRING (the three
 * signed/authenticated read sites, which must all reach it and none of which may go back to passing
 * the stamped pod as a target).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReadTarget, type ReadTargetInput } from '../applications/foxxi-content-intelligence/src/read-target.js';

const GATE = 'https://gate.interego.xwisee.com';
const INTERNAL = 'http://css.railway.internal:3456';
const TENANT = `${GATE}/foxxi/`;

/** The caller: a relay-mediated agent, whose pod the relay stamps in the INTERNAL spelling. */
const CALLER = `${INTERNAL}/u-eth-aaaaaaaaaaaa/`;
/** Another agent, enrolled, whose pod is the `u-` twin its `did:ethr:` can never derive. */
const OTHER_DERIVED = `${GATE}/eth-bbbbbbbbbbbb/`;
const OTHER_ENROLLED = `${INTERNAL}/u-eth-bbbbbbbbbbbb/`;

const principal = (u: string): string | null => {
  const seg = (u.replace(/\/+$/, '').split('/').pop() ?? '').trim().toLowerCase();
  return seg ? seg.replace(/^u-/, '') : null;
};
const base = {
  callerPodUrl: CALLER,
  tenantPodUrl: TENANT,
  inPodSpace: (p: string) => { try { return [GATE, INTERNAL].includes(new URL(p).origin); } catch { return false; } },
  samePrincipal: (a: string, b: string) => { const ka = principal(a); const kb = principal(b); return ka !== null && kb !== null && ka === kb; },
  // The register reads both spellings of B's wallet; the pointer names the one you are NOT reading.
  otherPodForPrincipal: (p: string) => {
    if (principal(p) !== 'eth-bbbbbbbbbbbb') return undefined;
    return p === OTHER_ENROLLED ? OTHER_DERIVED : OTHER_ENROLLED;
  },
} satisfies Omit<ReadTargetInput, 'subjectIdentityGiven' | 'subjectPodUrl'>;

describe('★ the question that could not be asked: another subject, through the relay', () => {
  it('a named subject is read from the SUBJECT\'s pod, not the caller\'s stamped one', () => {
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: true, subjectPodUrl: OTHER_DERIVED });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    // The whole defect in one assertion: this used to come back as CALLER.
    expect(d.podUrl).not.toBe(CALLER);
    expect(d.isSelf).toBe(false);
    expect(d.basis).toBe('subject-identity');
  });

  it('★ the OTHER pod of the same wallet is REPORTED, never substituted', () => {
    // One wallet, two pods: `eth-<hex>`, which a bare did:ethr derives, and `u-eth-<hex>`, which
    // the identity service creates. BOTH can hold records — which one a write landed in depends on
    // the identity form the writer presented.
    //
    // ★ SUBSTITUTION WAS TRIED AND WAS WRONG WITHIN THE HOUR. The rule "read whichever spelling the
    // register knows" is right for a relay-mediated agent whose work is in the `u-` twin, and I
    // then enrolled my `u-` pod while every record I held was in the other one — where the same
    // rule would have answered my own review out of an empty pod. A heuristic picking between two
    // real pods is wrong in one direction or the other and gives no sign which time it is.
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: true, subjectPodUrl: OTHER_DERIVED });
    expect(d.ok && d.podUrl, 'the target is exactly what was derived').toBe(OTHER_DERIVED);
    expect(d.ok && d.alsoHeld, 'and the other one is named so a caller can ask for it').toBe(OTHER_ENROLLED);
  });

  it('a subject whose wallet holds one pod gets no pointer to a second', () => {
    const stranger = `${GATE}/eth-cccccccccccc/`;
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: true, subjectPodUrl: stranger });
    expect(d.ok && d.podUrl).toBe(stranger);
    expect(d.ok && d.alsoHeld).toBeUndefined();
  });
});

describe('self is "these two reduce to the same principal", across both spellings', () => {
  it('naming no subject reads the caller\'s own pod', () => {
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: false, subjectPodUrl: CALLER });
    expect(d.ok && d.isSelf).toBe(true);
    expect(d.ok && d.basis).toBe('caller');
    expect(d.ok && d.podUrl).toBe(CALLER);
  });

  it('★ a SELF-read gets the pointer too, which is how I would have found my own split records', () => {
    // Measured on myself: a `did:ethr:` derives `eth-<hex>`, I enrolled the `u-eth-` twin, and my
    // records were in the first while the register knew the second. The self-read returned an
    // empty record I read as "I have written nothing" — also true at the time — and a check that
    // passes for two reasons is evidence for neither. Naming the other pod is what breaks the tie.
    const d = resolveReadTarget({
      ...base, callerPodUrl: OTHER_DERIVED, subjectIdentityGiven: false, subjectPodUrl: OTHER_DERIVED,
    });
    expect(d.ok && d.podUrl).toBe(OTHER_DERIVED);
    expect(d.ok && d.isSelf).toBe(true);
    expect(d.ok && d.alsoHeld).toBe(OTHER_ENROLLED);
  });

  it('naming yourself in the OTHER spelling is still yourself', () => {
    // The caller is stamped `http://css.railway.internal:3456/u-eth-aaa…/`; its DID derives
    // `https://gate.interego.xwisee.com/eth-aaa…/`. Different origin, different segment, one pod.
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: true, subjectPodUrl: `${GATE}/eth-aaaaaaaaaaaa/` });
    expect(d.ok && d.isSelf, 'a self-read must survive both spellings').toBe(true);
  });
});

describe('★ a named pod is a request, never an authority', () => {
  it('a pod outside this deployment\'s pod space is REFUSED, with the reason', () => {
    // The SSRF shape the origin checks exist for: an attacker host that ends with the real one.
    const attacker = 'https://gate.interego.xwisee.com.attacker.example/eth-bbbbbbbbbbbb/';
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: true, subjectPodUrl: OTHER_DERIVED, namedAs: attacker, namedPodUrl: attacker });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatch(/pod space/);
  });

  it('a name that is not a safe public target is REFUSED rather than quietly replaced', () => {
    // resolveSubjectPodUrlPure drops an unsafe override and derives instead — the right SSRF
    // behaviour and the wrong reporting behaviour: the caller asked for pod A, got pod B, and had
    // no way to find out. Every silent fallback on this path has cost us a bug.
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: true, subjectPodUrl: OTHER_DERIVED, namedAs: 'http://127.0.0.1:3456/admin/', namedPodUrl: undefined });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatch(/not a safe public target/);
  });

  it('a name inside the pod space selects among pods already read here', () => {
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: true, subjectPodUrl: OTHER_DERIVED, namedAs: OTHER_ENROLLED, namedPodUrl: OTHER_ENROLLED });
    expect(d.ok && d.basis).toBe('named-pod');
    expect(d.ok && d.podUrl).toBe(OTHER_ENROLLED);
    expect(d.ok && d.isSelf).toBe(false);
  });
});

describe('★ the answer names the principal whose pod it read, or it is refused', () => {
  it('a subject named in one breath and a pod named in another must be one principal', () => {
    // The delegate's live finding, in the shape that survives the split: read_pod_url points at B's
    // pod while subject_did says A, and the ELR — an IEEE P2997 credential-shaped artifact — comes
    // back asserting that A did B's 750 records. Nothing leaks and the document is a forgery.
    const d = resolveReadTarget({
      ...base, subjectIdentityGiven: true, subjectPodUrl: `${GATE}/eth-dddddddddddd/`,
      namedAs: OTHER_ENROLLED, namedPodUrl: OTHER_ENROLLED,
    });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatch(/attribution, not a record/);
  });

  it('and naming no subject at all does not let you read somebody else under your own name', () => {
    // The same forgery with the fields swapped: omit subject_did (so the answer names YOU) and name
    // another pod. The record would assert the caller performed the other party's work.
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: false, subjectPodUrl: CALLER, namedAs: OTHER_ENROLLED, namedPodUrl: OTHER_ENROLLED });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatch(/attribution, not a record/);
  });

  it('an address that cannot have a pod gets an empty pod of its own, never somebody else\'s', () => {
    // `did:ethr:0x…dEaD` derives eth-000000000000. It is in the pod space, holds nothing, and is
    // nobody's — which is the correct answer, and is not what a 200 carrying 750 records said.
    const dead = `${GATE}/eth-000000000000/`;
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: true, subjectPodUrl: dead });
    expect(d.ok && d.podUrl).toBe(dead);
    expect(d.ok && d.isSelf, 'and it is emphatically not a self-read').toBe(false);
  });
});

describe('an identity that resolves to nothing must not resolve to everybody', () => {
  it('the shared tenant pod is refused as another subject\'s record', () => {
    // resolveSubjectPodUrlPure's last resort is the tenant pod. That default already enrolled every
    // agent onto one pod once; as a READ it would answer a question about one subject with a store
    // belonging to all of them.
    const d = resolveReadTarget({ ...base, subjectIdentityGiven: true, subjectPodUrl: TENANT });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toMatch(/does not resolve to a pod of its own/);
  });

  it('but a caller whose OWN pod is the tenant pod still reads it', () => {
    const d = resolveReadTarget({ ...base, callerPodUrl: TENANT, subjectIdentityGiven: false, subjectPodUrl: TENANT });
    expect(d.ok && d.isSelf).toBe(true);
  });
});

describe('the three signed read sites all reach this rule, and none of them keeps the old one', () => {
  const src = readFileSync(join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'applications', 'foxxi-content-intelligence', 'bridge', 'server.ts',
  ), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

  it('review-record, verify-extension and assemble_learner_record each call readTargetFor', () => {
    expect(code.filter((l) => /readTargetFor\(\{/.test(l))).toHaveLength(3);
  });

  it('★ and no read site passes subject_pod_url as the pod to read', () => {
    // The exact expression that made the relay route answer about the caller. `stampedPodUrl:` is
    // the permitted use — it establishes WHO IS ASKING and is bound by selfBoundPod.
    const asTarget = code.filter((l) => /resolveSubjectPodUrl\([^)]*p\.subject_pod_url/.test(l));
    expect(asTarget, `still resolving a read target from the stamped pod: ${asTarget.join(' | ')}`).toHaveLength(0);
  });

  it('the subject side is derived from the identity ALONE — no caller pod in it', () => {
    const fnAt = src.indexOf('function readTargetFor');
    expect(fnAt).toBeGreaterThan(-1);
    const fn = src.slice(fnAt, src.indexOf('\n}\n', fnAt) + 3);
    expect(fn).toMatch(/subjectPodUrl: subjectIdentity \? resolveSubjectPodUrl\(subjectIdentity\) : callerPodUrl/);
    // And the caller side goes through selfBoundPod, which honours the stamp only when it IS the
    // caller's own pod — so folding the two questions apart cannot smuggle the request back in.
    expect(fn).toMatch(/selfBoundPod\(opts\.callerDid, opts\.stampedPodUrl\)/);
  });

  it('and the descriptor tells a reader that the two fields are different questions', () => {
    // ★ READ THE ONE DECLARATION. This was `src.indexOf('const REVIEW_RECORD_AFFORDANCE')` while
    // the affordance was declared twice — in bridge/server.ts AND affordances.ts — and only this
    // file's copy carried `read_pod_url`, while the manifest the relay redirects agents to carried
    // none. Merged and de-duplicated, so this now reads what actually publishes.
    const affSrc = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)), '..', 'applications', 'foxxi-content-intelligence',
      'affordances.ts',
    ), 'utf8');
    const at = affSrc.indexOf("action: 'urn:iep:action:foxxi:review-record'");
    expect(at, 'review-record not found in affordances.ts').toBeGreaterThan(-1);
    const open = affSrc.lastIndexOf('{', at);
    let depth = 0;
    let aff = '';
    for (let i = open; i < affSrc.length; i += 1) {
      if (affSrc[i] === '{') depth += 1;
      else if (affSrc[i] === '}') {
        depth -= 1;
        if (depth === 0) { aff = affSrc.slice(open, i + 1); break; }
      }
    }
    expect(aff, 'the read-target input must be advertised').toContain('read_pod_url');
    expect(aff, 'and what subject_pod_url actually answers').toMatch(/WHOSE POD AM I/);
    // The claim was scoped ("does NOT work through the relay") for one deploy while that was true.
    // It is not true any more, and a descriptor that under-promises is still a wrong descriptor.
    expect(aff).not.toMatch(/It does NOT work through the relay/);
  });
});
