/**
 * Fleet operations as descriptors: a deploy, an incident or a review lands on the operator's
 * pod as a SOC 2 evidence descriptor, published by the fleet's own delegate agent.
 *
 *   npx tsx tools/fleet-event.ts deploy   --sha <commit> --component relay [--component css]
 *                                         | --matrix '<auto-deploy deploy matrix JSON>'
 *   npx tsx tools/fleet-event.ts incident --severity sev-2 --title "…" --source "…"
 *                                         --summary "…" | --summary-file <log>
 *                                         [--status open] [--component postgres]
 *                                         [--detected-at <ISO>] [--supersedes <descriptor URL>]
 *                                         [--modal Hypothetical|Asserted]
 *   npx tsx tools/fleet-event.ts review   --kind monitoring --summary "…" | --summary-file <log>
 *                                         [--quarter 2026-Q3] [--finding "…"] [--finding-count N]
 *                                         [--modal Hypothetical|Asserted]
 *
 * Environment: INTEREGO_FLEET_AGENT_KEY_JSON is the agent, an Ed25519 OKP JWK whose did:key the
 * pod owner registered as a delegate with a publishing scope; INTEREGO_FLEET_POD_NAME is that
 * pod (--pod overrides it); INTEREGO_FLEET_CLIENT_NAME is the OAuth client name the relay turns
 * into the agent's surface slug (default interego-fleet). --relay names another relay MCP URL;
 * --dry-run prints the publish_context arguments and publishes nothing.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * packages/ops has built soc2:DeployEvent, soc2:IncidentEvent and soc2:QuarterlyReviewEvent
 * payloads since 2026-07, and spec/SOC2-PREPARATION.md says the operator eats its own dog food:
 * the protocol that gives customers an audit trail gives the fleet one. Until 2026-09-21 nothing
 * CALLED the builders from the places where the operations happen. Now auto-deploy.yml records
 * every service it rolled out (one event each, the commit sha inside), railway-fleet-audit.yml
 * records a volume at or over 80% as an open incident in the run that found it, and the weekly
 * pod-store collector records its measurement as the quarter's monitoring review. The evidence
 * is produced by the workflow that did the work, attributed to an agent whose key only CI holds,
 * on behalf of the operator whose pod registers it — the delegate shape the jev-harness bridge
 * proved on 2026-09-20 (applications/_shared/relay-agent).
 *
 * ── A DIAGNOSIS IS HYPOTHETICAL; A ROOT CAUSE IS ASSERTED ──────────────────────────────────
 *
 * An incident or a review is Asserted by default: it records what was observed. `--modal
 * Hypothetical` records what is suspected — the diagnosis while the incident is open — and the
 * event that names the root cause, Asserted and `--supersedes` the diagnosis, is what a reader
 * finds at the head of the chain. The 2026-09-20 outage, recorded this way: an open sev-1
 * "pods answer 500, disk full" (Asserted), a Hypothetical "suspected: unreferenced history from
 * the grow-only store" superseding it, then the Asserted resolved incident naming the 45 GB of
 * history and the rebuild, superseding the diagnosis. A deploy is a fact and takes no --modal.
 *
 * The pure part — arguments in, events and the publish_context call out — is exported for
 * tests/fleet-event.test.ts; main() reads the environment and dials the relay.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildDeployEvent, buildIncidentEvent, buildQuarterlyReviewEvent,
  type IncidentSeverity, type OpsEventPayload, type ReviewKind,
} from '@interego/ops';
import { DEFAULT_RELAY_URL, relayForAgent } from '../applications/_shared/relay-agent/index.js';

export type FleetEventKind = 'deploy' | 'incident' | 'review';
const KINDS: readonly FleetEventKind[] = ['deploy', 'incident', 'review'];
const SEVERITIES: readonly IncidentSeverity[] = ['sev-1', 'sev-2', 'sev-3', 'sev-4'];
const REVIEW_KINDS: readonly ReviewKind[] = ['access', 'change', 'risk', 'vendor', 'monitoring'];
const STATUSES = ['open', 'contained', 'resolved'] as const;
type IncidentStatus = (typeof STATUSES)[number];
const MODALS = ['Hypothetical', 'Asserted'] as const;
export type FleetModal = (typeof MODALS)[number];

// ── Arguments ─────────────────────────────────────────────────────────────────────────────

export interface ParsedArgs {
  readonly kind: FleetEventKind;
  /** Every `--name value` pair, in order; a flag given twice keeps both values. */
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [kind, ...rest] = argv;
  if (!kind || !(KINDS as readonly string[]).includes(kind)) {
    throw new Error(`the first argument names the event kind: ${KINDS.join(' | ')}`);
  }
  const flags = new Map<string, string[]>();
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a === '--dry-run') { dryRun = true; continue; }
    if (!a.startsWith('--') || a.length < 3) throw new Error(`unexpected argument ${a}`);
    const v = rest[i + 1];
    if (v === undefined) throw new Error(`${a} needs a value`);
    const name = a.slice(2);
    flags.set(name, [...(flags.get(name) ?? []), v]);
    i += 1;
  }
  return { kind: kind as FleetEventKind, flags, dryRun };
}

const one = (p: ParsedArgs, name: string): string | undefined => p.flags.get(name)?.at(-1);
const all = (p: ParsedArgs, name: string): readonly string[] => p.flags.get(name) ?? [];

function required(p: ParsedArgs, name: string): string {
  const v = one(p, name);
  if (v === undefined || v === '') throw new Error(`${p.kind} needs --${name}`);
  return v;
}

function oneOf<T extends string>(p: ParsedArgs, name: string, allowed: readonly T[], fallback?: T): T {
  const v = one(p, name) ?? fallback;
  if (v === undefined) throw new Error(`${p.kind} needs --${name} (${allowed.join(' | ')})`);
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`--${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

/** The services in the deploy matrix auto-deploy.yml computes: `{"include":[{"service":"relay"}]}`. */
export function componentsFromMatrix(json: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error('--matrix is not JSON'); }
  const include = (parsed as { include?: unknown } | null)?.include;
  if (!Array.isArray(include)) throw new Error('--matrix carries no include array');
  const services = include
    .map((e) => (e as { service?: unknown } | null)?.service)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (services.length !== include.length) throw new Error('--matrix has an entry without a service');
  return services;
}

/** The calendar quarter a moment falls in, as the ops builders name it: 2026-Q3. */
export function quarterOf(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/**
 * A captured log as a literal: colour codes stripped, line ends normalised, blank runs
 * collapsed, and when it is too long the TAIL kept — the verdict lines of every tool here
 * come last, and a summary that keeps the banner and drops the finding would be evidence of
 * nothing.
 */
export function summaryFromLog(text: string, max = 4000): string {
  const clean = text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length <= max ? clean : `… ${clean.slice(clean.length - max)}`;
}

// ── Events ────────────────────────────────────────────────────────────────────────────────

export interface FleetEvent {
  readonly kind: FleetEventKind;
  readonly payload: OpsEventPayload;
  /** Hypothetical for a diagnosis or a provisional review; Asserted (the default) for an observation. */
  readonly modal: FleetModal;
  /** What the agent's own trajectory step says it did. */
  readonly step: { readonly verb: string; readonly objectName: string };
}

export interface EventContext {
  /** The publishing agent; it is the deployer, responder or reviewer the payload attributes. */
  readonly agentDid: string;
  readonly now: Date;
  /** Reads --summary-file; injected so the builder stays pure. */
  readonly readFile?: (path: string) => string;
}

function summaryOf(p: ParsedArgs, ctx: EventContext): string {
  const inline = one(p, 'summary');
  if (inline !== undefined) return summaryFromLog(inline);
  const file = one(p, 'summary-file');
  if (file === undefined) throw new Error(`${p.kind} needs --summary or --summary-file`);
  if (!ctx.readFile) throw new Error('--summary-file needs a file reader');
  const s = summaryFromLog(ctx.readFile(file));
  if (s === '') throw new Error(`${file} is empty; nothing to record`);
  return s;
}

const DEFAULT_ROLLBACK_PLAN = 'deploy-railway.yml restores the previous pin itself when a deployment fails; '
  + 'to roll back by hand, dispatch it with the previous tag';

export function eventsFromArgs(p: ParsedArgs, ctx: EventContext): FleetEvent[] {
  const ts = ctx.now.toISOString();
  switch (p.kind) {
    case 'deploy': {
      const sha = required(p, 'sha');
      if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('--sha is not a commit sha');
      const matrix = one(p, 'matrix');
      const components = [...all(p, 'component'), ...(matrix ? componentsFromMatrix(matrix) : [])];
      if (components.length === 0) throw new Error('deploy needs --component or --matrix');
      if (one(p, 'modal') !== undefined) throw new Error('a deploy is a fact and takes no --modal');
      const environment = one(p, 'environment') ?? 'production';
      const rollbackPlan = one(p, 'rollback-plan') ?? DEFAULT_ROLLBACK_PLAN;
      return components.map((component) => ({
        kind: 'deploy' as const,
        payload: buildDeployEvent({ component, commitSha: sha, deployerDid: ctx.agentDid, environment, rollbackPlan, timestamp: ts }),
        modal: 'Asserted' as const,
        step: { verb: 'deployed', objectName: `${component} at ${sha.slice(0, 12)}` },
      }));
    }
    case 'incident': {
      const title = required(p, 'title');
      const payload = buildIncidentEvent({
        severity: oneOf(p, 'severity', SEVERITIES),
        title,
        summary: summaryOf(p, ctx),
        detectedAt: one(p, 'detected-at') ?? ts,
        detectionSource: required(p, 'source'),
        responderDid: ctx.agentDid,
        status: oneOf<IncidentStatus>(p, 'status', STATUSES, 'open'),
        affectedComponents: all(p, 'component'),
        supersedes: all(p, 'supersedes'),
      });
      const modal = oneOf<FleetModal>(p, 'modal', MODALS, 'Asserted');
      return [{ kind: 'incident', payload, modal, step: { verb: modal === 'Hypothetical' ? 'diagnosed-incident' : 'reported-incident', objectName: title } }];
    }
    case 'review': {
      const kind = oneOf(p, 'kind', REVIEW_KINDS);
      const quarter = one(p, 'quarter') ?? quarterOf(ctx.now);
      const findings = all(p, 'finding');
      const countFlag = one(p, 'finding-count');
      const findingCount = countFlag === undefined ? findings.length : Number(countFlag);
      if (!Number.isInteger(findingCount) || findingCount < 0) throw new Error('--finding-count must be a whole number');
      const payload = buildQuarterlyReviewEvent({ quarter, kind, reviewerDid: ctx.agentDid, summary: summaryOf(p, ctx), findingCount, findings, timestamp: ts });
      const modal = oneOf<FleetModal>(p, 'modal', MODALS, 'Asserted');
      return [{ kind: 'review', payload, modal, step: { verb: 'reviewed', objectName: `${quarter} ${kind} review` } }];
    }
  }
}

// ── The publish ───────────────────────────────────────────────────────────────────────────

export interface PublishTarget {
  readonly podName?: string;
  readonly agentDid?: string;
  readonly visibility?: 'public' | 'shared' | 'private';
}

/**
 * The publish_context call: the builder's payload, compliance opted in with its framework so the
 * relay signs, anchors and cites the controls, and — as a delegate — the owner's pod and the
 * agent's did.
 */
export function publishArgs(e: FleetEvent, target: PublishTarget): Record<string, unknown> {
  return {
    graph_iri: e.payload.graph_iri,
    graph_content: e.payload.graph_content,
    modal_status: e.modal === 'Hypothetical' ? 'Hypothetical' : e.payload.modal_status,
    compliance: true,
    compliance_framework: e.payload.compliance_framework,
    visibility: target.visibility ?? 'shared',
    auto_supersede_prior: true,
    sign_authorship: true,
    ...(target.podName ? { pod_name: target.podName } : {}),
    ...(target.agentDid ? { agent_did: target.agentDid } : {}),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const p = parseArgs(argv);
  const readFile = (path: string): string => readFileSync(path, 'utf8');
  const podName = one(p, 'pod') ?? process.env['INTEREGO_FLEET_POD_NAME'];
  const keyJson = process.env['INTEREGO_FLEET_AGENT_KEY_JSON'];
  const relayUrl = one(p, 'relay') ?? DEFAULT_RELAY_URL;

  if (p.dryRun) {
    const agentDid = 'did:key:dry-run';
    for (const e of eventsFromArgs(p, { agentDid, now: new Date(), readFile })) {
      console.log(JSON.stringify(publishArgs(e, { podName, agentDid }), null, 2));
    }
    return;
  }
  if (!keyJson) { console.error('INTEREGO_FLEET_AGENT_KEY_JSON is not set; nothing was published'); process.exit(2); }
  if (!podName) { console.error('INTEREGO_FLEET_POD_NAME (or --pod) names the pod the agent is registered on; nothing was published'); process.exit(2); }

  const relay = relayForAgent({ keyJson, relayUrl, clientName: process.env['INTEREGO_FLEET_CLIENT_NAME'] ?? 'interego-fleet', podName });
  const agentDid = relay.agentDid;
  if (!agentDid) throw new Error('the relay client carries no agent did');
  const events = eventsFromArgs(p, { agentDid, now: new Date(), readFile });

  let failed = 0;
  for (const e of events) {
    try {
      const r = await relay.callTool('publish_context', publishArgs(e, { podName, agentDid }));
      if (r.isError) throw new Error(r.text ?? JSON.stringify(r.raw));
      const descriptorUrl = typeof r.structured?.['descriptorUrl'] === 'string' ? r.structured['descriptorUrl'] : undefined;
      console.log(`${e.kind}: ${e.step.objectName} → ${descriptorUrl ?? '(the relay answered without a descriptor URL)'}`);
      // The agent's own trajectory, on its own pod; best effort, the descriptor is the evidence.
      await relay.callTool('record_trajectory_step', {
        verb: e.step.verb, object_name: e.step.objectName, granularity: 'tool-call', modal_status: 'Asserted', result_success: true,
        ...(descriptorUrl ? { was_derived_from: [descriptorUrl] } : {}),
      }).catch(() => undefined);
    } catch (err) {
      failed += 1;
      console.error(`${e.kind}: ${e.step.objectName} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(new URL(`file://${process.argv[1].split('\\').join('/')}`)).endsWith('fleet-event.ts')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
