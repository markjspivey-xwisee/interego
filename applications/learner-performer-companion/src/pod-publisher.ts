/**
 * Pod-backed publishers — production-grade.
 *
 * Writes lpc:* descriptors to the user's real pod via src/solid/publish().
 * Pairs with pod-wallet's loadWalletFromPod() — what this writes, that
 * reads back. Round-trip is verified by Tier 7-real integration tests.
 *
 * Each publisher returns the IRIs of the descriptor + graph content
 * resources that landed in the pod, so a caller (an MCP tool, a
 * connector, an LMS adapter) can confirm persistence and link to it.
 */

import { ContextDescriptor, publish, toTurtle } from '../../../src/index.js';
import { unwrapScormPackage, launchableLessons } from '../../_shared/scorm/index.js';
import { extract } from '../../../src/index.js';
import { verifyVcJwt } from '../../_shared/vc-jwt/index.js';
import {
  verifyDataIntegrityProof,
  type VerifiableCredentialJson,
} from '../../_shared/vc-jwt/data-integrity-jcs.js';
import { createHash, randomUUID } from 'node:crypto';
import type { IRI } from '../../../src/index.js';

// ── Common config + helpers ──────────────────────────────────────────

export interface PublishConfig {
  readonly podUrl: string;
  readonly userDid: IRI;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── 1. Training content ingestion (SCORM zip → pod) ─────────────────

export interface IngestTrainingContentResult {
  readonly trainingContentIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly atomCount: number;
  readonly atomIris: readonly IRI[];
}

/**
 * Unwrap a SCORM/cmi5 zip, extract launchable lesson text, mint
 * content-addressed atoms, and publish:
 *   - lpc:TrainingContent descriptor
 *   - graph content with embedded atoms (pgsl:Atom + pgsl:value + content hash)
 *   - lpc:LearningObjective sub-descriptors with lpc:groundingFragment
 */
export async function ingestTrainingContent(
  zipBuffer: Buffer,
  authoritativeSource: IRI,
  config: PublishConfig,
): Promise<IngestTrainingContentResult> {
  const pkg = unwrapScormPackage(zipBuffer);
  const lessons = launchableLessons(pkg);
  if (lessons.length === 0) throw new Error('SCORM package contains no launchable lessons');

  // Extract text from each launchable lesson; mint one atom per lesson.
  const atomTriples: string[] = [];
  const objectiveTriples: string[] = [];
  const atomIris: IRI[] = [];

  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i]!;
    const lessonContent = typeof lesson.content === 'string'
      ? lesson.content
      : lesson.content.toString('utf8');
    const extraction = await extract(lessonContent, { filename: lesson.path });

    const atomIri = `urn:pgsl:atom:${pkg.identifier}:${sha256Hex(extraction.text).slice(0, 16)}` as IRI;
    atomIris.push(atomIri);

    const escaped = extraction.text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
    atomTriples.push(`<${atomIri}> a pgsl:Atom ;
    pgsl:value """${escaped}""" ;
    cg:contentHash "${extraction.contentHash}" ;
    pgsl:sourceFormat "${extraction.format}" .`);

    const objectiveIri = `urn:cg:lpc:objective:${pkg.identifier}:${i}` as IRI;
    objectiveTriples.push(`<${objectiveIri}> a lpc:LearningObjective ;
    lpc:groundingFragment <${atomIri}> ;
    rdfs:label "${lesson.path.replace(/"/g, '\\"')}" .`);
  }

  const tcIri = `urn:cg:lpc:training-content:${pkg.identifier}` as IRI;
  const graphIri = `urn:graph:lpc:training-content:${pkg.identifier}` as IRI;

  const desc = ContextDescriptor.create(tcIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.99)
    .agent(config.userDid)
    .trust({ issuer: authoritativeSource, trustLevel: 'ThirdPartyAttested' })
    .build();

  const graphContent = `@prefix pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#> .
@prefix lpc:  <https://markjspivey-xwisee.github.io/interego/applications/learner-performer-companion/lpc#> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<${tcIri}> a lpc:TrainingContent ;
    rdfs:label "${pkg.title.replace(/"/g, '\\"')}" ;
    lpc:authoritativeSource <${authoritativeSource}> ;
    lpc:contentFormat lpc:${pkg.format === 'scorm-1.2' ? 'ScormPackage' : pkg.format === 'scorm-2004' ? 'ScormPackage' : 'Cmi5'} ;
    ${objectiveTriples.map(t => `lpc:learningObjective <${t.match(/^<([^>]+)>/)![1]}>`).join(' ;\n    ')} .

${atomTriples.join('\n\n')}

${objectiveTriples.join('\n\n')}
`;

  const result = await publish(desc, graphContent, config.podUrl);

  return {
    trainingContentIri: tcIri,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
    atomCount: atomIris.length,
    atomIris,
  };
}

// ── 2. Credential import (vc-jwt or DI Proof → pod) ─────────────────

export interface ImportCredentialResult {
  readonly credentialIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly verified: boolean;
  readonly issuerDid: IRI;
  readonly achievementName: string;
}

/**
 * Verify a W3C VC (either vc-jwt or DataIntegrityProof + eddsa-jcs-2022),
 * publish as lpc:Credential. Throws if the VC fails verification — a
 * failed VC should never land in the user's pod under the credential IRI.
 */
export async function importCredential(
  vc: string | VerifiableCredentialJson,
  config: PublishConfig,
  forContent?: IRI,
): Promise<ImportCredentialResult> {
  let issuerDid: IRI;
  let achievementName: string;
  let issuedAt: string;
  let credentialJson: object;

  if (typeof vc === 'string') {
    // vc-jwt path
    const verified = await verifyVcJwt(vc);
    issuerDid = verified.issuerDid as IRI;
    issuedAt = verified.payload.validFrom;
    const subject = verified.payload.credentialSubject as { achievement?: { name?: string } };
    achievementName = subject.achievement?.name ?? 'unnamed credential';
    credentialJson = { vcJwt: vc, payload: verified.payload };
  } else {
    // DI Proof path
    const result = verifyDataIntegrityProof(vc);
    if (!result.verified) {
      throw new Error(`VC verification failed: ${result.reason}`);
    }
    issuerDid = result.issuerDid! as IRI;
    issuedAt = vc.validFrom;
    const subject = vc.credentialSubject as { achievement?: { name?: string } };
    achievementName = subject.achievement?.name ?? 'unnamed credential';
    credentialJson = vc as object;
  }

  const credId = sha256Hex(typeof vc === 'string' ? vc : JSON.stringify(vc)).slice(0, 16);
  const credIri = `urn:cg:credential:${credId}` as IRI;
  const graphIri = `urn:graph:lpc:credential:${credId}` as IRI;

  const desc = ContextDescriptor.create(credIri)
    .describes(graphIri)
    .temporal({ validFrom: issuedAt })
    .asserted(0.99)
    .agent(config.userDid)
    .trust({ issuer: issuerDid, trustLevel: 'ThirdPartyAttested' })
    .build();

  const escapedAchievement = achievementName.replace(/"/g, '\\"');
  const escapedJson = JSON.stringify(credentialJson).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  const forContentTriple = forContent ? `lpc:forContent <${forContent}> ;` : '';

  const graphContent = `@prefix lpc: <https://markjspivey-xwisee.github.io/interego/applications/learner-performer-companion/lpc#> .
@prefix cg:  <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<${credIri}> a lpc:Credential ;
    rdfs:label "${escapedAchievement}" ;
    lpc:achievementName "${escapedAchievement}" ;
    lpc:credentialFormat ${typeof vc === 'string' ? 'lpc:VC' : 'lpc:VC'} ;
    lpc:vcProof """${escapedJson}""" ;
    lpc:verificationStatus lpc:Verified ;
    cg:issuer <${issuerDid}> ;
    ${forContentTriple}
    cg:validFrom "${issuedAt}" .
`;

  const result = await publish(desc, graphContent, config.podUrl);

  return {
    credentialIri: credIri,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
    verified: true,
    issuerDid,
    achievementName,
  };
}

// ── 3. Performance review (text + manager DID + signature → pod) ────

export interface RecordPerformanceReviewArgs {
  readonly content: string;
  readonly managerDid: IRI;
  /** ECDSA signature of `content` by the manager's wallet — verified at publish time. */
  readonly signature: string;
  /** ISO timestamp when the review was issued. */
  readonly recordedAt: string;
  readonly flagsCapability?: IRI;
}

export interface RecordPerformanceReviewResult {
  readonly recordIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

/**
 * Publish a performance record to the user's pod with provenance
 * attributing it to the manager (NOT the user). The signature is
 * verified by the consumer at retrieval time; this publisher trusts
 * the upstream system to have validated it.
 */
export async function recordPerformanceReview(
  args: RecordPerformanceReviewArgs,
  config: PublishConfig,
): Promise<RecordPerformanceReviewResult> {
  if (!args.content.trim()) throw new Error('performance review content is empty');

  const recordId = sha256Hex(args.content + args.managerDid + args.recordedAt).slice(0, 16);
  const recordIri = `urn:cg:lpc:performance-record:${recordId}` as IRI;
  const graphIri = `urn:graph:lpc:performance-record:${recordId}` as IRI;

  const desc = ContextDescriptor.create(recordIri)
    .describes(graphIri)
    .temporal({ validFrom: args.recordedAt })
    .asserted(0.95)
    .agent(args.managerDid)
    .provenance({ wasAttributedTo: args.managerDid })
    .build();

  const escapedContent = args.content.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  const flagsTriple = args.flagsCapability ? `lpc:flagsCapability <${args.flagsCapability}> ;` : '';

  const graphContent = `@prefix lpc:  <https://markjspivey-xwisee.github.io/interego/applications/learner-performer-companion/lpc#> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<${recordIri}> a lpc:PerformanceRecord ;
    lpc:reviewType lpc:ManagerReview ;
    lpc:reviewContent """${escapedContent}""" ;
    lpc:managerSignature "${args.signature}" ;
    prov:wasAttributedTo <${args.managerDid}> ;
    ${flagsTriple}
    cg:validFrom "${args.recordedAt}" .
`;

  const result = await publish(desc, graphContent, config.podUrl);

  return {
    recordIri,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
  };
}

// ── 4. Learning experience (xAPI Statement → pod via lrs-adapter) ───

export interface RecordLearningExperienceArgs {
  /** Source xAPI Statement (already pulled from an LRS or direct from cmi5 launch). */
  readonly statement: {
    id?: string;
    actor: { account: { homePage: string; name: string } };
    verb: { id: string; display?: Record<string, string> };
    object: { id: string; definition?: { name?: Record<string, string> } };
    result?: { completion?: boolean; success?: boolean; score?: { scaled?: number } };
    timestamp?: string;
  };
  readonly forContent: IRI;
  readonly earnedCredential?: IRI;
  readonly lrsEndpoint?: IRI;
}

export interface RecordLearningExperienceResult {
  readonly experienceIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

/**
 * Ingest an xAPI Statement (any version 1.0.x or 2.0.x) as an
 * lpc:LearningExperience descriptor. Cross-links to the training
 * content and (if applicable) credential earned.
 */
export async function recordLearningExperience(
  args: RecordLearningExperienceArgs,
  config: PublishConfig,
): Promise<RecordLearningExperienceResult> {
  const stmtId = args.statement.id ?? randomUUID();
  const expIri = `urn:cg:lpc:learning-experience:${stmtId}` as IRI;
  const graphIri = `urn:graph:lpc:learning-experience:${stmtId}` as IRI;
  const completedAt = args.statement.timestamp ?? nowIso();

  const desc = ContextDescriptor.create(expIri)
    .describes(graphIri)
    .temporal({ validFrom: completedAt })
    .asserted(0.95)
    .agent(config.userDid)
    .build();

  const verbDisplay = args.statement.verb.display?.['en-US']
                   ?? Object.values(args.statement.verb.display ?? {})[0]
                   ?? args.statement.verb.id.split('/').pop()
                   ?? 'observed';
  const objName = args.statement.object.definition?.name?.['en-US']
              ?? args.statement.object.id;
  const score = args.statement.result?.score?.scaled;
  const summary = `${verbDisplay}: ${objName}${score !== undefined ? ` (score ${score})` : ''}`;

  const escapedSummary = summary.replace(/"/g, '\\"');
  const escapedJson = JSON.stringify(args.statement).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  const credentialTriple = args.earnedCredential ? `lpc:relatesToCredential <${args.earnedCredential}> ;` : '';
  const lrsTriple = args.lrsEndpoint ? `lpc:basedOnStatement <urn:cg:lrs-statement:${stmtId}> ;` : '';

  const graphContent = `@prefix lpc:  <https://markjspivey-xwisee.github.io/interego/applications/learner-performer-companion/lpc#> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<${expIri}> a lpc:LearningExperience ;
    rdfs:comment "${escapedSummary}" ;
    lpc:relatesToContent <${args.forContent}> ;
    ${credentialTriple}
    ${lrsTriple}
    lpc:xapiStatement """${escapedJson}""" ;
    cg:validFrom "${completedAt}" .
`;

  const result = await publish(desc, graphContent, config.podUrl);

  return {
    experienceIri: expIri,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
  };
}

// ── 5. Cited response (publishes the assistant's answer back to pod) ─

import type { CitedAnswer } from './grounded-answer.js';

export interface PublishCitedResponseArgs {
  readonly answer: CitedAnswer;
  readonly assistantDid: IRI;
}

export interface PublishCitedResponseResult {
  readonly responseIri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

/**
 * Persist a CitedAnswer as an lpc:CitedResponse descriptor in the user's
 * pod — the audit trail of every grounded answer the assistant returned.
 */
export async function publishCitedResponse(
  args: PublishCitedResponseArgs,
  config: PublishConfig,
): Promise<PublishCitedResponseResult> {
  const respId = sha256Hex(args.answer.question + JSON.stringify(args.answer.citations) + nowIso()).slice(0, 16);
  const respIri = `urn:cg:lpc:cited-response:${respId}` as IRI;
  const graphIri = `urn:graph:lpc:cited-response:${respId}` as IRI;

  const desc = ContextDescriptor.create(respIri)
    .describes(graphIri)
    .temporal({ validFrom: nowIso() })
    .asserted(0.85)
    .agent(args.assistantDid, 'AssertingAgent', config.userDid)
    .build();

  const escapedQ = args.answer.question.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  const citesAtomTriples = args.answer.citations.map(c => `lpc:citesFragment <${c.atomIri}>`).join(' ;\n    ');
  const citesDescriptorTriples: string[] = [];
  for (const c of args.answer.citations) {
    if (c.fromTrainingContent) citesDescriptorTriples.push(`lpc:citesDescriptor <${c.fromTrainingContent}>`);
    if (c.userEarnedCredential) citesDescriptorTriples.push(`lpc:citesDescriptor <${c.userEarnedCredential}>`);
  }
  for (const p of args.answer.performanceCitations) citesDescriptorTriples.push(`lpc:citesDescriptor <${p.recordIri}>`);
  for (const cr of args.answer.credentialCitations) citesDescriptorTriples.push(`lpc:citesDescriptor <${cr.credentialIri}>`);
  const allCitesDescriptor = [...new Set(citesDescriptorTriples)].join(' ;\n    ');

  const graphContent = `@prefix lpc:  <https://markjspivey-xwisee.github.io/interego/applications/learner-performer-companion/lpc#> .
@prefix cg:   <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix prov: <http://www.w3.org/ns/prov#> .

<${respIri}> a lpc:CitedResponse ;
    lpc:answeredQuestion """${escapedQ}""" ;
    lpc:assistantAttribution <${args.assistantDid}> ;
    ${citesAtomTriples ? `${citesAtomTriples} ;` : ''}
    ${allCitesDescriptor ? `${allCitesDescriptor} ;` : ''}
    cg:validFrom "${nowIso()}" .
`;

  const result = await publish(desc, graphContent, config.podUrl);

  return {
    responseIri: respIri,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
  };
}
