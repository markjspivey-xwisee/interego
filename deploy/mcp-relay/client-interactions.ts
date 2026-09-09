/** Authenticated, durable handoffs. Stores public proofs, never client private keys. */
import { createHash } from 'node:crypto';
import { encryptFacetValue, decryptFacetValue, isEncryptedFacetValue, type EncryptionKeyPair, type FetchFn } from '@interego/core';
import type { ResourceComposition, ResourceSignatureDraft, ResourceWriteContext } from './resource-compositions.js';

export const INTERACTION_PREFIX = 'urn:interego:client-interaction:v1:';
export const INTERACTION_STATUS = 'urn:interego:client-interaction:status';
export const INTERACTION_CANCEL = 'urn:interego:client-interaction:cancel';
export interface InteractionOwner { userId: string; clientId: string; principal: string }
export interface InteractionRecord {
  version: 1; id: string; owner: InteractionOwner; credential: string;
  reference: string; action: string; payload: Record<string, unknown>; binding: string;
  status: 'pending' | 'reviewing' | 'submitting' | 'completed' | 'cancelled' | 'expired' | 'failed';
  createdAt: number; expiresAt: number; updatedAt: number;
  draft?: ResourceSignatureDraft; result?: Record<string, unknown>;
}
export interface InteractionStore {
  read(id: string): Promise<{ record: InteractionRecord; etag: string } | undefined>;
  write(record: InteractionRecord, etag?: string): Promise<void>;
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
  return {
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
    store: InteractionStore; publicUrl: string; now?: () => number;
    /** Revalidates the original grant, its current scopes and account on EVERY operation. */
    authorize: (credential: string) => Promise<InteractionOwner & { expiresAt: number }>;
    prepare: (record: InteractionRecord) => Promise<ResourceSignatureDraft>;
    validate: (record: InteractionRecord, proof: unknown) => Promise<void>;
    execute: (record: InteractionRecord, proof: unknown) => Promise<Record<string, unknown>>;
    complete?: (id: string, owner: InteractionOwner) => void;
  }) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  operationId(credential: string, reference: string, action: string, payload: Record<string, unknown>) {
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable((value as Record<string, unknown>)[key])])) : value;
    return createHash('sha256').update(JSON.stringify([credential, reference, action, stable(payload)])).digest('base64url');
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
    return { schema: 'interego.client-interaction/v1', id: record.id, status: record.status,
      expiresAt: new Date(record.expiresAt).toISOString(),
      signingUrl: this.deps.publicUrl.replace(/\/$/, '') + '/sign-action?request=' + record.id,
      descriptorUrl: INTERACTION_PREFIX + record.id, action: INTERACTION_STATUS,
      cancelAction: INTERACTION_CANCEL,
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
      return this.publicRecord(previous.record);
    }
    if (previous && ['completed', 'submitting', 'failed'].includes(previous.record.status)) return this.publicRecord(previous.record);
    const record: InteractionRecord = { version: 1, id,
      owner: { userId: owner.userId, clientId: owner.clientId, principal: owner.principal },
      credential: input.credential, reference: input.reference, action: input.action, payload: input.payload,
      binding: input.draft.binding, status: 'pending', createdAt: now, updatedAt: now, expiresAt };
    await this.deps.store.write(record, previous?.etag);
    return this.publicRecord(record);
  }
  async status(id: string, caller: InteractionOwner | { holderUserId: string }) {
    const { record } = await this.load(id);
    this.checkCaller(record, caller);
    // Status is read-only. Expiry does not need a pod write to take effect.
    return this.publicRecord(!terminal(record.status) && record.status !== 'submitting' && record.expiresAt <= this.now()
      ? { ...record, status: 'expired' } : record);
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
      || !proof || typeof proof !== 'object' || (proof as Record<string, unknown>)['message'] !== record.draft.request.message) {
      throw new Error('signature does not match the current review');
    }
    await this.authorize(record);
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
    access: (ref, action) => !claims(ref) ? undefined : action === INTERACTION_STATUS ? 'read' : action === INTERACTION_CANCEL ? 'write' : undefined,
    async render(ref, context) {
      if (!claims(ref)) return undefined;
      if (!context.interactionStatus) throw new Error('authenticated interaction session required');
      const status = await context.interactionStatus(id(ref));
      const body = JSON.stringify(status, null, 2);
      return { descriptorUrl: ref, title: 'Signing request', body, hmd: body, controls: [
        { descriptorUrl: ref, action: INTERACTION_STATUS, label: 'Check signing result', method: 'GET', fields: [], executable: true },
        { descriptorUrl: ref, action: INTERACTION_CANCEL, label: 'Cancel signing request', method: 'POST', fields: [], executable: true },
      ], interaction: status };
    },
    async invoke(ref, action, payload, context) {
      if (payload && Object.keys(payload).length) throw new Error('interaction controls take no inputs');
      if (action === INTERACTION_STATUS && context.interactionStatus) return context.interactionStatus(id(ref));
      const write = context as ResourceWriteContext;
      if (action === INTERACTION_CANCEL && write.cancelInteraction) return write.cancelInteraction(id(ref));
      throw new Error('authenticated interaction session required');
    },
  };
}
