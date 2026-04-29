/**
 * Pod-backed publishers for the organizational-working-memory vertical.
 *
 * Each handler builds a typed Context Descriptor and writes it to the
 * org's pod via @interego/core's publish(). The graph_iri patterns
 * make entity types content-stable: re-upserting the same person /
 * project produces the same graph_iri, so subsequent versions
 * supersede earlier ones via the auto-supersedes machinery.
 *
 * All descriptors live on ONE pod (the org's) — this vertical is
 * single-org by intent. Cross-org sharing happens through Interego's
 * standard share_with primitive in the underlying publish path; we
 * don't reinvent it here.
 */

import { ContextDescriptor, publish, discover } from '../../../src/index.js';
import type { IRI, ContextDescriptorData } from '../../../src/index.js';
import { createHash } from 'node:crypto';

const OWM_NS = 'https://markjspivey-xwisee.github.io/interego/applications/organizational-working-memory/owm#';

function nowIso(): string { return new Date().toISOString(); }
function sha16(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }
function escapeLit(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'); }
function escapeMulti(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"'); }

export interface PodCtx {
  readonly podUrl: string;
  readonly orgDid: IRI;
}

interface PublishResult {
  readonly iri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly modalStatus: 'Asserted' | 'Hypothetical' | 'Counterfactual';
  readonly supersedes: IRI[];
}

async function publishOwm(args: {
  graphIri: IRI;
  graphContent: string;
  modalStatus: 'Asserted' | 'Hypothetical' | 'Counterfactual';
  confidence?: number;
  supersedes?: IRI[];
  ctx: PodCtx;
}): Promise<PublishResult> {
  const now = nowIso();
  const descId = `urn:cg:owm:desc:${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as IRI;

  const builder = ContextDescriptor.create(descId)
    .describes(args.graphIri)
    .temporal({ validFrom: now })
    .validFrom(now)
    .delegatedBy(args.ctx.orgDid, args.ctx.orgDid, { endedAt: now })
    .trust({ trustLevel: 'SelfAsserted', issuer: args.ctx.orgDid })
    .federation({ origin: args.ctx.podUrl as IRI, storageEndpoint: args.ctx.podUrl as IRI, syncProtocol: 'SolidNotifications' })
    .version(1);

  // Modal-truth consistency: Hypothetical leaves groundTruth unset
  // (three-valued); Asserted ⇒ true; Counterfactual ⇒ false.
  if (args.modalStatus === 'Hypothetical') {
    builder.semiotic({ modalStatus: 'Hypothetical', epistemicConfidence: args.confidence });
  } else if (args.modalStatus === 'Asserted') {
    builder.semiotic({ modalStatus: 'Asserted', groundTruth: true, epistemicConfidence: args.confidence });
  } else {
    builder.semiotic({ modalStatus: 'Counterfactual', groundTruth: false, epistemicConfidence: args.confidence });
  }

  const allSupersedes = args.supersedes ?? [];
  if (allSupersedes.length > 0) builder.supersedes(...allSupersedes);

  const descriptor: ContextDescriptorData = builder.build();
  const result = await publish(descriptor, args.graphContent, args.ctx.podUrl);
  return {
    iri: args.graphIri,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
    modalStatus: args.modalStatus,
    supersedes: allSupersedes,
  };
}

/** Find the descriptor URL that currently describes a given graph IRI
 *  (to chain supersedes). Returns null if no prior descriptor. */
async function priorDescriptorFor(graphIri: IRI, podUrl: string): Promise<IRI | null> {
  try {
    const entries = await discover(podUrl);
    const matches = entries.filter(e => e.describes.some(d => d === graphIri));
    if (matches.length === 0) return null;
    // Pick the head: the one nothing supersedes. Defensive sort by validFrom desc.
    const supersedingIris = new Set<string>();
    for (const m of matches) for (const s of (m.supersedes ?? [])) supersedingIris.add(s);
    const head = matches.find(m => !supersedingIris.has(m.descriptorUrl));
    return ((head ?? matches[0]!).descriptorUrl as IRI);
  } catch {
    return null;
  }
}

// ── Person ──────────────────────────────────────────────────────────

export interface UpsertPersonArgs {
  name: string;
  role?: string;
  organization?: string;
  did?: string;
  aliases?: string[];
  notes?: string;
}

export async function upsertPerson(args: UpsertPersonArgs, ctx: PodCtx): Promise<PublishResult> {
  if (!args.name?.trim()) throw new Error('upsertPerson requires name');
  const stableKey = `${args.name.toLowerCase()}|${(args.organization ?? '').toLowerCase()}`;
  const personIri = `urn:owm:person:${sha16(stableKey)}` as IRI;

  const aliasesTtl = (args.aliases ?? []).map(a => `"${escapeLit(a)}"`).join(', ');
  const ttl = `@prefix owm: <${OWM_NS}> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<${personIri}> a owm:Person ;
  foaf:name "${escapeLit(args.name)}" ;
${args.role ? `  owm:role "${escapeLit(args.role)}" ;\n` : ''}\
${args.organization ? `  owm:organization "${escapeLit(args.organization)}" ;\n` : ''}\
${args.did ? `  owm:agentDid <${args.did}> ;\n` : ''}\
${aliasesTtl ? `  owm:alias ${aliasesTtl} ;\n` : ''}\
${args.notes ? `  dct:description """${escapeMulti(args.notes)}""" ;\n` : ''}\
  owm:upsertedAt "${nowIso()}" .`;

  const prior = await priorDescriptorFor(personIri, ctx.podUrl);
  return publishOwm({
    graphIri: personIri,
    graphContent: ttl,
    modalStatus: 'Asserted',
    confidence: 0.9,
    supersedes: prior ? [prior] : [],
    ctx,
  });
}

// ── Project ─────────────────────────────────────────────────────────

export interface UpsertProjectArgs {
  name: string;
  objective?: string;
  olke_stage?: 'Tacit' | 'Articulate' | 'Collective' | 'Institutional';
  participants?: string[];
  status?: string;
}

export async function upsertProject(args: UpsertProjectArgs, ctx: PodCtx): Promise<PublishResult> {
  if (!args.name?.trim()) throw new Error('upsertProject requires name');
  const projectIri = `urn:owm:project:${sha16(args.name.toLowerCase())}` as IRI;
  const participantsTtl = (args.participants ?? []).map(p => `<${p}>`).join(', ');

  const ttl = `@prefix owm: <${OWM_NS}> .
@prefix olke: <https://markjspivey-xwisee.github.io/interego/ns/olke#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${projectIri}> a owm:Project ;
  dct:title "${escapeLit(args.name)}" ;
${args.objective ? `  owm:objective """${escapeMulti(args.objective)}""" ;\n` : ''}\
${args.olke_stage ? `  olke:knowledgeStage olke:${args.olke_stage} ;\n` : ''}\
${participantsTtl ? `  owm:participant ${participantsTtl} ;\n` : ''}\
${args.status ? `  owm:status "${escapeLit(args.status)}" ;\n` : ''}\
  owm:upsertedAt "${nowIso()}" .`;

  const prior = await priorDescriptorFor(projectIri, ctx.podUrl);
  return publishOwm({
    graphIri: projectIri,
    graphContent: ttl,
    modalStatus: 'Asserted',
    confidence: 0.9,
    supersedes: prior ? [prior] : [],
    ctx,
  });
}

// ── Decision ────────────────────────────────────────────────────────

export interface RecordDecisionArgs {
  topic: string;
  rationale: string;
  modal_status?: 'Hypothetical' | 'Asserted' | 'Counterfactual';
  project_iri?: string;
  decided_by?: string[];
  supersedes?: string[];
}

export async function recordDecision(args: RecordDecisionArgs, ctx: PodCtx): Promise<PublishResult> {
  if (!args.topic?.trim() || !args.rationale?.trim()) throw new Error('recordDecision requires topic + rationale');
  const decisionIri = `urn:owm:decision:${Date.now()}-${sha16(args.topic).slice(0, 8)}` as IRI;
  const decidedByTtl = (args.decided_by ?? []).map(p => `<${p}>`).join(', ');

  const ttl = `@prefix owm: <${OWM_NS}> .
@prefix dct: <http://purl.org/dc/terms/> .
<${decisionIri}> a owm:Decision ;
  dct:title "${escapeLit(args.topic)}" ;
  owm:rationale """${escapeMulti(args.rationale)}""" ;
${args.project_iri ? `  owm:concernsProject <${args.project_iri}> ;\n` : ''}\
${decidedByTtl ? `  owm:decidedBy ${decidedByTtl} ;\n` : ''}\
  owm:recordedAt "${nowIso()}" .`;

  return publishOwm({
    graphIri: decisionIri,
    graphContent: ttl,
    modalStatus: args.modal_status ?? 'Hypothetical',
    confidence: args.modal_status === 'Asserted' ? 0.95 : 0.7,
    supersedes: (args.supersedes ?? []) as IRI[],
    ctx,
  });
}

// ── FollowUp ────────────────────────────────────────────────────────

export interface QueueFollowupArgs {
  topic: string;
  due_at: string;
  context_iri?: string;
  watcher_did?: string;
}

export async function queueFollowup(args: QueueFollowupArgs, ctx: PodCtx): Promise<PublishResult> {
  if (!args.topic?.trim()) throw new Error('queueFollowup requires topic');
  if (!args.due_at) throw new Error('queueFollowup requires due_at (ISO 8601)');
  const followupIri = `urn:owm:followup:${Date.now()}-${sha16(args.topic).slice(0, 8)}` as IRI;

  const ttl = `@prefix owm: <${OWM_NS}> .
@prefix dct: <http://purl.org/dc/terms/> .
<${followupIri}> a owm:FollowUp ;
  dct:title "${escapeLit(args.topic)}" ;
  owm:dueAt "${args.due_at}" ;
${args.context_iri ? `  owm:contextOf <${args.context_iri}> ;\n` : ''}\
${args.watcher_did ? `  owm:watcher <${args.watcher_did}> ;\n` : ''}\
  owm:queuedAt "${nowIso()}" .`;

  return publishOwm({
    graphIri: followupIri,
    graphContent: ttl,
    modalStatus: 'Hypothetical',
    confidence: 0.8,
    ctx,
  });
}

// ── Note (content-addressed) ────────────────────────────────────────

export interface RecordNoteArgs {
  text: string;
  subject_iris?: string[];
  tags?: string[];
}

export async function recordNote(args: RecordNoteArgs, ctx: PodCtx): Promise<PublishResult> {
  if (!args.text?.trim()) throw new Error('recordNote requires text');
  // Content-addressed atom IRI: identical text → identical IRI.
  const atomIri = `urn:pgsl:atom:owm:${sha16(args.text)}` as IRI;
  const subjectsTtl = (args.subject_iris ?? []).map(s => `<${s}>`).join(', ');
  const tagsTtl = (args.tags ?? []).map(t => `"${escapeLit(t)}"`).join(', ');

  const ttl = `@prefix owm: <${OWM_NS}> .
@prefix pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${atomIri}> a owm:KnowledgeNote, pgsl:Atom ;
  pgsl:value """${escapeMulti(args.text)}""" ;
${subjectsTtl ? `  owm:about ${subjectsTtl} ;\n` : ''}\
${tagsTtl ? `  owm:tag ${tagsTtl} ;\n` : ''}\
  owm:capturedAt "${nowIso()}" .`;

  return publishOwm({
    graphIri: atomIri,
    graphContent: ttl,
    modalStatus: 'Asserted',
    confidence: 0.9,
    ctx,
  });
}

// ── Discovery ───────────────────────────────────────────────────────

export interface OverdueFollowupsArgs {
  now?: string;
  limit?: number;
}

export interface OverdueFollowupSummary {
  iri: string;
  descriptorUrl: string;
  due_at: string | null;
  topic: string | null;
}

export async function listOverdueFollowups(args: OverdueFollowupsArgs, ctx: PodCtx): Promise<OverdueFollowupSummary[]> {
  const now = args.now ?? nowIso();
  const limit = args.limit ?? 50;
  const entries = await discover(ctx.podUrl);
  const followupEntries = entries.filter(e => e.describes.some(d => d.startsWith('urn:owm:followup:')));

  const out: OverdueFollowupSummary[] = [];
  for (const entry of followupEntries) {
    if (out.length >= limit) break;
    try {
      const r = await fetch(entry.descriptorUrl.replace(/\.ttl$/, '-graph.trig'), { headers: { Accept: 'application/trig, text/turtle' } });
      if (!r.ok) continue;
      const trig = await r.text();
      const dueMatch = trig.match(/owm:dueAt\s+"([^"]+)"/);
      const topicMatch = trig.match(/dct:title\s+"([^"]+)"/);
      const due = dueMatch ? dueMatch[1]! : null;
      if (!due) continue;
      if (due > now) continue; // not due yet
      out.push({
        iri: entry.describes[0]!,
        descriptorUrl: entry.descriptorUrl,
        due_at: due,
        topic: topicMatch ? topicMatch[1]! : null,
      });
    } catch { /* skip */ }
  }
  // Newest-overdue last; due-soonest first.
  out.sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''));
  return out;
}

export interface DiscoverSubgraphArgs {
  subject_iri: string;
  depth?: number;
}

export interface SubgraphEdge {
  descriptor_url: string;
  describes: readonly string[];
  facet_types: readonly string[];
  modal_status: string | null;
  supersedes: readonly string[];
}

export async function discoverSubgraph(args: DiscoverSubgraphArgs, ctx: PodCtx): Promise<{ subject: string; edges: SubgraphEdge[] }> {
  const entries = await discover(ctx.podUrl);
  // Depth-1: any descriptor that describes the subject OR mentions
  // it in its supersedes set. Depth>1 currently just returns depth-1
  // (deeper traversal would walk into the graph TriG bodies).
  const matches = entries.filter(e =>
    e.describes.some(d => d === args.subject_iri) ||
    (e.supersedes ?? []).includes(args.subject_iri),
  );
  return {
    subject: args.subject_iri,
    edges: matches.map(m => ({
      descriptor_url: m.descriptorUrl,
      describes: m.describes,
      facet_types: m.facetTypes ?? [],
      modal_status: m.modalStatus ?? null,
      supersedes: m.supersedes ?? [],
    })),
  };
}
