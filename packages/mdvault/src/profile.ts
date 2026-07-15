/**
 * The projection PROFILE — the knobs that make the general engine behave like a specific
 * Markdown-vault dialect. This is the whole point of "compliant without hardcoding": the
 * engine reads a profile; a dialect is DATA. "Vault-LD" is one profile instance
 * (`VAULT_LD_PROFILE`), published as a dereferenceable graph. A second dialect
 * (Obsidian/Foam/OKF) is a new profile — no engine change.
 *
 * Nothing in the engine branches on a profile's identity; it only reads these fields.
 */
import { DEFAULT_FRONTMATTER_LIMITS, type FrontmatterLimits } from './frontmatter.js';

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

/** Vault-LD's own namespace (SPEC §5.4): `vld:` and its single term `vld:path`. */
export const VLD_NS = 'https://github.com/The-Knowledge-Graph-Guys/vault-ld#';
export const VLD_PATH = `${VLD_NS}path`;

export interface VaultProfile {
  /** the profile's own dereferenceable IRI (a published graph). */
  readonly id: string;
  /** human label. */
  readonly label: string;
  /** rung ceiling: 3 = descriptive (no authority), 4 = full HMD. Screened by the rung gate. */
  readonly maxRung: number;
  /** the note file extension stripped before minting a filename identity (e.g. ".md"). */
  readonly noteExtension: string;
  /** expanded @type IRIs that mark a note as SCHEMA (mint under the governing @base, §4.5);
   *  any other @type => INSTANCE (mint under the root @base). */
  readonly schemaMetaTypes: ReadonlySet<string>;
  /** predicate that records a note's placement on export (Vault-LD: vld:path). Provenance
   *  only — never identity or authority. */
  readonly placementPredicate: string;
  /** true: a note MUST NOT carry its own inline @context (Vault-LD §4); refuse if it does. */
  readonly forbidInlineContext: boolean;
  /** true: recognize `[[wiki-link]]` values as object-property edges (§4.4.1). */
  readonly wikiLinks: boolean;
  /** parse/resource bounds. */
  readonly limits: FrontmatterLimits;
  /** the published SHACL conformance shape IRI this profile validates output against. */
  readonly conformsToShape?: string;
}

/**
 * Vault-LD v0.5, expressed as a profile (DATA). The engine never names Vault-LD; it just
 * reads these values. Published to /ns/maintainer/vault-ld alongside the §6 SHACL shape.
 */
export const VAULT_LD_PROFILE: VaultProfile = Object.freeze({
  id: 'https://relay.interego.xwisee.com/ns/maintainer/vault-ld',
  label: 'Vault-LD v0.5 (rung-<=3 HyperMarkdown conformance profile)',
  maxRung: 3,
  noteExtension: '.md',
  schemaMetaTypes: new Set([
    `${OWL}Class`,
    `${OWL}ObjectProperty`,
    `${OWL}DatatypeProperty`,
    `${OWL}AnnotationProperty`,
    `${RDFS}Class`,
    `${RDFS}Datatype`,
    `${RDF}Property`,
    `${SKOS}ConceptScheme`,
  ]),
  placementPredicate: VLD_PATH,
  forbidInlineContext: true,
  wikiLinks: true,
  limits: DEFAULT_FRONTMATTER_LIMITS,
  conformsToShape: 'https://relay.interego.xwisee.com/ns/maintainer/vault-ld#ConformanceShape',
});
