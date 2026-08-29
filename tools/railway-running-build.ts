/**
 * WHAT IS EACH SERVICE ACTUALLY RUNNING? Asked of the service, not of Railway.
 *
 * ── ★★ THE FALSE GREEN THIS EXISTS FOR ──────────────────────────────────────
 *
 * OBSERVED during the 2026-08-29 rollout. `tools/railway-fleet-audit.ts` printed "Every
 * service is running the image master would build for it." and exited 0 while `bridge` was
 * still serving the PREVIOUS commit. The table underneath said why, and nobody could have
 * read it as a warning: `tools/railway-pins.mjs` showed `bridge` as DEPLOYING with
 * FRESH=current.
 *
 *   `current` means RAILWAY IS POINTED AT THE RIGHT IMAGE. It does not mean a container
 *   built from that image is answering requests, and every axis the audit had — image
 *   repository, pin freshness, bundle scope, deploy dates, caps, replica settings — is a
 *   statement about the POINTER. The audit never asked a single service what it was
 *   running, and its headline sentence claimed the answer.
 *
 * ★ THAT THE OLD AUDIT COULD NOT SEE IT IS STRUCTURAL, NOT AN ACCIDENT OF TIMING, AND THE
 * NEW AXIS WAS DRIVEN AGAINST THE LIVE FLEET TO CONFIRM IT: with `bridge`'s row rewritten
 * IN MEMORY to the sha eleven services really run — nothing deployed, no pin touched — the
 * real /health request to bridge.interego.xwisee.com came back with the OTHER sha and this
 * axis reported NOT-RUNNING. Every column the old audit printed for that row was unchanged.
 *
 * Two live states produce that gap, and only one of them clears on its own:
 *
 *   · a rollout IN FLIGHT — the pin is new, the old container is still serving. Minutes.
 *   · a deploy that NEVER SWAPPED — Railway calls the deployment SUCCESS once the
 *     container binds a port, and if the image cannot be pulled the PREVIOUS container
 *     keeps serving and keeps answering 200. tools/railway-redeploy.mjs's header records
 *     this happening: "if the tag does not exist in the registry, the PREVIOUS container
 *     keeps serving and its /health keeps returning 200". That one does not clear.
 *
 * ── WHY IT REUSES THE DEPLOY PATH'S ANSWER RATHER THAN INVENTING ONE ─────────
 *
 * `tools/railway-redeploy.mjs` §7a already solved this for one service at deploy time: it
 * polls the service's own /health until the `build` field equals the sha being deployed,
 * "which is the only assertion that distinguishes the new container from the old one".
 * The predicate here is that one, unchanged, and the target is derived the same way — by
 * `verifyUrlFor()` from Railway's own `domains` answer plus that service's health path in
 * tools/railway-services.mjs. ★ That derivation is not a convenience: it is the guard that
 * killed a deploy of `identity` reporting "verified" after polling RELAY. An audit that
 * built its own URL list would be that defect again, at fleet scale, on a schedule.
 *
 * What is deliberately NOT reused is redeploy's LOOP. That one waits for a build to
 * BECOME the expected sha, because a deploy it triggered is in progress. This asks what is
 * true right now and must not sit for three minutes turning a real "not running it" into a
 * pass by outlasting it. The retries below exist only so a dropped packet is not reported
 * as drift; they stop the moment a service answers.
 *
 * ── ★ WHAT IT COMPARES AGAINST, AND WHY THAT IS THE PIN AND NOT master ───────
 *
 * The pin. "Is the pin acceptable" is already answered, on its own axis, by
 * annotateFreshness + refineFreshness — including the `equivalent` verdict that keeps
 * eleven legitimately-behind services green because none of their shipped files changed.
 * Re-deciding it here would be a second, weaker copy of that rule. This axis answers only
 * the question the other one cannot: is the container in front of users built from the
 * image the pin names. The two compose into the sentence the audit prints, and neither is
 * enough alone.
 *
 * ── ★ A SERVICE THAT CANNOT BE ASKED IS UNVERIFIED, NEVER GREEN ──────────────
 *
 * Four of the eighteen cannot answer this question at all:
 *
 *   · `postgres` and `redis` run upstream images this repository does not build, so there
 *     is no build sha for them to report.
 *   · `css` and `discord` bind no externally reachable health path — css has no public
 *     domain and 500s on any Host but its internal one, discord is a worker that dials
 *     out. Their deploy-time evidence is a boot line in the logs of a specific deployment
 *     (tools/railway-redeploy.mjs §7b), and a boot line does not name a build sha, so it
 *     cannot answer THIS question even after the fact.
 *
 * They are reported as unverified and named, and the headline sentence says how many were
 * asked. They are NOT counted as disagreements: a permanent red is the failure mode
 * .github/workflows/railway-fleet-audit.yml was split out of deploy-railway.yml to escape,
 * and four rows that can never go green would recreate it exactly. Not-asked and
 * asked-and-fine are different facts and are printed as different facts.
 */

import { healthPathFor, verifyUrlFor } from './railway-services.mjs';
import type { PinRow } from './railway-pins.mjs';

/**
 * Deployment statuses that are not terminal. A build mismatch under one of these is a
 * rollout in flight; under anything else it is a deploy that settled without swapping.
 *
 * Both are reported, both are disagreements — a fleet mid-rollout is not yet running what
 * this repository asserts, and saying so is the whole point — but they are DIFFERENT
 * findings with different remedies, and collapsing them would send an operator hunting a
 * registry problem that is really thirty seconds of patience.
 *
 * NEEDS_APPROVAL is in here because it is genuinely not terminal, and it is the one that
 * never resolves without a human: tools/railway-redeploy.mjs refuses to wait on it for
 * exactly that reason.
 */
export const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  'BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING', 'NEEDS_APPROVAL',
]);

export type RunningVerdict =
  | 'running'
  | 'ROLLING'
  | 'NOT-RUNNING'
  | 'NO-BUILD-FIELD'
  | 'UNREACHABLE'
  | 'NO-HOST'
  | 'unaskable'
  | 'n/a';

/** What a probe saw. A discriminated union so "did not answer" cannot be read as a build. */
export type Observation =
  | { kind: 'answered'; url: string; build: string | null }
  | { kind: 'unreachable'; url: string; reason: string }
  | { kind: 'no-host'; reason: string }
  | { kind: 'unaskable'; reason: string };

export interface RunningReport {
  service: string;
  verdict: RunningVerdict;
  /** True only when a request reached the service and it answered. Drives the headline count. */
  asked: boolean;
  /** The build sha the service reported, when it answered with one. */
  build: string | null;
  /** The URL that was asked, when there was one to ask. */
  url: string | null;
  /** Printed verbatim under the service name in the failure report. */
  reason: string;
}

/**
 * Where to ask a service what it is running, or why it cannot be asked.
 *
 * `structural` separates "this service has no such surface, by design" from "this service
 * should have answered and there was nowhere to send the request". The first is a fact
 * about the fleet and is reported as unverified; the second is a misconfiguration and is a
 * disagreement. Folding them together is how four permanent reds get introduced, and a
 * permanently red audit is one nobody reads.
 */
export function runningTargetFor(
  row: PinRow,
  hosts: readonly string[],
): { ok: true; url: string } | { ok: false; structural: boolean; reason: string } {
  if (!row.builtHere) {
    return {
      ok: false,
      structural: true,
      reason: 'an upstream image this repository does not build, so it reports no build sha',
    };
  }
  const health = healthPathFor(row.service);
  if (!health.ok) {
    return {
      ok: false,
      structural: true,
      reason: 'binds no externally reachable health path, so nothing can be asked over HTTP '
        + '(its deploy-time proof is a boot line, which names no build sha)',
    };
  }
  const verify = verifyUrlFor(row.service, hosts, undefined);
  if (!verify.ok) return { ok: false, structural: false, reason: verify.reason };
  return { ok: true, url: verify.url };
}

/**
 * The fold. Pure, and every input it reads is a parameter, so a mutant that hardcodes a
 * verdict dies on a case rather than surviving under a double that answers the same way
 * every time.
 */
export function classifyRunning(row: PinRow, obs: Observation): RunningReport {
  const base = { service: row.service, asked: false, build: null, url: null };

  // Already shouted about by `agreement`. A second alarm for one fault trains people to
  // read past both.
  if (row.missingFromRailway) {
    return { ...base, verdict: 'n/a', reason: 'Railway does not have this service (reported by the agreement axis)' };
  }
  if (row.error) {
    return { ...base, verdict: 'n/a', reason: 'the service could not be read from Railway at all (reported by the agreement axis)' };
  }
  if (obs.kind === 'unaskable') {
    return { ...base, verdict: 'unaskable', reason: obs.reason };
  }
  // A mutable tag means the running commit is unidentifiable no matter what /health says,
  // and `tagKind` reports it already. Asking anyway would produce a mismatch against the
  // string "7-alpine" and call it drift.
  if (row.tagKind !== 'sha') {
    return { ...base, verdict: 'n/a', reason: `pinned to a non-sha tag (${row.tagKind}), reported by the tag axis` };
  }
  if (obs.kind === 'no-host') {
    return { ...base, verdict: 'NO-HOST', reason: obs.reason };
  }
  if (obs.kind === 'unreachable') {
    return {
      ...base,
      url: obs.url,
      verdict: 'UNREACHABLE',
      reason: `did not answer ${obs.url} — ${obs.reason}`,
    };
  }
  if (obs.build === null) {
    return {
      ...base,
      url: obs.url,
      asked: true,
      verdict: 'NO-BUILD-FIELD',
      reason: `${obs.url} answered with no "build" field, so what it is running cannot be read. `
        + 'The image predates this service consuming the GIT_SHA build-arg: rebuild it, do not blank the check.',
    };
  }
  if (obs.build === row.tag) {
    return {
      ...base,
      url: obs.url,
      asked: true,
      build: obs.build,
      verdict: 'running',
      reason: 'answered with the build its pin names',
    };
  }
  const inFlight = IN_FLIGHT_STATUSES.has(String(row.status ?? ''));
  return {
    ...base,
    url: obs.url,
    asked: true,
    build: obs.build,
    verdict: inFlight ? 'ROLLING' : 'NOT-RUNNING',
    reason: inFlight
      ? `pinned to ${String(row.tag).slice(0, 12)} but serving ${String(obs.build).slice(0, 12)}, `
        + `and its latest deployment is ${row.status} — a rollout is in flight. Re-run once it settles.`
      : `pinned to ${String(row.tag).slice(0, 12)} but serving ${String(obs.build).slice(0, 12)}, `
        + `and its latest deployment is ${row.status ?? '(unknown)'}. The pointer moved and the container did not: `
        + 'a pull that failed leaves the PREVIOUS container serving and answering 200.',
  };
}

/** The verdicts that mean this repository's assertion about a service is contradicted. */
export function isRunningDisagreement(report: RunningReport): boolean {
  return report.verdict === 'ROLLING' || report.verdict === 'NOT-RUNNING'
    || report.verdict === 'NO-BUILD-FIELD' || report.verdict === 'UNREACHABLE'
    || report.verdict === 'NO-HOST';
}

/**
 * Read one service's own claim about what it is running.
 *
 * ★ RETRIES, NOT A POLL. Three attempts exist so a dropped connection is not published as
 * fleet drift; they stop the moment the service answers. Nothing here waits for a build to
 * CHANGE — see the header for why redeploy's loop is the wrong shape for an audit.
 *
 * ★ THE BODY IS READ AND PARSED, not just the status code, for the reason
 * tools/fleet-liveness.mjs states: a response whose headers arrive and whose body never
 * does is the same outage wearing a 200.
 */
export async function readRunningBuild(
  url: string,
  opts: {
    fetchImpl?: typeof fetch;
    attempts?: number;
    timeoutMs?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ ok: true; build: string | null } | { ok: false; reason: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const delayMs = opts.delayMs ?? 3_000;
  const nap = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));

  let last = 'no attempt was made';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await nap(delayMs);
    try {
      const res = await doFetch(url, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.status >= 400) {
        last = `HTTP ${res.status}`;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not retried: a service answering HTML is answering, and asking four more times
        // produces four more pages of HTML. Reported as what it is.
        return { ok: false, reason: `answered HTTP ${res.status} with a body that is not JSON` };
      }
      const build = (parsed as { build?: unknown } | null)?.build;
      return { ok: true, build: typeof build === 'string' && build ? build : null };
    } catch (e) {
      const err = e as { name?: string; message?: string };
      last = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `no response within ${timeoutMs} ms`
        : String(err?.message ?? e);
    }
  }
  return { ok: false, reason: `${last} (after ${attempts} attempt(s))` };
}

/**
 * Ask every service that can be asked, in parallel, and classify all of them.
 *
 * `domainsFor` is injected for the same reason `gql` and `git` are injected in
 * tools/railway-pins.mjs: a double can then answer DIFFERENTLY per service, and a mutation
 * that resolves every URL from one service's hosts is killed by a case instead of
 * surviving under a double that says the same thing every time.
 *
 * Parallel because the alternative does not fit. Fourteen services, each retried up to
 * three times on a 15-second timeout, is over ten minutes of waiting in the worst case if
 * they are asked one after another — against a workflow whose timeout-minutes is 10. A
 * check that cannot finish when the fleet is unwell is a check that gets deleted. MEASURED
 * in the healthy case, against the live fleet: the whole audit, GraphQL round trips
 * included, takes 13 seconds.
 */
export async function askRunningBuilds(
  rows: readonly PinRow[],
  domainsFor: (row: PinRow) => Promise<readonly string[]>,
  opts: Parameters<typeof readRunningBuild>[1] = {},
): Promise<RunningReport[]> {
  return Promise.all(rows.map(async (row) => {
    let hosts: readonly string[] = [];
    if (row.builtHere && !row.missingFromRailway && !row.error) {
      try {
        hosts = await domainsFor(row);
      } catch (e) {
        // A domains query that failed is NOT "no domains" — that would silently downgrade
        // an unreadable service to the NO-HOST branch and print a confident wrong reason.
        return classifyRunning(row, {
          kind: 'unreachable',
          url: '(no URL — Railway would not report the domains of this service)',
          reason: String((e as Error)?.message ?? e),
        });
      }
    }
    const target = runningTargetFor(row, hosts);
    if (!target.ok) {
      return classifyRunning(row, target.structural
        ? { kind: 'unaskable', reason: target.reason }
        : { kind: 'no-host', reason: target.reason });
    }
    const read = await readRunningBuild(target.url, opts);
    return classifyRunning(row, read.ok
      ? { kind: 'answered', url: target.url, build: read.build }
      : { kind: 'unreachable', url: target.url, reason: read.reason });
  }));
}

/**
 * What this axis actually established, said in a sentence — and the reason this is a
 * function over the reports rather than a string literal at the call site.
 *
 * ★★ THE HEADLINE WAS THE DEFECT. "Every service is running the image master would build
 * for it." was printed by a tool that had asked no service anything, about a fleet that
 * included four services it could never ask. A sentence is a claim; this one is derived
 * from the reports it describes, so it cannot outrun them, and the services it does NOT
 * cover are named in it rather than omitted from it.
 *
 * ★ AND IT IS TRUE UNDER EVERY CALLER, NOT ONLY THE GREEN ONE. The first version of this
 * function asserted "all N answered with the build their pin names" whenever it was called
 * at all, on the reasoning that the audit only calls it after `bad.length === 0`. That is
 * the defect it was written to fix, one layer further in: a claim whose truth depends on
 * the caller having checked something the sentence itself never looks at. It was caught by
 * DRIVING it — printing it unconditionally against a live fleet with one pin doctored,
 * where it cheerfully reported all fourteen fine above a NOT-RUNNING row. The counts are
 * now read off the verdicts, so a mismatch changes the sentence.
 *
 * ★ IT ALSO DOES NOT CLAIM THE PIN IS master. That is the freshness axis, which these
 * reports know nothing about; the audit states it separately, from the axis that checked
 * it. One sentence per thing actually measured.
 */
export function runningHeadline(reports: readonly RunningReport[]): string {
  const total = reports.length;
  const answered = reports.filter((r) => r.asked);
  const matched = answered.filter((r) => r.verdict === 'running');
  const mismatched = answered.filter((r) => r.verdict !== 'running');
  const unasked = reports.filter((r) => r.verdict === 'unaskable');
  const other = reports.filter((r) => r.verdict === 'n/a');

  const lines: string[] = [];
  lines.push(
    `Asked ${answered.length} of ${total} service(s) what build they are serving; `
    + `${matched.length === answered.length ? `all ${matched.length}` : String(matched.length)} `
    + 'answered with the build their pin names.');
  if (mismatched.length) {
    lines.push(
      `${mismatched.length} answered with something else: `
      + `${mismatched.map((r) => r.service).join(', ')}.`);
  }
  if (unasked.length) {
    lines.push(
      `${unasked.length} service(s) were NOT asked, and nothing here covers them: `
      + `${unasked.map((r) => r.service).join(', ')}.`);
  }
  if (other.length) {
    lines.push(
      `${other.length} service(s) have no build sha to compare and are reported on other axes: `
      + `${other.map((r) => r.service).join(', ')}.`);
  }
  return lines.join('\n');
}
