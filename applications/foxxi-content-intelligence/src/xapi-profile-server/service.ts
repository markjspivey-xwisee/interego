/**
 * The xAPI Profile Server (xAPI Profiles, Part Three) as Foxxi serves it.
 *
 * Nothing here is a separate product bolted on. The parts are ones the bridge already has:
 *
 *   store     each profile version is a holon in a public PGSL lattice on the commons pod, the
 *             exact document its content. Its triples are projected from that into
 *             @interego/pgsl triple stores, which are the "RDF triple store" the specification
 *             asks for. This module is given `persist` and `hydrate` and does not know where
 *             they lead.
 *   query     @interego/pgsl's SPARQL engine, over the named graphs in ./dataset.ts.
 *   validate  ./processor.ts, the specification's own algorithms.
 *   add       a signed affordance: an agent adds a profile as itself, by contents or by URI.
 *
 * The specification's "administrators" are, here, the agents that sign: whoever first adds a
 * profile IRI is the one who may add later versions of it or take it down, and the operator may
 * take down any.
 */
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response, RequestHandler } from 'express';
import { rateLimit, type Options as RateLimitOptions } from 'express-rate-limit';
import { turtleIriRef } from '@interego/core';
import { ProfileDataset, SparqlRefused, type HeldProfile } from './dataset.js';
import { follows, validates, type Json as PJson } from './processor.js';
import { toRdfTerm, versionsOf, type Json } from './rdf.js';
import type { ExternalTerm, ProfileExamples } from './lint.js';

type Obj = { [key: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const MAX_PROFILE_BYTES = 256 * 1024;
/** Everything ever added, together. The lattice is append-only and lives in one pod resource. */
export const MAX_KEPT_BYTES = 12 * 1024 * 1024;
export const MAX_PROFILE_TRIPLES = 6000;
export const MAX_PATTERN_STATEMENTS = 500;
/** The most records one record withdraws. Past this many not kept, a write first sends one record that withdraws them. */
export const MAX_WITHDRAWN_BY_ONE_RECORD = 32;

/**
 * What every record carries besides its change.
 *
 * `id` names the record, so a store can be asked whether it has it. `withdraws` names earlier
 * records this server sent and then reported as not kept. A store may still come to hold such a
 * record: its answer was lost and it could not be read back, or the store writes it with the next
 * record that does land. A withdrawn record is skipped when records are replayed, so a restarted
 * server holds what the running one said it held. Records kept before these existed have neither.
 */
interface RecordMarks { readonly id?: string; readonly withdraws?: readonly string[] }

/** What is kept for each added version, and replayed when the bridge starts. */
export type ProfileRecord =
  | ({ kind: 'added'; doc: Json; by: string; at: string; source?: string } & RecordMarks)
  /** A version published from a draft: never replaced, and kept with the examples it was linted with. */
  | ({ kind: 'published'; doc: Json; examples: ProfileExamples; external: ExternalTerm[]; by: string; at: string } & RecordMarks)
  | ({ kind: 'removed'; iri: string; by: string; at: string } & RecordMarks)
  /** Changes nothing itself: it is kept for what it withdraws. */
  | ({ kind: 'withdrawn'; by: string; at: string } & RecordMarks);

export interface ProfileServerOptions {
  /** Profiles that are part of the deployment itself (Foxxi's own). Never removable, never persisted. */
  readonly builtIn: () => Json[];
  /**
   * What each built-in profile is kept with: the examples its lint is run with and the terms of
   * other publishers its templates name. Served where a published version's are. A built-in
   * profile was never published from a draft, so this is the deployment's own say-so, from code.
   */
  readonly builtInKept?: () => Array<{ /** A built-in profile's IRI, or the IRI of one version of it. */ profile: string; examples: ProfileExamples; external: ExternalTerm[] }>;
  /** Keep a record durably. Resolves with where it went, or throws. */
  readonly persist?: (record: ProfileRecord, held?: HeldProfile) => Promise<{ holonUri?: string; persisted?: boolean }>;
  /**
   * Whether the durable store holds a record, read from the store itself: true when it does, false
   * when it was read and does not, undefined when it could not be read. Asked when `persist` threw
   * or did not acknowledge, because a write can land and its answer be lost.
   */
  readonly confirm?: (record: ProfileRecord) => Promise<boolean | undefined>;
  /** Every record kept so far. */
  readonly hydrate?: () => Promise<ProfileRecord[]>;
  /** A stored statement by id, for templates that check a referenced statement. */
  readonly statementById?: (id: string) => PJson | undefined;
  readonly isOperator?: (did: string) => boolean;
}

export class ProfileServerError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/**
 * A change whose durable write was not acknowledged. Nothing changed: what the server held and
 * answered before, it holds and answers now, and the same request can be sent again.
 */
export class WriteNotKept extends ProfileServerError {
  constructor(message: string) { super(503, message); }
}

/**
 * A publication whose durable write was not acknowledged. Nothing was published: the version is
 * not held and answers nowhere, and publishing the same version again is allowed.
 */
export class PublicationNotKept extends WriteNotKept {
  constructor(readonly profile: string, readonly version: string, why: string) {
    super(`${version} was not published: ${why} Nothing changed: the version is not held here and answers nowhere. Publishing the same version again is allowed.`);
  }
}

/** An added version whose durable write was not acknowledged. It is not held; what was held before still is. */
export class AdditionNotKept extends WriteNotKept {
  constructor(readonly profile: string, readonly version: string, why: string) {
    super(`${version} was not added: ${why} Nothing changed: what this server held and answered before, it holds and answers now. Adding the same version again is allowed.`);
  }
}

/** A removal whose durable write was not acknowledged. Everything it named is still held and still answers. */
export class RemovalNotKept extends WriteNotKept {
  constructor(readonly iri: string, why: string) {
    super(`${iri} was not taken down: ${why} Nothing changed: it is still held here and still answers. Taking it down again is allowed.`);
  }
}

/**
 * A change whose durable write was not acknowledged and could not be read back either: the store
 * answered neither the write nor the read, so whether it has the record is not known.
 *
 * Saying "kept" or "not kept" here would be a guess, and a restart reads the store, not the guess.
 * So the server says neither. Nothing has changed here yet, the profile is changed by nobody
 * until this is settled, and the server settles it from the store as soon as the store can be
 * read: the change is made here if the record is there, and withdrawn if it is not.
 */
export class WriteInDoubt extends ProfileServerError {
  constructor(readonly change: 'added' | 'published' | 'removed', readonly iri: string, readonly profile: string) {
    super(503, `Whether ${iri} was ${change === 'removed' ? 'taken down' : change} is not known yet: the durable store did not acknowledge the write and could not be read back. `
      + `Here it is ${change === 'removed' ? 'still held' : 'not held'} for now. This server settles it as soon as the store can be read, and until then ${profile} is not changed by anyone. `
      + 'Read the profile to see which it was before sending the request again.');
  }
}

/** What a route answers for a write in doubt: not ok, and neither kept nor not kept. */
export function inDoubtAnswer(e: WriteInDoubt): Record<string, unknown> {
  return { ok: false, inDoubt: true, error: e.message, change: e.change, iri: e.iri, profile: e.profile };
}

/** How long after a write is left in doubt the store is first read again, and the longest between later reads. */
const SETTLE_FIRST_MS = 5_000, SETTLE_MOST_MS = 60_000;

/** What sending one record came to. `unknown`: not acknowledged, and the store could not be read. */
type Sent = { kept: true; holonUri?: string } | { kept: false; why: string } | { kept: 'unknown'; record: ProfileRecord };

/**
 * What a route answers for an addition or a removal that was not kept: not ok, and nothing changed.
 * `retry` is where the same signed request is sent again.
 */
export function notKeptAnswer(e: AdditionNotKept | RemovalNotKept, retry: string): Record<string, unknown> {
  return e instanceof AdditionNotKept
    ? { ok: false, added: false, persisted: false, error: e.message, profile: e.profile, version: e.version, retry }
    : { ok: false, removed: [], persisted: false, error: e.message, iri: e.iri, stillHeld: true, retry };
}

export class ProfileServer {
  readonly dataset = new ProfileDataset();
  /** profile IRI → the agent that first added it. */
  private readonly owners = new Map<string, string>();
  private readonly builtInIds = new Set<string>();
  /** version IRI of a built-in profile → what it is kept with. */
  private readonly builtInWith = new Map<string, { examples: ProfileExamples; external: ExternalTerm[] }>();
  /** version IRI → what it was published with. A version here is immutable. */
  private readonly publishedVersions = new Map<string, { examples: ProfileExamples; external: ExternalTerm[]; at: string }>();
  /** version IRI → an addition or publication waiting on its durable write. The version is not held until that lands. */
  private readonly writing = new Map<string, { id: string; by: string }>();
  /** profile IRI → a removal under it waiting on its durable write. What it names is held until that lands. */
  private readonly removing = new Set<string>();
  /** ids of records reported as not kept and not yet withdrawn by a record that was. */
  private readonly notKept = new Set<string>();
  /** The record that withdraws them when there are too many for a change to carry, until it is kept. */
  private withdrawal: ProfileRecord | undefined;
  /** Writes in doubt, each with what to do here once the store says which it was. Their reservations are held meanwhile. */
  private readonly inDoubt: Array<{ record: ProfileRecord; apply: () => void; release: (kept: boolean) => void }> = [];
  private settling: Promise<void> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private settleDelay = SETTLE_FIRST_MS;
  private hydrated: Promise<void> | undefined;
  private keptBytes = 0;

  constructor(private readonly options: ProfileServerOptions) {
    for (const doc of options.builtIn()) this.builtInIds.add(this.dataset.add(doc).id);
    for (const kept of options.builtInKept?.() ?? []) {
      // Named by profile (its current version) or by one version of it.
      const named = this.dataset.get(kept.profile);
      const held = named && this.builtInIds.has(named.id) ? named : undefined;
      if (!held) throw new Error(`${kept.profile} is not one of this deployment's built-in profiles, so nothing is kept with it.`);
      this.builtInWith.set(held.version, { examples: kept.examples, external: kept.external });
    }
  }

  /** Replay what was kept. Safe to call on every request: it runs once, and again after a failure. */
  ready(): Promise<void> {
    return this.hydrated ??= (async () => {
      const records = (await this.options.hydrate?.()) ?? [];
      // A record another record withdraws was reported as not kept: it is not replayed.
      const withdrawn = new Set(records.flatMap(r => Array.isArray(r.withdraws) ? r.withdraws : []));
      for (const r of [...records].sort((a, b) => a.at.localeCompare(b.at))) {
        if (r.id !== undefined && withdrawn.has(r.id)) continue;
        try {
          if (r.kind === 'added') { this.keptBytes += sizeOf(r.doc); this.hold(r.doc, r.by); }
          else if (r.kind === 'published') {
            this.keptBytes += sizeOf(r.doc) + sizeOf(r.examples);
            const held = this.hold(r.doc, r.by);
            this.publishedVersions.set(held.version, { examples: r.examples, external: r.external ?? [], at: r.at });
          }
          else if (r.kind === 'removed') this.drop(r.iri);
        } catch { /* a record that no longer reads is skipped, not fatal */ }
      }
    })().catch(e => { this.hydrated = undefined; throw e; });
  }

  private hold(doc: Json, by: string): HeldProfile {
    const held = this.admit(doc, by);
    this.dataset.put(held);
    this.owners.set(held.id, by);
    return held;
  }

  /** Whether a document may be held for an agent, and what it would be held as. Holds nothing. */
  private admit(doc: Json, by: string): HeldProfile {
    const why = whyNotAddable(doc);
    if (why) throw new ProfileServerError(400, why);
    const id = (doc as Obj).id as string;
    if (this.builtInIds.has(id)) throw new ProfileServerError(409, `${id} is this deployment's own profile and is served from its code.`);
    const owner = this.owners.get(id);
    if (owner && owner !== by) throw new ProfileServerError(409, `${id} was added by another agent, and only that agent adds versions of it.`);
    // The dataset is keyed by version IRI. A version already held under another profile is that
    // profile's: without this, a document naming a different profile could replace it, the
    // deployment's own included.
    const version = versionsOf(doc).current.id;
    if (this.publishedVersions.has(version)) throw new ProfileServerError(409, `${version} is published, and a published version is not changed. Publish a new version that revises it.`);
    const taken = this.dataset.all().find(h => h.version === version || h.id === version);
    if (taken && taken.id !== id) throw new ProfileServerError(409, `${version} is already held as a version of ${taken.id}.`);
    if (this.dataset.all().some(h => h.version === id)) throw new ProfileServerError(409, `${id} is held here as a version, not as a profile.`);
    // A write waiting on its pod has the version, and the profile: one version of a profile is
    // written at a time, its own writer's included. Which version is current can turn on the order
    // versions were held in, and a restart holds them in the order of their records' times. Two
    // writes under one profile acknowledged out of that order would leave a restarted server
    // resolving the profile to a different version than this one does.
    if (this.writing.has(version)) throw new ProfileServerError(409, `${version} is being written now.`);
    if ([...this.writing.values()].some(p => p.id === id)) throw new ProfileServerError(409, `A version of ${id} is being written now. Send this one once that has finished.`);
    // The two checks above on what is held, made on what is about to be: an IRI is a profile or a version, not both.
    if (this.writing.has(id)) throw new ProfileServerError(409, `${id} is being written now as a version, and cannot also be a profile.`);
    if ([...this.writing.values()].some(p => p.id === version)) throw new ProfileServerError(409, `${version} is being written now as a profile, and cannot also be a version.`);
    // Records are replayed in the order of their times. A version written under a profile while a
    // removal under it waits would be held here and gone, or gone here and held, after a restart.
    if (this.removing.has(id)) throw new ProfileServerError(409, `${id} is being taken down now. Add to it once that has finished.`);
    const held = this.dataset.prepare(doc);
    if (held.stated.length > MAX_PROFILE_TRIPLES)
      throw new ProfileServerError(413, `The profile states ${held.stated.length} triples; this server holds profiles of up to ${MAX_PROFILE_TRIPLES}.`);
    return held;
  }

  /**
   * Send one record to the durable store, and say whether the store has it.
   *
   * Kept means `persist` acknowledged it, or, when it threw or did not acknowledge, `confirm` read
   * the record back from the store: the write landed and only its answer was lost.
   *
   * A record that is not kept is remembered, and the next record sent names it in `withdraws`.
   * The store may come to hold it all the same, and `ready` skips a withdrawn record. A record
   * that was not acknowledged and could not be read back either is in doubt (`unknown`): it is not
   * withdrawn, because the store may have it, and `settle` decides once the store can be read.
   *
   * A store that is down fails write after write, and a store like the bridge's keeps each failed
   * record in hand. So what one record withdraws is bounded: past MAX_WITHDRAWN_BY_ONE_RECORD not
   * kept, the change is not sent until one record that only withdraws them has been kept. That
   * record changes nothing when replayed, so it needs no withdrawing itself, and it is the same
   * record on every attempt, so a store that keeps what it is sent keeps it once.
   */
  private async keep(change: ProfileRecord, held?: HeldProfile): Promise<Sent> {
    if (this.notKept.size >= MAX_WITHDRAWN_BY_ONE_RECORD) {
      const withdrawal = this.withdrawal ??= { kind: 'withdrawn', by: change.by, at: new Date().toISOString(), id: randomUUID(), withdraws: [...this.notKept] };
      // In doubt counts as not kept here: the change itself was not sent, and this record is sent again as it is.
      if ((await this.send(withdrawal)).kept !== true) return { kept: false, why: 'the durable store has not kept this server\'s recent writes, and did not keep this one.' };
      for (const id of withdrawal.withdraws ?? []) this.notKept.delete(id);
      if (this.withdrawal === withdrawal) this.withdrawal = undefined;
    }
    const withdraws = [...this.notKept];
    const record: ProfileRecord = { ...change, id: randomUUID(), ...(withdraws.length ? { withdraws } : {}) };
    const sent = await this.send(record, held);
    // In doubt: neither withdrawn nor counted as kept. `settle` does one or the other.
    if (sent.kept === 'unknown') return sent;
    if (!sent.kept) { this.notKept.add(record.id!); return sent; }
    // What this record withdrew is withdrawn durably now.
    for (const id of withdraws) this.notKept.delete(id);
    return sent;
  }

  /**
   * One record to the store: acknowledged, or read back from it when it was not. A store that
   * cannot be asked (no `confirm`) is taken at its word, as before: not acknowledged is not kept.
   */
  private async send(record: ProfileRecord, held?: HeldProfile): Promise<Sent> {
    let answer: { holonUri?: string; persisted?: boolean } | undefined;
    let why = 'the durable write was not acknowledged.';
    try { answer = await this.options.persist!(record, held); } catch { why = 'the durable write failed.'; }
    if (answer?.persisted === true) return { kept: true, ...(answer.holonUri ? { holonUri: answer.holonUri } : {}) };
    if (!this.options.confirm) return { kept: false, why };
    const there = await this.has(record);
    return there === true ? { kept: true } : there === false ? { kept: false, why } : { kept: 'unknown', record };
  }

  /** Whether the store has a record: true, false, or undefined when it could not be read. */
  private async has(record: ProfileRecord): Promise<boolean | undefined> {
    try { return await this.options.confirm?.(record); } catch { return undefined; }
  }

  /** Leave a write in doubt: what it reserved stays reserved until `settle` learns which it was. */
  private doubt(record: ProfileRecord, apply: () => void, release: (kept: boolean) => void): void {
    this.inDoubt.push({ record, apply, release });
    this.settleLater();
  }

  /** How many writes are in doubt. */
  get unsettled(): number { return this.inDoubt.length; }

  /**
   * Settle what is in doubt, from the store. A record the store has is applied here, as if its
   * write had been acknowledged; one it does not have is withdrawn, as any write that was not
   * kept is; one it still cannot say is left for the next time. Runs before every write, and on a
   * timer while anything is in doubt, so a server nobody writes to settles too.
   */
  settle(): Promise<void> {
    if (this.inDoubt.length === 0) return Promise.resolve();
    return this.settling ??= (async () => {
      try {
        for (const d of [...this.inDoubt]) {
          const there = await this.has(d.record);
          if (there === undefined) continue;
          this.inDoubt.splice(this.inDoubt.indexOf(d), 1);
          if (there) { for (const id of d.record.withdraws ?? []) this.notKept.delete(id); d.apply(); }
          else this.notKept.add(d.record.id!);
          d.release(there);
        }
      } finally {
        this.settling = undefined;
        if (this.inDoubt.length === 0) this.settleDelay = SETTLE_FIRST_MS;
        this.settleLater();
      }
    })();
  }

  private settleLater(): void {
    if (this.inDoubt.length === 0 || this.settleTimer) return;
    this.settleTimer = setTimeout(() => { this.settleTimer = undefined; void this.settle(); }, this.settleDelay);
    this.settleTimer.unref?.();
    this.settleDelay = Math.min(this.settleDelay * 2, SETTLE_MOST_MS);
  }

  private drop(iri: string): string[] {
    const gone = this.dataset.remove(iri);
    for (const version of gone) this.publishedVersions.delete(version);
    if (!this.dataset.all().some(h => h.id === iri)) this.owners.delete(iri);
    return gone;
  }

  /**
   * Add a profile version by its contents.
   *
   * ★ THE DURABLE WRITE COMES FIRST, as for `publish` below. The version is held, and answers, only
   * once `persist` has said `persisted: true`. When the write fails or is not acknowledged this
   * throws AdditionNotKept: the version is not held, a version it would have replaced is still the
   * document it was, and the same addition can be sent again. A server given no `persist` adds nothing.
   */
  async add(doc: Json, by: string, source?: string): Promise<{ held: HeldProfile; replaced: boolean; holonUri?: string; persisted: true }> {
    await this.ready();
    await this.settle();
    const held = this.admit(doc, by);
    if (!this.options.persist) throw new AdditionNotKept(held.id, held.version, 'this server has no durable store to keep a profile in.');
    const size = sizeOf(doc);
    if (this.keptBytes + size > MAX_KEPT_BYTES) throw new ProfileServerError(507, 'This server has kept as many profile documents as it holds; an operator has to make room.');
    const replaced = this.dataset.all().some(h => h.version === held.version);
    this.writing.set(held.version, { id: held.id, by });
    // Counted from here, as a publication's are, and given back if it is not kept.
    this.keptBytes += size;
    let landed = false, waiting = false;
    const hold = () => { this.dataset.put(held); this.owners.set(held.id, by); };
    const release = (kept: boolean) => { this.writing.delete(held.version); if (!kept) this.keptBytes -= size; };
    try {
      const kept = await this.keep({ kind: 'added', doc, by, at: new Date().toISOString(), ...(source ? { source } : {}) }, held);
      if (kept.kept === 'unknown') { waiting = true; this.doubt(kept.record, hold, release); throw new WriteInDoubt('added', held.version, held.id); }
      if (!kept.kept) throw new AdditionNotKept(held.id, held.version, kept.why);
      hold();
      landed = true;
      return { held, replaced, ...(kept.holonUri ? { holonUri: kept.holonUri } : {}), persisted: true };
    } finally {
      if (!waiting) release(landed);
    }
  }

  /**
   * Take down a profile (every version) or one version.
   *
   * ★ THE DURABLE WRITE COMES FIRST here too. A removal that only this process knew of would be
   * undone by the next restart: the profile would answer again with nobody having added it. So
   * what is named stops answering only once `persist` has said `persisted: true`; otherwise this
   * throws RemovalNotKept and everything is still held. A server given no `persist` removes nothing.
   */
  async remove(iri: string, by: string): Promise<{ removed: string[]; persisted: true }> {
    await this.ready();
    await this.settle();
    const target = this.dataset.all().find(h => h.id === iri || h.version === iri);
    if (!target) throw new ProfileServerError(404, `No profile or version ${iri} is held here.`);
    if (this.builtInIds.has(target.id)) throw new ProfileServerError(409, `${target.id} is this deployment's own profile and cannot be taken down.`);
    if (this.owners.get(target.id) !== by && !this.options.isOperator?.(by)) throw new ProfileServerError(403, 'Only the agent that added a profile, or the operator, takes it down.');
    // What was published stays: others may hold statements that name it. The operator can still take it down.
    if (!this.options.isOperator?.(by) && this.dataset.all().some(h => (h.id === iri || h.version === iri) && this.publishedVersions.has(h.version)))
      throw new ProfileServerError(409, 'A published version is not taken down by its author. Publish a new version: what it leaves out stays resolvable, marked deprecated.');
    // One change to a profile at a time, for the reason given in `admit`.
    if (this.removing.has(target.id)) throw new ProfileServerError(409, `${target.id} is being taken down now.`);
    if ([...this.writing.values()].some(p => p.id === target.id)) throw new ProfileServerError(409, `A version of ${target.id} is being written now. Take it down once that has finished.`);
    if (!this.options.persist) throw new RemovalNotKept(iri, 'this server has no durable store to record a removal in.');
    this.removing.add(target.id);
    let waiting = false;
    const release = () => { this.removing.delete(target.id); };
    try {
      const kept = await this.keep({ kind: 'removed', iri, by, at: new Date().toISOString() });
      if (kept.kept === 'unknown') { waiting = true; this.doubt(kept.record, () => { this.drop(iri); }, release); throw new WriteInDoubt('removed', iri, target.id); }
      if (!kept.kept) throw new RemovalNotKept(iri, kept.why);
      return { removed: this.drop(iri), persisted: true };
    } finally {
      if (!waiting) release();
    }
  }

  /**
   * Publish a version: held like an added one, and from then on immutable. The caller (./authoring.ts)
   * has linted the document and fixed its `generatedAtTime`; this refuses a version already held.
   *
   * ★ THE DURABLE WRITE COMES FIRST. A published version is a promise that its IRIs keep answering,
   * and one that lives only in this process breaks it at the next restart. So the version is held,
   * and answers, only once `persist` has said `persisted: true`. Until then nothing here serves it;
   * when the write fails or is not acknowledged this throws PublicationNotKept, leaves no trace,
   * and the same version can be published again. A server given no `persist` publishes nothing.
   */
  async publish(doc: Json, examples: ProfileExamples, external: ExternalTerm[], by: string, at: string): Promise<{ held: HeldProfile; holonUri?: string; persisted: true }> {
    await this.ready();
    await this.settle();
    const why = whyNotAddable(doc);
    if (why) throw new ProfileServerError(400, why);
    const version = versionsOf(doc).current.id;
    if (this.dataset.all().some(h => h.version === version)) throw new ProfileServerError(409, `${version} is already held here. A published version is not changed: give the draft a new version IRI.`);
    const size = sizeOf(doc) + sizeOf(examples);
    if (this.keptBytes + size > MAX_KEPT_BYTES) throw new ProfileServerError(507, 'This server has kept as many profile documents as it holds; an operator has to make room.');
    const held = this.admit(doc, by);
    if (!this.options.persist) throw new PublicationNotKept(held.id, version, 'this server has no durable store to keep a published version in.');
    this.writing.set(version, { id: held.id, by });
    // Its bytes are counted from here, so what is on its way to the pod is inside the ceiling that
    // additions and other publications are measured against. They are given back if it is not kept.
    this.keptBytes += size;
    let landed = false, waiting = false;
    const hold = () => { this.dataset.put(held); this.owners.set(held.id, by); this.publishedVersions.set(held.version, { examples, external, at }); };
    const release = (kept: boolean) => { this.writing.delete(version); if (!kept) this.keptBytes -= size; };
    try {
      const kept = await this.keep({ kind: 'published', doc, examples, external, by, at }, held);
      if (kept.kept === 'unknown') { waiting = true; this.doubt(kept.record, hold, release); throw new WriteInDoubt('published', version, held.id); }
      if (!kept.kept) throw new PublicationNotKept(held.id, version, kept.why);
      hold();
      landed = true;
      return { held, ...(kept.holonUri ? { holonUri: kept.holonUri } : {}), persisted: true };
    } finally {
      if (!waiting) release(landed);
    }
  }

  /** What a version was published with, when it was published from a draft here. */
  published(version: string): { examples: ProfileExamples; external: ExternalTerm[]; at: string } | undefined { return this.publishedVersions.get(version); }

  /** What a version is kept with: what it was published with, or for a built-in profile what the deployment keeps with it. `at` is absent for a built-in. */
  keptWith(version: string): { examples: ProfileExamples; external: ExternalTerm[]; at?: string } | undefined {
    return this.publishedVersions.get(version) ?? this.builtInWith.get(version);
  }

  /** The type of a concept that a held profile other than `except` declares: a term known to this server. */
  knownTerm(iri: string, except?: string): string | undefined {
    for (const held of this.dataset.all()) {
      if (held.id === except) continue;
      const concepts = (held.doc as Obj).concepts;
      const found = Array.isArray(concepts) ? concepts.find(c => isObj(c) && c.id === iri) : undefined;
      if (isObj(found) && typeof found.type === 'string') return found.type;
    }
    return undefined;
  }

  /**
   * What an IRI names here: a profile (its current version), a version, or a concept, statement
   * template or pattern. A term is read from the current version of its profile when that version
   * has it, and otherwise from the latest version that did, marked deprecated: an IRI that was
   * once published keeps answering.
   */
  resolve(iri: string): Resolved | undefined {
    const whole = this.dataset.get(iri);
    if (whole) return { kind: whole.id === iri ? 'profile' : 'version', held: whole, body: whole.doc as Obj };
    const current = new Set(this.dataset.current().map(h => h.version));
    const newestFirst = [...this.dataset.all()].sort((a, b) => Number(current.has(b.version)) - Number(current.has(a.version))
      || (Date.parse(b.generatedAtTime ?? '') || 0) - (Date.parse(a.generatedAtTime ?? '') || 0));
    for (const held of newestFirst) {
      for (const [key, kind] of [['concepts', 'concept'], ['templates', 'template'], ['patterns', 'pattern']] as const) {
        const terms = (held.doc as Obj)[key];
        const term = Array.isArray(terms) ? terms.find(t => isObj(t) && t.id === iri) : undefined;
        if (!isObj(term)) continue;
        const superseded = !current.has(held.version);
        const context = (held.doc as Obj)['@context'] ?? 'https://w3id.org/xapi/profiles/context';
        return { kind, held, body: { '@context': context, ...term, ...(superseded ? { deprecated: true } : {}) }, deprecated: superseded || term.deprecated === true };
      }
    }
    return undefined;
  }

  /** A held version, or with `iri` what it states about one term and the blank nodes that leads to, as N-Triples. */
  ntriples(held: HeldProfile, iri?: string): string {
    // A term that cannot be written safely is null, and the triple it is in is left out.
    const term = (stored: string): string | null => {
      const t = toRdfTerm(stored);
      if (t.type === 'uri') return turtleIriRef(t.value);
      if (t.type === 'bnode') return /^[A-Za-z0-9]+$/.test(t.value) ? `_:${t.value}` : null;
      const text = JSON.stringify(t.value);
      if (t['xml:lang']) return /^[A-Za-z]+(-[A-Za-z0-9]+)*$/.test(t['xml:lang']) ? `${text}@${t['xml:lang']}` : text;
      if (!t.datatype) return text;
      const datatype = turtleIriRef(t.datatype);
      return datatype === null ? null : `${text}^^${datatype}`;
    };
    let triples = held.stated;
    if (iri !== undefined) {
      const subjects = new Set([iri]);
      for (let grew = true; grew;) {
        grew = false;
        for (const t of held.stated) if (subjects.has(t.subject) && t.object.startsWith('_:') && !subjects.has(t.object)) { subjects.add(t.object); grew = true; }
      }
      triples = held.stated.filter(t => subjects.has(t.subject));
    }
    return triples.map(t => [term(t.subject), term(t.predicate), term(t.object)]).filter(parts => parts.every(p => p !== null)).map(parts => `${parts.join(' ')} .\n`).join('');
  }

  owner(profileId: string): string | undefined { return this.builtInIds.has(profileId) ? undefined : this.owners.get(profileId); }
  isBuiltIn(profileId: string): boolean { return this.builtInIds.has(profileId); }

  private parts(profile: unknown): { held: HeldProfile; templates: PJson[]; patterns: PJson[] } {
    if (typeof profile !== 'string' || profile === '') throw new ProfileServerError(400, 'Name the profile by its id in `profile`.');
    const held = this.dataset.get(profile);
    if (!held) throw new ProfileServerError(400, `No profile with id ${profile} is on this server. GET the server root for the ones that are, or add it.`);
    const doc = held.doc as Obj;
    const list = (v: Json | undefined) => (Array.isArray(v) ? v.filter(isObj) : []) as unknown as PJson[];
    // A deprecated template or pattern stays in the document so its IRI resolves, and judges nothing.
    const live = (all: PJson[]) => all.filter(p => p.deprecated !== true);
    return { held, templates: live(list(doc.templates)), patterns: live(list(doc.patterns)) };
  }

  /** The specification's /validate_templates: no comments means the statement validates. */
  async validateTemplates(statement: unknown, profile: unknown): Promise<{ comments: string[]; templates: string[]; skipped: string[] }> {
    await this.ready();
    const { templates } = this.parts(profile);
    const one = parsed(statement, 'statement');
    if (!isObj(one)) throw new ProfileServerError(400, '`statement` is one xAPI Statement, as a JSON object.');
    let r;
    try { r = validates(one as unknown as PJson, templates, { ...(this.options.statementById ? { statementById: this.options.statementById } : {}) }); }
    catch (e) { return { comments: [(e as Error).message], templates: [], skipped: [] }; }
    const comments = r.outcome === 'success' ? []
      : r.outcome === 'unmatched' ? ['The statement matches no statement template of this profile: no template\'s determining properties (verb, object activity type, context activity types, attachment usage types) all match it.']
        : r.findings.map(f => `${f.template}: ${f.location ? `rule at ${f.location}: ` : ''}${f.reason}`);
    return { comments, templates: r.templates, skipped: r.skipped };
  }

  /** The specification's /validate_patterns. */
  async validatePatterns(statements: unknown, profile: unknown): Promise<{ comments: string[]; pattern?: string }> {
    await this.ready();
    const { templates, patterns } = this.parts(profile);
    const many = parsed(statements, 'statements');
    if (!Array.isArray(many) || !many.every(isObj)) throw new ProfileServerError(400, '`statements` is an array of xAPI Statements.');
    if (many.length > MAX_PATTERN_STATEMENTS) throw new ProfileServerError(413, `Up to ${MAX_PATTERN_STATEMENTS} statements are checked in one request.`);
    let r;
    try { r = follows(many as unknown as PJson[], templates, patterns, { ...(this.options.statementById ? { statementById: this.options.statementById } : {}) }); }
    catch (e) { return { comments: [(e as Error).message] }; }
    return r.follows ? { comments: [], ...(r.pattern ? { pattern: r.pattern } : {}) } : { comments: r.reasons };
  }
}

/** What `resolve` found for an IRI. */
export interface Resolved {
  readonly kind: 'profile' | 'version' | 'concept' | 'template' | 'pattern';
  /** The version the answer is read from. */
  readonly held: HeldProfile;
  /** The JSON-LD to serve. */
  readonly body: { [key: string]: Json };
  /** True for a term its profile's current version no longer has, or marks deprecated. */
  readonly deprecated?: boolean;
}

function sizeOf(doc: unknown): number { try { return Buffer.byteLength(JSON.stringify(doc) ?? ''); } catch { return 0; } }

/** A POST variable that may arrive as JSON text (a form) or already as JSON (a JSON body). */
function parsed(value: unknown, name: string): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { throw new ProfileServerError(400, `\`${name}\` is not valid JSON.`); }
}

/** Why a document cannot be added as a profile, or undefined. Shape only: what a query or a validation would trip on. */
export function whyNotAddable(doc: unknown): string | undefined {
  if (!isObj(doc)) return 'A profile is a JSON object.';
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(doc)); } catch { return 'The profile is not serializable JSON.'; }
  if (size > MAX_PROFILE_BYTES) return `The profile is ${size} bytes; this server holds profiles of up to ${MAX_PROFILE_BYTES}.`;
  const iri = (v: unknown) => typeof v === 'string' && /^https?:\/\/[^\s<>"{}|\\^`]+$/i.test(v);
  if (!iri(doc.id)) return 'A profile needs an "id" that is an http(s) IRI.';
  const types = Array.isArray(doc.type) ? doc.type : [doc.type];
  if (!types.includes('Profile')) return 'A profile has "type": "Profile".';
  if (!Array.isArray(doc.versions) || doc.versions.length === 0 || !doc.versions.every(v => isObj(v) && iri(v.id)))
    return 'A profile needs "versions": an array of objects, each with an "id" that is an http(s) IRI.';
  if (doc.versions.some(v => (v as Obj).id === doc.id)) return 'A version\'s "id" is different from the profile\'s own.';
  for (const key of ['concepts', 'templates', 'patterns'] as const) {
    const v = doc[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every(e => isObj(e) && iri(e.id))) return `"${key}" is an array of objects, each with an "id" that is an http(s) IRI.`;
  }
  return undefined;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

type Body = Record<string, unknown>;

export interface WriteRouteOptions {
  /** `<bridge>/xapi/profiles`, where the server is mounted. */
  readonly base: string;
  /** Where the two routes are reached from outside, for the `retry` of an answer that was not kept. */
  readonly addTarget: string;
  readonly removeTarget: string;
  /**
   * How often one address may call the two routes, together. The limiter is made here from these
   * options, and applied before anything else: a request is counted before its signature is checked.
   */
  readonly limit: Pick<RateLimitOptions, 'windowMs' | 'limit'> & Partial<RateLimitOptions>;
  /** Who signed the request, and what they sent. */
  readonly verify: (body: unknown) => Promise<{ ok: true; callerDid: string; payload: Body } | { ok: false; status: number; error: string }>;
  /**
   * How many versions one signer adds in an hour. `admit` counts the addition it admits and says
   * when (`at`); `giveBack` returns that one count when the addition ends up not held, whatever
   * refused it.
   */
  readonly allowance?: {
    admit(signer: string): { ok: true; at: number } | { ok: false; retryAfterSeconds: number };
    giveBack(signer: string, at: number): void;
  };
  /** Read a profile from where it is published; throws a ProfileServerError when it cannot. */
  readonly fetchByUri: (uri: string) => Promise<unknown>;
  /** How the bridge sends an action's result (it adds the links that follow). Defaults to plain JSON. */
  readonly send?: (req: Request, res: Response, payload: Body, title: string) => void;
  /** What to answer for an error that is not this server's own. Defaults to a 500. */
  readonly serverError?: (res: Response, err: unknown) => void;
}

/**
 * The write side: POST /agent/xapi-profiles/add and /remove, both signed.
 *
 * add     a profile version by its contents (`profile`) or by where it is published (`uri`), held
 *         under the agent that added it, and only once its durable write is acknowledged.
 * remove  a profile (every version) or one version, by the agent that added it or the operator.
 *         What is recorded is the removal; the server stops answering once that is acknowledged.
 *
 * A write that was not kept is a 503, not ok, with nothing changed and where to send it again.
 */
export function mountProfileServerWrites(app: Express, server: ProfileServer, o: WriteRouteOptions): void {
  const send = o.send ?? ((_req, res, payload) => { res.json(payload); });
  const guard = rateLimit({ standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'too_many_requests' }, ...o.limit });
  const fail = (res: Response, err: unknown) => {
    if (err instanceof AdditionNotKept) { res.status(err.status).json(notKeptAnswer(err, o.addTarget)); return; }
    if (err instanceof RemovalNotKept) { res.status(err.status).json(notKeptAnswer(err, o.removeTarget)); return; }
    if (err instanceof WriteInDoubt) { res.status(err.status).json(inDoubtAnswer(err)); return; }
    if (err instanceof ProfileServerError) { res.status(err.status).json({ error: err.message }); return; }
    if (o.serverError) { o.serverError(res, err); return; }
    res.status(500).json({ error: 'The profile server could not answer.' });
  };

  app.post('/agent/xapi-profiles/add', guard, async (req, res) => {
    // Set once the signer's allowance has counted this request, and cleared once the version is held.
    let counted: { signer: string; at: number } | undefined;
    try {
      const auth = await o.verify(req.body);
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
      const admitted = o.allowance?.admit(auth.callerDid);
      if (admitted && !admitted.ok) {
        res.setHeader('Retry-After', String(admitted.retryAfterSeconds));
        res.status(429).json({ error: 'this signer has added as many profiles as one signer may in an hour; try again later', retryAfterSeconds: admitted.retryAfterSeconds });
        return;
      }
      if (admitted) counted = { signer: auth.callerDid, at: admitted.at };
      const p = auth.payload;
      if ((p.profile === undefined) === (p.uri === undefined)) throw new ProfileServerError(400, 'send the profile itself as `profile`, or where it is published as `uri` — one of the two');
      const uri = typeof p.uri === 'string' ? p.uri : undefined;
      const doc = uri !== undefined ? await o.fetchByUri(uri) : p.profile;
      const r = await server.add(doc as never, auth.callerDid, uri);
      counted = undefined;
      send(req, res, {
        ok: true, profile: r.held.id, version: r.held.version, replaced: r.replaced,
        current: server.dataset.get(r.held.id)?.version === r.held.version,
        triples: r.held.stated.length, addedBy: auth.callerDid,
        graph: r.held.version, document: `${o.base}/profile?iri=${encodeURIComponent(r.held.version)}`,
        sparql: `${o.base}/sparql`,
        validateTemplates: `${o.base}/validate_templates`,
        validatePatterns: `${o.base}/validate_patterns`,
        server: o.base,
        holonUri: r.holonUri ?? null, persisted: r.persisted,
      }, 'Profile added');
    } catch (err) {
      // In doubt, the version may yet be held: its count stays.
      if (err instanceof WriteInDoubt) counted = undefined;
      fail(res, err);
    } finally {
      // The allowance is for versions a signer adds. One that was refused, or not kept, added nothing.
      if (counted !== undefined) o.allowance?.giveBack(counted.signer, counted.at);
    }
  });

  app.post('/agent/xapi-profiles/remove', guard, async (req, res) => {
    try {
      const auth = await o.verify(req.body);
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
      const iri = typeof auth.payload.iri === 'string' ? auth.payload.iri : '';
      if (!iri) { res.status(400).json({ error: 'name the profile or the version to take down as `iri`' }); return; }
      const r = await server.remove(iri, auth.callerDid);
      send(req, res, { ok: true, removed: r.removed, persisted: r.persisted, server: o.base }, 'Profile taken down');
    } catch (err) { fail(res, err); }
  });
}

export interface ReadRouteOptions {
  /** `<bridge>/xapi/profiles`, where the server is mounted. */
  readonly base: string;
  readonly urlencoded: RequestHandler;
  readonly text: RequestHandler;
  /** Where the add and remove affordances are, for the index to point at. */
  readonly addTarget: string;
  readonly removeTarget: string;
}

const label = (doc: Json, key: 'prefLabel' | 'definition'): Json | undefined => isObj(doc) ? doc[key] : undefined;

/** The read side: the index, a profile's document, /sparql, /validate_templates and /validate_patterns. */
export function mountProfileServerReads(app: Express, server: ProfileServer, o: ReadRouteOptions): void {
  const open = (res: Response) => { res.setHeader('Access-Control-Allow-Origin', '*'); };
  const fail = (res: Response, e: unknown) => {
    if (e instanceof ProfileServerError) { res.status(e.status).json({ error: e.message, comments: [e.message] }); return; }
    if (e instanceof SparqlRefused) { res.status(400).json({ error: e.message }); return; }
    res.status(500).json({ error: 'The profile server could not answer.' });
  };
  const documentUrl = (iri: string) => `${o.base}/profile?iri=${encodeURIComponent(iri)}`;

  app.get('/xapi/profiles', async (_req, res) => {
    open(res);
    try {
      await server.ready();
      const current = new Set(server.dataset.current().map(h => h.version));
      res.json({
        '@id': o.base,
        type: 'xAPI Profile Server',
        conformsTo: 'https://github.com/adlnet/xapi-profiles/blob/master/xapi-profiles-communication.md#part-three',
        sparql: `${o.base}/sparql`,
        validateTemplates: `${o.base}/validate_templates`,
        validatePatterns: `${o.base}/validate_patterns`,
        add: o.addTarget,
        remove: o.removeTarget,
        profiles: server.dataset.all().map(h => ({
          id: h.id, version: h.version, current: current.has(h.version),
          ...(h.generatedAtTime ? { generatedAtTime: h.generatedAtTime } : {}),
          ...(label(h.doc, 'prefLabel') !== undefined ? { prefLabel: label(h.doc, 'prefLabel') } : {}),
          builtIn: server.isBuiltIn(h.id),
          ...(server.owner(h.id) ? { addedBy: server.owner(h.id) } : {}),
          document: documentUrl(h.version),
          graph: h.version,
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // The exact document a profile or a version was added as.
  app.get('/xapi/profiles/profile', async (req, res) => {
    open(res);
    try {
      await server.ready();
      const held = typeof req.query.iri === 'string' ? server.dataset.get(req.query.iri) : undefined;
      if (!held) { res.status(404).json({ error: 'No profile or version with that iri is held here.' }); return; }
      res.type('application/ld+json').send(JSON.stringify(held.doc, null, 2));
    } catch (e) { fail(res, e); }
  });

  const sparql = async (req: Request, res: Response) => {
    open(res);
    try {
      await server.ready();
      const body: unknown = req.body;
      const from = (name: string): string[] => {
        const q: unknown = req.query[name], b: unknown = isObj(body) ? body[name] : undefined;
        return [q, b].flatMap((v): unknown[] => Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((v): v is string => typeof v === 'string');
      };
      const query = typeof body === 'string' && body.trim() !== '' ? body
        : isObj(body) && typeof body.query === 'string' ? body.query
          : typeof req.query.query === 'string' ? req.query.query : '';
      if (!query) { res.status(400).json({ error: 'Send the query as `query` (GET, or a POSTed form or JSON), or as an application/sparql-query body.' }); return; }
      const answer = server.dataset.query(query, { defaultGraphUris: from('default-graph-uri'), namedGraphUris: from('named-graph-uri') });
      res.type('application/sparql-results+json').send(JSON.stringify(answer));
    } catch (e) { fail(res, e); }
  };
  app.get('/xapi/profiles/sparql', sparql);
  app.post('/xapi/profiles/sparql', o.urlencoded, o.text, sparql);

  app.post('/xapi/profiles/validate_templates', o.urlencoded, async (req, res) => {
    open(res);
    try {
      const body = isObj(req.body) ? req.body : {};
      const r = await server.validateTemplates(body.statement, body.profile);
      if (r.comments.length === 0) { res.status(204).end(); return; }
      res.status(400).json({ valid: false, comments: r.comments, ...(r.skipped.length ? { notChecked: r.skipped } : {}) });
    } catch (e) { fail(res, e); }
  });

  app.post('/xapi/profiles/validate_patterns', o.urlencoded, async (req, res) => {
    open(res);
    try {
      const body = isObj(req.body) ? req.body : {};
      const r = await server.validatePatterns(body.statements, body.profile);
      if (r.comments.length === 0) { res.status(204).end(); return; }
      res.status(400).json({ valid: false, comments: r.comments });
    } catch (e) { fail(res, e); }
  });
}
