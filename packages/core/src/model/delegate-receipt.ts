/**
 * @module model/delegate-receipt
 * @description A RECEIPT A DELEGATE SIGNS WITH ITS OWN KEY, AND WHAT ADMITTING ONE ESTABLISHES.
 *
 * A delegate that did a piece of assigned work says so in a record it signs itself and keeps on
 * its own pod. The party that assigned the work reads that record and has to decide whether to
 * count it. This module is the record's shape, the signing of it, and that decision.
 *
 * ── WHY THIS IS NOT `checkDelegation` OR `judgeAuthorship` ───────────────────────────────────
 *
 * Both live next door in `model/delegate.ts` and both answer a different question.
 *
 *  · `checkDelegation` is a WRITE verdict on the delegator's pod. A delegate seated `ReadOnly`
 *    or `DiscoverOnly` gets `ok: false` from it, correctly. A receipt kept on the delegate's own
 *    pod needs no write on anybody else's, so using that verdict as the gate would either refuse
 *    every isolated worker or push somebody to widen a scope to make it pass.
 *  · `judgeAuthorship` is relative to the owner of the log a record sits in, and it takes the
 *    signer as a fact somebody else already verified. A record on the DELEGATE's pod, on behalf
 *    of a person, has a log owner who is not the principal; and nothing upstream has verified
 *    its signature, because no relay signed it.
 *
 * So admission here keeps FOUR things apart and reports each on its own line, because collapsing
 * any two of them is how a record gets counted for the wrong reason:
 *
 *   1. SIGNATURE — the receipt's exact text was signed by the key bound to the agent it names.
 *   2. STANDING  — that agent is, right now, an unrevoked delegate on the principal's own pod.
 *                  Read from the roster ({@link readDelegates}); the scope is not consulted,
 *                  because standing is not permission to write.
 *   3. FOOTING   — the receipt says on whose behalf the act was done, and it is the principal
 *                  the reader expected. The two kinds a writer may state are the ones
 *                  `model/delegate.ts` defines; a receipt cannot leave it unsaid.
 *   4. CUSTODY   — the pod the reader actually fetched it from is the pod the receipt says it
 *                  is kept on. Where a record sits is a fact about storage and is never used to
 *                  decide who answers for it.
 *
 * and a fifth that is about the reader's own memory rather than the record: a receipt already
 * admitted is refused the second time.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────────────────────
 *
 *  · It holds no key and imports no signing library. Signing and recovering are PORTS, as the
 *    registry read already is, so the module loads in a browser bundle and a caller chooses the
 *    key custody. `scheme` names what the ports must implement.
 *  · It does not fetch, decrypt or store anything. The caller hands over the receipt it read and
 *    says where it read it from.
 *  · It does not make replay memory durable. {@link MemoryReceiptLedger} forgets on restart; a
 *    caller that must survive one supplies its own {@link ReceiptLedger}.
 *  · It does not record a person's approval. That is a separate act by a person.
 */

import { canonicalJson } from '../canonical-json.js';
import {
  AGENT_ID_RX,
  agentPodOf,
  isDelegateRow,
  readDelegates,
  type Check,
  type DelegateRegistryPort,
  type DelegateRow,
  type StatedFooting,
} from './delegate.js';

/** The format string every receipt carries. A reader refuses any other. */
export const DELEGATE_RECEIPT_FORMAT = 'interego-delegate-receipt/1';

/**
 * The signature schemes a receipt may name.
 *
 * ★ A NAMED FIELD RATHER THAN AN ASSUMPTION. One scheme exists today: an EIP-191 `personal_sign`
 * by a secp256k1 key over the receipt's canonical text, the same primitive `signDescriptor` uses.
 * It is written into the signed text so a second scheme can be added without a receipt signed
 * under the first ever being read as the second.
 */
export const DELEGATE_RECEIPT_SCHEMES = ['eip191-secp256k1'] as const;
export type DelegateReceiptScheme = typeof DELEGATE_RECEIPT_SCHEMES[number];

const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POD = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** Default limit on how old a receipt may be when admitted: seven days. */
export const DELEGATE_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Default allowance for a signer's clock running ahead of the reader's: two minutes. */
export const DELEGATE_RECEIPT_MAX_SKEW_MS = 2 * 60 * 1000;

/**
 * What a delegate signs.
 *
 * Every field is covered by the signature. The two digests are opaque here: what the assignment
 * digest binds (its scope, version and input) is the assigner's to define, and this module only
 * holds the receipt to the one the reader expected.
 */
export interface DelegateReceiptBody {
  readonly format: typeof DELEGATE_RECEIPT_FORMAT;
  readonly scheme: DelegateReceiptScheme;
  /** The agent that did the work and signs this. */
  readonly signer: string;
  /** On whose behalf this act was done, stated positively either way. */
  readonly footing: StatedFooting;
  /** Lowercase SHA-256 hex identifying the assignment this answers. */
  readonly assignmentDigest: string;
  /** Lowercase SHA-256 hex of the result. */
  readonly resultDigest: string;
  /** The pod this receipt is kept on. */
  readonly custodian: string;
  readonly nonce: string;
  /** ISO 8601, UTC. */
  readonly issuedAt: string;
}

/** A receipt as it travels: the body and the signature over {@link receiptText}. */
export interface SignedDelegateReceipt {
  readonly body: DelegateReceiptBody;
  readonly signature: string;
}

/**
 * Lowercase SHA-256 hex of a value's canonical JSON: keys sorted at every depth, array order
 * kept, UTF-8.
 */
export async function digestOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The exact text a receipt's signature is over. */
export const receiptText = (body: DelegateReceiptBody): string => canonicalJson(body);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const BODY_KEYS = ['assignmentDigest', 'custodian', 'footing', 'format', 'issuedAt', 'nonce', 'resultDigest', 'scheme', 'signer'];

/**
 * What is wrong with a receipt body's shape, or null.
 *
 * ★ EXACT KEYS, NOT AT LEAST THESE. The signature covers the canonical text of whatever object
 * it is handed, so an extra field would be signed too and would mean something to nobody. A
 * body is refused for a field this format does not define, as it is for one that is missing.
 */
export function receiptBodyProblem(body: unknown): string | null {
  if (!isRecord(body)) return 'the receipt body is not an object';
  const keys = Object.keys(body).sort();
  if (keys.length !== BODY_KEYS.length || keys.some((k, i) => k !== BODY_KEYS[i])) {
    return 'the receipt body must have exactly these fields: ' + BODY_KEYS.join(', ');
  }
  if (body['format'] !== DELEGATE_RECEIPT_FORMAT) return 'the receipt format is not ' + DELEGATE_RECEIPT_FORMAT;
  if (!(DELEGATE_RECEIPT_SCHEMES as readonly unknown[]).includes(body['scheme'])) {
    return 'the receipt names a signature scheme this reader does not implement';
  }
  if (typeof body['signer'] !== 'string' || !AGENT_ID_RX.test(body['signer'])) return 'the signer is not an agent id';
  const f = body['footing'];
  if (!isRecord(f)) return 'the receipt does not state its footing';
  if (f['kind'] === 'on-behalf-of') {
    if (Object.keys(f).sort().join(',') !== 'kind,principal') return 'an on-behalf-of footing has exactly a kind and a principal';
    if (typeof f['principal'] !== 'string' || !AGENT_ID_RX.test(f['principal'])) return 'the footing names no principal';
  } else if (f['kind'] === 'own-account') {
    if (Object.keys(f).join(',') !== 'kind') return 'an own-account footing has only a kind';
  } else {
    return 'the receipt does not state its footing as on-behalf-of or own-account';
  }
  for (const k of ['assignmentDigest', 'resultDigest'] as const) {
    if (typeof body[k] !== 'string' || !HEX64.test(body[k])) return k + ' is not lowercase SHA-256 hex';
  }
  if (typeof body['custodian'] !== 'string' || !POD.test(body['custodian'])) return 'the custodian is not a pod name';
  if (typeof body['nonce'] !== 'string' || !NONCE.test(body['nonce'])) return 'the nonce is not 16 to 128 base64url characters';
  const at = body['issuedAt'];
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(at) || Number.isNaN(Date.parse(at))) {
    return 'issuedAt is not an ISO 8601 UTC time';
  }
  return null;
}

/** Build a receipt body, refusing one that could not be admitted for its shape. */
export function delegateReceiptBody(args: {
  readonly signer: string;
  readonly footing: StatedFooting;
  readonly assignmentDigest: string;
  readonly resultDigest: string;
  readonly custodian: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly scheme?: DelegateReceiptScheme;
}): DelegateReceiptBody {
  const footing: StatedFooting = args.footing.kind === 'on-behalf-of'
    ? { kind: 'on-behalf-of', principal: args.footing.principal }
    : { kind: 'own-account' };
  const body: DelegateReceiptBody = {
    format: DELEGATE_RECEIPT_FORMAT,
    scheme: args.scheme ?? 'eip191-secp256k1',
    signer: args.signer,
    footing,
    assignmentDigest: args.assignmentDigest,
    resultDigest: args.resultDigest,
    custodian: args.custodian,
    nonce: args.nonce,
    issuedAt: args.issuedAt,
  };
  const problem = receiptBodyProblem(body);
  if (problem) throw new Error('This receipt cannot be written: ' + problem + '.');
  return body;
}

/**
 * Sign a receipt body. `sign` is the caller's key: it is handed the exact text and returns the
 * signature the body's `scheme` names.
 */
export async function signDelegateReceipt(
  body: DelegateReceiptBody,
  sign: (text: string) => Promise<string>,
): Promise<SignedDelegateReceipt> {
  const problem = receiptBodyProblem(body);
  if (problem) throw new Error('This receipt cannot be signed: ' + problem + '.');
  return { body, signature: await sign(receiptText(body)) };
}

/**
 * The address an agent id states outright, or null.
 *
 * Three id forms carry their own secp256k1 address: `did:ethr:[<chain>:]0x…`,
 * `did:pkh:eip155:<chain>:0x…` and `did:key:0x…`. Any other id — a `did:web`, a WebID — does not
 * say which key is its own, and this function does not guess one from it.
 */
export function addressStatedBy(agentId: string): string | null {
  const m = /^did:ethr:(?:[A-Za-z0-9]+:)?(0x[0-9a-fA-F]{40})$/.exec(agentId)
    ?? /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/.exec(agentId)
    ?? /^did:key:(0x[0-9a-fA-F]{40})$/.exec(agentId);
  return m ? m[1]!.toLowerCase() : null;
}

/** The reader's memory of receipts it has already admitted. */
export interface ReceiptLedger {
  /**
   * Record that (signer, nonce) was admitted. Resolves true the first time and false when the
   * pair is already recorded. `forgetAfterMs` is the time after which the receipt is too old to
   * be admitted anyway, so the entry may be dropped.
   */
  readonly admit: (signer: string, nonce: string, forgetAfterMs: number) => boolean | Promise<boolean>;
}

/** A {@link ReceiptLedger} held in this process. It does not survive a restart. */
export class MemoryReceiptLedger implements ReceiptLedger {
  private readonly seen = new Map<string, number>();
  constructor(private readonly clock: () => number = Date.now) {}
  admit(signer: string, nonce: string, forgetAfterMs: number): boolean {
    const now = this.clock();
    for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k);
    // The signer exactly as written. Standing compares agent ids exactly, and two ids that differ
    // only in case are two agents, so folding case here would let one use up the other's nonce.
    const key = signer + '|' + nonce;
    if (this.seen.has(key)) return false;
    this.seen.set(key, forgetAfterMs);
    return true;
  }
}

/** What admitting a receipt established, one line per question. */
export interface ReceiptAdmission {
  /** True only when every line is a finding in favour. A `q` never makes this true. */
  readonly ok: boolean;
  /** The first line that is not in favour, as a sentence; null when `ok`. */
  readonly why: string | null;
  readonly checks: readonly Check[];
  /** The body, once its shape was accepted; null when it was not. */
  readonly body: DelegateReceiptBody | null;
  /** The address recovered from the signature, when one was. */
  readonly signedBy: string | null;
  /** The roster row that gives the signer its standing, when one was found. */
  readonly row: DelegateRow | null;
}

export interface AdmitReceiptArgs {
  readonly receipt: unknown;
  /** The pod the reader actually fetched this receipt from. */
  readonly storedOn: string;
  readonly expect: {
    /** The digest of the assignment the reader is waiting on. */
    readonly assignmentDigest: string;
    /** The person the work was assigned on behalf of. */
    readonly principal: string;
    /** That person's pod, whose roster decides the signer's standing. */
    readonly principalPod: string;
  };
  readonly now: Date;
  /** Reads the principal's pod. The same port {@link readDelegates} takes. */
  readonly registry: DelegateRegistryPort;
  /**
   * Recover the address that signed `text` under `scheme`, or null when none can be recovered.
   * May throw; a throw is read as null.
   */
  readonly recover: (text: string, signature: string, scheme: DelegateReceiptScheme) => string | null | Promise<string | null>;
  /**
   * The address bound to an agent id that does not state its own (see {@link addressStatedBy}),
   * from a source the caller trusts for it — the id's DID document, say. Omitted, or resolving
   * null, the binding is not established and the receipt is not admitted.
   */
  readonly resolveAddress?: (agentId: string) => string | null | Promise<string | null>;
  readonly ledger: ReceiptLedger;
  readonly maxAgeMs?: number;
  readonly maxSkewMs?: number;
}

/**
 * Decide whether to count a delegate's receipt.
 *
 * Every check that can run does run, so the caller sees all of what is wrong and not only the
 * first thing. The ledger is the exception: it is written last and only when everything before
 * it passed, so a receipt that is refused for another reason can be presented again once that
 * reason is gone, and only its own signer can use up one of its nonces.
 */
export async function admitDelegateReceipt(args: AdmitReceiptArgs): Promise<ReceiptAdmission> {
  const checks: Check[] = [];
  const add = (mark: Check['mark'], text: string, detail?: string): void => {
    checks.push(detail === undefined ? { mark, text } : { mark, text, detail });
  };
  const done = (body: DelegateReceiptBody | null, signedBy: string | null, row: DelegateRow | null): ReceiptAdmission => {
    const bad = checks.find((c) => c.mark !== 'y');
    return { ok: !bad, why: bad ? bad.text : null, checks, body, signedBy, row };
  };

  const receipt = args.receipt;
  const shape = !isRecord(receipt) || typeof receipt['signature'] !== 'string' || !receipt['signature']
    ? 'the receipt is not a body with a signature'
    : receiptBodyProblem(receipt['body']);
  if (shape) {
    add('n', 'The receipt is not in a form this reader admits: ' + shape + '.');
    return done(null, null, null);
  }
  const body = (receipt as { body: DelegateReceiptBody }).body;
  const signature = (receipt as { signature: string }).signature;
  add('y', 'The receipt is in the ' + DELEGATE_RECEIPT_FORMAT + ' form.');

  // 1. SIGNATURE — the key bound to the named agent signed this exact text.
  let signedBy: string | null = null;
  try {
    const got = await args.recover(receiptText(body), signature, body.scheme);
    signedBy = typeof got === 'string' && ADDRESS.test(got) ? got.toLowerCase() : null;
  } catch {
    signedBy = null;
  }
  let bound = addressStatedBy(body.signer);
  let boundBy = 'its own id';
  if (!bound && args.resolveAddress) {
    try {
      const got = await args.resolveAddress(body.signer);
      bound = typeof got === 'string' && ADDRESS.test(got) ? got.toLowerCase() : null;
      boundBy = 'the resolver this reader was given';
    } catch {
      bound = null;
    }
  }
  if (!signedBy) {
    add('n', 'No signer can be recovered from this signature over this receipt.');
  } else if (!bound) {
    add('q', 'Which key belongs to ' + body.signer + ' is not established, so the signature cannot be held to it.', signedBy);
  } else if (bound !== signedBy) {
    add('n', 'The receipt names ' + body.signer + ' and was signed by a different key.', signedBy);
  } else {
    add('y', 'The receipt was signed by the key bound to ' + body.signer + ' by ' + boundBy + '.', signedBy);
  }

  // 2. STANDING — an unrevoked delegate row on the principal's own pod, read now.
  let row: DelegateRow | null = null;
  const roster = await readDelegates(args.registry, args.expect.principalPod);
  if (!roster.read) {
    add('q', 'The principal\'s delegates could not be read, so the signer\'s standing is not established: ' + (roster.why ?? 'no reason given') + '.');
  } else if (roster.owner !== args.expect.principal) {
    add('n', 'Pod ' + args.expect.principalPod + ' is not established as ' + args.expect.principal + '\'s own, so its roster does not speak for them.',
      roster.owner ?? 'the read named no owner');
  } else {
    const found = roster.rows.find((r) => r.agentId === body.signer) ?? null;
    const at = args.now.getTime();
    if (!found) {
      add('n', body.signer + ' is not listed among ' + args.expect.principal + '\'s agents.');
    } else if (!isDelegateRow(found)) {
      add('n', body.signer + ' is listed on that pod but not as a delegate.');
    } else if (found.revoked === true) {
      add('n', 'The delegation of ' + body.signer + ' has been revoked.');
    } else if (!found.validFrom || Number.isNaN(Date.parse(found.validFrom)) || Date.parse(found.validFrom) > at) {
      add('n', 'The delegation of ' + body.signer + ' is not in force yet, or does not say when it began.');
    } else if (found.validUntil !== undefined && !(Date.parse(found.validUntil) > at)) {
      add('n', 'The delegation of ' + body.signer + ' has expired.');
    } else {
      row = found;
      add('y', body.signer + ' is a current delegate of ' + args.expect.principal + ' (scope ' + (found.scope || 'not stated')
        + ', which is not consulted: standing is not permission to write).');
    }
  }

  // 3. FOOTING — stated, and for the principal the reader expected.
  if (body.footing.kind === 'own-account') {
    add('n', 'The receipt says the agent acted on its own account, so it is not ' + args.expect.principal + '\'s work to count.');
  } else if (body.footing.principal !== args.expect.principal) {
    add('n', 'The receipt says the act was on behalf of somebody other than ' + args.expect.principal + '.', body.footing.principal);
  } else {
    add('y', 'The receipt says the act was on behalf of ' + args.expect.principal + '.');
  }

  // 4. CUSTODY — it is where it says it is. Never used to decide who answers for it.
  if (body.custodian !== args.storedOn) {
    add('n', 'The receipt says it is kept on pod ' + body.custodian + ' and was read from pod ' + args.storedOn + '.');
  } else {
    const own = agentPodOf(body.signer);
    add('y', 'The receipt was read from the pod it says it is kept on, ' + body.custodian
      + (body.custodian === args.expect.principalPod ? ', which is the principal\'s pod.'
        : own === body.custodian ? ', which is the signer\'s own pod.' : '.'));
  }

  // The assignment the reader is waiting on, and no other.
  if (body.assignmentDigest !== args.expect.assignmentDigest) {
    add('n', 'The receipt answers a different assignment from the one expected.', body.assignmentDigest);
  } else {
    add('y', 'The receipt answers the expected assignment.');
  }

  // Age.
  const maxAge = args.maxAgeMs ?? DELEGATE_RECEIPT_MAX_AGE_MS;
  const maxSkew = args.maxSkewMs ?? DELEGATE_RECEIPT_MAX_SKEW_MS;
  const issued = Date.parse(body.issuedAt);
  const age = args.now.getTime() - issued;
  if (age < -maxSkew) add('n', 'The receipt is dated in the future.', body.issuedAt);
  else if (age > maxAge) add('n', 'The receipt is older than this reader admits.', body.issuedAt);
  else add('y', 'The receipt is recent enough to admit.');

  // Not admitted before. Written only when everything above passed.
  if (checks.every((c) => c.mark === 'y')) {
    let first = false;
    let failed: string | null = null;
    try {
      first = await args.ledger.admit(body.signer, body.nonce, issued + maxAge + maxSkew);
    } catch (e) {
      failed = String((e as { message?: unknown })?.message ?? e);
    }
    if (failed !== null) add('q', 'Whether this receipt was admitted before could not be recorded: ' + failed + '.');
    else if (!first) add('n', 'This receipt was already admitted once.');
    else add('y', 'This receipt has not been admitted before.');
  }
  return done(body, signedBy, row);
}
