/**
 * Fleet migration runner (Stage 5 tooling) — orchestrates the per-pod migrator
 * across many pods, SAFE BY DEFAULT.
 *
 * With `execute` unset/false it is a DRY RUN: it plans + counts and writes
 * NOTHING. Only `execute === true` performs the non-destructive per-pod
 * migration, each gated by the fail-closed `verifyMigration` byte-parity check;
 * any pod that doesn't fully verify is reported in `failedPods` and NOT counted
 * as migrated (so a bad pod never silently "passes").
 *
 * The runner + its gating are proven here on SYNTHETIC fleets. Pointing it at the
 * ~728 REAL users' pods with `execute:true` (and flipping the prod publish path +
 * enabling prod multi-replica) is the consent-gated production go-live — a human
 * passes `execute:true` with oversight; it is not run autonomously.
 */

import type { LdpStore } from './ldp.js';
import { migratePod, verifyMigration, type MigrationReport, type SourceResource } from './migrate.js';

export interface PodPlan {
  pod: string;
  resources: SourceResource[];
}

export interface FleetReport {
  /** false = dry run (nothing was written). */
  executed: boolean;
  pods: number;
  totalResources: number;
  /** Pods that migrated AND fully passed the byte-parity verify gate. */
  migratedPods: number;
  /** Pods that did not fully verify (empty on a clean run). */
  failedPods: Array<{ pod: string; mismatches: string[] }>;
}

export async function runMigration(
  ldp: LdpStore,
  plan: readonly PodPlan[],
  opts: { execute?: boolean; onProgress?: (pod: string, report: MigrationReport | null) => void } = {},
): Promise<FleetReport> {
  const execute = opts.execute === true;
  let totalResources = 0;
  let migratedPods = 0;
  const failedPods: Array<{ pod: string; mismatches: string[] }> = [];

  for (const { pod, resources } of plan) {
    totalResources += resources.length;
    if (!execute) {
      opts.onProgress?.(pod, null); // dry run: no writes
      continue;
    }
    const report = await migratePod(ldp, pod, resources);
    opts.onProgress?.(pod, report);
    const gate = await verifyMigration(ldp, pod, resources);
    if (gate.ok) migratedPods++;
    else failedPods.push({ pod, mismatches: gate.mismatches });
  }

  return { executed: execute, pods: plan.length, totalResources, migratedPods, failedPods };
}
