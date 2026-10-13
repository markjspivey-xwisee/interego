/**
 * The credential fixtures in this directory and the verdict each gets: the specification's, which the
 * Foxxi validator gives the JSON and a SHACL processor gives the RDF reading. Held by
 * credentials-the-specs-allow-conform-in-both-readings.test.ts (the substrate's SHACL processor) and by
 * the Foxxi SHACL agreement job (pySHACL; see tools/shacl-agreement/).
 */
import type { OntologyModel } from '../../../src/spec-ontology.js';
import { OB3_MODEL, CLR_MODEL } from '../../../src/spec/ler.model.js';

export interface Expect {
  model: OntologyModel;
  /** The specification's verdict. */
  conforms: boolean;
  /** The shapes the violations are reported by, in both readings. */
  faults?: string[];
  /** A requirement on the JSON document only: the RDF reading cannot see it. */
  jsonOnly?: string;
  /** Safe mode refuses to read the document: no RDF reading, and this is why. */
  refused?: string;
}
const ob3 = (conforms: boolean, rest: Partial<Expect> = {}): Expect => ({ model: OB3_MODEL, conforms, ...rest });
const clr = (conforms: boolean, rest: Partial<Expect> = {}): Expect => ({ model: CLR_MODEL, conforms, ...rest });
export const CREDENTIAL_CASES: Readonly<Record<string, Expect>> = {
  'ob3-embedded-proof': ob3(true),
  'ob3-enveloped': ob3(true),
  'ob3-identifier-only': ob3(true),
  'foxxi-course-completion': ob3(true),
  'ob3-no-id': ob3(false, { faults: ['OpenBadgeCredentialShape'] }),
  'ob3-no-issuer': ob3(false, { faults: ['OpenBadgeCredentialShape'] }),
  'ob3-local-time': ob3(false, { faults: ['OpenBadgeCredentialShape'] }),
  'ob3-anonymous-subject': ob3(false, { faults: ['AchievementSubjectShape'] }),
  'ob3-undescribed-achievement': ob3(false, { faults: ['AchievementShape'] }),
  'ob3-no-criteria': ob3(false, { faults: ['AchievementShape'] }),
  'ob3-unhashed-identity': ob3(false, { faults: ['IdentityObjectShape'] }),
  'ob3-untyped-subject': ob3(false, { refused: 'invalid property' }),
  'ob3-untyped-achievement': ob3(false, { refused: 'invalid property' }),
  'ob3-contexts-swapped': ob3(false, { jsonOnly: '@context' }),
  'clr-valid': clr(true),
  'clr-identifier-only': clr(true),
  'foxxi-clr': clr(true),
  'clr-unnamed': clr(false, { faults: ['ClrCredentialShape'] }),
  'clr-no-validfrom': clr(false, { faults: ['ClrCredentialShape'] }),
  'clr-no-credentials': clr(false, { faults: ['ClrSubjectShape'] }),
  'clr-without-ob-context': clr(false, { refused: 'relative @type reference' }),
};
