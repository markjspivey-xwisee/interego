/**
 * What a failed unit of work is answered with, and what a performer keeps.
 *
 * When a unit fails and its trajectory was sent, the bridge answers with an offer: the regime its
 * work reads as, the plan for that regime, and the forms of content that plan admits at the
 * competency. It is the performer's to keep (foxxi.content_admit) or not; nothing is kept from the
 * offer itself. What they keep, resolution reads whenever it resolves a composition for them, until
 * they replace it or withdraw it (foxxi.content_admissions lists it). A person and an agent keep
 * and withdraw the same way.
 */
import { FRAGMENT_KIND_LIST } from '../../../src/fragment-kinds.js';

/** An offer, as record-performance answers a failed unit with one. */
export interface WorkOffer {
  competency: string;
  kinds: string[];
  because: string;
  regime?: string;
  forPerformer?: string;
  note?: string;
  situation?: { observed: string; modalStatus: string };
  diagnosis?: { regime: string; regimeSource?: string; method?: string };
  plan?: { selected: string[]; summary: string };
  evidence?: { work: string[]; failed: number; assessed: number; withTrajectory: number };
}

/** What record-performance answers. */
export interface Recorded {
  ok: true;
  recorded: true;
  statementId: string;
  taskId: string;
  taskName: string;
  activityType: string;
  success: boolean;
  offer?: WorkOffer;
  offerWithheld?: string;
}

/** A kept admission, as foxxi.content_admissions lists it: the standing record at a competency. */
export interface KeptAdmission {
  competency: string;
  /** null: withdrawn, so nothing limits that competency. */
  admission: { kinds: string[]; because: string } | null;
  source?: string;
  regime?: string;
  at: string;
}

/** What keeping an offer sends to foxxi.content_admit. */
export function keepArgs(offer: WorkOffer): Record<string, unknown> {
  return {
    competency: offer.competency,
    admission: { kinds: [...offer.kinds], because: offer.because },
    ...(offer.regime ? { regime: offer.regime } : {}),
  };
}

/** What withdrawing the admission kept at a competency sends: nothing limits it after. */
export function withdrawArgs(competency: string): Record<string, unknown> {
  return { competency, admission: null };
}

/** The forms of content an admission lets in, as a person reads them. */
export function kindsLine(kinds: readonly string[]): string {
  if (!kinds.length) return 'no form of content: nothing is taught here until this changes';
  return kinds.map(k => FRAGMENT_KIND_LIST.find(d => d.kind === k)?.label ?? k).join(', ');
}

/** A kept admission, one line. */
export function keptLine(k: KeptAdmission): string {
  return k.admission ? `Admits ${kindsLine(k.admission.kinds)}` : 'Withdrawn: nothing limits this competency';
}

/** The kept admissions still standing (not withdrawn), newest first as the bridge lists them. */
export function standing(kept: readonly KeptAdmission[]): KeptAdmission[] {
  return kept.filter(k => k.admission !== null);
}
