/**
 * Bind a claimed performance to evidence that exists, BEFORE the claim is recorded.
 *
 * ★ WHY THIS EXISTS, AND IT IS NOT A HYPOTHETICAL.
 *
 * `record-performance` used to take the performer's word for everything. An independent
 * reviewer registered a throwaway agent, submitted six signed performances citing
 * `task_id`s that had never existed — every one of them a live 404 — and read back
 * `performanceVerifiedCompetencies: 1` at Dreyfus Proficient with a Wilson lower bound of
 * 0.61, the exact figure for 6/6. Nothing on the path that produced that claim required a
 * workspace, a membership, an acceptance, a witness, a shape-validated record, or evidence
 * that resolves. The published work shape gated only writes that VOLUNTARILY declared it;
 * the read path never consulted it.
 *
 * So the check moves to the side that cannot be opted out of. Two preconditions, both
 * general, neither naming any vertical:
 *
 *   1. A `task_id` that is an http(s) URL MUST dereference. A pointer that answers 404 is
 *      not weak evidence, it is a claim about an artifact that does not exist — and this
 *      vertical credentials people for spotting exactly that.
 *   2. When the submitter names an `evidence_shape`, the FETCHED record is validated
 *      against it and a violation refuses the write. The shape is published data; the
 *      engine is the substrate's general SHACL engine; nothing here knows what the shape
 *      says. That is what turns a work contract from a write-side opt-in on the producer's
 *      pod into a read-side precondition on the consumer's record.
 *
 * ★ WHAT IT STILL DOES NOT ESTABLISH, stated here rather than left for a reader to find.
 * A submitter who names no shape gets `resolved`, not `validated`: the artifact exists and
 * a stranger can read it, but nobody checked what it says. A submitter who cites no URL at
 * all gets `unbound` — a pure self-report. Both outcomes are STAMPED ON THE STATEMENT
 * (see `EVIDENCE_BINDING_EXT`) and surfaced on the record, so the strength of a claim is a
 * field a reader can read, not a paragraph they have to trust.
 */

import { validateAgainstShape } from '@interego/core';
import { safeFetch } from './ssrf-guard.js';
import { FOXXI_NS } from './foxxi-vocab.js';

/** How strongly a recorded performance is tied to an artifact anybody can check. */
export type EvidenceBinding =
  /** No http(s) `task_id` was cited — a self-report about work with no external artifact. */
  | 'unbound'
  /** The cited artifact dereferences. Nobody checked what it says. */
  | 'resolved'
  /** The cited artifact dereferences AND validates against a shape the submitter named. */
  | 'shape-validated';

/** Context-extension IRIs the evidence binding stamps onto the xAPI statement, so the
 *  strength of a claim travels with the claim instead of living in a README. */
export const EVIDENCE_BINDING_EXT = `${FOXXI_NS}evidenceBinding`;
export const EVIDENCE_SHAPE_EXT = `${FOXXI_NS}evidenceShape`;

export interface EvidenceBindingResult {
  readonly ok: boolean;
  readonly binding: EvidenceBinding;
  /** Set when `ok` is false: the caller-safe reason, and the HTTP status to answer with. */
  readonly status?: number;
  readonly error?: string;
  readonly detail?: string;
  /** The shape IRI that was applied, when one was. */
  readonly shapeIri?: string;
  readonly violations?: ReadonlyArray<{ focusNode: string; path?: string; constraint: string; message: string }>;
}

const MAX_EVIDENCE_BYTES = 512 * 1024;

type GuardedResponse = { headers: { get(n: string): string | null }; text(): Promise<string> };

/** Read a guarded response, bounded. A caller-supplied `task_id` is an arbitrary URL, so
 *  the recording path must not agree to buffer whatever is at the other end: a declared
 *  Content-Length over the bound is refused before the body is read, and an undeclared one
 *  is truncated after. Truncation is safe for the only two consumers — a SHACL parse of a
 *  truncated document fails closed, it does not pass vacuously. */
async function boundedText(r: GuardedResponse, what: string): Promise<string> {
  const declared = Number(r.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_EVIDENCE_BYTES) {
    throw new Error(`${what} declares ${declared} bytes, over the ${MAX_EVIDENCE_BYTES}-byte bound this path will read`);
  }
  const body = await r.text();
  return body.length > MAX_EVIDENCE_BYTES ? body.slice(0, MAX_EVIDENCE_BYTES) : body;
}

export async function bindPerformanceToEvidence(args: {
  /** The `task_id` the submitter cited. */
  readonly taskId: string;
  /** A published SHACL shape IRI the submitter names for its own evidence. Optional. */
  readonly evidenceShapeIri?: string | undefined;
  readonly fetchFn?: Parameters<typeof safeFetch>[2];
}): Promise<EvidenceBindingResult> {
  const taskId = args.taskId.trim();
  // A task id that is not a URL cites no artifact. That is a weaker claim, not an invalid
  // one — `record-performance` has always accepted a bare task name — so it is recorded
  // AS a weaker claim rather than refused. Refusing would break every existing caller
  // while catching nothing: a fabricator would simply stop citing a URL, and the honest
  // answer to that is to make the difference visible, which `unbound` does.
  if (!/^https?:\/\//i.test(taskId)) return { ok: true, binding: 'unbound' };

  const fetchFn = args.fetchFn;
  let body: string;
  try {
    // safeFetch re-screens every redirect hop: `task_id` is caller-supplied, so without it
    // this route is an SSRF probe that reports reachability through its own status code.
    const r = await safeFetch(taskId, { headers: { Accept: 'text/turtle, application/ld+json;q=0.9, */*;q=0.5' } }, fetchFn);
    if (!r.ok) {
      return {
        ok: false, binding: 'unbound', status: 400,
        error: 'the cited evidence does not resolve',
        detail: `task_id <${taskId}> answered ${r.status}. A performance is a claim about an artifact; recording one whose artifact cannot be fetched mints an evidence pointer that lies, and descriptors are immutable so it would lie permanently.`,
      };
    }
    body = await boundedText(r, `task_id <${taskId}>`);
  } catch (e) {
    return {
      ok: false, binding: 'unbound', status: 400,
      error: 'the cited evidence could not be fetched',
      detail: `task_id <${taskId}>: ${(e as Error).message}`,
    };
  }

  const shapeIri = args.evidenceShapeIri?.trim();
  if (!shapeIri) return { ok: true, binding: 'resolved' };
  if (!/^https?:\/\//i.test(shapeIri)) {
    return { ok: false, binding: 'resolved', status: 400, error: 'evidence_shape must be a dereferenceable http(s) IRI', detail: `Received "${shapeIri}".` };
  }

  let shapeTurtle: string;
  try {
    const s = await safeFetch(shapeIri, { headers: { Accept: 'text/turtle' } }, fetchFn);
    // ★ AN UNREADABLE SHAPE IS A REFUSAL, NOT A PASS. Treating a 404 shape as "no
    // constraints" is how a gate becomes a decoration: the submitter names a shape, the
    // fetch fails, and the record is stamped `shape-validated` having been validated
    // against nothing. Same failure the relay's publish gate was fixed for (#268).
    if (!s.ok) {
      return {
        ok: false, binding: 'resolved', status: 400,
        error: 'the named evidence shape does not resolve',
        detail: `evidence_shape <${shapeIri}> answered ${s.status}. A shape that cannot be read cannot be relied on as a gate, and passing the record anyway would record it as checked.`,
      };
    }
    shapeTurtle = await boundedText(s, `evidence_shape <${shapeIri}>`);
  } catch (e) {
    return { ok: false, binding: 'resolved', status: 400, error: 'the named evidence shape could not be fetched', detail: `evidence_shape <${shapeIri}>: ${(e as Error).message}` };
  }

  const report = validateAgainstShape(body, shapeTurtle);
  if (!report.conforms) {
    return {
      ok: false, binding: 'resolved', status: 422,
      error: 'the cited evidence does not satisfy the shape its submitter named',
      detail: `evidence_shape <${shapeIri}> rejected <${taskId}>.`,
      shapeIri,
      violations: report.results.map(v => ({
        focusNode: String(v.focusNode ?? ''),
        ...(v.path !== undefined ? { path: String(v.path) } : {}),
        constraint: String(v.constraintComponent ?? ''),
        message: String(v.message ?? ''),
      })),
    };
  }
  return { ok: true, binding: 'shape-validated', shapeIri };
}
