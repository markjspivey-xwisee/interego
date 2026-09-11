/** Authenticated, durable handoffs. Stores public proofs, never client private keys. */
import { createHash } from 'node:crypto';
import { encryptFacetValue, decryptFacetValue, isEncryptedFacetValue, type EncryptionKeyPair, type FetchFn } from '@interego/core';
import type { ResourceComposition, ResourceSignatureDraft, ResourceWriteContext } from './resource-compositions.js';

export const INTERACTION_PREFIX = 'urn:interego:client-interaction:v1:';
export const INTERACTION_STATUS = 'urn:interego:client-interaction:status';
export const INTERACTION_CANCEL = 'urn:interego:client-interaction:cancel';
export const INTERACTION_RENEW = 'urn:interego:client-interaction:renew-authorization';
export interface InteractionOwner { userId: string; clientId: string; principal: string }
export interface InteractionRecord {
  version: 1; id: string; owner: InteractionOwner; credential: string;
  reference: string; action: string; payload: Record<string, unknown>; binding: string;
  status: 'pending' | 'reviewing' | 'submitting' | 'completed' | 'cancelled' | 'expired' | 'failed';
  createdAt: number; expiresAt: number; updatedAt: number;
  signingOrigin?: string;
  draft?: ResourceSignatureDraft; result?: Record<string, unknown>;
}
export interface InteractionStore {
  read(id: string): Promise<{ record: InteractionRecord; etag: string } | undefined>;
  write(record: InteractionRecord, etag?: string): Promise<void>;
  enqueue?(record: InteractionRecord): Promise<void>;
  pending?(owner: InteractionOwner): Promise<readonly string[]>;
}
const validId = (id: string) => /^[a-zA-Z0-9_-]{43}$/.test(id);
const sameOwner = (a: InteractionOwner, b: InteractionOwner) => a.userId === b.userId && a.clientId === b.clientId && a.principal === b.principal;
const terminal = (status: InteractionRecord['status']) => ['completed', 'cancelled', 'expired', 'failed'].includes(status);

/** The pod permits public GETs. Encrypt the ENTIRE record, including its OAuth credential. */
export function encryptedInteractionStore(config: { podUrl: string; fetch: FetchFn; encryptionKey: EncryptionKeyPair }): InteractionStore {
  if (!config.encryptionKey) throw new Error('client interactions require encryption at rest');
  const url = (id: string) => {
    if (!validId(id)) throw new Error('invalid interaction identifier');
    return config.podUrl.replace(/\/$/, '') + '/client-interactions/' + id + '.json';
  };
  const queueUrl = (owner: InteractionOwner) => config.podUrl.replace(/\/$/, '') + '/client-interaction-queues/'
    + createHash('sha256').update(JSON.stringify([owner.userId, owner.clientId, owner.principal])).digest('base64url') + '.json';
  const readQueue = async (owner: InteractionOwner) => {
    const response = await config.fetch(queueUrl(owner), { headers: { Accept: 'application/json', 'Cache-Control': 'no-store' } });
    if (response.status === 404) return { entries: [] as { id: string; expiresAt: number }[], etag: undefined };
    if (!response.ok) throw new Error('cannot read private signing queue');
    const sealed: unknown = await response.json();
    if (!isEncryptedFacetValue(sealed)) throw new Error('unencrypted signing queue refused');
    const plain = decryptFacetValue(sealed, config.encryptionKey);
    const etag = response.headers?.get('etag');
    if (!plain || !etag) throw new Error('signing queue requires encrypted conditional storage');
    const queue = JSON.parse(plain) as { owner: InteractionOwner; entries: { id: string; expiresAt: number }[] };
    if (!sameOwner(owner, queue.owner) || !Array.isArray(queue.entries) || queue.entries.length > 128
      || queue.entries.some(e => !validId(e.id) || !Number.isFinite(e.expiresAt))) throw new Error('invalid signing queue');
    return { entries: queue.entries, etag };
  };
  return {
    async enqueue(record) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const queue = await readQueue(record.owner);
        const entries = queue.entries.filter(e => e.expiresAt > record.updatedAt && e.id !== record.id);
        if (!terminal(record.status) && record.expiresAt > record.updatedAt) {
          if (entries.length >= 128) throw new Error('signing queue is full; complete or wait for pending requests to expire');
          entries.push({ id: record.id, expiresAt: record.expiresAt });
        }
        const body = encryptFacetValue(JSON.stringify({ owner: record.owner, entries }), [config.encryptionKey.publicKey], config.encryptionKey);
        const response = await config.fetch(queueUrl(record.owner), { method: 'PUT', headers: { 'Content-Type': 'application/json',
          ...(queue.etag ? { 'If-Match': queue.etag } : { 'If-None-Match': '*' }) }, body: JSON.stringify(body) });
        if (response.ok) return;
        if (response.status !== 412) throw new Error('cannot update private signing queue');
      }
      throw new Error('signing queue changed repeatedly; retry the handoff');
    },
    async pending(owner) { return (await readQueue(owner)).entries.map(e => e.id); },
    async read(id) {
      const response = await config.fetch(url(id), { headers: { Accept: 'application/json', 'Cache-Control': 'no-store' } });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`interaction store read failed (${response.status})`);
      const sealed: unknown = await response.json();
      if (!isEncryptedFacetValue(sealed)) throw new Error('unencrypted interaction record refused');
      const plain = decryptFacetValue(sealed, config.encryptionKey);
      if (!plain) throw new Error('cannot decrypt interaction record');
      const record = JSON.parse(plain) as InteractionRecord;
      if (record.version !== 1 || record.id !== id) throw new Error('invalid interaction record binding');
      const etag = response.headers?.get('etag');
      if (!etag) throw new Error('interaction store must support conditional writes');
      return { record, etag };
    },
    async write(record, etag) {
      const body = encryptFacetValue(JSON.stringify(record), [config.encryptionKey.publicKey], config.encryptionKey);
      const response = await config.fetch(url(record.id), { method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(response.status === 412 ? 'interaction changed; reload its status' : `interaction store write failed (${response.status})`);
    },
  };
}

export class ClientInteractions {
  constructor(private readonly deps: {
    store: InteractionStore; publicUrl: string; signingOrigins?: readonly string[]; now?: () => number;
    /** Revalidates the original grant, its current scopes and account on EVERY operation. */
    authorize: (credential: string) => Promise<InteractionOwner & { expiresAt: number }>;
    prepare: (record: InteractionRecord) => Promise<ResourceSignatureDraft>;
    validate: (record: InteractionRecord, proof: unknown) => Promise<void>;
    prepareGrant?: (record: InteractionRecord, payload: Record<string, unknown>) => Promise<{ action: string; payload: Record<string, unknown>; draft: ResourceSignatureDraft }>;
    execute: (record: InteractionRecord, proof: unknown) => Promise<Record<string, unknown>>;
    complete?: (id: string, owner: InteractionOwner) => void;
  }) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  operationId(credential: string, reference: string, action: string, payload: Record<string, unknown>) {
    // An optional empty proof field is the same unsigned request as an omitted
    // field. The interpreter removes it before creating the handoff.
    const unsigned = { ...payload };
    if (!unsigned['client_proof']) delete unsigned['client_proof'];
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable((value as Record<string, unknown>)[key])])) : value;
    return createHash('sha256').update(JSON.stringify([credential, reference, action, stable(unsigned)])).digest('base64url');
  }
  async existing(credential: string, reference: string, action: string, payload: Record<string, unknown>, owner: InteractionOwner) {
    const entry = await this.deps.store.read(this.operationId(credential, reference, action, payload));
    if (!entry) return undefined;
    this.checkCaller(entry.record, owner);
    return this.status(entry.record.id, owner);
  }
  async resume(id: string, owner: InteractionOwner, reference: string, action: string, payload: Record<string, unknown>) {
    const { record } = await this.load(id);
    this.checkCaller(record, owner);
    if (this.operationId('', reference, action, payload) !== this.operationId('', record.reference, record.action, record.payload)) {
      throw new Error('continuation does not match the original action and inputs');
    }
    return this.status(id, owner);
  }
  private async load(id: string) {
    if (!validId(id)) throw new Error('interaction not found');
    const entry = await this.deps.store.read(id);
    if (!entry) throw new Error('interaction not found');
    return entry;
  }
  private async authorize(record: InteractionRecord) {
    const owner = await this.deps.authorize(record.credential);
    if (!sameOwner(owner, record.owner) || owner.expiresAt <= this.now()) throw new Error('the originating authorization expired or changed; request a new signing handoff');
  }
  private publicRecord(record: InteractionRecord) {
    return { schema: 'interego.client-interaction/v1', id: record.id, status: record.status, actor: record.owner.principal,
      expiresAt: new Date(record.expiresAt).toISOString(),
      signingUrl: (record.signingOrigin ?? this.deps.publicUrl).replace(/\/$/, '') + '/sign-action?request=' + record.id,
      descriptorUrl: INTERACTION_PREFIX + record.id, action: INTERACTION_STATUS,
      cancelAction: INTERACTION_CANCEL,
      ...(['pending', 'reviewing', 'expired'].includes(record.status) && record.createdAt + 30 * 60_000 > this.now()
        ? { renewAction: INTERACTION_RENEW, resumableUntil: new Date(record.createdAt + 30 * 60_000).toISOString() } : {}),
      ...(!terminal(record.status) ? { signingRequirement: { authorization: 'authenticated-session', proof: 'registered-client-key',
        reason: 'This action requires a client signature. No client proof was supplied; the relay cannot sign with the holder’s private key.' } } : {}),
      ...(record.result ? { result: record.result } : {}),
      ...(record.status === 'submitting' && this.now() - record.updatedAt > 120_000
        ? { blocker: 'Submission outcome is uncertain. Inspect the current resource head before any new submission.' } : {}),
    };
  }
  async create(input: { credential: string; reference: string; action: string; payload: Record<string, unknown>; draft: ResourceSignatureDraft }) {
    const owner = await this.deps.authorize(input.credential);
    const now = this.now();
    const expiresAt = Math.min(now + 30 * 60_000, owner.expiresAt);
    if (expiresAt - now < 60_000) throw new Error('the current authorization expires too soon; refresh the MCP connection before requesting a signature');
    const id = this.operationId(input.credential, input.reference, input.action, input.payload);
    const previous = await this.deps.store.read(id);
    if (previous && previous.record.expiresAt > now && previous.record.status !== 'cancelled') {
      this.checkCaller(previous.record, owner);
      await this.deps.store.enqueue?.(previous.record);
      return this.publicRecord(previous.record);
    }
    if (previous && ['completed', 'submitting', 'failed'].includes(previous.record.status)) return this.publicRecord(previous.record);
    // Choose only an operator-configured signing page that can use a registered
    // credential. A key's origin list must never become an arbitrary redirect.
    const configuredOrigins = this.deps.signingOrigins ?? [this.deps.publicUrl];
    const passkeyOrigin = (origin: string, verified: boolean) => {
      const url = new URL(origin);
      return input.draft.request.keys.some(({ key }) => key.scheme === 'webauthn'
          && (!verified || key.rpIds?.length === 1) && key.origins?.includes(url.origin)
          && key.rpIds?.some(rp => url.hostname === rp || url.hostname.endsWith('.' + rp)));
    };
    // A wallet on the same account must not send a pinned passkey to a sibling
    // site. Legacy multi-RP metadata is only a compatibility hint, not proof of
    // registration; the page offers configured-site recovery before login.
    const signingOrigin = configuredOrigins.find(origin => passkeyOrigin(origin, true))
      ?? (input.draft.request.keys.some(({ key }) => key.scheme === 'eip191') ? configuredOrigins[0] : undefined)
      ?? configuredOrigins.find(origin => passkeyOrigin(origin, false));
    if (!signingOrigin) throw new Error('No configured signing page supports your registered credential. Use your registered agent signer and submit its client_proof through MCP.');
    const record: InteractionRecord = { version: 1, id,
      owner: { userId: owner.userId, clientId: owner.clientId, principal: owner.principal },
      credential: input.credential, reference: input.reference, action: input.action, payload: input.payload,
      binding: input.draft.binding, status: 'pending', createdAt: now, updatedAt: now, expiresAt, signingOrigin };
    await this.deps.store.write(record, previous?.etag);
    await this.deps.store.enqueue?.(record);
    return this.publicRecord(record);
  }
  /** A holder may watch only the exact originating agent/client's private queue. */
  async pending(id: string, holderUserId: string) {
    const { record } = await this.load(id);
    this.checkCaller(record, { holderUserId });
    if (!this.deps.store.pending) throw new Error('background signing is unavailable');
    const pending = [];
    for (const nextId of await this.deps.store.pending(record.owner)) {
      const next = await this.deps.store.read(nextId);
      if (next && sameOwner(next.record.owner, record.owner) && ['pending', 'reviewing'].includes(next.record.status)
        && next.record.expiresAt > this.now()) pending.push({ ...this.publicRecord(next.record), requestedAction: next.record.action });
    }
    return { requests: pending };
  }
  /** Create an owner-reviewed enrollment using the original agent's authenticated authority. */
  async grant(id: string, holderUserId: string, payload: Record<string, unknown>) {
    const { record } = await this.load(id);
    this.checkCaller(record, { holderUserId });
    if (!['pending', 'reviewing'].includes(record.status) || record.expiresAt <= this.now()) throw new Error('a live action review is required');
    await this.authorize(record);
    if (!this.deps.prepareGrant) throw new Error('scoped client signing is unavailable');
    // Recheck the original immutable authority, then derive the declared enrollment
    // action. The browser cannot select another agent, credential or application.
    const current = await this.deps.prepare(record);
    if (current.binding !== record.binding) throw new Error('authority or inputs changed; request a fresh review');
    const enrollment = await this.deps.prepareGrant({ ...record, reference: current.reference }, payload);
    return this.create({ credential: record.credential, reference: enrollment.draft.reference,
      action: enrollment.action, payload: enrollment.payload, draft: enrollment.draft });
  }
  async status(id: string, caller: InteractionOwner | { holderUserId: string }) {
    const { record } = await this.load(id);
    this.checkCaller(record, caller);
    // Status is read-only. Expiry does not need a pod write to take effect.
    return this.publicRecord(!terminal(record.status) && record.status !== 'submitting' && record.expiresAt <= this.now()
      ? { ...record, status: 'expired' } : record);
  }
  /** Explicit MCP write: renew the same request using its same client's current grant. */
  async renewAuthorization(id: string, credential: string) {
    const { record, etag } = await this.load(id);
    const owner = await this.deps.authorize(credential);
    this.checkCaller(record, owner);
    if (!['pending', 'reviewing'].includes(record.status)) throw new Error('this interaction cannot be resumed');
    const now = this.now();
    const expiresAt = Math.min(record.createdAt + 30 * 60_000, owner.expiresAt);
    if (expiresAt <= now) throw new Error('interaction or current authorization expired; request a new handoff');
    // Invalidate the old receipt. A fresh review still resolves the original
    // authority/evidence binding before any new signature can be accepted.
    const next: InteractionRecord = { ...record, credential, expiresAt, status: 'pending', draft: undefined, updatedAt: now };
    await this.deps.store.write(next, etag);
    await this.deps.store.enqueue?.(next);
    return this.publicRecord(next);
  }
  private checkCaller(record: InteractionRecord, caller: InteractionOwner | { holderUserId: string }) {
    if ('holderUserId' in caller ? caller.holderUserId !== record.owner.userId : !sameOwner(record.owner, caller)) {
      throw new Error('interaction not found');
    }
  }
  async review(id: string, holderUserId: string) {
    const { record, etag } = await this.load(id);
    this.checkCaller(record, { holderUserId });
    if (terminal(record.status) || record.status === 'submitting') throw new Error('this interaction cannot be reviewed again');
    if (record.expiresAt <= this.now()) throw new Error('interaction expired; request a new handoff');
    await this.authorize(record);
    const draft = await this.deps.prepare(record);
    if (draft.binding !== record.binding) throw new Error('authority, evidence or action inputs changed; request a new action review');
    const next: InteractionRecord = { ...record, status: 'reviewing', draft, updatedAt: this.now() };
    await this.deps.store.write(next, etag);
    return { ...this.publicRecord(next), signingRequest: draft.request,
      reviewId: createHash('sha256').update(draft.request.message).digest('hex') };
  }
  async cancel(id: string, caller: InteractionOwner | { holderUserId: string }) {
    const { record, etag } = await this.load(id);
    this.checkCaller(record, caller);
    if (record.status === 'submitting') throw new Error('submission is already in progress; inspect its result');
    if (terminal(record.status)) return this.publicRecord(record);
    const next: InteractionRecord = { ...record, status: 'cancelled', updatedAt: this.now(), credential: '', draft: undefined };
    await this.deps.store.write(next, etag);
    // Queue cleanup is optional after the durable terminal result; a stale entry
    // is filtered by pending() and must not make a committed action look failed.
    await this.deps.store.enqueue?.(next).catch(() => {});
    this.deps.complete?.(id, record.owner);
    return this.publicRecord(next);
  }
  async submit(id: string, holderUserId: string, reviewId: string, proof: unknown) {
    const { record, etag } = await this.load(id);
    this.checkCaller(record, { holderUserId });
    if (terminal(record.status) || record.status === 'submitting') return this.publicRecord(record);
    if (record.status !== 'reviewing' || !record.draft) throw new Error('review this request before signing');
    if (record.expiresAt <= this.now() || Date.parse(record.draft.request.expiresAt) <= this.now()) throw new Error('review expired; load and review a fresh receipt');
    if (createHash('sha256').update(record.draft.request.message).digest('hex') !== reviewId
      || !proof || typeof proof !== 'object' || Array.isArray(proof)) {
      throw new Error('signature does not match the current review');
    }
    await this.authorize(record);
    // The installed interpreter validates the exact retained draft and proof domain.
    // Delegated proofs wrap the receipt instead of using a top-level message field.
    await this.deps.validate(record, proof);
    // Claim before external publication. A crash or ambiguous network outcome is never
    // retried automatically: durable 'submitting' prompts explicit reconciliation.
    const claimed: InteractionRecord = { ...record, status: 'submitting', updatedAt: this.now() };
    await this.deps.store.write(claimed, etag);
    const saved = await this.load(id);
    let result: Record<string, unknown>;
    try { result = await this.deps.execute(claimed, proof); }
    catch (error) {
      // A thrown transport error may follow a successful publish. Do not label it safe to retry.
      result = { error: 'submission_requires_reconciliation', message: (error as Error).message, committed: 'unknown' };
    }
    const next: InteractionRecord = { ...claimed,
      status: result['committed'] === true && !result['error'] ? 'completed' : 'failed',
      result, updatedAt: this.now(), credential: '', draft: undefined };
    await this.deps.store.write(next, saved.etag);
    // Queue cleanup is optional after the durable terminal result; a stale entry
    // is filtered by pending() and must not make a committed action look failed.
    await this.deps.store.enqueue?.(next).catch(() => {});
    this.deps.complete?.(id, record.owner);
    return this.publicRecord(next);
  }
}

/** Generic lifecycle controls remain on act/dereference, without domain MCP tools. */
export function clientInteractionComposition(): ResourceComposition {
  const id = (ref: string) => ref.slice(INTERACTION_PREFIX.length);
  const claims = (ref: string) => ref.startsWith(INTERACTION_PREFIX) && validId(id(ref));
  return {
    claims,
    access: (ref, action) => !claims(ref) ? undefined : action === INTERACTION_STATUS ? 'read' : [INTERACTION_CANCEL, INTERACTION_RENEW].includes(action) ? 'write' : undefined,
    async render(ref, context) {
      if (!claims(ref)) return undefined;
      if (!context.interactionStatus) throw new Error('authenticated interaction session required');
      const status = await context.interactionStatus(id(ref));
      const body = 'Review and sign using your registered credential. This panel checks the submitted result automatically.';
      return { descriptorUrl: ref, title: 'Signing request', body, hmd: body, controls: [
        { descriptorUrl: ref, action: INTERACTION_STATUS, label: 'Check signing result', method: 'GET', fields: [], executable: true },
        ...(status['renewAction'] ? [{ descriptorUrl: ref, action: INTERACTION_RENEW, label: 'Resume with current session', method: 'POST', fields: [], executable: true }] : []),
        { descriptorUrl: ref, action: INTERACTION_CANCEL, label: 'Cancel signing request', method: 'POST', fields: [], executable: true },
      ], interaction: status };
    },
    async invoke(ref, action, payload, context) {
      if (payload && Object.keys(payload).length) throw new Error('interaction controls take no inputs');
      if (action === INTERACTION_STATUS && context.interactionStatus) return context.interactionStatus(id(ref));
      const write = context as ResourceWriteContext;
      if (action === INTERACTION_CANCEL && write.cancelInteraction) return write.cancelInteraction(id(ref));
      if (action === INTERACTION_RENEW && write.renewInteraction) return write.renewInteraction(id(ref));
      throw new Error('authenticated interaction session required');
    },
  };
}
