/**
 * Extensions: capabilities a vertical publishes as descriptors, read through one neutral contract.
 *
 * ★ WHY THIS EXISTS, AND WHY IT KNOWS NO VOCABULARY (#367). The MCP relay used to carry a loader
 * for one vertical's promoted tools: it scanned a configured pod for that vertical's graph prefix
 * and type name, and registered each hit as a callable alias outside the relay's declared tool
 * surface. The vocabulary was the vertical's, the aliases were invisible to every catalog, and the
 * load was neither complete (it read the newest 200 rows and said nothing of the rest) nor atomic.
 * This module is what replaced it. The substrate supplies the parts no vertical should have to
 * rewrite; a vertical supplies a PROFILE, which is the only place its vocabulary appears:
 *
 *   - which manifest rows are candidates (`selects`), from what the row records;
 *   - what one candidate offers (`interpret`), from its verified descriptor and payload.
 *
 * ★ DISCOVERY IS COMPLETE AND BOUNDED, OR IT REFUSES. The whole manifest chain is read, archives
 * included; an unreadable segment, a pod past the row bound, an unreadable selected descriptor or
 * payload, or a profile that throws refuses the load (`ExtensionLoadRefused`). A catalog never
 * silently lacks an operation its pod publishes.
 *
 * ★ EVERY CANDIDATE IS VERIFIED BEFORE A PROFILE SEES IT. Its descriptor must sit inside the pod
 * (read from the pod's own origin, whatever host the manifest's canonical IRI names), must describe
 * every graph its row says it does, and must hash to the content id its row records, if any.
 *
 * ★ IDENTITY IS THE ACTION, AND IT IS UNAMBIGUOUS. Every operation names an absolute action IRI,
 * compared scheme-independently (`actionKey`, so the urn and URL forms of one action are one
 * action). Two current descriptors offering the same action refuse the load rather than letting
 * load order pick a winner. A descriptor another row supersedes is not current.
 *
 * ★ PUBLICATION IS DESCRIPTOR- AND AFFORDANCE-DRIVEN. A catalog is data: each operation names the
 * descriptor that defines it and, when it is invocable, its hypermedia target. Clients follow those
 * through the generic verbs (dereference, act, invoke_affordance). Nothing is installed into any
 * MCP tool list, so no transport's declared surface changes when a catalog does.
 *
 * ★ REFRESH IS EXPLICIT. A catalog is a snapshot with a content digest (sha256 over its canonical
 * JSON). Load it again and compare digests; there is no background state, so there is no
 * half-loaded state to be ready or not ready.
 */

import { actionKey, canonicalJson, computeCid, sha256 } from '@interego/core';
import type { IRI, ManifestEntry } from '@interego/core';
import { getDefaultFetch, type FetchFn } from '@interego/core/http';
import { fetchAllManifestEntries, fetchGraphContent, parseDistributionFromDescriptorTurtle } from './client.js';

/** A vertical's reading of its own descriptors. Its vocabulary lives here and nowhere else. */
export interface ExtensionProfile {
  /** An absolute IRI naming what this profile recognises; recorded in every catalog it produces. */
  readonly id: string;
  /** Whether a manifest row is a candidate, judged from what the row itself records. */
  selects(entry: ManifestEntry): boolean;
  /**
   * The operation one verified candidate offers, or undefined when it offers none. Throwing refuses
   * the whole load: a profile that cannot read something it selected must not yield a catalog that
   * quietly lacks it.
   */
  interpret(candidate: ExtensionCandidate): Promise<ExtensionOperationDraft | undefined>;
}

/** One selected manifest row, after verification, with pod-confined readers. */
export interface ExtensionCandidate {
  readonly entry: ManifestEntry;
  /** The candidate's descriptor, as the pod serves it. */
  readonly descriptor: string;
  /** Every current row of the same manifest, for an operation defined across descriptors. */
  readonly rows: readonly ManifestEntry[];
  /** A descriptor inside this pod, verified against its row the same way. */
  readDescriptor(descriptorUrl: string): Promise<string>;
  /** The plaintext graph payload a descriptor inside this pod distributes. */
  readPayload(descriptorUrl: string): Promise<string>;
}

/** What a profile says one candidate offers. */
export interface ExtensionOperationDraft {
  /** An absolute IRI: the operation's stable identity. */
  readonly action: string;
  readonly title: string;
  readonly description?: string;
  /** JSON Schema of the operation's input, when it declares one. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /** Where to invoke it through act or invoke_affordance, when it is invocable. */
  readonly target?: { readonly href: string; readonly method?: string };
  /** The descriptor that defines the operation, when it is not the candidate's own. */
  readonly definedBy?: string;
}

/** One operation in a catalog. */
export interface ExtensionOperation extends ExtensionOperationDraft {
  /** The candidate descriptor, as its manifest row names it. */
  readonly descriptorUrl: string;
  /** Its content id, when the manifest records one. */
  readonly cid?: string;
}

/** Everything a pod offers under one profile, complete, with a content digest. */
export interface ExtensionCatalog {
  readonly profile: string;
  readonly pod: string;
  /** Sorted by action. */
  readonly operations: readonly ExtensionOperation[];
  /** `sha256:<hex>` over the canonical JSON of the profile and its operations. */
  readonly digest: string;
  /** Manifest rows read, archives included. */
  readonly rows: number;
  /** Rows the profile selected. */
  readonly selected: number;
}

export type ExtensionRefusal = 'incomplete' | 'over-bound' | 'unverified' | 'ambiguous' | 'invalid';

/** A load that could not produce a complete, unambiguous catalog. */
export class ExtensionLoadRefused extends Error {
  constructor(readonly reason: ExtensionRefusal, message: string) {
    super(`extension load refused (${reason}): ${message}`);
    this.name = 'ExtensionLoadRefused';
  }
}

export interface LoadExtensionCatalogOptions {
  readonly fetch?: FetchFn;
  /** Most manifest rows read before refusing as over-bound. Default 5000. */
  readonly maxRows?: number;
  /** Most operations one catalog holds before refusing as over-bound. Default 500. */
  readonly maxOperations?: number;
}

const MANIFEST_PATH = '.well-known/context-graphs';

const withSlash = (u: string): string => (u.endsWith('/') ? u : `${u}/`);

/**
 * A URL a manifest or descriptor names, as a fetch target inside the pod, or undefined when it
 * names a path outside it. The IRI in stored bytes is canonical (it may name the pod server's
 * internal host); only the fetch target is rebased onto the origin the pod was reached at.
 */
function insidePod(pod: URL, iri: string): string | undefined {
  let u: URL;
  try { u = new URL(iri, pod); } catch { return undefined; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (!u.pathname.startsWith(pod.pathname) || u.pathname === pod.pathname) return undefined;
  return new URL(`${u.pathname}${u.search}`, pod.origin).href;
}

const absoluteIri = (iri: unknown): iri is string => {
  if (typeof iri !== 'string' || iri.trim() !== iri || iri === '') return false;
  try { return new URL(iri).protocol.length > 1; } catch { return false; }
};

/** The describes/content-id checks a descriptor must pass against the row that lists it. */
function verifyAgainstRow(entry: ManifestEntry, turtle: string): string | undefined {
  const described = new Set<string>();
  for (const m of turtle.matchAll(/iep:describes\s+((?:<[^>]*>\s*,\s*)*<[^>]*>)/g)) {
    for (const iri of m[1]!.matchAll(/<([^>]*)>/g)) described.add(iri[1]!);
  }
  for (const graph of entry.describes) {
    if (!described.has(graph)) return `its descriptor does not describe ${graph}, which its manifest row says it does`;
  }
  // The row's content id is the CID of the descriptor's body, mirrored at publish time: the same
  // comparison the supersession precondition makes when it falls back to a body fetch.
  if (entry.cid && computeCid(turtle) !== entry.cid) {
    return `its descriptor is not the one its row records (content id ${entry.cid})`;
  }
  return undefined;
}

/**
 * Read every operation `profile` finds in the pod at `podUrl`: complete, verified and unambiguous,
 * or refused.
 */
export async function loadExtensionCatalog(
  podUrl: string,
  profile: ExtensionProfile,
  options: LoadExtensionCatalogOptions = {},
): Promise<ExtensionCatalog> {
  if (!absoluteIri(profile.id)) throw new ExtensionLoadRefused('invalid', 'a profile is named by an absolute IRI');
  const fetchFn = options.fetch ?? getDefaultFetch();
  const maxRows = options.maxRows ?? 5000;
  const maxOperations = options.maxOperations ?? 500;
  const pod = new URL(withSlash(podUrl));
  const manifestUrl = new URL(MANIFEST_PATH, pod).href;

  let chain: Awaited<ReturnType<typeof fetchAllManifestEntries>>;
  try {
    chain = await fetchAllManifestEntries(manifestUrl, fetchFn, { stopAfterEntries: maxRows + 1 });
  } catch (e) {
    throw new ExtensionLoadRefused('incomplete', `the pod's manifest could not be read: ${(e as Error).message}`);
  }
  const empty = chain.hotStatus === 404 && chain.entries.length === 0;
  if (!empty) {
    if (chain.hotStatus < 200 || chain.hotStatus >= 300) {
      throw new ExtensionLoadRefused('incomplete', `the pod's manifest answered ${chain.hotStatus}`);
    }
    if (!chain.complete || chain.archivesUnreachable.length > 0) {
      throw new ExtensionLoadRefused('incomplete', `${chain.archivesUnreachable.length || 'some'} archive segment(s) of the manifest could not be read`);
    }
  }
  if (chain.bounded || chain.entries.length > maxRows) {
    throw new ExtensionLoadRefused('over-bound', `the manifest holds more than ${maxRows} rows`);
  }

  const superseded = new Set(chain.entries.flatMap(e => e.supersedes ?? []));
  const rows = chain.entries.filter(e => !superseded.has(e.descriptorUrl));
  const byUrl = new Map(rows.map(e => [e.descriptorUrl, e]));

  const descriptors = new Map<string, Promise<string>>();
  const readDescriptor = (descriptorUrl: string): Promise<string> => {
    const cached = descriptors.get(descriptorUrl);
    if (cached) return cached;
    const read = (async () => {
      const entry = byUrl.get(descriptorUrl);
      if (!entry) throw new ExtensionLoadRefused('unverified', `${descriptorUrl} is not a current row of this pod's manifest`);
      const target = insidePod(pod, descriptorUrl);
      if (!target) throw new ExtensionLoadRefused('unverified', `${descriptorUrl} is outside the pod ${pod.href}`);
      let resp: Awaited<ReturnType<FetchFn>>;
      try { resp = await fetchFn(target, { method: 'GET', headers: { Accept: 'text/turtle' } }); }
      catch (e) { throw new ExtensionLoadRefused('incomplete', `${descriptorUrl} could not be read: ${(e as Error).message}`); }
      if (!resp.ok) throw new ExtensionLoadRefused('incomplete', `${descriptorUrl} answered ${resp.status}`);
      const turtle = await resp.text();
      const mismatch = verifyAgainstRow(entry, turtle);
      if (mismatch) throw new ExtensionLoadRefused('unverified', `${descriptorUrl}: ${mismatch}`);
      return turtle;
    })();
    descriptors.set(descriptorUrl, read);
    return read;
  };
  const readPayload = async (descriptorUrl: string): Promise<string> => {
    const link = parseDistributionFromDescriptorTurtle(await readDescriptor(descriptorUrl));
    if (!link) throw new ExtensionLoadRefused('incomplete', `${descriptorUrl} declares no payload`);
    if (link.encrypted) throw new ExtensionLoadRefused('incomplete', `${descriptorUrl}'s payload is encrypted, so no one but its recipients can read what it offers`);
    const target = insidePod(pod, link.accessURL);
    if (!target) throw new ExtensionLoadRefused('unverified', `${descriptorUrl}'s payload ${link.accessURL} is outside the pod`);
    let got: Awaited<ReturnType<typeof fetchGraphContent>>;
    try { got = await fetchGraphContent(target, { fetch: fetchFn }); }
    catch (e) { throw new ExtensionLoadRefused('incomplete', `${descriptorUrl}'s payload could not be read: ${(e as Error).message}`); }
    if (got.content === null || got.encrypted) throw new ExtensionLoadRefused('incomplete', `${descriptorUrl}'s payload could not be read as plaintext`);
    return got.content;
  };

  const selected = rows.filter(e => profile.selects(e));
  const operations: ExtensionOperation[] = [];
  for (const entry of selected) {
    const descriptor = await readDescriptor(entry.descriptorUrl);
    let draft: ExtensionOperationDraft | undefined;
    try {
      draft = await profile.interpret({ entry, descriptor, rows, readDescriptor, readPayload });
    } catch (e) {
      if (e instanceof ExtensionLoadRefused) throw e;
      throw new ExtensionLoadRefused('invalid', `the profile could not read ${entry.descriptorUrl}: ${(e as Error).message}`);
    }
    if (draft === undefined) continue;
    if (!absoluteIri(draft.action)) throw new ExtensionLoadRefused('invalid', `${entry.descriptorUrl} offers an action that is not an absolute IRI`);
    if (typeof draft.title !== 'string' || draft.title.trim() === '') throw new ExtensionLoadRefused('invalid', `${entry.descriptorUrl} offers an operation with no title`);
    if (draft.inputSchema !== undefined && (typeof draft.inputSchema !== 'object' || draft.inputSchema === null || Array.isArray(draft.inputSchema))) {
      throw new ExtensionLoadRefused('invalid', `${entry.descriptorUrl}'s input schema is not a JSON Schema object`);
    }
    if (draft.target !== undefined) {
      let href: URL | undefined;
      try { href = new URL(draft.target.href); } catch { href = undefined; }
      if (!href || (href.protocol !== 'https:' && href.protocol !== 'http:')) {
        throw new ExtensionLoadRefused('invalid', `${entry.descriptorUrl}'s target is not an absolute http(s) URL`);
      }
    }
    if (draft.definedBy !== undefined) await readDescriptor(draft.definedBy);
    operations.push({
      action: draft.action,
      title: draft.title,
      ...(draft.description !== undefined ? { description: draft.description } : {}),
      ...(draft.inputSchema !== undefined ? { inputSchema: draft.inputSchema } : {}),
      ...(draft.target !== undefined ? { target: { href: draft.target.href, method: (draft.target.method ?? 'POST').toUpperCase() } } : {}),
      ...(draft.definedBy !== undefined ? { definedBy: draft.definedBy } : {}),
      descriptorUrl: entry.descriptorUrl,
      ...(entry.cid !== undefined ? { cid: entry.cid } : {}),
    });
    if (operations.length > maxOperations) {
      throw new ExtensionLoadRefused('over-bound', `the pod offers more than ${maxOperations} operations under ${profile.id}`);
    }
  }

  const byAction = new Map<string, ExtensionOperation>();
  for (const op of operations) {
    const key = actionKey(op.action) || op.action;
    const other = byAction.get(key);
    if (other) {
      throw new ExtensionLoadRefused('ambiguous', `${other.descriptorUrl} and ${op.descriptorUrl} both offer ${op.action}`);
    }
    byAction.set(key, op);
  }
  operations.sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));
  const digest = `sha256:${sha256(canonicalJson({ profile: profile.id, operations }))}`;
  return { profile: profile.id as IRI, pod: pod.href, operations, digest, rows: chain.entries.length, selected: selected.length };
}
