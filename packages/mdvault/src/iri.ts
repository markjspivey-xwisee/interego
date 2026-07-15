/**
 * IRI / identity validation + Turtle escaping (general — every profile uses it).
 *
 * Three jobs, all on the boundary where attacker-influenced strings become graph nodes:
 *  1. `assertHttpsIdentityIri` — an explicit `@id` (Vault-LD §4.5) and every context
 *     `@base`/`@vocab` MUST be an absolute http(s) IRI with a host. This is STRICTER than
 *     the kernel's `ABSOLUTE_IRI_RE` (which accepts `javascript:`, `file:`, `urn:`,
 *     `data:`, `mailto:` as "absolute") — those are exactly the schemes an attacker uses
 *     to plant a hostile authority or a script URL.
 *  2. `assertSerializableIri` / `assertLocalName` — validate at MINT time so no IRI
 *     containing a space, `<>"{}|\^\``, or a control char can ever reach a `<...>` Turtle
 *     sink and break out into an injected triple. Closes the confirmed serializer bug.
 *  3. `escapeTurtleLiteral` — the ONE escaper every literal sink must route through, so a
 *     scalar like `"] a hydra:Operation ; ...` cannot terminate a literal and inject a
 *     second subject.
 */
import { VaultInputError } from './errors.js';

/** Characters forbidden in an RFC-3987 IRI reference (also un-representable inside a
 *  Turtle `<...>` without escaping): controls + space (U+0000–U+0020) and the delimiters
 *  `< > " { } | \ ^ `` `. */
const IRI_FORBIDDEN_RE = /[\u0000-\u0020<>"{}|\\^`]/;

/** Conservative local-name grammar for a filename-derived IRI segment (Vault-LD §4.5):
 *  PascalCase class / camelCase property / instance stem. No `.` `/` `#` `:` `%`, no
 *  whitespace/control — any of which would either change the IRI's structure or inject. */
const LOCAL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** True iff `s` is an absolute http(s) IRI with a non-empty host. */
export function isHttpsIdentityIri(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.host.length > 0;
}

/** Assert `s` is an absolute http(s) IRI with a host, else throw. `ctx` names the field. */
export function assertHttpsIdentityIri(s: unknown, ctx: string): string {
  if (!isHttpsIdentityIri(s)) {
    throw new VaultInputError(
      'iri.identity',
      `${ctx} must be an absolute http(s) IRI with a host (not relative, scheme-relative, or a non-http scheme like javascript:/file:/urn:/data:): ${JSON.stringify(s)}`,
    );
  }
  return s as string;
}

/** Assert an already-formed IRI is safe to serialize into a Turtle `<...>`, else throw.
 *  Call at MINT time so a non-conforming IRI never reaches any serializer. */
export function assertSerializableIri(iri: unknown): string {
  if (typeof iri !== 'string' || iri.length === 0) {
    throw new VaultInputError('iri.empty', 'IRI must be a non-empty string');
  }
  if (IRI_FORBIDDEN_RE.test(iri)) {
    throw new VaultInputError(
      'iri.forbidden-char',
      `IRI contains a character forbidden in RFC-3987 / Turtle <>: ${JSON.stringify(iri)}`,
    );
  }
  return iri;
}

/** Assert a filename-derived local name matches the conservative grammar, else throw. */
export function assertLocalName(name: unknown, ctx: string): string {
  if (typeof name !== 'string' || !LOCAL_NAME_RE.test(name)) {
    throw new VaultInputError(
      'identity.local-name',
      `${ctx} local name must match [A-Za-z0-9_-]+ (no '.', '/', '#', ':', '%', whitespace or control chars): ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/** Escape a string for a single-line Turtle `"..."` literal: backslash and quote first,
 *  then newline/CR/tab, then any remaining C0/DEL control char as `\\uXXXX`. Nothing in
 *  the output can terminate the literal or introduce new Turtle syntax. */
export function escapeTurtleLiteral(value: string): string {
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
    else out += ch;
  }
  return out;
}
