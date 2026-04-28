/**
 * Pod-backed publishers for the lrs-adapter vertical.
 *
 * Bidirectional bridge between an external xAPI LRS and the user's pod:
 *   - ingestStatementFromLrs() — fetch a Statement from the LRS, project
 *     as a cg:ContextDescriptor in the user's pod
 *   - ingestStatementBatchFromLrs() — same, multi-Statement batch
 *   - projectDescriptorToLrs() — read a descriptor from the pod, project
 *     to xAPI Statement, POST to the LRS (with version negotiation)
 *
 * Both directions write an audit row (lrs:StatementIngestion or
 *  lrs:StatementProjection) to the user's pod so the operation is
 * traceable.
 */

import { ContextDescriptor, publish } from '../../../src/index.js';
import { LrsClient, type LrsClientConfig, type XapiStatement } from './lrs-client.js';
import { createHash } from 'node:crypto';
import type { IRI } from '../../../src/index.js';

export interface PodPublishConfig {
  readonly podUrl: string;
  readonly userDid: IRI;
}

const LRS_NS = 'https://markjspivey-xwisee.github.io/interego/applications/lrs-adapter/lrs#';

function nowIso(): string { return new Date().toISOString(); }
function sha16(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }

// ── 1. Ingest single Statement from LRS → pod ───────────────────────

export interface IngestStatementResult {
  readonly statementDescriptorIri: IRI;
  readonly ingestionAuditIri: IRI;
  readonly descriptorUrl: string;
  readonly auditUrl: string;
  readonly xapiVersion: string;
}

export async function ingestStatementFromLrs(
  lrsConfig: LrsClientConfig,
  statementId: string,
  podConfig: PodPublishConfig,
): Promise<IngestStatementResult> {
  const client = new LrsClient(lrsConfig);
  const stmt = await client.getStatement(statementId);
  if (!stmt) throw new Error(`Statement ${statementId} not found in LRS at ${lrsConfig.endpoint}`);

  return await publishIngestedStatement(stmt, lrsConfig.endpoint, client.getNegotiatedVersion() ?? '1.0.3', podConfig);
}

export async function ingestStatementBatchFromLrs(
  lrsConfig: LrsClientConfig,
  filter: { verb?: string; activity?: string; agent?: XapiStatement; since?: string; until?: string; limit?: number },
  podConfig: PodPublishConfig,
): Promise<readonly IngestStatementResult[]> {
  const client = new LrsClient(lrsConfig);
  const result = await client.queryStatements(filter);

  const out: IngestStatementResult[] = [];
  // Sequential ingestion to avoid manifest race in publish()
  for (const stmt of result.statements) {
    const r = await publishIngestedStatement(stmt, lrsConfig.endpoint, client.getNegotiatedVersion() ?? '1.0.3', podConfig);
    out.push(r);
  }
  return out;
}

async function publishIngestedStatement(
  stmt: XapiStatement,
  lrsEndpoint: string,
  xapiVersion: string,
  podConfig: PodPublishConfig,
): Promise<IngestStatementResult> {
  const stmtId = (stmt['id'] as string) ?? sha16(JSON.stringify(stmt));
  const stmtDescIri = `urn:cg:lrs-statement:${stmtId}` as IRI;
  const stmtGraphIri = `urn:graph:lrs:statement:${stmtId}` as IRI;
  const auditIri = `urn:cg:lrs-ingestion:${stmtId}` as IRI;
  const auditGraphIri = `urn:graph:lrs:ingestion:${stmtId}` as IRI;

  const verbId = (stmt['verb'] as { id?: string } | undefined)?.id ?? '';
  const verbDisplay = (stmt['verb'] as { display?: Record<string, string> } | undefined)?.display?.['en-US']
                  ?? Object.values((stmt['verb'] as { display?: Record<string, string> } | undefined)?.display ?? {})[0]
                  ?? verbId.split('/').pop()
                  ?? 'observed';
  const objectIri = (stmt['object'] as { id?: string } | undefined)?.id ?? '';
  const actorName = (stmt['actor'] as { account?: { name?: string }; mbox?: string } | undefined)?.account?.name
                  ?? (stmt['actor'] as { account?: { name?: string }; mbox?: string } | undefined)?.mbox
                  ?? 'unknown';
  const timestamp = (stmt['timestamp'] as string | undefined) ?? nowIso();
  const authorityHomePage = (stmt['authority'] as { account?: { homePage?: string } } | undefined)?.account?.homePage
                          ?? lrsEndpoint;

  // Statement descriptor — modal Asserted (LRS Statements are committed
  // claims by spec).
  const desc = ContextDescriptor.create(stmtDescIri)
    .describes(stmtGraphIri)
    .temporal({ validFrom: timestamp })
    .asserted(0.95)
    .agent(podConfig.userDid)
    .trust({ issuer: authorityHomePage as IRI, trustLevel: 'ThirdPartyAttested' })
    .federation({
      origin: lrsEndpoint as IRI,
      storageEndpoint: lrsEndpoint as IRI,
      syncProtocol: 'SolidNotifications',
    })
    .build();

  const escapedJson = JSON.stringify(stmt).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');

  const graphContent = `@prefix lrs:  <${LRS_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix prov: <http://www.w3.org/ns/prov#> .

<${stmtDescIri}> a lrs:StatementIngestion ;
    lrs:sourceStatementId "${stmtId}" ;
    lrs:xapiVerb <${verbId}> ;
    lrs:xapiVersion "${xapiVersion}" ;
    lrs:xapiResult """${escapedJson}""" ;
    prov:wasGeneratedBy <${objectIri}> ;
    prov:wasAttributedTo <urn:agent:${actorName}> ;
    cg:modalStatus cg:Asserted ;
    cg:validFrom "${timestamp}" .
`;

  const stmtRes = await publish(desc, graphContent, podConfig.podUrl);

  // Audit row: separate descriptor capturing the ingestion event itself
  const audit = ContextDescriptor.create(auditIri)
    .describes(auditGraphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.99)
    .agent(podConfig.userDid)
    .selfAsserted(podConfig.userDid)
    .build();

  const auditGraph = `@prefix lrs:  <${LRS_NS}> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .

<${auditIri}> a lrs:StatementIngestion ;
    lrs:ingestedFromEndpoint <${lrsEndpoint}> ;
    lrs:sourceStatementId "${stmtId}" ;
    lrs:ingestedDescriptor <${stmtDescIri}> ;
    lrs:projectionLossy false ;
    lrs:xapiVersion "${xapiVersion}" ;
    cg:modalStatus cg:Asserted ;
    cg:validFrom "${nowIso()}" .
`;

  const auditRes = await publish(audit, auditGraph, podConfig.podUrl);

  return {
    statementDescriptorIri: stmtDescIri,
    ingestionAuditIri: auditIri,
    descriptorUrl: stmtRes.descriptorUrl,
    auditUrl: auditRes.descriptorUrl,
    xapiVersion,
  };
}

// ── 2. Project descriptor → LRS Statement (with version negotiation) ─

export interface ProjectDescriptorArgs {
  readonly descriptorIri: IRI;
  readonly actor: XapiStatement;  // xAPI Agent shape
  readonly verbId: string;
  readonly objectId: string;
  /** Caller may override defaults. */
  readonly verbDisplay?: string;
  readonly objectName?: string;
  /** When source descriptor is Hypothetical, set to true to project anyway
   *  with audit-loud lossy markers. */
  readonly allowHypothetical?: boolean;
  /** When source synthesis has multiple coherentNarrative values, all
   *  narratives are preserved in result.extensions; first becomes
   *  result.response. */
  readonly coherentNarratives?: readonly string[];
  readonly modalStatus?: 'Asserted' | 'Hypothetical' | 'Counterfactual';
}

export interface ProjectDescriptorResult {
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly statementId?: string;
  readonly lossy: boolean;
  readonly lossNotes: readonly string[];
  readonly xapiVersion: string;
  readonly projectionAuditIri?: IRI;
  readonly auditUrl?: string;
}

export async function projectDescriptorToLrs(
  lrsConfig: LrsClientConfig,
  args: ProjectDescriptorArgs,
  podConfig: PodPublishConfig,
): Promise<ProjectDescriptorResult> {
  const client = new LrsClient(lrsConfig);

  // Skip Counterfactual unconditionally
  if (args.modalStatus === 'Counterfactual') {
    return await writeSkipAudit(args, lrsConfig.endpoint, 'Counterfactual descriptors are not projectable to xAPI under any circumstance', podConfig, client);
  }

  // Skip Hypothetical unless caller explicitly opts in
  if (args.modalStatus === 'Hypothetical' && !args.allowHypothetical) {
    return await writeSkipAudit(args, lrsConfig.endpoint, 'Source descriptor has cg:modalStatus cg:Hypothetical; xAPI Statements are committed claims by spec; skipped to avoid over-claiming', podConfig, client);
  }

  // Construct Statement
  const lossNotes: string[] = [];
  const lossy = args.modalStatus === 'Hypothetical' || (args.coherentNarratives !== undefined && args.coherentNarratives.length > 1);

  if (args.modalStatus === 'Hypothetical') {
    lossNotes.push('Source descriptor was Hypothetical; projected per caller request; xAPI consumers may treat as committed unless they read extensions');
  }

  const stmt: XapiStatement = {
    id: crypto.randomUUID(),
    actor: args.actor,
    verb: { id: args.verbId, display: { 'en-US': args.verbDisplay ?? args.verbId.split('/').pop() ?? 'observed' } },
    object: {
      objectType: 'Activity',
      id: args.objectId,
      definition: { name: { 'en-US': args.objectName ?? args.descriptorIri } },
    },
    result: {
      response: args.coherentNarratives?.[0] ?? '',
      extensions: {} as Record<string, unknown>,
    },
    timestamp: nowIso(),
  };

  const exts: Record<string, unknown> = {
    'urn:cg:source-descriptor': args.descriptorIri,
    'urn:cg:modal-status': args.modalStatus ?? 'Asserted',
  };

  if (args.coherentNarratives && args.coherentNarratives.length > 1) {
    exts['urn:cg:coherent-narratives'] = args.coherentNarratives;
    exts['urn:cg:projection-lossy'] = true;
    lossNotes.push(`Source had ${args.coherentNarratives.length} coherent narratives; first emitted in result.response, remainder in result.extensions[urn:cg:coherent-narratives]`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stmt['result'] as any).extensions = exts;

  // Post to LRS
  const statementId = await client.postStatement(stmt);
  const xapiVersion = client.getNegotiatedVersion() ?? '1.0.3';

  // Audit row
  const auditId = sha16(args.descriptorIri + statementId);
  const auditIri = `urn:cg:lrs-projection:${auditId}` as IRI;
  const auditGraphIri = `urn:graph:lrs:projection:${auditId}` as IRI;

  const auditDesc = ContextDescriptor.create(auditIri)
    .describes(auditGraphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.99)
    .agent(podConfig.userDid)
    .selfAsserted(podConfig.userDid)
    .build();

  const lossNotesTriples = lossNotes.map(n => `lrs:lossNote """${n.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""`).join(' ;\n    ');

  const auditGraph = `@prefix lrs: <${LRS_NS}> .
@prefix cg:  <https://markjspivey-xwisee.github.io/interego/ns/cg#> .

<${auditIri}> a lrs:StatementProjection ;
    lrs:projectedDescriptor <${args.descriptorIri}> ;
    lrs:projectedToEndpoint <${lrsConfig.endpoint}> ;
    lrs:projectedStatementId "${statementId}" ;
    lrs:projectionLossy ${lossy} ;
    lrs:xapiVersion "${xapiVersion}" ;
    ${lossNotesTriples ? `${lossNotesTriples} ;` : ''}
    cg:modalStatus cg:Asserted ;
    cg:validFrom "${nowIso()}" .
`;

  const auditRes = await publish(auditDesc, auditGraph, podConfig.podUrl);

  return {
    skipped: false,
    statementId,
    lossy,
    lossNotes,
    xapiVersion,
    projectionAuditIri: auditIri,
    auditUrl: auditRes.descriptorUrl,
  };
}

async function writeSkipAudit(
  args: ProjectDescriptorArgs,
  lrsEndpoint: string,
  reason: string,
  podConfig: PodPublishConfig,
  client: LrsClient,
): Promise<ProjectDescriptorResult> {
  const xapiVersion = (await client.negotiateVersion().catch(() => null as XapiVersion | null)) ?? '1.0.3';
  const auditId = sha16(args.descriptorIri + reason);
  const auditIri = `urn:cg:lrs-skip:${auditId}` as IRI;
  const auditGraphIri = `urn:graph:lrs:skip:${auditId}` as IRI;

  const auditDesc = ContextDescriptor.create(auditIri)
    .describes(auditGraphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.99)
    .agent(podConfig.userDid)
    .selfAsserted(podConfig.userDid)
    .build();

  const auditGraph = `@prefix lrs: <${LRS_NS}> .
@prefix cg:  <https://markjspivey-xwisee.github.io/interego/ns/cg#> .

<${auditIri}> a lrs:StatementProjection ;
    lrs:projectedDescriptor <${args.descriptorIri}> ;
    lrs:projectedToEndpoint <${lrsEndpoint}> ;
    lrs:projectionLossy true ;
    lrs:xapiSkipReason """${reason.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}""" ;
    cg:modalStatus cg:Asserted ;
    cg:validFrom "${nowIso()}" .
`;

  const auditRes = await publish(auditDesc, auditGraph, podConfig.podUrl);

  return {
    skipped: true,
    skipReason: reason,
    lossy: true,
    lossNotes: [],
    xapiVersion,
    projectionAuditIri: auditIri,
    auditUrl: auditRes.descriptorUrl,
  };
}

import type { XapiVersion } from './lrs-client.js';
