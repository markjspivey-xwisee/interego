/**
 * @module skills/agentskills-bridge
 * @description SKILL.md (agentskills.io) ↔ cg:Affordance translator.
 *
 * Architectural framing: a SKILL.md *is* a cg:Affordance by structure
 * — a discoverable named capability with metadata + instructions +
 * optional resources. This module is purely the translator between
 * the runtime-friendly file layout and the substrate's typed
 * descriptor surface.
 *
 * What composes from the rest of the substrate WITHOUT new code:
 *
 *   - Modal status (cg:Hypothetical / cg:Asserted) — "is this skill
 *     trusted?"
 *   - cg:supersedes — skill versioning across edits
 *   - amta:Attestation — multi-axis review (correctness / safety /
 *     efficiency) using the AC vertical's existing attestation flow
 *   - cgh:PromotionConstraint — "this skill cannot be Asserted until
 *     it has a safety-axis attestation"
 *   - publish/discover/share_with — federation across pods, E2EE
 *     sharing
 *   - PROV facet — signed authorship, audit-walkable provenance
 *   - pgsl:Atom — content-addressed storage of SKILL.md + scripts +
 *     references; integrity verifiable via cg:contentHash
 *
 * No `skills:` namespace is introduced. The translator uses existing
 * cg: / cgh: / dct: / hydra: / dcat: / pgsl: predicates only.
 */

import { ContextDescriptor } from '../model/descriptor.js';
import { sha256 } from '../crypto/ipfs.js';
import type { IRI, ContextDescriptorData } from '../model/types.js';
import { parseSkillMd, emitSkillMd, type SkillValidationError } from './skill-md.js';

// ── Skill package: SKILL.md plus optional sibling files ──────────────

/**
 * A skill bundle — the SKILL.md and (optionally) any files from the
 * scripts/, references/, assets/ subdirectories the agentskills.io
 * spec defines. Each non-SKILL.md file is keyed by its path RELATIVE
 * to the skill root (e.g. "scripts/extract.py").
 *
 * Bundles are the unit the bridge translates. Producers (file-system
 * loaders, git fetchers, etc.) populate this structure; the substrate
 * doesn't care where the bytes came from.
 */
export interface SkillBundle {
  readonly skillMd: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface SkillToDescriptorOptions {
  /** Authoring agent DID — sets PROV provenance + signs the descriptor. */
  readonly authoringAgentDid: IRI;
  /**
   * Initial modal status. Default: 'Hypothetical' (a fresh skill is
   * untested until the community attests). Set 'Asserted' only for
   * skills you yourself have already vetted.
   */
  readonly modalStatus?: 'Hypothetical' | 'Asserted' | 'Counterfactual';
  /** Initial epistemic confidence; default 0.5 for Hypothetical. */
  readonly confidence?: number;
  /**
   * IRI of an earlier version this descriptor supersedes. Use this to
   * publish a revised SKILL.md while keeping the supersedes-chain
   * walkable for audit. Multiple supersedes are allowed (merging
   * forks).
   */
  readonly supersedes?: readonly IRI[];
  /**
   * IRI of a hydra:target endpoint where the skill can be invoked.
   * Optional — most skills are loaded into the agent's local skill
   * folder rather than invoked over HTTP. When omitted the affordance
   * has no hydra:target and consumers fetch the SKILL.md atom directly.
   */
  readonly hydraTarget?: string;
}

export interface DescriptorBundle {
  readonly descriptor: ContextDescriptorData;
  readonly graphContent: string;
  /** Stable IRI of this version. */
  readonly skillIri: IRI;
  /** Graph IRI describing the skill's typed RDF block. */
  readonly graphIri: IRI;
  /** Atom IRIs for SKILL.md + each bundled file, keyed by relative path. */
  readonly atomIris: ReadonlyMap<string, IRI>;
  /** Validation diagnostics surfaced by the SKILL.md parser. */
  readonly skillValidation: readonly SkillValidationError[];
}

const CG_NS = 'https://markjspivey-xwisee.github.io/interego/ns/cg#';
const CGH_NS = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
const PGSL_NS = 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#';
const HYDRA_NS = 'http://www.w3.org/ns/hydra/core#';
const DCAT_NS = 'http://www.w3.org/ns/dcat#';
const DCT_NS = 'http://purl.org/dc/terms/';
const PROV_NS = 'http://www.w3.org/ns/prov#';
const RDFS_NS = 'http://www.w3.org/2000/01/rdf-schema#';

function escapeLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeMulti(s: string): string {
  // Escape ALL double-quotes, not just the substring `"""`. A string
  // ending in one or two quotes would otherwise collide with the
  // closing `"""` of the literal and the parser would close the
  // literal prematurely (with content truncated).
  // Over-escaping (`"x"` → `\"x\"`) is verbose but always valid;
  // under-escaping is a correctness bug. See tests/skills.test.ts
  // "adversarial literal escaping" for the round-trip contract.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Translate a SKILL.md bundle into a typed substrate descriptor +
 * its accompanying named-graph TriG content.
 *
 * The descriptor's IRI uses a content-derived stable form,
 * `urn:cg:skill:<name>:<sha256(SKILL.md)[:16]>`. Republishing the same
 * SKILL.md text by the same author yields the same IRI; editing it
 * yields a new one (which the caller can supersedes-chain to the prior).
 *
 * The graph block contains:
 *   - the skill subject typed as cg:Affordance + cgh:Affordance +
 *     hydra:Operation + dcat:Distribution
 *   - rdfs:label = SKILL.md `name`
 *   - rdfs:comment = SKILL.md `description`
 *   - dct:license / dct:requires (if license / compatibility provided)
 *   - dct:source pointing at the SKILL.md atom
 *   - dct:hasPart for each bundled scripts/ + references/ + assets/ atom
 *   - pgsl:Atom blocks for SKILL.md + each part, content-hashed
 *
 * Validation: surfaces all SKILL.md parser errors via
 * {@link DescriptorBundle.skillValidation}. The caller decides whether
 * to refuse publication on errors. Hard-required fields (name,
 * description) cause this function to throw — those are not recoverable.
 */
export function skillBundleToDescriptor(
  bundle: SkillBundle,
  options: SkillToDescriptorOptions,
): DescriptorBundle {
  const parse = parseSkillMd(bundle.skillMd);
  if (!parse.document) {
    const summary = parse.errors.map(e => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`SKILL.md is not parseable: ${summary}`);
  }
  const fm = parse.document.frontmatter;

  const skillContentHash = sha256(bundle.skillMd);
  const skillId = skillContentHash.slice(0, 16);
  const skillIri = `urn:cg:skill:${fm.name}:${skillId}` as IRI;
  const graphIri = `urn:graph:cg:skill:${fm.name}:${skillId}` as IRI;
  const skillAtomIri = `urn:pgsl:atom:skill-md:${skillContentHash}` as IRI;

  // Per-file atoms; sorted for deterministic output
  const atomIris = new Map<string, IRI>();
  atomIris.set('SKILL.md', skillAtomIri);
  const sortedFiles = Array.from(bundle.files.entries()).sort(([a], [b]) => a.localeCompare(b));
  const fileAtoms: Array<{ relPath: string; iri: IRI; hash: string; content: string }> = [];
  for (const [relPath, content] of sortedFiles) {
    const h = sha256(content);
    const iri = `urn:pgsl:atom:skill-part:${h}` as IRI;
    atomIris.set(relPath, iri);
    fileAtoms.push({ relPath, iri, hash: h, content });
  }

  // ── Build the descriptor (typed pointer to the graph) ──
  // We compose the standard facet stack:
  //   - Agent (who is signing)
  //   - Trust (Self-asserted at publish time; peers will add their own
  //     attestations later via the existing amta: flow)
  //   - Provenance (PROV-O wasAttributedTo for audit walks)
  //   - Temporal (validFrom = now)
  //   - Semiotic (modal status + epistemic confidence)
  // Every property a regulator or downstream agent might want — signed
  // authorship, self-asserted-vs-peer-asserted, supersedes-chain — is
  // already on the descriptor without any skill-specific code.
  const nowIso = new Date().toISOString();
  const builder = ContextDescriptor.create(skillIri)
    .describes(graphIri)
    .agent(options.authoringAgentDid)
    .selfAsserted(options.authoringAgentDid)
    .generatedBy(options.authoringAgentDid, { endedAt: nowIso })
    .temporal({ validFrom: nowIso });
  switch (options.modalStatus ?? 'Hypothetical') {
    case 'Asserted':
      builder.asserted(options.confidence ?? 0.85);
      break;
    case 'Counterfactual':
      // Modal-status Counterfactual (rejected/deprecated). The
      // Pearl-causal `.counterfactual()` builder is a different concept;
      // we reach for the underlying .semiotic() facet directly.
      builder.semiotic({ modalStatus: 'Counterfactual', groundTruth: false, epistemicConfidence: options.confidence ?? 0.5 });
      break;
    case 'Hypothetical':
    default:
      builder.hypothetical(options.confidence ?? 0.5);
      break;
  }
  if (options.supersedes && options.supersedes.length > 0) {
    builder.supersedes(...options.supersedes);
  }
  const descriptor = builder.build();

  // ── Build the named-graph TriG content (typed RDF triples) ──
  //
  // Only fields the substrate USES go into RDF. Ergonomic frontmatter
  // (allowed-tools, opaque metadata block) lives in the SKILL.md atom
  // — the source of truth. Re-emission via descriptorGraphToSkillBundle
  // recovers them from the atom, so nothing is lost; we just don't
  // duplicate them as triples.
  const targetTriple = options.hydraTarget
    ? `    <${HYDRA_NS}target> <${options.hydraTarget}> ;\n`
    : '';
  const licenseTriple = fm.license !== undefined
    ? `    <${DCT_NS}license> "${escapeLit(fm.license)}" ;\n`
    : '';
  const compatTriple = fm.compatibility !== undefined
    ? `    <${DCT_NS}requires> "${escapeLit(fm.compatibility)}" ;\n`
    : '';

  const hasPartTriples = fileAtoms.length > 0
    ? `    <${DCT_NS}hasPart> ${fileAtoms.map(f => `<${f.iri}>`).join(' , ')} ;\n`
    : '';

  const skillSubject = `<${skillIri}> a <${CG_NS}Affordance> , <${CGH_NS}Affordance> , <${HYDRA_NS}Operation> , <${DCAT_NS}Distribution> ;
    <${RDFS_NS}label> "${escapeLit(fm.name)}" ;
    <${RDFS_NS}comment> "${escapeLit(fm.description)}" ;
${licenseTriple}${compatTriple}${targetTriple}    <${DCT_NS}source> <${skillAtomIri}> ;
${hasPartTriples}    <${PROV_NS}wasAttributedTo> <${options.authoringAgentDid}> .
`;

  const skillAtomBlock = `<${skillAtomIri}> a <${PGSL_NS}Atom> ;
    <${PGSL_NS}value> """${escapeMulti(bundle.skillMd)}""" ;
    <${CG_NS}contentHash> "${skillContentHash}" ;
    <${RDFS_NS}label> "SKILL.md" .
`;

  const partAtomBlocks = fileAtoms.map(f =>
    `<${f.iri}> a <${PGSL_NS}Atom> ;
    <${PGSL_NS}value> """${escapeMulti(f.content)}""" ;
    <${CG_NS}contentHash> "${f.hash}" ;
    <${RDFS_NS}label> "${escapeLit(f.relPath)}" .
`).join('');

  const graphContent = skillSubject + '\n' + skillAtomBlock + (partAtomBlocks ? '\n' + partAtomBlocks : '');

  return {
    descriptor,
    graphContent,
    skillIri,
    graphIri,
    atomIris,
    skillValidation: parse.errors,
  };
}

// ── Reverse direction: descriptor → SKILL.md bundle ──────────────────

import {
  parseTrig,
  findSubjectsOfType,
  readStringValue,
  readIriValue,
} from '../rdf/turtle-parser.js';

/**
 * Reverse translator: read a previously-published skill descriptor's
 * graph content and reconstruct a SkillBundle ready to drop into a
 * runtime's skill folder.
 *
 * The SKILL.md text is recovered from the pgsl:Atom referenced by
 * dct:source — content-hashed, so any tampering between publish and
 * discover is verifiable.
 *
 * Files in scripts/, references/, assets/ are recovered from the
 * dct:hasPart atoms. Each atom's rdfs:label preserves the relative
 * path the producer used.
 */
export function descriptorGraphToSkillBundle(graphContent: string): SkillBundle {
  const doc = parseTrig(graphContent);
  const affordances = findSubjectsOfType(doc, `${CG_NS}Affordance` as IRI);
  if (affordances.length === 0) throw new Error('no cg:Affordance subject in graph');
  // Use the first affordance subject (a graph published by skillBundleToDescriptor has exactly one)
  const affordance = affordances[0]!;

  const skillSourceIri = readIriValue(affordance, `${DCT_NS}source` as IRI);
  if (!skillSourceIri) throw new Error('cg:Affordance subject has no dct:source pointing at the SKILL.md atom');

  // Build a quick lookup of pgsl:Atom subjects by IRI
  const atoms = findSubjectsOfType(doc, `${PGSL_NS}Atom` as IRI);
  const atomByIri = new Map<string, { value: string; label: string | undefined }>();
  for (const a of atoms) {
    if (typeof a.subject !== 'string') continue;
    const value = readStringValue(a, `${PGSL_NS}value` as IRI);
    if (value === undefined) continue;
    const label = readStringValue(a, `${RDFS_NS}label` as IRI);
    atomByIri.set(a.subject, { value, label });
  }

  const skillAtom = atomByIri.get(skillSourceIri);
  if (!skillAtom) throw new Error(`SKILL.md atom ${skillSourceIri} not present in graph`);

  // Collect bundled parts via dct:hasPart
  const hasPartTerms = affordance.properties.get(`${DCT_NS}hasPart` as IRI) ?? [];
  const files = new Map<string, string>();
  for (const term of hasPartTerms) {
    if (term.kind !== 'iri') continue;
    const part = atomByIri.get(term.iri);
    if (!part) continue;
    const rel = part.label && part.label !== 'SKILL.md' ? part.label : term.iri;
    files.set(rel, part.value);
  }

  return { skillMd: skillAtom.value, files };
}

/**
 * Convenience: parse a previously-published descriptor graph and
 * produce a fully re-emittable SKILL.md text. Round-trips cleanly
 * with {@link skillBundleToDescriptor}.
 */
export function descriptorGraphToSkillMd(graphContent: string): string {
  const bundle = descriptorGraphToSkillBundle(graphContent);
  const parsed = parseSkillMd(bundle.skillMd);
  if (!parsed.document) {
    // Edge case: producer wrote a SKILL.md that doesn't pass our parser.
    // Returning the literal bytes is safer than guessing structure.
    return bundle.skillMd;
  }
  return emitSkillMd(parsed.document);
}
