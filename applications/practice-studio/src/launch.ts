/**
 * A cmi5 launch of the hosted player, and the statements that player writes.
 *
 * The launch itself is `buildCmi5Launch` from the Foxxi cmi5 LMS: the same
 * function the bridge's `POST /agent/cmi5/launch` uses. The player then writes
 * its own statements to the endpoint that launch names. This process stores
 * those statements and reads them with Practice Evidence's `readLaunchedCall`,
 * the function `pev.import_launched_attempt` runs on a registration. It does
 * not score the call and it does not write statements of its own.
 */
import { randomUUID } from 'node:crypto';
import { buildCmi5Launch, cmi5BearerActor, cmi5BearerRegistration, redeemFetchToken } from '../../foxxi-content-intelligence/src/cmi5-lms.js';
import { readLaunchedCall, type LaunchVocabulary } from '../../practice-evidence/src/launched-import.js';
import type { ScenarioSpec } from '../../practice-evidence/src/practice.js';
import type { ScenarioDoc } from './score.js';

const MAX_LAUNCHES = 200;
const MAX_STATEMENTS = 500;

export interface HeldLaunch {
  registration: string;
  learnerDid: string;
  scenarioKey: string;
  personaId: string;
  learnerPlace: 'person' | 'agent';
  launchUrl: string;
  snapshotId: string;
  endpoint: string;
}

interface Held {
  launch: HeldLaunch;
  doc: ScenarioDoc;
  launchData: Record<string, unknown>;
  statements: Record<string, unknown>[];
}

const refusal = (status: number, error: string): { status: number; body: Record<string, unknown> } => ({
  status,
  body: { kind: 'refusal', 'iep:refusalStatus': status, error },
});

function tokenOf(authorization: string | undefined): string | null {
  const match = /^(?:Basic|Bearer)\s+(\S+)/i.exec(authorization ?? '');
  return match?.[1] ?? null;
}

function vocabulary(doc: ScenarioDoc): LaunchVocabulary | null {
  const xapi = doc.xapi;
  if (!xapi) return null;
  const turnVerb = xapi.verbs['turn'];
  const counterpartLineExt = xapi.extensions['counterpartLine'];
  const criterionKeyExt = xapi.extensions['criterionKey'];
  const rubricExt = xapi.extensions['rubric'];
  if (!turnVerb || !counterpartLineExt || !criterionKeyExt || !rubricExt) return null;
  return { turnVerb, counterpartLineExt, criterionKeyExt, rubricExt };
}

export class LaunchBook {
  private readonly held = new Map<string, Held>();
  private readonly snapshots = new Map<string, ScenarioDoc>();

  snapshot(id: string): ScenarioDoc | undefined {
    return this.snapshots.get(id);
  }

  open(learnerDid: string, doc: ScenarioDoc, personaId: string, origin: string, learnerPlace: 'person' | 'agent'): Record<string, unknown> {
    if (this.held.size >= MAX_LAUNCHES) return { kind: 'refusal', 'iep:refusalStatus': 429, error: 'this process is holding its limit of launches' };
    const root = origin.replace(/\/$/, '');
    const snapshotId = randomUUID();
    const snapshot = JSON.parse(JSON.stringify(doc)) as ScenarioDoc;
    this.snapshots.set(snapshotId, snapshot);
    const scenarioUrl = `${root}/studio/snapshots/${snapshotId}`;
    const auUrl = `${root}/player/index.html?${new URLSearchParams({ scenario: scenarioUrl, persona: personaId })}`;
    const place = learnerPlace === 'agent' ? 'actorKind=agent&contextKind=agent-test' : '';
    const launch = buildCmi5Launch({
      au: {
        id: `urn:studio:au:${doc.scenarioKey}`,
        url: auUrl,
        title: doc.title,
        moveOn: 'Completed',
        ...(place ? { launchParameters: place } : {}),
      },
      learner: { id: learnerDid },
      lrsEndpoint: `${root}/xapi`,
      fetchBaseUrl: `${root}/cmi5/fetch`,
      authoritativeSource: `${root}/studio`,
    });
    const statements: Record<string, unknown>[] = [];
    if (launch.launched) {
      const stored = { ...launch.launched };
      if (typeof stored['id'] !== 'string') stored['id'] = randomUUID();
      statements.push(stored);
    }
    const view: HeldLaunch = {
      registration: launch.registration,
      learnerDid,
      scenarioKey: doc.scenarioKey,
      personaId,
      learnerPlace,
      launchUrl: launch.launchUrl,
      snapshotId,
      endpoint: `${root}/xapi`,
    };
    this.held.set(launch.registration, { launch: view, doc: snapshot, launchData: launch.launchData, statements });
    return { launch: view };
  }

  redeem(fetchToken: string): { status: number; body: unknown } {
    const redeemed = redeemFetchToken(fetchToken);
    return { status: redeemed.ok ? 200 : redeemed.status, body: redeemed.body };
  }

  private authorized(authorization: string | undefined, registration: string): { ok: true } | { ok: false; status: number; body: Record<string, unknown> } {
    const token = tokenOf(authorization);
    if (!token) return { ok: false, ...refusal(401, 'the launch credential is missing') };
    const bound = cmi5BearerRegistration(token);
    if (!bound || bound !== registration || !this.held.has(registration)) {
      return { ok: false, ...refusal(401, 'the launch credential is not for this registration') };
    }
    return { ok: true };
  }

  state(authorization: string | undefined, registration: string): { status: number; body: unknown } {
    const auth = this.authorized(authorization, registration);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    return { status: 200, body: this.held.get(registration)!.launchData };
  }

  acceptStatement(authorization: string | undefined, raw: unknown): { status: number; body: unknown } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refusal(400, 'one statement object');
    const statement = raw as Record<string, unknown>;
    const context = statement['context'];
    const registration = context && typeof context === 'object' ? (context as Record<string, unknown>)['registration'] : undefined;
    if (typeof registration !== 'string') return refusal(400, 'the statement has no registration');
    const auth = this.authorized(authorization, registration);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const actor = cmi5BearerActor(tokenOf(authorization)!);
    const account = (statement['actor'] as { account?: { homePage?: unknown; name?: unknown } } | undefined)?.account;
    if (!actor || account?.homePage !== actor.homePage || account?.name !== actor.name) {
      return refusal(403, 'the statement actor is not the learner this launch was issued to');
    }
    const held = this.held.get(registration)!;
    const id = typeof statement['id'] === 'string' ? statement['id'] : '';
    const prior = held.statements.find((item) => item['id'] === id);
    if (prior) {
      return JSON.stringify(prior) === JSON.stringify(statement)
        ? { status: 204, body: null }
        : refusal(409, 'this statement id is already stored with a different body');
    }
    if (held.statements.length >= MAX_STATEMENTS) return refusal(429, 'this registration is holding its limit of statements');
    held.statements.push(statement);
    return { status: 200, body: [id] };
  }

  listStatements(authorization: string | undefined, registration: string, statementId: string | null): { status: number; body: unknown } {
    const auth = this.authorized(authorization, registration);
    if (!auth.ok) return { status: auth.status, body: auth.body };
    const statements = this.held.get(registration)!.statements;
    if (statementId) {
      const found = statements.find((item) => item['id'] === statementId);
      return found ? { status: 200, body: found } : refusal(404, 'no such statement');
    }
    return { status: 200, body: { statements, more: '' } };
  }

  /** Practice Evidence's read of the statements the player wrote for this registration. */
  read(callerDid: string, registration: string): Record<string, unknown> {
    const held = this.held.get(registration);
    if (!held) return { kind: 'refusal', 'iep:refusalStatus': 404, error: `no launch ${registration}` };
    if (held.launch.learnerDid.toLowerCase() !== callerDid.toLowerCase()) {
      return { kind: 'refusal', 'iep:refusalStatus': 403, error: 'this launch was issued to another learner' };
    }
    const terms = vocabulary(held.doc);
    if (!terms) return { kind: 'refusal', 'iep:refusalStatus': 422, error: 'the scenario names no turn verb or rubric extensions for the import to read' };
    const criteria = held.doc.rubric.criteria.map((criterion) => ({
      id: criterion.id,
      levels: criterion.levels.map((level) => ({ id: level.id, value: level.value })),
    }));
    const read = readLaunchedCall(held.statements, {
      registration,
      endpoint: held.launch.endpoint,
      vocabulary: terms,
      rubricHash: held.doc.rubricRef ?? `urn:studio:scenario:${held.doc.scenarioKey}#rubric`,
      ...(held.doc.rubricRef ? { scenarioVersionRef: held.doc.rubricRef } : {}),
      spec: {
        turnLimit: held.doc.turnLimit ?? held.doc.personas[0]?.stages.length ?? 1,
        assessmentUse: held.doc.assessmentUse ?? 'feedback-only',
        rubric: { criteria, passRule: null },
      } as unknown as ScenarioSpec,
    });
    return {
      registration,
      learnerDid: held.launch.learnerDid,
      scenarioKey: held.launch.scenarioKey,
      learnerPlace: held.launch.learnerPlace,
      source: 'pev.readLaunchedCall',
      read,
    };
  }
}
