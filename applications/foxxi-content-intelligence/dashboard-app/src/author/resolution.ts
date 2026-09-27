/**
 * A composition seen from outside the author tools: how it resolves for a learner, and where else it
 * can be taken.
 *
 * Resolving (foxxi.content_resolve) is what a launch does first, without starting a play or
 * recording anything: the author sees which alternative each position gives them from their own
 * record, and why, and which positions are skipped or cannot be filled. They may ask as a person or
 * as an agent, since some fragments are meant for one kind of learner only.
 *
 * Exporting is the bridge's own: a composition dereferences to a cmi5 course structure and to a
 * SCORM 2004 package, whose one unit is this bridge's player. Any LMS that takes either can import
 * it. A learner an LMS names is one the bridge cannot verify, so their play resolves as for anyone
 * new to it, and adds nothing to what has worked here.
 */
import type { PositionNote, StepView } from '../learn/play.js';

/** One step as a resolution gives it. */
export type ResolvedStepView = Omit<StepView, 'step' | 'of' | 'wayIn'> & {
  position: number;
  path: string[];
  alternatives: string[];
  pitchedAt: string;
};

/** What foxxi.content_resolve answers. */
export interface ResolutionView {
  ok: true;
  learnerKind: 'human' | 'agent';
  steps: ResolvedStepView[];
  skipped: PositionNote[];
  unmet: PositionNote[];
  refused: string[];
  missing?: string[];
  admittedBy?: Array<{ competency: string; admission: { kinds: string[]; because: string } | null }>;
  trace: string[];
}

/** A resolution in one line. */
export function resolutionLine(r: Pick<ResolutionView, 'steps' | 'skipped' | 'unmet'>): string {
  const n = r.steps.length;
  const parts = [n === 0 ? 'nothing to play' : n === 1 ? 'one step' : `${n} steps`];
  if (r.skipped.length) parts.push(`${r.skipped.length} position${r.skipped.length === 1 ? '' : 's'} skipped`);
  if (r.unmet.length) parts.push(`${r.unmet.length} that nothing could fill`);
  return parts.join(', ');
}

/** One step, as the author reads it: what they would be shown there, and at what level. */
export function stepLine(s: ResolvedStepView): string {
  const f = s.fragment;
  return `${f.title ?? `a ${f.kind} fragment`} (${f.kind}, pitched ${s.pitchedAt})`;
}

/** Where a composition can be taken: its cmi5 course structure and its SCORM 2004 package, on the bridge at `base`. */
export function exportLinks(base: string, hash: string): { cmi5: string; scorm: string } {
  const iri = `${base.replace(/\/+$/, '')}/ns/foxxi/composition/${hash}`;
  return { cmi5: `${iri}/cmi5.xml`, scorm: `${iri}/scorm.zip` };
}

/** What each is saved as: named as the bridge names the SCORM package it serves, after the first twelve of the hash. */
export function exportFileNames(hash: string): { cmi5: string; scorm: string } {
  const stem = `composition-${hash.slice(0, 12)}`;
  return { cmi5: `${stem}-cmi5.xml`, scorm: `${stem}-scorm.zip` };
}
