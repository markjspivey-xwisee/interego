/**
 * Writing an xAPI Profile here: a draft, a lint, and a publication.
 *
 *   draft     one per profile IRI, held under the agent that opened it. Edited whole (a document) or
 *             in parts (metadata, concepts, statement templates, patterns, examples), in xAPI
 *             Profiles 1.0 JSON-LD throughout.
 *   lint      ./lint.ts over the document that WOULD be published, so the writer is told about the
 *             version as it will stand, deprecations included.
 *   publish   only with no findings. The version's `generatedAtTime` is the moment of publication,
 *             set here and never again; it revises the version before it; and what the earlier
 *             version had that the draft leaves out is carried into the new one marked deprecated,
 *             so every IRI ever published still resolves.
 *
 * ★ A DRAFT IS WORKING STATE AND IS KEPT IN MEMORY UNLESS A STORE IS GIVEN. The lattice the
 * published versions live in is append-only and public: keeping every keystroke of a draft there
 * would fill it with documents nobody published. Every answer about a draft carries the whole
 * draft, so a writer who keeps the answer can send it back as `document` and `examples`.
 *
 * ★ EXAMPLES BECOME PUBLIC AT PUBLICATION. While a draft is open its examples are its writer's.
 * Once the version is published they are kept in the public lattice with it and served to anyone
 * at `GET /xapi/profiles/examples?iri=<version>` (./authoring-http.ts). The draft and publish
 * affordances and every draft answer say so, because an example statement is easily copied from a
 * real one, actor and all.
 */
import { lintProfile, emptyExamples, type ExampleSequence, type ExampleStatement, type ExternalTerm, type LintFinding, type ProfileExamples } from './lint.js';
import { MAX_PROFILE_BYTES, ProfileServerError, whyNotAddable, type ProfileServer } from './service.js';
import type { HeldProfile } from './dataset.js';
import type { Json } from './rdf.js';
import type { Json as PJson } from './processor.js';

type Obj = { [key: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isHttpIri = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\/[^\s<>"{}|\\^`]+$/i.test(v);
const sizeOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '');

export const MAX_EXAMPLE_BYTES = 512 * 1024;
export const MAX_DRAFTS_PER_AGENT = 10;
/** Any wallet can open a draft, and each is up to 768 KB in memory: this bounds the total near 77 MB. */
export const MAX_DRAFTS = 100;
const PARTS = ['concepts', 'templates', 'patterns'] as const;
type Part = typeof PARTS[number];
const DEFAULT_TYPE: Record<Part, string | undefined> = { concepts: undefined, templates: 'StatementTemplate', patterns: 'Pattern' };
const METADATA = ['prefLabel', 'definition', 'seeAlso', 'author', 'conformsTo', '@context'] as const;

export interface Draft {
  /** The profile IRI. */
  profile: string;
  /** The IRI of the version being written. */
  version: string;
  /** The version this one revises, when the profile already has a published or added version here. */
  revises?: string;
  /** The document as written: `versions` holds this version only until publication. */
  document: Obj;
  examples: ProfileExamples;
  external: ExternalTerm[];
  by: string;
  updatedAt: string;
}

/** One edit of a draft. Everything but `profile` is optional; with nothing else, the draft is read. */
export interface DraftEdit {
  profile?: unknown;
  /** Set or change the IRI of the version being written. */
  version?: unknown;
  /** Replace the whole document. */
  document?: unknown;
  /** Profile metadata to set: prefLabel, definition, seeAlso, author, conformsTo. */
  set?: unknown;
  /** Concepts, templates and patterns to add, or to replace by id. */
  put?: unknown;
  /** Ids to take out: of concepts, templates, patterns, example statements or example sequences. */
  remove?: unknown;
  /** Example statements and sequences to add, or to replace by id. With `replace: true`, all of them. */
  examples?: unknown;
  /** Terms other publishers define that this profile's templates name. Replaces the list. */
  external?: unknown;
  /** Throw the draft away. */
  discard?: unknown;
}

export interface DraftStore {
  load(): Promise<Draft[]>;
  save(draft: Draft): Promise<void>;
  drop(profile: string): Promise<void>;
}

export interface AuthoringOptions {
  /** The moment of publication. A test passes a fixed one. */
  readonly now?: () => Date;
  readonly store?: DraftStore;
  /**
   * The address profiles written here are hosted under (`<bridge>/xapi/profiles/p/`). A profile
   * whose IRI is on this deployment's own origin has to be under it: nothing else there is a
   * profile's to claim.
   */
  readonly hostedUnder?: string;
}

export interface DraftView { draft: Draft; findings: LintFinding[]; publishable: boolean; wouldPublish: Obj }

export class LintRefused extends ProfileServerError {
  constructor(readonly findings: LintFinding[]) { super(422, `The draft has ${findings.length} finding(s). A version is published when it has none.`); }
}

export class ProfileAuthoring {
  private readonly drafts = new Map<string, Draft>();
  private loaded: Promise<void> | undefined;

  constructor(private readonly server: ProfileServer, private readonly options: AuthoringOptions = {}) {}

  private ready(): Promise<void> {
    return this.loaded ??= (async () => {
      await this.server.ready();
      for (const d of (await this.options.store?.load()) ?? []) this.drafts.set(d.profile, d);
    })().catch(e => { this.loaded = undefined; throw e; });
  }

  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  /** The draft of a profile, for its writer. */
  private mine(profile: unknown, by: string, mustExist: boolean): Draft | undefined {
    if (!isHttpIri(profile)) throw new ProfileServerError(400, 'Name the profile by its IRI in `profile`: an http(s) IRI.');
    if (this.server.isBuiltIn(profile)) throw new ProfileServerError(409, `${profile} is this deployment's own profile and is written in its code.`);
    const owner = this.server.owner(profile);
    if (owner && owner !== by) throw new ProfileServerError(409, `${profile} was added by another agent, and only that agent writes versions of it.`);
    const draft = this.drafts.get(profile);
    if (draft && draft.by !== by) throw new ProfileServerError(409, `Another agent has a draft of ${profile} open.`);
    if (!draft && mustExist) throw new ProfileServerError(404, `You have no draft of ${profile}. Open one with the draft affordance.`);
    return draft;
  }

  /** A fresh draft: revising what is held, or empty. */
  private open(profile: string, by: string): Draft {
    const mineSoFar = [...this.drafts.values()].filter(d => d.by === by).length;
    if (mineSoFar >= MAX_DRAFTS_PER_AGENT) throw new ProfileServerError(429, `One agent has up to ${MAX_DRAFTS_PER_AGENT} drafts open. Publish or discard one.`);
    if (this.drafts.size >= MAX_DRAFTS) throw new ProfileServerError(507, 'This server holds as many drafts as it can.');
    const hosted = this.options.hostedUnder;
    if (hosted) {
      const origin = new URL(hosted).origin;
      if (profile.startsWith(`${origin}/`) && !(profile.startsWith(hosted) && profile.length > hosted.length))
        throw new ProfileServerError(400, `A profile written here with an IRI on this deployment is under ${hosted}, such as ${hosted}my-profile. An IRI on your own domain is also accepted.`);
    }
    const held = this.server.dataset.get(profile);
    const base: Draft = { profile, version: '', document: {}, examples: emptyExamples(), external: [], by, updatedAt: this.now() };
    if (!held) {
      base.version = `${profile}/v/1`;
      base.document = { '@context': 'https://w3id.org/xapi/profiles/context', id: profile, type: 'Profile', conformsTo: 'https://w3id.org/xapi/profiles#1.0',
        versions: [{ id: base.version }], concepts: [], templates: [], patterns: [] };
      return base;
    }
    // Revising: start from the current version, as it stands, in a new version.
    const taken = new Set(this.server.dataset.all().map(h => h.version));
    let n = this.server.dataset.all().filter(h => h.id === profile).length + 1;
    while (taken.has(`${profile}/v/${n}`)) n++;
    base.version = `${profile}/v/${n}`;
    base.revises = held.version;
    base.document = { ...copy(held.doc as Obj), versions: [{ id: base.version }] };
    for (const key of PARTS) {
      const parts = base.document[key];
      if (Array.isArray(parts)) base.document[key] = parts.map(p => isObj(p) && p.inScheme === held.version ? { ...p, inScheme: base.version } : p);
    }
    const before = this.server.published(held.version);
    if (before) { base.examples = copy(before.examples); base.external = copy(before.external); }
    return base;
  }

  private reversion(draft: Draft, version: unknown): void {
    if (!isHttpIri(version)) throw new ProfileServerError(400, '`version` is the http(s) IRI of the version being written.');
    if (version === draft.profile) throw new ProfileServerError(400, 'A version has an IRI of its own, different from the profile\'s.');
    if (version === draft.version) return;
    for (const key of PARTS) {
      const parts = draft.document[key];
      if (Array.isArray(parts)) draft.document[key] = parts.map(p => isObj(p) && p.inScheme === draft.version ? { ...p, inScheme: version } : p);
    }
    const others = (Array.isArray(draft.document.versions) ? draft.document.versions : []).filter(v => isObj(v) && v.id !== draft.version && v.id !== version);
    draft.version = version;
    draft.document.versions = [{ id: version }, ...others];
  }

  private apply(draft: Draft, edit: DraftEdit): void {
    if (edit.document !== undefined) {
      const doc = edit.document;
      if (!isObj(doc)) throw new ProfileServerError(400, '`document` is the profile as a JSON object.');
      if (doc.id !== undefined && doc.id !== draft.profile) throw new ProfileServerError(400, `The document's id is ${JSON.stringify(doc.id)} and the draft is of ${draft.profile}.`);
      const first = Array.isArray(doc.versions) && isObj(doc.versions[0]) ? doc.versions[0].id : undefined;
      draft.document = { ...copy(doc), id: draft.profile };
      // A document that says which version it is is taken at its word, unless that version is already held.
      const version = isHttpIri(first) && !this.server.dataset.all().some(h => h.version === first || h.id === first) ? first : draft.version;
      // Its parts are in the version it names; they move with it if the draft is of another.
      draft.version = typeof first === 'string' ? first : '';
      this.reversion(draft, version);
    }
    if (edit.version !== undefined) this.reversion(draft, edit.version);
    if (edit.set !== undefined) {
      if (!isObj(edit.set)) throw new ProfileServerError(400, '`set` is an object of profile metadata: prefLabel, definition, seeAlso, author, conformsTo.');
      for (const [key, value] of Object.entries(edit.set)) {
        if (!(METADATA as readonly string[]).includes(key)) throw new ProfileServerError(400, `\`set\` takes ${METADATA.join(', ')}. Concepts, templates and patterns go in \`put\`; the version in \`version\`.`);
        if (value === null) delete draft.document[key]; else draft.document[key] = copy(value);
      }
    }
    if (edit.put !== undefined) {
      if (!isObj(edit.put)) throw new ProfileServerError(400, '`put` is { concepts?: [...], templates?: [...], patterns?: [...] }.');
      for (const [key, given] of Object.entries(edit.put)) {
        if (!(PARTS as readonly string[]).includes(key)) throw new ProfileServerError(400, '`put` takes concepts, templates and patterns.');
        if (!Array.isArray(given) || !given.every(g => isObj(g) && isHttpIri(g.id))) throw new ProfileServerError(400, `\`put.${key}\` is an array of objects, each with an "id" that is an http(s) IRI.`);
        const part = key as Part;
        const existing = Array.isArray(draft.document[part]) ? [...(draft.document[part] as Json[])] : [];
        for (const g of given as Obj[]) {
          const term: Obj = { ...copy(g), ...(g.type === undefined && DEFAULT_TYPE[part] ? { type: DEFAULT_TYPE[part]! } : {}), inScheme: draft.version };
          const at = existing.findIndex(e => isObj(e) && e.id === term.id);
          if (at >= 0) existing[at] = term; else existing.push(term);
        }
        draft.document[part] = existing;
      }
    }
    if (edit.examples !== undefined) {
      if (!isObj(edit.examples)) throw new ProfileServerError(400, '`examples` is { statements?: [...], sequences?: [...], replace?: true }.');
      if (edit.examples.replace === true) draft.examples = emptyExamples();
      const taken = new Set([...draft.examples.statements, ...draft.examples.sequences].map(e => e.id));
      const idFor = (given: Json | undefined, stem: string): string => {
        if (typeof given === 'string' && given !== '') return given;
        let n = 1; while (taken.has(`${stem}-${n}`)) n++;
        taken.add(`${stem}-${n}`); return `${stem}-${n}`;
      };
      const statements = edit.examples.statements ?? [], sequences = edit.examples.sequences ?? [];
      if (!Array.isArray(statements) || !Array.isArray(sequences)) throw new ProfileServerError(400, '`examples.statements` and `examples.sequences` are arrays.');
      for (const s of statements) {
        if (!isObj(s) || !isObj(s.statement)) throw new ProfileServerError(400, 'An example statement is { follows: [<template IRI>, …], statement: { …an xAPI Statement… }, id?: "…" }.');
        const follows = (Array.isArray(s.follows) ? s.follows : s.follows === undefined ? [] : [s.follows]).filter((f): f is string => typeof f === 'string');
        const example: ExampleStatement = { id: idFor(s.id, 'statement'), follows, statement: copy(s.statement) as unknown as PJson };
        const at = draft.examples.statements.findIndex(e => e.id === example.id);
        if (at >= 0) draft.examples.statements[at] = example; else draft.examples.statements.push(example);
      }
      for (const s of sequences) {
        if (!isObj(s) || typeof s.pattern !== 'string' || !Array.isArray(s.statements)) throw new ProfileServerError(400, 'An example sequence is { pattern: <pattern IRI>, statements: [ …statements, or ids of example statements… ], id?: "…" }.');
        const example: ExampleSequence = { id: idFor(s.id, 'sequence'), pattern: s.pattern, statements: copy(s.statements) as unknown as Array<PJson | string> };
        const at = draft.examples.sequences.findIndex(e => e.id === example.id);
        if (at >= 0) draft.examples.sequences[at] = example; else draft.examples.sequences.push(example);
      }
    }
    if (edit.external !== undefined) {
      if (!Array.isArray(edit.external) || !edit.external.every(e => isObj(e) && isHttpIri(e.id) && typeof e.type === 'string'))
        throw new ProfileServerError(400, '`external` is an array of { id: <IRI>, type: "Verb" | "ActivityType" | "AttachmentUsageType" | "ContextExtension" | "ResultExtension" | "ActivityExtension" }.');
      draft.external = (edit.external as Obj[]).map(e => ({ id: e.id as string, type: e.type as string }));
    }
    if (edit.remove !== undefined) {
      if (!Array.isArray(edit.remove) || !edit.remove.every(r => typeof r === 'string')) throw new ProfileServerError(400, '`remove` is an array of ids.');
      const gone = new Set(edit.remove as string[]);
      for (const key of PARTS) { const parts = draft.document[key]; if (Array.isArray(parts)) draft.document[key] = parts.filter(p => !(isObj(p) && typeof p.id === 'string' && gone.has(p.id))); }
      draft.examples.statements = draft.examples.statements.filter(e => !gone.has(e.id));
      draft.examples.sequences = draft.examples.sequences.filter(e => !gone.has(e.id));
    }
    if (sizeOf(draft.document) > MAX_PROFILE_BYTES) throw new ProfileServerError(413, `A profile document is up to ${MAX_PROFILE_BYTES} bytes.`);
    if (sizeOf(draft.examples) > MAX_EXAMPLE_BYTES) throw new ProfileServerError(413, `The examples kept with a profile are up to ${MAX_EXAMPLE_BYTES} bytes.`);
  }

  /**
   * The document a draft would be published as, short of its time: this version at the head of
   * `versions`, revising the one before, and every part the earlier version had that the draft
   * leaves out carried forward as deprecated.
   */
  private candidate(draft: Draft, generatedAtTime?: string): { doc: Obj; previous?: HeldProfile } {
    const previous = this.server.dataset.get(draft.profile);
    const doc = copy(draft.document);
    const earlier = previous ? (Array.isArray((previous.doc as Obj).versions) ? (previous.doc as Obj).versions as Json[] : [])
      : (Array.isArray(doc.versions) ? doc.versions : []).filter(v => isObj(v) && v.id !== draft.version);
    doc.versions = [{ id: draft.version, ...(generatedAtTime ? { generatedAtTime } : {}), ...(previous ? { wasRevisionOf: [previous.version] } : {}) }, ...copy(earlier)];
    if (previous) {
      for (const key of PARTS) {
        const now = Array.isArray(doc[key]) ? doc[key] as Json[] : [];
        const have = new Set(now.filter(isObj).map(p => p.id));
        const before = (previous.doc as Obj)[key];
        const dropped = (Array.isArray(before) ? before : []).filter((p): p is Obj => isObj(p) && !have.has(p.id));
        doc[key] = [...now, ...dropped.map(p => ({ ...copy(p), inScheme: draft.version, deprecated: true }))];
      }
    }
    return { doc, ...(previous ? { previous } : {}) };
  }

  private view(draft: Draft): DraftView {
    const { doc } = this.candidate(draft);
    const findings = this.lintDocument(doc, draft.examples, draft.external, draft.version, draft.profile);
    return { draft, findings, publishable: findings.length === 0, wouldPublish: doc };
  }

  /** Lint any document with its examples, as a draft of it would be linted. */
  lintDocument(doc: unknown, examples: ProfileExamples = emptyExamples(), external: readonly ExternalTerm[] = [], version?: string, profile?: string): LintFinding[] {
    const shape = whyNotAddable(doc);
    const vouched = new Map(external.map(e => [e.id, e.type]));
    const except = profile ?? (isObj(doc) && typeof doc.id === 'string' ? doc.id : undefined);
    const findings = lintProfile(doc, examples, { ...(version ? { version } : {}), external: iri => vouched.get(iri) ?? this.server.knownTerm(iri, except) });
    // What the server would refuse on the way in is a finding too, once, if nothing above already says it.
    if (shape && findings.length === 0) findings.push({ code: 'profile-shape', at: 'profile', path: '', message: shape, fix: 'Correct the document as the message says.' });
    return findings;
  }

  /** Open, read, edit or discard a draft. */
  async edit(edit: DraftEdit, by: string): Promise<DraftView | { discarded: string }> {
    await this.ready();
    const existing = this.mine(edit.profile, by, false);
    const profile = edit.profile as string;
    if (edit.discard === true) {
      if (existing) { this.drafts.delete(profile); await this.options.store?.drop(profile); }
      return { discarded: profile };
    }
    // Edits are made on a copy, so one that is refused leaves the draft as it was.
    const draft = existing ? copy(existing) : this.open(profile, by);
    this.apply(draft, edit);
    draft.updatedAt = this.now();
    this.drafts.set(profile, draft);
    await this.options.store?.save(draft);
    return this.view(draft);
  }

  /** Lint your draft of a profile. */
  async lint(profile: unknown, by: string): Promise<DraftView> {
    await this.ready();
    return this.view(this.mine(profile, by, true)!);
  }

  /** The drafts an agent has open. */
  async draftsOf(by: string): Promise<Array<{ profile: string; version: string; updatedAt: string }>> {
    await this.ready();
    return [...this.drafts.values()].filter(d => d.by === by).map(d => ({ profile: d.profile, version: d.version, updatedAt: d.updatedAt }));
  }

  /**
   * Publish a draft as a version. Refused, with the findings, unless the lint has none.
   *
   * The draft is closed only after the server has kept the version durably. When that write does
   * not land, `server.publish` throws PublicationNotKept before anything below it runs: the draft
   * stays in the map and in the store exactly as it was, and publishing it again is the retry.
   */
  async publish(profile: unknown, by: string): Promise<{ held: HeldProfile; generatedAtTime: string; revises?: string; deprecated: string[]; holonUri?: string; persisted: true }> {
    await this.ready();
    const draft = this.mine(profile, by, true)!;
    const at = this.now();
    const { doc, previous } = this.candidate(draft, at);
    const findings = this.lintDocument(doc, draft.examples, draft.external, draft.version, draft.profile);
    if (findings.length > 0) throw new LintRefused(findings);
    const r = await this.server.publish(doc, copy(draft.examples), copy(draft.external), by, at);
    // Kept durably: a publication that was not kept threw above, and `r.persisted` is `true` by its type.
    this.drafts.delete(draft.profile);
    // The version is published whether or not the stored draft could be dropped. A draft left in the
    // store is read back at the next start as a draft of a version already held, which cannot be
    // published twice; failing the request here would tell the writer a kept publication had failed.
    try { await this.options.store?.drop(draft.profile); } catch { /* see above */ }
    const deprecated = PARTS.flatMap(key => (Array.isArray(doc[key]) ? doc[key] as Json[] : []).filter((p): p is Obj => isObj(p) && p.deprecated === true).map(p => String(p.id)));
    return { held: r.held, generatedAtTime: at, ...(previous ? { revises: previous.version } : {}), deprecated, ...(r.holonUri ? { holonUri: r.holonUri } : {}), persisted: r.persisted };
  }
}
