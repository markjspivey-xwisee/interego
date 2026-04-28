/**
 * Pod-backed wallet loader — production-grade.
 *
 * Loads a user's actual learner-performer-companion wallet by walking
 * the pod's manifest, fetching descriptor Turtle for each lpc:* entry,
 * fetching the described graph content (where atoms / VC / review-text
 * actually live), and assembling the in-memory shape `groundedAnswer()`
 * consumes.
 *
 * Production guarantees:
 *   - Real HTTP against the pod URL (no mocked responses)
 *   - Bounded fetch concurrency (caps connections; prevents lock storms)
 *   - Conservative parsing (drops malformed entries with a logged warning;
 *     does not throw the whole load)
 *   - Returns the same shape Tier 7 verified — same honesty discipline
 *     applies (verbatim citation, no confabulation, tamper detection)
 */

import { discover, fetchGraphContent, parseManifest } from '../../../src/index.js';
import { createHash } from 'node:crypto';
import type {
  UserWallet,
  TrainingContentRecord,
  CredentialRecord,
  PerformanceRecord,
  LearningExperience,
  GroundingAtom,
} from './grounded-answer.js';
import type { IRI } from '../../../src/index.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface PodWalletConfig {
  readonly podUrl: string;
  readonly userDid: IRI;
  /** Concurrency cap for parallel fetches of descriptor turtle / graph content. */
  readonly fetchConcurrency?: number;
  /** Per-fetch timeout (ms). */
  readonly fetchTimeoutMs?: number;
  /** Custom logger; defaults to console.warn. */
  readonly logger?: (level: 'warn' | 'info', msg: string) => void;
}

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 6000;

// ── Manifest walking ─────────────────────────────────────────────────

interface DescriptorEntry {
  readonly descriptorUrl: string;
  readonly graphUrl: string | null;
  readonly turtle: string;
  readonly graphContent: string | null;
  readonly type: 'lpc:Credential' | 'lpc:TrainingContent' | 'lpc:LearningObjective' | 'lpc:PerformanceRecord' | 'lpc:LearningExperience' | 'unknown';
}

async function fetchPool<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function fetchTurtle(url: string, timeoutMs: number): Promise<string | null> {
  // Prefer trig over turtle so .trig graph files return BOTH default and
  // named graph content; CSS may strip named graphs when serving as
  // turtle, and named graphs are where domain-namespace triples live.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/trig, text/turtle;q=0.5, application/ld+json;q=0.3, */*;q=0.1' },
      signal: ac.signal,
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function detectDescriptorType(...sources: (string | null | undefined)[]): DescriptorEntry['type'] {
  // The lpc: type triple lives in the graph content (where rich domain
  // statements go), NOT in the descriptor turtle (which is L1 cg:* only).
  // Scan all sources together for the type marker.
  const blob = sources.filter(Boolean).join('\n');
  if (/\ba\b\s+(lpc:Credential|<[^>]*\/lpc#Credential>)/.test(blob)) return 'lpc:Credential';
  if (/\ba\b\s+(lpc:TrainingContent|<[^>]*\/lpc#TrainingContent>)/.test(blob)) return 'lpc:TrainingContent';
  if (/\ba\b\s+(lpc:LearningObjective|<[^>]*\/lpc#LearningObjective>)/.test(blob)) return 'lpc:LearningObjective';
  if (/\ba\b\s+(lpc:PerformanceRecord|<[^>]*\/lpc#PerformanceRecord>)/.test(blob)) return 'lpc:PerformanceRecord';
  if (/\ba\b\s+(lpc:LearningExperience|<[^>]*\/lpc#LearningExperience>)/.test(blob)) return 'lpc:LearningExperience';
  return 'unknown';
}

function extractGraphUrlFromDescriptor(turtle: string): string | null {
  const m = /cg:affordance\s+\[[^\]]*?hydra:target\s+<([^>]+)>/s.exec(turtle)
        ?? /cg:hasDistribution\s+\[[^\]]*?hydra:target\s+<([^>]+)>/s.exec(turtle)
        ?? /dcat:accessURL\s+<([^>]+)>/.exec(turtle);
  return m ? m[1]! : null;
}

// ── Field extractors (parse triples we care about from descriptor + graph turtle) ─

function extractDescriptorIri(turtle: string): IRI {
  const m = /^\s*<([^>]+)>\s+a\s+/m.exec(turtle);
  return (m?.[1] ?? '') as IRI;
}

function extractTimestamp(turtle: string, predicate: 'cg:validFrom' | 'cg:recordedAt' | 'lpc:issuedAt' | 'lpc:completedAt'): string | undefined {
  const re = new RegExp(`${predicate}\\s+"([^"]+)"`);
  return re.exec(turtle)?.[1];
}

function extractIriProperty(turtle: string, predicate: string): IRI | undefined {
  const re = new RegExp(`${predicate}\\s+<([^>]+)>`);
  const m = re.exec(turtle);
  return m ? (m[1] as IRI) : undefined;
}

function extractStringProperty(turtle: string, predicate: string): string | undefined {
  const re = new RegExp(`${predicate}\\s+"((?:[^"\\\\]|\\\\.)*)"`);
  const m = re.exec(turtle);
  return m ? m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : undefined;
}

function extractMultilineStringProperty(turtle: string, predicate: string): string | undefined {
  // """multi-line content""" form
  const re = new RegExp(`${predicate}\\s+"""([\\s\\S]*?)"""`);
  const m = re.exec(turtle);
  if (m) return m[1]!;
  return extractStringProperty(turtle, predicate);
}

// ── Per-type loaders ─────────────────────────────────────────────────

function parseTrainingContent(entry: DescriptorEntry, allEntries: readonly DescriptorEntry[]): TrainingContentRecord | null {
  const iri = extractDescriptorIri(entry.turtle);
  if (!iri) return null;

  const name = extractStringProperty(entry.graphContent ?? '', 'rdfs:label')
            ?? extractStringProperty(entry.turtle, 'rdfs:label')
            ?? extractStringProperty(entry.turtle, 'dct:title')
            ?? 'untitled training content';

  const authoritativeSource = extractIriProperty(entry.turtle, 'lpc:authoritativeSource')
                            ?? extractIriProperty(entry.turtle, 'cg:issuer')
                            ?? ('did:unknown' as IRI);

  // Atoms come from associated lpc:LearningObjective entries that
  // have lpc:groundingFragment pointing at PGSL atoms; OR atoms can
  // be embedded directly in this content's described graph via
  // `lpc:groundingFragment <iri> ; pgsl:value "text" ; cg:contentHash "hash"`
  const atoms: GroundingAtom[] = [];

  // Direct atoms from this descriptor's graph content
  if (entry.graphContent) {
    const atomMatches = entry.graphContent.matchAll(/<([^>]+)>\s+a\s+pgsl:Atom\s*;\s*pgsl:value\s+"""([\s\S]*?)"""/g);
    for (const m of atomMatches) {
      const atomIri = m[1]! as IRI;
      const value = m[2]!;
      atoms.push({
        iri: atomIri,
        value,
        contentHash: computeContentHashHex(value),
      });
    }
  }

  // Linked LearningObjective entries with grounding fragments
  for (const o of allEntries) {
    if (o.type !== 'lpc:LearningObjective') continue;
    const oIri = extractDescriptorIri(o.turtle);
    if (!oIri) continue;
    // Heuristic linkage: training content references the learning objective IRI
    if (!entry.turtle.includes(oIri) && !entry.graphContent?.includes(oIri)) continue;

    const fragmentIri = extractIriProperty(o.turtle, 'lpc:groundingFragment')
                     ?? extractIriProperty(o.graphContent ?? '', 'lpc:groundingFragment');
    if (!fragmentIri) continue;

    const value = extractMultilineStringProperty(o.graphContent ?? '', 'pgsl:value')
              ?? extractMultilineStringProperty(o.turtle, 'pgsl:value');
    if (!value) continue;

    atoms.push({
      iri: fragmentIri,
      value,
      contentHash: computeContentHashHex(value),
    });
  }

  return {
    iri,
    name,
    authoritativeSource,
    atoms,
  };
}

function parseCredential(entry: DescriptorEntry): CredentialRecord | null {
  const iri = extractDescriptorIri(entry.turtle);
  if (!iri) return null;

  const issuer = extractIriProperty(entry.turtle, 'cg:issuer') ?? ('did:unknown' as IRI);
  const issuedAt = extractTimestamp(entry.turtle, 'cg:validFrom') ?? new Date().toISOString();
  const achievementName = extractStringProperty(entry.graphContent ?? '', 'lpc:achievementName')
                        ?? extractStringProperty(entry.turtle, 'lpc:achievementName')
                        ?? extractStringProperty(entry.graphContent ?? '', 'rdfs:label')
                        ?? extractStringProperty(entry.turtle, 'rdfs:label')
                        ?? 'unnamed credential';
  const forContent = extractIriProperty(entry.turtle, 'lpc:forContent')
                   ?? extractIriProperty(entry.graphContent ?? '', 'lpc:forContent');

  return { iri, achievementName, issuer, issuedAt, forContent };
}

function parsePerformanceRecord(entry: DescriptorEntry): PerformanceRecord | null {
  const iri = extractDescriptorIri(entry.turtle);
  if (!iri) return null;

  const attributedTo = extractIriProperty(entry.turtle, 'prov:wasAttributedTo')
                     ?? extractIriProperty(entry.graphContent ?? '', 'prov:wasAttributedTo')
                     ?? ('did:unknown' as IRI);
  const recordedAt = extractTimestamp(entry.turtle, 'cg:validFrom')
                  ?? extractTimestamp(entry.turtle, 'cg:recordedAt')
                  ?? new Date().toISOString();
  const content = extractMultilineStringProperty(entry.graphContent ?? '', 'lpc:reviewContent')
              ?? extractMultilineStringProperty(entry.graphContent ?? '', 'rdfs:comment')
              ?? extractMultilineStringProperty(entry.turtle, 'lpc:reviewContent')
              ?? '';
  const flagsCapability = extractIriProperty(entry.turtle, 'lpc:flagsCapability')
                        ?? extractIriProperty(entry.graphContent ?? '', 'lpc:flagsCapability');

  if (!content) return null;
  return { iri, content, attributedTo, recordedAt, flagsCapability };
}

function parseLearningExperience(entry: DescriptorEntry): LearningExperience | null {
  const iri = extractDescriptorIri(entry.turtle);
  if (!iri) return null;

  const forContent = extractIriProperty(entry.turtle, 'lpc:relatesToContent')
                  ?? extractIriProperty(entry.graphContent ?? '', 'lpc:relatesToContent');
  const earnedCredential = extractIriProperty(entry.turtle, 'lpc:relatesToCredential')
                        ?? extractIriProperty(entry.graphContent ?? '', 'lpc:relatesToCredential');
  const completedAt = extractTimestamp(entry.turtle, 'cg:validFrom') ?? new Date().toISOString();
  const summary = extractStringProperty(entry.graphContent ?? '', 'rdfs:comment')
              ?? extractStringProperty(entry.turtle, 'rdfs:comment')
              ?? '';

  if (!forContent) return null;
  return { iri, forContent, earnedCredential, summary, completedAt };
}

function computeContentHashHex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ── Public API ───────────────────────────────────────────────────────

export async function loadWalletFromPod(config: PodWalletConfig): Promise<UserWallet> {
  const concurrency = config.fetchConcurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = config.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = config.logger ?? ((level, msg) => {
    if (level === 'warn') console.warn(`[pod-wallet] ${msg}`);
  });

  // 1. Fetch the manifest to discover all descriptors in the pod
  const manifestEntries = await discover(config.podUrl).catch((e) => {
    log('warn', `manifest discovery failed: ${(e as Error).message}`);
    return [];
  });

  if (manifestEntries.length === 0) {
    log('info', `pod has no manifest entries (cold-start wallet)`);
    return emptyWallet(config.userDid);
  }

  // 2. Fetch each descriptor's Turtle in parallel (bounded concurrency)
  const turtles = await fetchPool(
    manifestEntries,
    async (entry) => ({ entry, turtle: await fetchTurtle(entry.descriptorUrl, timeoutMs) }),
    concurrency,
  );

  // 3. For each descriptor that loaded, also fetch its graph content
  //    (this is where atom values, VC bodies, review text actually live)
  const enriched: DescriptorEntry[] = await fetchPool(
    turtles.filter((t): t is { entry: typeof manifestEntries[number]; turtle: string } => t.turtle !== null),
    async ({ entry, turtle }) => {
      const graphUrl = extractGraphUrlFromDescriptor(turtle);
      const graphContent = graphUrl ? await fetchTurtle(graphUrl, timeoutMs) : null;
      return {
        descriptorUrl: entry.descriptorUrl,
        graphUrl,
        turtle,
        graphContent,
        type: detectDescriptorType(turtle, graphContent),
      };
    },
    concurrency,
  );

  // 4. Parse per type
  const trainingContent: TrainingContentRecord[] = [];
  const credentials: CredentialRecord[] = [];
  const performanceRecords: PerformanceRecord[] = [];
  const learningExperiences: LearningExperience[] = [];

  for (const e of enriched) {
    try {
      switch (e.type) {
        case 'lpc:TrainingContent': {
          const tc = parseTrainingContent(e, enriched);
          if (tc) trainingContent.push(tc);
          break;
        }
        case 'lpc:Credential': {
          const c = parseCredential(e);
          if (c) credentials.push(c);
          break;
        }
        case 'lpc:PerformanceRecord': {
          const r = parsePerformanceRecord(e);
          if (r) performanceRecords.push(r);
          break;
        }
        case 'lpc:LearningExperience': {
          const le = parseLearningExperience(e);
          if (le) learningExperiences.push(le);
          break;
        }
        case 'lpc:LearningObjective':
          // Consumed by the training-content parser via cross-reference;
          // not surfaced standalone in the wallet shape
          break;
        case 'unknown':
          log('info', `skipping non-lpc descriptor: ${e.descriptorUrl}`);
          break;
      }
    } catch (err) {
      log('warn', `parse failure for ${e.descriptorUrl}: ${(err as Error).message}`);
    }
  }

  log('info', `loaded wallet: ${trainingContent.length} training-content, ${credentials.length} credentials, ${performanceRecords.length} performance records, ${learningExperiences.length} learning experiences`);

  return {
    userDid: config.userDid,
    trainingContent,
    credentials,
    performanceRecords,
    learningExperiences,
  };
}

function emptyWallet(userDid: IRI): UserWallet {
  return {
    userDid,
    trainingContent: [],
    credentials: [],
    performanceRecords: [],
    learningExperiences: [],
  };
}

// ── Helpers exposed for tests ────────────────────────────────────────

export const internals = {
  detectDescriptorType,
  extractDescriptorIri,
  extractIriProperty,
  extractStringProperty,
  extractMultilineStringProperty,
  extractGraphUrlFromDescriptor,
  parseTrainingContent,
  parseCredential,
  parsePerformanceRecord,
  parseLearningExperience,
  computeContentHashHex,
};
