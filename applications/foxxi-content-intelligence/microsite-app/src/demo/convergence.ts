/**
 * Live ops for the W3C-convergence demo. Each maps an Interego primitive to a
 * W3C effort, composing EXISTING bridge endpoints (no new substrate):
 *   - Holon (W3C Holon CG): mint a real holon -> dereference the iep: descriptor
 *     + read the lattice holarchy (whole + part).
 *   - Context gap (W3C Context Graphs CG): interrogate -> per-interrogative
 *     resolution state (full/partial/pointer/absent). `absent` = the answering
 *     facet is not on this descriptor = the unresolved-context PRECONDITION a
 *     safe-stop keys on (NOT an abstain/escalate trigger the call performs; that
 *     gap-detection predicate is not yet wired — see docs/NAME-PROVENANCE.md §6).
 *   - DataBook (Cagle): ingest a Markdown DataBook -> holon; emit a SKILL.md back.
 * BYOK (optional, key stays in this tab): an LLM authors a DataBook from a plain
 * description; everything else runs keyless.
 */
import { freshAgent, postSigned, type AgentWallet } from './agent-signing.js';
import { bridgeRest, BRIDGE_URL } from '../bridge-client.js';

const STD = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';
export const PAGES_NS = 'https://markjspivey-xwisee.github.io/interego/ns';

export interface MintedHolon {
  agent: AgentWallet; label: string; did: string;
  holonUri?: string; descriptorUrl?: string;
  reusedNodes?: number; newNodes?: number;
  stats?: { atoms?: number; fragments?: number; totalNodes?: number; maxLevel?: number; levels?: Record<string, number> };
  siblingHolonUri?: string;  // a prior holon in the SAME lattice that this one shares atoms with
  raw?: unknown;
}

async function record(a: AgentWallet, taskName: string) {
  const r = await postSigned('/agent/record-performance', a, { task_name: taskName, success: true, quality: 1, activity_type: STD });
  const b = (r.body ?? {}) as any;
  return { ok: r.ok, status: r.status, b, sl: (b.sharedLattice ?? {}) as any };
}

/**
 * Mint a real holon on the live bridge with a fresh self-sovereign wallet. To
 * actually DEMONSTRATE the hypergraph holarchy (one atom shared by many wholes),
 * we mint a sibling first, then THIS holon, in the SAME agent's lattice — so the
 * returned holon's `reusedNodes` is the count of atoms it genuinely shares with
 * its sibling (the agent DID, the verb, the activity-type), not a synthetic claim.
 * Fails loudly if the bridge did not compose a holon (never fabricates success).
 */
export async function mintHolon(taskName = 'A holon, minted live'): Promise<MintedHolon> {
  const a = freshAgent();
  const label = `eth-${a.address.slice(2, 14)}`;
  const first = await record(a, 'A sibling holon, sharing this agent’s lattice');
  if (!first.ok || !first.sl.holonUri) throw new Error(`mint failed: HTTP ${first.status}${first.b?.error ? ` — ${first.b.error}` : ''}${first.b?.hint ? ` (${first.b.hint})` : ''}`.slice(0, 200));
  const r = await record(a, taskName);
  if (!r.ok || !r.sl.holonUri) throw new Error(`mint failed: HTTP ${r.status}${r.b?.error ? ` — ${r.b.error}` : ''}`.slice(0, 200));
  const sl = r.sl;
  return { agent: a, label, did: a.did, holonUri: sl.holonUri, descriptorUrl: sl.descriptorUrl, reusedNodes: sl.reusedNodes, newNodes: sl.newNodes, stats: sl.stats, siblingHolonUri: first.sl.holonUri, raw: r.b };
}

/** Dereference the holon's projected descriptor (the WHOLE) — its iep: Turtle.
 *  css-gate allows the microsite origin; best-effort with one retry (async persist). */
export async function dereferenceDescriptor(url: string): Promise<{ ok: boolean; turtle?: string; status: number }> {
  for (const wait of [0, 1500]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
      if (r.ok) return { ok: true, turtle: await r.text(), status: r.status };
      if (wait) return { ok: false, status: r.status };
    } catch { /* retry once */ }
  }
  return { ok: false, status: 0 };
}

export interface InterrogativeAnswer { interrogative: string; status: 'full' | 'partial' | 'pointer' | 'absent' | string; values?: Record<string, unknown>; caveat?: string; nextStep?: { tool?: string }; }

/** Interrogate a holon — the per-interrogative resolution state IS the
 *  context-gap resolution state; absent/pointer + caveat == safe-stop. */
export async function interrogateHolon(label: string, holonUri: string, did: string): Promise<{ answers: InterrogativeAnswer[]; error?: string }> {
  try {
    const url = `${BRIDGE_URL}/agent/lattice/${label}/interrogate?uri=${encodeURIComponent(holonUri)}&agent_did=${encodeURIComponent(did)}`;
    const r = await fetch(url);
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j?.ok === false) return { answers: [], error: j?.error || `HTTP ${r.status}` };
    return { answers: Array.isArray(j.answers) ? j.answers : [] };
  } catch (e) { return { answers: [], error: (e as Error).message }; }
}

export interface DataBookIngest { ok: boolean; error?: string; course?: any; holonUri?: string; descriptorUrl?: string; label?: string; concepts?: number; }

/** Ingest a DataBook-shaped Markdown (frontmatter + fenced turtle) into a holon. */
export async function ingestDataBook(markdown: string): Promise<DataBookIngest> {
  const { status, json } = await bridgeRest('/agent/course/analyze-skill', { skillMd: markdown });
  if (status !== 200 || (json as any).ok === false) return { ok: false, error: String((json as any).error ?? `HTTP ${status}`) };
  const j = json as any;
  return { ok: true, course: j.course, holonUri: j.courseKg?.holonUri, descriptorUrl: j.courseKg?.descriptorUrl, label: j.courseKg?.label, concepts: j.course?.concepts?.length };
}

/** Round-trip: emit a SKILL.md (markdown-carrier-of-semantics) from the holon. */
export async function emitSkill(course: any, holonUri?: string): Promise<{ ok: boolean; skillMd?: string; error?: string }> {
  const { status, json } = await bridgeRest('/agent/course/skill', { course, tool: 'DataBook', holonUri });
  if (status !== 200 || (json as any).ok === false) return { ok: false, error: String((json as any).error ?? `HTTP ${status}`) };
  return { ok: true, skillMd: String((json as any).skillMd ?? '') };
}

/** Fetch a slice of the iep: protocol ontology (the renamed L1) for display. */
export async function fetchProtocolExcerpt(): Promise<string> {
  try {
    const r = await fetch(`${PAGES_NS}/iep.ttl`, { headers: { Accept: 'text/turtle' } });
    const t = await r.text();
    // Pull the iep:ContextDescriptor + iep:Holon class blocks (best-effort).
    const want = ['iep:ContextDescriptor a owl:Class', 'iep:Holon a owl:Class'];
    const lines = t.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (want.some(w => lines[i].includes(w))) {
        out.push(...lines.slice(i, i + 6).filter(l => l.trim()));
        out.push('');
      }
    }
    return out.join('\n') || t.slice(0, 600);
  } catch { return '(could not fetch /ns/iep.ttl)'; }
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
/** BYOK one-shot: author a DataBook (Markdown + YAML frontmatter + fenced Turtle)
 *  from a plain-English capability. Key is sent only to api.anthropic.com. */
export async function authorDataBook(apiKey: string, description: string): Promise<{ ok: boolean; markdown?: string; error?: string }> {
  const prompt = [
    'Author a DataBook: a single Markdown document that is a self-describing knowledge artifact.',
    'Structure EXACTLY:',
    '1) YAML frontmatter delimited by --- with keys: name (kebab-case), description, license.',
    '2) One or more "## " sections of prose explaining the capability.',
    '3) At least one fenced ```turtle block with a few RDF triples (use @prefix ex: <http://example.org/> .) modeling the domain.',
    'Keep it under ~30 lines. Output ONLY the Markdown, no commentary, no code fence around the whole thing.',
    '',
    `The capability to capture: ${description}`,
  ].join('\n');
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) { const e = await resp.text().catch(() => ''); return { ok: false, error: `Anthropic HTTP ${resp.status}: ${e.slice(0, 140)}` }; }
    const j: any = await resp.json();
    let md = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    // Strip an accidental OUTER ``` fence ONLY if the doc both opens and closes
    // with one (else we would eat a legitimate trailing ```turtle fence).
    if (/^```(?:markdown|md)?\s*\n/.test(md) && /\n```\s*$/.test(md)) {
      md = md.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
    }
    if (!md.startsWith('---')) return { ok: false, error: 'model did not return frontmatter-led Markdown' };
    return { ok: true, markdown: md };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export const SAMPLE_DATABOOK = [
  '---',
  'name: extend-a-standard',
  'description: How to extend an interoperability standard (xAPI / IEEE-LER / ADL-TLA) without forking it.',
  'license: CC-BY-4.0',
  '---',
  '## Approach',
  'Discover the in-flow guidance catalog, then author a context extension that COMPOSES the',
  'standard rather than replacing it. What you did rides in the object’s conformsTo, not the verb.',
  '',
  '## Vocabulary',
  '```turtle',
  '@prefix ex: <http://example.org/> .',
  'ex:StandardsExtension a ex:Capability ;',
  '  ex:composes ex:xAPI ;',
  '  ex:ridesIn ex:objectConformsTo .',
  '```',
].join('\n');
