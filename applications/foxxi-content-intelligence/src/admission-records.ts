/**
 * What a learner keeps, on their own pod, about which forms of content suit them at a competency:
 * an admission (compositions.ts), with where it came from and when.
 *
 * ★ THE LEARNER KEEPS IT; THE BRIDGE ONLY READS IT. A plan says which forms of content deliver the
 * interventions it selected. The performance practice makes plans, and a plan for Emergent work
 * admits probes and reflection, never a lesson. The bridge does not write a plan's consequence
 * onto anyone's record. The learner, person or agent, keeps it with foxxi.content_admit, and
 * replaces or withdraws it the same way. Resolution reads the latest one kept for each
 * competency whenever a request names no admission of its own.
 *
 * ★ THE LATEST ONE STANDS. Records are added, never overwritten. For each competency the latest
 * stands, and a withdrawal is a record too, so what stood before stays in the learner's history.
 *
 * ★ WHERE IT CAME FROM TRAVELS WITH IT. A record names its source (the plan or situation it came
 * from) and the regime that plan read, when it had one. So the learner can see why content was
 * kept from them, and when that was decided.
 */
import { admissionFrom, type Admission } from './compositions.js';
import { competencyRef, ContentError } from './content-fragments.js';
import { competencyIdOf } from './competency-identity.js';

/** The lattice content type a kept admission is stored under. */
export const CONTENT_ADMISSION_TYPE = 'foxxi:ContentAdmission';

export interface AdmissionRecord {
  /** The competency it is about, as a competency IRI. */
  competency: string;
  /** Which forms suit the learner there, or null for a withdrawal: nothing said, every form admitted. */
  admission: Admission | null;
  /** What it came from: the IRI of a plan or situation. */
  source?: string;
  /** The work regime the plan read, as it named it. */
  regime?: string;
  /** When it was kept. */
  at: string;
}

const REGIMES = ['Evident', 'Knowable', 'Emergent', 'Turbulent'] as const;

/** A record from what a learner sent, or read back from their pod: checked, and its competency normalized. */
export function admissionRecordFrom(raw: unknown): AdmissionRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContentError('an admission record is { competency, admission, source?, regime?, at }');
  const r = raw as Record<string, unknown>;
  const competency = competencyRef(r.competency, 'competency');
  const admission = r.admission === null ? null : admissionFrom(r.admission);
  if (r.source !== undefined && (typeof r.source !== 'string' || r.source.length > 500 || !/^(https?|urn|did):\S+$/.test(r.source))) {
    throw new ContentError('source is the IRI of the plan or situation the admission came from');
  }
  if (r.regime !== undefined && !REGIMES.includes(r.regime as typeof REGIMES[number])) throw new ContentError(`regime is one of ${REGIMES.join(', ')}`);
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) throw new ContentError('at is when the admission was kept');
  return {
    competency, admission,
    ...(r.source !== undefined ? { source: r.source as string } : {}),
    ...(r.regime !== undefined ? { regime: r.regime as string } : {}),
    at: new Date(r.at).toISOString(),
  };
}

/**
 * The record standing for each competency, keyed by the competency's id: the latest kept, a
 * withdrawal included. What cannot be read as a record is passed over, since a learner's pod may
 * hold anything.
 */
export function standingAdmissions(records: Iterable<unknown>): Map<string, AdmissionRecord> {
  const standing = new Map<string, AdmissionRecord>();
  for (const raw of records) {
    let record: AdmissionRecord;
    try { record = admissionRecordFrom(raw); } catch { continue; }
    const id = competencyIdOf(record.competency);
    if (!id) continue;
    const held = standing.get(id);
    if (!held || Date.parse(record.at) >= Date.parse(held.at)) standing.set(id, record);
  }
  return standing;
}

/** The record standing for a competency, a withdrawal included, or undefined when none was kept. */
export function recordFor(standing: ReadonlyMap<string, AdmissionRecord>, competency: string): AdmissionRecord | undefined {
  const id = competencyIdOf(competency);
  return id ? standing.get(id) : undefined;
}

/** The admission standing for a competency, or undefined when none is kept or the latest was a withdrawal. */
export function admissionFor(standing: ReadonlyMap<string, AdmissionRecord>, competency: string): Admission | undefined {
  return recordFor(standing, competency)?.admission ?? undefined;
}
