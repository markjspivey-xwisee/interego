/**
 * THE MESH ENROLMENT REGISTER AS AN ARRAY TRANSFORM — retire a row, do not erase it.
 *
 * ── ★★ THE PRUNE WAS RIGHT AND THE ERASURE WAS NOT ──────────────────────────────────────────
 *
 * MEASURED: an agent enrolled itself, was answered `durable: true`, appeared in the register beside
 * two others, and was gone fifty minutes later with nothing anywhere saying so. The prune had
 * removed it for presenting no trajectory-step manifest, which is correct for the fifteen pods once
 * left enrolled by keys nobody holds — and exactly wrong for a new agent, because "has written
 * nothing yet" is the state every agent starts in. So the system silently un-enrols precisely the
 * agents whose records would honestly read empty, and their empty record then reports "not
 * enrolled": the ambiguity the `whyEmpty` block exists to remove, arriving from behind.
 *
 * Deleting the row published the retirement as an ABSENCE, and an absence reads identically to
 * "never enrolled" and to "your durable write silently failed". Three different situations, one
 * representation, and only the party who cannot see any of it needed to tell them apart.
 *
 * ★ SO A RETIREMENT IS A ROW WITH A REASON. The prune is unchanged — a retired pod is swept by
 * nothing — and the record of what this service decided about a party who was not present stays
 * readable in the register that party can dereference.
 *
 * ★ AND IT IS A BOUNDED TAIL, NOT A LEDGER. The point is that the agent just retired can find out;
 * a row from months ago serves nobody and costs every reader of a public document bytes. Retired
 * rows are also excluded from the enrolment CAP, which bounds recurring outbound work (one pod
 * fetch per cycle per enrolled pod) — counting them would let the audit tail deny enrolment to real
 * agents, which is the failure the retirement path was added to fix.
 */

/** A register row, as loosely as it is actually read back from a pod section. */
export type RegisterRow = Record<string, unknown>;

/** Is this row a retirement rather than an enrolment? Its `retired_at` is what makes it one. */
export function isRetired(row: RegisterRow): boolean {
  return typeof row['retired_at'] === 'string' && row['retired_at'] !== '';
}

/** The rows the projector actually sweeps, and the only ones that count against the cap. */
export function activeRows(rows: readonly RegisterRow[]): RegisterRow[] {
  return rows.filter((r) => !isRetired(r));
}

export interface RetireResult {
  /** The register as it should now be published. Unchanged when nothing needed doing. */
  readonly rows: RegisterRow[];
  /** Did this call change anything? A row already retired is left exactly as it was. */
  readonly changed: boolean;
  /** Is the pod now out of the swept set? True for "retired just now" AND "already retired". */
  readonly retired: boolean;
}

/**
 * Retire the row for `pod`, keeping at most `keep` retirements newest-first.
 *
 * `samePod` is injected rather than assumed: one pod has two legitimate spellings here and a
 * comparison on the URL bytes has already been wrong four times elsewhere in this deployment.
 */
export function retireRow(opts: {
  readonly rows: readonly RegisterRow[];
  readonly pod: string;
  readonly reason: string;
  readonly now: string;
  readonly keep: number;
  readonly samePod: (a: string, b: string) => boolean;
}): RetireResult {
  const { rows, pod, reason, now, keep, samePod } = opts;
  const isThisPod = (r: RegisterRow): boolean => typeof r['pod_url'] === 'string' && samePod(r['pod_url'], pod);
  const target = rows.find(isThisPod);

  // No row at all: nothing was retired, and that is not an error.
  if (!target) return { rows: [...rows], changed: false, retired: false };
  // ★ ALREADY RETIRED — LEAVE THE ACCOUNT ALONE. Re-stamping would overwrite the record of what
  // actually happened with a fresher timestamp and a less accurate reason, which is a worse
  // outcome than doing nothing: the row would then misdate the decision it exists to explain.
  if (isRetired(target)) return { rows: [...rows], changed: false, retired: true };

  const retiredRow: RegisterRow = { ...target, retired_at: now, retired_reason: reason };
  const others = rows.filter((r) => !isThisPod(r));
  const priorRetired = others.filter(isRetired)
    .sort((a, b) => String(b['retired_at']).localeCompare(String(a['retired_at'])))
    .slice(0, Math.max(0, keep - 1));
  return { rows: [...activeRows(others), retiredRow, ...priorRetired], changed: true, retired: true };
}
