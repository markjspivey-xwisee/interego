/**
 * The xapi-x decorations an emitter puts on a statement, as functions of their arguments.
 *
 *   projectionCategory     the marker: this statement is a projection of a signed descriptor
 *   contentDigest          `sha256:` and 64 hex characters of some bytes
 *   supersession           the statement ids this one replaces as the current account
 *   canonicalJson          RFC 8785, the form a statement is hashed in
 *   statementDigest        the digest of a statement as its emitter sent it
 *   chained                a run of statements, each naming the one before it and its digest
 *   orderBasis             what stands behind the order of a run (../../xapix/README.md, section 6)
 *
 * Every decoration is an extension key or a category. None changes a member xAPI defines, and a
 * statement with all of them removed is the statement it was.
 */
import { createHash } from 'node:crypto';
import { xapix } from './namespace.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export const PROJECTION_TYPE = xapix('Projection');

/** The category a projection carries. Its id and its type are the one IRI: the marker is the type. */
export const projectionCategory = (): Json =>
  ({ id: PROJECTION_TYPE, objectType: 'Activity', definition: { type: PROJECTION_TYPE } });

export const contentDigest = (bytes: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export const isDigest = (v: unknown): v is string => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);

/**
 * The context members that say this statement replaces earlier ones. It voids nothing: a
 * revision leaves the earlier statement counting as the record it was, and a correction sends
 * xAPI's own voiding statement as well.
 */
export function supersession(earlier: readonly string[]): { statement?: Json; extensions: Json } {
  if (earlier.length === 0) return { extensions: {} };
  return {
    statement: { objectType: 'StatementRef', id: earlier[0] },
    extensions: { [xapix('supersedesStatement')]: [...earlier] },
  };
}

/** RFC 8785: members sorted by UTF-16 code unit, no whitespace, numbers and strings as ECMAScript writes them. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('A number that is not finite has no canonical JSON.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).filter(k => value[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error(`A ${typeof value} has no canonical JSON.`);
}

/** The members an LRS sets. A digest is of what the emitter sent, so they are left out. */
const SET_BY_THE_STORE = ['stored', 'authority', 'version'];

export function statementDigest(statement: Json): string {
  const sent = Object.fromEntries(Object.entries(statement).filter(([k]) => !SET_BY_THE_STORE.includes(k)));
  return contentDigest(canonicalJson(sent));
}

/**
 * The same statements in the same order, each after the first naming the one before it and that
 * one's digest. Every statement needs an id: a link to a statement the LRS has yet to name is no link.
 */
export function chained(statements: readonly Json[]): Json[] {
  const out: Json[] = [];
  for (const statement of statements) {
    if (typeof statement.id !== 'string') throw new Error('A chained statement has an id its emitter gave it.');
    const before = out[out.length - 1];
    if (!before) { out.push(statement); continue; }
    const context = isObject(statement.context) ? statement.context : {};
    out.push({
      ...statement,
      context: {
        ...context,
        extensions: {
          ...(isObject(context.extensions) ? context.extensions : {}),
          [xapix('previous')]: before.id,
          [xapix('previousDigest')]: statementDigest(before),
        },
      },
    });
  }
  return out;
}

export type OrderBasis = 'ProviderClaimed' | 'StoreAssigned' | 'Chained' | 'Attested';

/**
 * An order attestation as its reader holds it: the digests it lists, and whether the reader
 * verified the signature of the descriptor that lists them. Verifying is the reader's act; this
 * function is told the answer and does not take a signer's word for it.
 */
export interface OrderAttestationRead { readonly digests: readonly string[]; readonly signatureVerified: boolean; readonly signer?: string }

export interface OrderJudgement { basis: OrderBasis; iri: string; reasons: string[]; signer?: string }

const extension = (statement: Json, key: string): unknown => {
  const context = statement.context;
  return isObject(context) && isObject(context.extensions) ? context.extensions[key] : undefined;
};

/**
 * What stands behind the order these statements are given in. The strongest basis that holds for
 * the whole run: one broken link makes the run no stronger than its weakest part.
 */
export function orderBasis(statements: readonly Json[], attestation?: OrderAttestationRead): OrderJudgement {
  const reasons: string[] = [];
  const judged = (basis: OrderBasis, signer?: string): OrderJudgement => ({ basis, iri: xapix(basis), reasons, ...(signer ? { signer } : {}) });
  const digests = statements.map(statementDigest);
  if (attestation) {
    if (!attestation.signatureVerified) reasons.push('The attestation\'s signature was not verified.');
    else if (attestation.digests.length !== digests.length || attestation.digests.some((d, i) => d !== digests[i]))
      reasons.push('The attestation lists other statements, or these in another order.');
    else return judged('Attested', attestation.signer);
  }
  let linked = statements.length > 0;
  for (let i = 1; i < statements.length; i++) {
    const s = statements[i]!;
    if (extension(s, xapix('previous')) !== statements[i - 1]!.id) { linked = false; reasons.push(`Statement ${i + 1} does not name the one before it.`); break; }
    if (extension(s, xapix('previousDigest')) !== digests[i - 1]) { linked = false; reasons.push(`Statement ${i + 1} carries a digest that is not the digest of the one before it.`); break; }
  }
  if (linked && statements.length > 1) return judged('Chained');
  const stored = statements.map(s => typeof s.stored === 'string' ? Date.parse(s.stored) : NaN);
  if (stored.length > 0 && stored.every(t => !Number.isNaN(t)) && stored.every((t, i) => i === 0 || stored[i - 1]! <= t)) return judged('StoreAssigned');
  reasons.push('Nothing but what the emitter wrote orders these statements.');
  return judged('ProviderClaimed');
}
