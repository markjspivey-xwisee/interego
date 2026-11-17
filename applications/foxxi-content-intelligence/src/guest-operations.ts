/**
 * What a general guest may ask the bridge to do. Default-deny.
 *
 * A general guest (identity's `u-try-guest-<32 hex>`, admitted through the door in
 * src/dashboard-general-guest.ts) is a caller with no wallet, no directory role and no pod but
 * its own. It does not call the bridge's `/agent/*` routes or its `foxxi.*` tools: those refuse
 * a guest (src/caller-principal.ts). It calls ONE route, with one of the operation names below.
 *
 * The list is the whole of what a guest can do. An operation that is not in it is refused,
 * whatever it is called: a new bridge route or tool is out of a guest's reach until someone adds
 * a name here on purpose, with a handler for it (src/dashboard-general-guest.ts types its
 * handler table by `GuestOperation`, so a name without a handler does not compile).
 *
 * Each operation also names every argument it takes. An argument it does not name is refused, and
 * an argument that would say WHO the request is for or WHERE its records go is refused as a
 * delegation claim: a guest acts as itself, on its own pod, and nothing in a request can say
 * otherwise.
 *
 * Pure: no I/O, no environment.
 */

export interface GuestOperationSpec {
  /** Every argument the operation takes. Any other is refused. */
  readonly args: readonly string[];
  /** Whether it writes to the guest's own pod (and so spends the guest's write allowance). */
  readonly writes: boolean;
  /** Why a guest may do this. */
  readonly why: string;
}

export const GUEST_OPERATIONS = Object.freeze({
  'guest.standing': {
    args: [], writes: false,
    why: 'a guest may ask who the bridge takes it to be and until when',
  },
  'guest.sign_out': {
    args: [], writes: false,
    why: 'a guest may end its own session; nothing on any pod is removed',
  },
  'record.read': {
    args: [], writes: false,
    why: 'a guest may read its own learning record, from its own pod',
  },
  'course.resolve': {
    args: ['composition'], writes: false,
    why: 'a guest may see what a published composition would play for it',
  },
  'course.launch': {
    args: ['composition'], writes: false,
    why: 'a guest may start playing a published composition; the play is held in the process',
  },
  'course.next': {
    args: ['session_id', 'answers', 'expected_step'], writes: true,
    why: 'a guest may answer a step of its own play; the statements are kept in its own record, on its own pod',
  },
} as const satisfies Record<string, GuestOperationSpec>);

export type GuestOperation = keyof typeof GUEST_OPERATIONS;

/** What the tab key signs with a guest operation, so a signature made for another route is no use here. */
export const GUEST_OPERATION_PURPOSE = 'foxxi-dashboard-general-guest-act-v1';

/**
 * Names that say who a request is for, on whose authority, or which pod it touches. A guest's
 * request carrying any of them, at the top of the signed payload or among the arguments, is
 * refused whatever its value (including its own DID or its own pod): there is no accepted form of
 * the claim, so there is nothing to get subtly wrong. Compared without case, `-` or `_`.
 */
const DELEGATION_NAMES = new Set([
  'actingas', 'actas', 'onbehalfof', 'behalfof', 'delegation', 'delegate', 'delegatedby', 'delegator', 'impersonate',
  'actor', 'actordid', 'subject', 'subjectdid', 'learner', 'learnerdid', 'learnerkind', 'agent', 'agentdid', 'owner', 'ownerdid',
  'did', 'webid', 'userid', 'guest', 'guestdid', 'role',
  'pod', 'podurl', 'subjectpodurl', 'learnerpodurl', 'tenantpodurl', 'targetpod', 'targetpodurl',
  'session', 'sessionkey', 'callertoken', 'admission',
]);
const plainName = (name: string): string => name.toLowerCase().replace(/[-_]/g, '');
/** Does this argument or payload name claim an identity, an authority or a pod? */
export function isDelegationName(name: string): boolean { return DELEGATION_NAMES.has(plainName(name)); }

/** The keys of the signed payload a guest operation consists of, and no others. */
const PAYLOAD_KEYS = ['agent_id', 'timestamp', 'purpose', 'operation', 'args'] as const;

export type GuestOperationRefusal =
  | 'general_guest_input_invalid'
  | 'general_guest_delegation_refused'
  | 'general_guest_operation_refused';

export type GuestOperationDecision =
  | { ok: true; operation: GuestOperation; spec: GuestOperationSpec; args: Record<string, unknown> }
  | { ok: false; status: number; code: GuestOperationRefusal };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * May a guest do what this signed payload asks? Answers the operation and its arguments, or a
 * refusal. The signature, the purpose and the guest's admission are the caller's to check; this
 * decides only the request's shape and the operation's name.
 */
export function decideGuestOperation(payload: unknown): GuestOperationDecision {
  if (!record(payload)) return { ok: false, status: 400, code: 'general_guest_input_invalid' };
  const args = payload['args'];
  // A delegation claim is refused as one before anything else is read, wherever it sits.
  const claimed = [...Object.keys(payload).filter(key => !(PAYLOAD_KEYS as readonly string[]).includes(key)), ...(record(args) ? Object.keys(args) : [])];
  if (claimed.some(isDelegationName)) return { ok: false, status: 403, code: 'general_guest_delegation_refused' };
  if (Object.keys(payload).length !== PAYLOAD_KEYS.length || PAYLOAD_KEYS.some(key => !(key in payload)) || !record(args)) {
    return { ok: false, status: 400, code: 'general_guest_input_invalid' };
  }
  const operation = payload['operation'];
  if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(GUEST_OPERATIONS, operation)) {
    return { ok: false, status: 403, code: 'general_guest_operation_refused' };
  }
  const spec: GuestOperationSpec = GUEST_OPERATIONS[operation as GuestOperation];
  if (Object.keys(args).some(key => !spec.args.includes(key))) return { ok: false, status: 400, code: 'general_guest_input_invalid' };
  return { ok: true, operation: operation as GuestOperation, spec, args };
}
