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
});

describe('the bridge keeps an admission only when the learner asks, and reads it back', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n});', src.indexOf(from)));
  const fn = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n}\n', src.indexOf(from)));

  it('keeps it on the caller\'s own pod, dated by the bridge, in their lattice with no public projection', () => {
    const r = route("app.post('/agent/content/admit'");
    expect(r.indexOf('contentRateLimited(req, res)')).toBeGreaterThan(0);
    expect(r.indexOf('contentRateLimited(req, res)')).toBeLessThan(r.indexOf('verifyDelegatedCaller(req.body)'));
    expect(r).toMatch(/admissionRecordFrom\(\{ competency: p\.competency, admission: p\.admission, source: p\.source, regime: p\.regime, at: new Date\(\)\.toISOString\(\) \}\)/);
    expect(r).toMatch(/const pod = resolveSubjectPodUrl\(auth\.callerDid\);/);
    expect(r).not.toMatch(/subject_pod_url/);
    expect(r).toMatch(/if \(!tenantPodUrl \|\| !sameStore\(pod, tenantPodUrl\)\) \{\n\s+res\.status\(409\)/);
    expect(r).toMatch(/contentType: CONTENT_ADMISSION_TYPE, ts: record\.at, projections: \['rdf'\], publishDescriptor: false,/);
    expect(r).toMatch(/if \(!kept\?\.persisted\) \{ res\.status\(503\)/);
  });

  it('reads the learner\'s own records only from a pod on its store, and only when a request names no admission', () => {
    const read = fn('async function learnerAdmissions');
    expect(read).toMatch(/if \(!tenantPodUrl \|\| !sameStore\(pod, tenantPodUrl\)\) return new Map\(\);/);
    expect(read).toMatch(/standingAdmissions\(latticeArtifacts\(label, CONTENT_ADMISSION_TYPE\)\.map\(a => a\.content\)\)/);
    const resolve = route('async function resolveForCaller');
    expect(resolve).toMatch(/const kept = admission \? undefined : await learnerAdmissions\(callerDid\);/);
    expect(resolve).toMatch(/\.\.\.\(admission \? \{ admission: \(\) => admission \} : kept\?\.size \? \{ admission: fromKept \} : \{\}\)/);
    expect(resolve).toMatch(/if \(standing\?\.admission\) admittedBy\.set\(standing\.competency, standing\);/);
    expect(route("app.post('/agent/content/resolve'")).toMatch(/admittedBy: r\.admittedBy/);
    expect(lookupTerm('ContentAdmission')).toBeTruthy();
  });
});
