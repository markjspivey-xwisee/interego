/**
 * Vault orchestration — ingest a bundle to a graph, recover it byte-exact.
 *
 * Ingest is two passes so wiki-links can resolve across the whole vault:
 *   Pass 1 — canonicalize every path, store each note/context as a byte-exact source atom,
 *            parse frontmatter, compose the governing context, decide participation (§4.4.1
 *            needs @type), mint the §4.5 subject, detect subject collisions (B6), and index
 *            each participating note's stem for wiki resolution.
 *   Pass 2 — lift each participating note (resolving wiki-links against the pass-1 index)
 *            and screen it against the rung ceiling; a note that breaches the ceiling or
 *            fails to mint is QUARANTINED (excluded from the active graph) but its source
 *            atom still recovers.
 *
 * Output triples are canonically sorted (F4) so the same bundle always yields identical
 * bytes (A3). No filesystem or network I/O — the bundle is fully in-memory (E5).
 */
import type { HmdTriple } from '@interego/core';
import { VaultInputError, VaultConformanceError, type Diagnostic } from './errors.js';
import { canonicalizeVaultPath, parentFolder, baseName, stripExtension } from './paths.js';
import { splitNote, parseFrontmatter } from './frontmatter.js';
import { parseContextDocument, composeContextForNote, indexContextsByFolder, type ParsedContext, type ComposedContext } from './context.js';
import { mintSubjectIri } from './identity.js';
import { WikiIndex, parseWikiLink } from './wiki.js';
import { liftNote, keywordKeys, expandVaultTerm, type KeywordKeys } from './lift.js';
import { computeGraphAuthority, noteAuthorityViolation } from './rung-gate.js';
import { mintSourceAtom, recoverAtomBytes, type SourceAtom } from './atoms.js';
import type { VaultProfile } from './profile.js';

export interface VaultBundle {
  /** note path -> exact bytes. */
  readonly notes: Readonly<Record<string, string>>;
  /** context.jsonld path -> exact bytes. */
  readonly contexts: Readonly<Record<string, string>>;
  /** the designated root context path (preserved on recovery — A5/F5). */
  readonly rootContextPath?: string;
}

export interface NoteRecord {
  readonly path: string;
  readonly participates: boolean;
  readonly subject?: string;
  /** set when the note was quarantined (rung breach, mint failure, etc.). */
  readonly quarantinedReason?: string;
}

export interface VaultGraph {
  readonly triples: readonly HmdTriple[];
  readonly notes: readonly NoteRecord[];
  /** byte-exact source atoms for every note + context. */
  readonly atoms: readonly SourceAtom[];
  readonly rootContextPath?: string;
  readonly diagnostics: readonly Diagnostic[];
}

function cmpTriple(a: HmdTriple, b: HmdTriple): number {
  return (a.s < b.s ? -1 : a.s > b.s ? 1 : 0)
    || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0)
    || (a.o < b.o ? -1 : a.o > b.o ? 1 : 0)
    || (a.oKind < b.oKind ? -1 : a.oKind > b.oKind ? 1 : 0)
    || ((a.datatype ?? '') < (b.datatype ?? '') ? -1 : (a.datatype ?? '') > (b.datatype ?? '') ? 1 : 0);
}

interface Pending {
  path: string;
  frontmatter: Record<string, unknown>;
  context: ComposedContext;
  keywords: KeywordKeys;
  subject: string;
}

/** Ingest a vault bundle into a graph + byte-exact source atoms + diagnostics. */
export function ingestVault(bundle: VaultBundle, profile: VaultProfile): VaultGraph {
  const diagnostics: Diagnostic[] = [];
  const atoms: SourceAtom[] = [];

  // ── contexts: canonicalize, atomize, parse, index by governed folder ──
  const parsedContexts: ParsedContext[] = [];
  for (const rawPath of Object.keys(bundle.contexts).sort()) {
    const path = canonicalizeVaultPath(rawPath);
    const bytes = bundle.contexts[rawPath]!;
    atoms.push(mintSourceAtom(path, 'context', bytes));
    parsedContexts.push(parseContextDocument(bytes, parentFolder(path), profile.limits));
  }
  const byFolder = indexContextsByFolder(parsedContexts);

  let rootContextPath: string | undefined;
  if (bundle.rootContextPath !== undefined) {
    rootContextPath = canonicalizeVaultPath(bundle.rootContextPath);
    if (parentFolder(rootContextPath) !== '') {
      throw new VaultInputError('context.root-not-at-root', `rootContextPath must be at the bundle root: ${bundle.rootContextPath}`);
    }
  }

  // ── pass 1: notes -> atoms, parse, mint, index ──
  const pending: Pending[] = [];
  const noteRecords: NoteRecord[] = [];
  const wiki = new WikiIndex();
  const subjectToPath = new Map<string, string>();

  for (const rawPath of Object.keys(bundle.notes).sort()) {
    const path = canonicalizeVaultPath(rawPath);
    const bytes = bundle.notes[rawPath]!;
    atoms.push(mintSourceAtom(path, 'note', bytes));

    const split = splitNote(bytes);
    if (!split.hasFrontmatter) {
      noteRecords.push({ path, participates: false });
      continue;
    }
    const frontmatter = parseFrontmatter(split.frontmatter!, profile.limits);
    const context = composeContextForNote(path, byFolder);
    for (const d of context.diagnostics) diagnostics.push(d);
    const keywords = keywordKeys(context.terms as Record<string, unknown>);

    const hasType = [...keywords.type].some(k => k in frontmatter);
    if (!hasType) {
      noteRecords.push({ path, participates: false });
      diagnostics.push({ severity: 'flag', code: 'no-type', message: `note "${path}" has no @type; it does not participate in the graph`, where: path });
      continue;
    }

    let explicitId: unknown;
    for (const k of keywords.id) if (k in frontmatter) { explicitId = frontmatter[k]; break; }

    const expandedTypes: string[] = [];
    for (const k of keywords.type) {
      if (!(k in frontmatter)) continue;
      for (const raw of (Array.isArray(frontmatter[k]) ? frontmatter[k] as unknown[] : [frontmatter[k]])) {
        if (typeof raw === 'string' && !parseWikiLink(raw)) {
          const t = expandVaultTerm(raw, context.terms as Record<string, unknown>);
          if (t) expandedTypes.push(t);
        }
      }
    }

    let subject: string;
    try {
      subject = mintSubjectIri({ notePath: path, explicitId, expandedTypes, rootBase: context.rootBase, governingBase: context.governingBase }, profile).subject;
    } catch (e) {
      if (e instanceof VaultInputError || e instanceof VaultConformanceError) {
        noteRecords.push({ path, participates: false, quarantinedReason: e.message });
        diagnostics.push({ severity: 'refuse', code: e.code, message: e.message, where: path });
        continue;
      }
      throw e;
    }

    const prior = subjectToPath.get(subject);
    if (prior !== undefined) {
      diagnostics.push({ severity: 'flag', code: 'identity.collision', message: `subject ${subject} is minted by both "${prior}" and "${path}"`, where: path });
    } else {
      subjectToPath.set(subject, path);
    }
    wiki.add(stripExtension(baseName(path), profile.noteExtension), subject, path);
    pending.push({ path, frontmatter, context, keywords, subject });
  }

  // ── pass 2: lift each note (resolve wiki-links). Authority is screened in pass 3. ──
  interface Lifted { path: string; subject: string; triples: readonly HmdTriple[]; diags: readonly Diagnostic[]; }
  const lifted: Lifted[] = [];
  for (const p of pending) {
    try {
      const r = liftNote({ notePath: p.path, frontmatter: p.frontmatter, context: p.context, subject: p.subject, wiki, profile, keywords: p.keywords });
      lifted.push({ path: p.path, subject: p.subject, triples: r.triples, diags: r.diagnostics });
    } catch (e) {
      // A structural conformance failure (e.g. inline @context) — quarantine here.
      if (e instanceof VaultConformanceError) {
        noteRecords.push({ path: p.path, participates: false, subject: p.subject, quarantinedReason: e.message });
        diagnostics.push({ severity: 'refuse', code: e.code, message: e.message, where: p.path });
      } else {
        throw e;
      }
    }
  }

  // ── pass 3: GRAPH-LEVEL rung ceiling (entailment-closed authority) ──
  // Compute the authority closure over EVERY lifted triple (so subClassOf / equivalentClass
  // / subPropertyOf / equivalentProperty / sameAs chains that reach the authority set are
  // seen across notes), then quarantine any note that carries authority directly, defines an
  // authority-linking axiom, or uses a tainted class/predicate. Surviving notes are emitted.
  const triples: HmdTriple[] = [];
  const emit = (l: Lifted): void => {
    triples.push(...l.triples);
    for (const d of l.diags) diagnostics.push(d);
    noteRecords.push({ path: l.path, participates: true, subject: l.subject });
  };
  if (profile.maxRung < 4) {
    const screen = computeGraphAuthority(lifted.flatMap(l => l.triples as HmdTriple[]));
    for (const l of lifted) {
      const v = noteAuthorityViolation(l.triples, screen);
      if (v.violated) {
        const reason = `rung-${profile.maxRung} authority (${v.reasons[0]})`;
        noteRecords.push({ path: l.path, participates: false, subject: l.subject, quarantinedReason: reason });
        diagnostics.push({ severity: 'refuse', code: 'rung.authority', message: `note "${l.path}" breaches the rung-${profile.maxRung} ceiling: ${v.reasons.join('; ')}`, where: l.path });
      } else {
        emit(l);
      }
    }
  } else {
    for (const l of lifted) emit(l);
  }

  triples.sort(cmpTriple);
  atoms.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const graph: VaultGraph = rootContextPath !== undefined
    ? { triples, notes: noteRecords, atoms, rootContextPath, diagnostics }
    : { triples, notes: noteRecords, atoms, diagnostics };
  return graph;
}

export interface RecoveredVault {
  /** every note + context path -> its exact original bytes (hash-verified). */
  readonly files: Readonly<Record<string, string>>;
  readonly rootContextPath?: string;
}

/** Recover the exact source bytes of every note + context, verifying each atom's hash
 *  (throws on tamper — A13). Byte-exact for frontmatter delimiters, spacing, newlines. */
export function recoverVault(graph: VaultGraph): RecoveredVault {
  const files: Record<string, string> = Object.create(null);
  for (const atom of graph.atoms) {
    files[atom.path] = recoverAtomBytes(atom);
  }
  return graph.rootContextPath !== undefined ? { files, rootContextPath: graph.rootContextPath } : { files };
}
