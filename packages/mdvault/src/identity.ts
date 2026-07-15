/**
 * §4.5 identity minting (threat class + georgio's B catalogue).
 *
 * Rules:
 *  - an explicit `@id` (or a `id` key the context aliases to `@id`) wins VERBATIM, but only
 *    if it is a safe absolute http(s) IRI (B7 rejects relative/blank/unsafe-scheme/control),
 *    and it may not carry an HMD `#control-*` fragment (the authority-target escape hatch);
 *  - otherwise the subject is minted from a base + the filename-without-extension, and
 *    FOLDERS NEVER ENTER THE IRI. Schema notes (an @type in the profile's schema-meta set)
 *    mint under the nearest/governing @base; every other note mints under the root @base;
 *  - the local name passes a strict grammar before concatenation, and the final IRI is
 *    validated so nothing injectable reaches a serializer.
 *
 * Collision detection across the whole bundle (B6) is the vault layer's job (it needs all
 * subjects at once); this module mints one note's subject.
 */
import { VaultInputError, VaultConformanceError } from './errors.js';
import { assertHttpsIdentityIri, assertSerializableIri, assertLocalName } from './iri.js';
import { baseName } from './paths.js';
import type { VaultProfile } from './profile.js';

export type IdentityKind = 'explicit' | 'schema' | 'instance';

export interface IdentityResult {
  readonly subject: string;
  readonly kind: IdentityKind;
}

export interface MintInputs {
  /** canonical note path. */
  readonly notePath: string;
  /** raw value of the note's @id (or context-aliased `id`) key, if present. */
  readonly explicitId?: unknown;
  /** the note's expanded @type IRIs (computed by the lift after context expansion). */
  readonly expandedTypes: readonly string[];
  /** root @base (instance minting). */
  readonly rootBase?: string;
  /** nearest/governing @base (schema minting). */
  readonly governingBase?: string;
}

function stripExtension(name: string, ext: string): string {
  return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
}

/** Mint (or validate) a note's subject IRI per §4.5, or throw. */
export function mintSubjectIri(inputs: MintInputs, profile: VaultProfile): IdentityResult {
  // 1. Explicit @id — verbatim, but must be a safe absolute http(s) IRI.
  if (inputs.explicitId !== undefined && inputs.explicitId !== null) {
    const id = assertHttpsIdentityIri(inputs.explicitId, `explicit @id of "${inputs.notePath}"`);
    assertSerializableIri(id);
    let frag = '';
    try { frag = new URL(id).hash; } catch { /* validated above */ }
    if (/^#control-/.test(frag)) {
      throw new VaultInputError('identity.control-fragment', `explicit @id must not carry an HMD #control-* fragment: ${id}`);
    }
    return { subject: id, kind: 'explicit' };
  }

  // 2. Classify schema vs instance by @type; pick governing vs root @base (§4.5).
  const isSchema = inputs.expandedTypes.some(t => profile.schemaMetaTypes.has(t));
  const base = isSchema ? inputs.governingBase : inputs.rootBase;
  if (!base) {
    throw new VaultConformanceError(
      'identity.no-base',
      `cannot mint ${isSchema ? 'schema' : 'instance'} identity for "${inputs.notePath}": no ${isSchema ? 'governing' : 'root'} @base in scope`,
    );
  }
  assertHttpsIdentityIri(base, 'mint @base'); // re-assert defensively (validated at parse)

  // 3. Filename local name only — folders never enter the IRI (§4.5).
  const local = assertLocalName(
    stripExtension(baseName(inputs.notePath), profile.noteExtension),
    `note "${inputs.notePath}"`,
  );
  const subject = assertSerializableIri(base + local);
  return { subject, kind: isSchema ? 'schema' : 'instance' };
}
