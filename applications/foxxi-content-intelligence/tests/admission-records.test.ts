/**
 * What a learner keeps about which forms of content suit them at a competency: checked, the latest
 * standing for each competency (a withdrawal included), and read by resolution whenever a request
 * names no admission of its own. The learner keeps it; the bridge only reads it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { admissionFor, admissionRecordFrom, recordFor, standingAdmissions } from '../src/admission-records.js';
import { compositionFrom, resolveComposition, type Composition } from '../src/compositions.js';
import { ContentError, fragmentFrom, type Fragment } from '../src/content-fragments.js';
import { competencyIri } from '../src/competency-identity.js';
import { lookupTerm } from '../src/foxxi-vocab.js';

const competency = competencyIri('refund-authority');
const probeOnly = { kinds: ['probe', 'reflection'], because: 'the plan for this Emergent work selected probe, coaching' };
const at = (day: number): string => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;

describe('an admission record', () => {
  it('is checked, its competency normalized, and a withdrawal kept as null', () => {
    const r = admissionRecordFrom({ competency: 'Refund-Authority', admission: probeOnly, source: 'urn:foxxi:situation:s1', regime: 'Emergent', at: at(1) });
    expect(r).toEqual({ competency, admission: probeOnly, source: 'urn:foxxi:situation:s1', regime: 'Emergent', at: at(1) });
    expect(admissionRecordFrom({ competency, admission: null, at: at(2) }).admission).toBeNull();
    for (const bad of [
      { competency: 'not a slug!', admission: probeOnly, at: at(1) },
      { competency, admission: { kinds: ['lecture'], because: 'x' }, at: at(1) },
      { competency, at: at(1) },
      { competency, admission: probeOnly, source: 'javascript:alert(1)', at: at(1) },
      { competency, admission: probeOnly, regime: 'Chaotic', at: at(1) },
      { competency, admission: probeOnly, at: 'yesterday' },
    ]) expect(() => admissionRecordFrom(bad), JSON.stringify(bad)).toThrow(ContentError);
  });

  it('stands as the latest for its competency, a withdrawal included, whatever the IRI\'s spelling', () => {
    const standing = standingAdmissions([
      { competency: 'refund-authority', admission: probeOnly, at: at(1) },
      { competency, admission: { kinds: ['reference'], because: 'the plan for this Evident work selected reference' }, at: at(3) },
      { competency: 'https://elsewhere.example/ns/foxxi/competency/refund-authority', admission: probeOnly, at: at(2) },   // older, other authority
      { competency: 'escalation', admission: probeOnly, at: at(1) },
      'not a record', { competency, admission: probeOnly, at: 'never' },
    ]);
    expect(standing.size).toBe(2);
    expect(admissionFor(standing, competency)?.kinds).toEqual(['reference']);
    expect(admissionFor(standing, 'https://another.example/ns/foxxi/competency/refund-authority')?.kinds).toEqual(['reference']);
    const withdrawn = standingAdmissions([{ competency, admission: probeOnly, at: at(1) }, { competency, admission: null, at: at(4) }]);
    expect(recordFor(withdrawn, competency)?.admission).toBeNull();
    expect(admissionFor(withdrawn, competency)).toBeUndefined();   // nothing said: every form admitted
    expect(admissionFor(standing, competencyIri('unheard-of'))).toBeUndefined();
  });
});

describe('resolution reads what the learner kept', () => {
  const concept = fragmentFrom({ kind: 'concept', competencies: ['refund-authority'], body: 'How refunds are approved.' });
  const probe = fragmentFrom({ kind: 'probe', competencies: ['refund-authority'], body: 'Try a small refund and watch who objects.' });
  const course = compositionFrom({ title: 'Refunds', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [concept['@id'], probe['@id']] }] });
  const store = new Map<string, Fragment | Composition>([concept, probe].map(x => [x['@id'], x]));
  const learner = { id: 'did:web:learner.example', kind: 'human' as const };
  const resolveWith = (records: unknown[]) => {
    const standing = standingAdmissions(records);
    return resolveComposition({ composition: course, learner, lookup: i => store.get(i), ...(standing.size ? { admission: (c: string) => admissionFor(standing, c) } : {}) });
  };

  it('admits only the forms kept for the competency, and every form again once that is withdrawn', () => {
    expect(resolveWith([]).steps[0]!.fragment['@id']).toBe(concept['@id']);
    const kept = resolveWith([{ competency, admission: probeOnly, regime: 'Emergent', at: at(1) }]);
    expect(kept.steps[0]!.fragment['@id']).toBe(probe['@id']);
    expect(kept.trace.join('\n')).toMatch(/a concept is not admitted: the plan for this Emergent work selected probe, coaching/);
    expect(resolveWith([{ competency, admission: probeOnly, at: at(1) }, { competency, admission: null, at: at(2) }]).steps[0]!.fragment['@id']).toBe(concept['@id']);
    const nothing = resolveWith([{ competency, admission: { kinds: [], because: 'the plan for this Turbulent work selected environmental-fix, which no content delivers' }, at: at(1) }]);
    expect(nothing.steps).toHaveLength(0);
    expect(JSON.stringify(nothing.unmet)).toMatch(/no content is admitted here: the plan for this Turbulent work/);
  });

  it('lets a withdrawal at a position stand over what its composition\'s competency admits', () => {
    // The course develops "refunds"; its position is about "refund-authority".
    const wide = compositionFrom({ title: 'Refunds', competency: 'refunds', positions: [{ competency: 'refund-authority', paradigm: [concept['@id'], probe['@id']] }] });
    const resolveWide = (records: unknown[]) => {
      const standing = standingAdmissions(records);
      return resolveComposition({ composition: wide, learner, lookup: i => store.get(i),
        admission: c => { const r = recordFor(standing, c); return r ? r.admission : undefined; } });
    };
    const courseWide = { competency: competencyIri('refunds'), admission: probeOnly, at: at(1) };
    // Nothing kept for the position: what the course's competency admits applies there.
    expect(resolveWide([courseWide]).steps[0]!.fragment['@id']).toBe(probe['@id']);
    // Withdrawn for the position: nothing limits it, and the course's does not step in.
    const withdrawn = resolveWide([courseWide, { competency, admission: probeOnly, at: at(1) }, { competency, admission: null, at: at(2) }]);
    expect(withdrawn.steps[0]!.fragment['@id']).toBe(concept['@id']);
    expect(withdrawn.trace.join('\n')).toMatch(/the admission for this competency was withdrawn, so every form was admitted/);
  });
});

describe('the bridge keeps an admission only when the learner asks, and reads it back', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n});', src.indexOf(from)));
  const fn = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n}\n', src.indexOf(from)));

  it('keeps it on the caller\'s own pod, dated by the bridge, sealed, and only once the pod holds it', () => {
    const r = route("app.post('/agent/content/admit'");
    expect(r.indexOf('contentRateLimited(req, res)')).toBeGreaterThan(0);
    expect(r.indexOf('contentRateLimited(req, res)')).toBeLessThan(r.indexOf('verifyDelegatedCaller(req.body)'));
    expect(r).toMatch(/admissionRecordFrom\(\{ competency: p\.competency, admission: p\.admission, source: p\.source, regime: p\.regime, at: new Date\(\)\.toISOString\(\) \}\)/);
    expect(r).toMatch(/const pod = resolveSubjectPodUrl\(auth\.callerDid\);/);
    expect(r).not.toMatch(/subject_pod_url/);
    expect(r).toMatch(/if \(!tenantPodUrl \|\| !sameStore\(pod, tenantPodUrl\)\) \{\n\s+res\.status\(409\)/);
    // Its own sealed list on the pod (src/admission-store.ts), not the shared lattice: a write that fails
    // leaves nothing in memory that a later read or a later write could pick up.
    expect(r).not.toMatch(/composeIntoSharedLattice/);
    expect(r).toMatch(/if \(!key\) \{ res\.status\(503\)/);
    expect(r).toMatch(/const kept = await keepAdmission\(pod, record, key, globalThis\.fetch as never, ownerKey\);/);
    expect(r).toMatch(/if \(!kept\.ok\) \{ res\.status\(503\)/);
  });

  it('reads the learner\'s own records only from a pod on its store, refuses when they cannot be read, and only when a request names no admission', () => {
    const read = fn('async function learnerAdmissions');
    expect(read).toMatch(/if \(!tenantPodUrl \|\| !sameStore\(pod, tenantPodUrl\)\) return \{ ok: true, standing: new Map\(\) \};/);
    expect(read).toMatch(/const read = await readAdmissions\(pod, bridgeEncryptionKeypair\(\), globalThis\.fetch as never\);/);
    expect(read).toMatch(/return read\.ok \? \{ ok: true, standing: standingAdmissions\(read\.records\) \} : read;/);
    const resolve = route('async function resolveForCaller');
    expect(resolve).toMatch(/const kept = admission \? undefined : await learnerAdmissions\(callerDid\);/);
    // Unreadable is not empty: a learner who limited their content is not resolved as one who did not.
    expect(resolve).toMatch(/if \(kept && !kept\.ok\) return \{ ok: false, status: 503,/);
    expect(resolve.indexOf('kept && !kept.ok')).toBeLessThan(resolve.indexOf('resolveComposition('));
    // One rule, the request's own admission or else what the learner kept, is what resolution reads
    // and what the play keeps, so a way in after a missed check reads the same one.
    expect(resolve).toMatch(/const admit = admission \? \(\) => admission : kept\?\.ok && kept\.standing\.size \? fromKept : undefined;/);
    expect(resolve).toMatch(/\.\.\.\(admit \? \{ admission: admit \} : \{\}\), lookup: iri => contentStore\.get\(iri\)/);
    expect(resolve).toMatch(/if \(standing\?\.admission\) admittedBy\.set\(standing\.competency, standing\);/);
    // A withdrawal answers null, so the composition's own admission does not step in.
    expect(resolve).toMatch(/return standing \? standing\.admission : undefined;/);
    expect(route("app.post('/agent/content/resolve'")).toMatch(/admittedBy: r\.admittedBy/);
    expect(lookupTerm('ContentAdmission')).toBeTruthy();
  });
});
