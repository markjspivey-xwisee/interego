/**
 * The compositions a person or an agent has made, and the ones they have played: what a learner's
 * portal lists, and what an agent asks for before it launches anything.
 *
 * ★ READ FROM WHAT IS ALREADY KEPT. Nothing new is stored to answer this.
 * - Playing is read from the learner's own record: each step of a play is an `experienced`
 *   statement grouped under the composition it came from, and a finished play ends with a
 *   `completed` statement about the composition, with its score (composition-play.ts).
 * - Authoring is read from the index of where content lives, which names each item's author and
 *   is kept on the tenant pod. An authoring act also records an `authored` statement about the
 *   composition it made, the root of a folded course included but not the lessons inside it; where
 *   one is still at hand, the composition is marked as a root.
 *
 * ★ A COMPOSITION IS NAMED BY ITS HASH. The IRIs in a record carry the authority that minted them,
 * which need not be this bridge's (a local bridge mints content under the production base, say), so
 * each composition is named here by this bridge's IRI for its hash.
 */
import type { StoredStatement } from './statement-store.js';
import type { ContentLocation } from './content-store.js';
import { compositionIri, contentRefOf } from './content-fragments.js';
import { AUTHORED_VERB } from './learner-record.js';
import { PLAY_EXT, PLAY_TYPES } from './composition-play.js';

const ADL_COMPLETED = 'http://adlnet.gov/expapi/verbs/completed';
const ADL_EXPERIENCED = 'http://adlnet.gov/expapi/verbs/experienced';

export interface AuthoredComposition {
  iri: string;
  title?: string;
  /** When the authoring act was recorded, where that record is at hand. */
  at?: string;
  /** Made as a whole (a composition authored, or a folded course's root), not only held inside one. */
  root?: true;
}

export interface PlayedComposition {
  iri: string;
  title?: string;
  /** The last step taken. */
  at: string;
  finished: boolean;
  /** The score of the latest finished play, when it had graded questions. */
  score?: { raw: number; max: number };
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' ? x as Obj : {});
const nameOf = (o: Obj): string | undefined => {
  const name = obj(obj(o.definition).name);
  const first = Object.values(name).find(v => typeof v === 'string');
  return typeof first === 'string' ? first : undefined;
};
/** This bridge's IRI for a composition named anywhere, or undefined for anything else. */
const ours = (iri: unknown): string | undefined => {
  const ref = contentRefOf(iri);
  return ref?.type === 'composition' ? compositionIri(ref.hash) : undefined;
};

/** The compositions an author has made, newest first where that is known, at most `limit`. */
export function authoredCompositions(statements: readonly StoredStatement[], locations: ReadonlyMap<string, readonly ContentLocation[]>,
  authorDid: string, limit: number): AuthoredComposition[] {
  const found = new Map<string, AuthoredComposition>();
  // The index first, in the order it was written: the latest last.
  for (const [key, held] of locations) {
    if (!key.startsWith('composition:') || !held.some(l => l.did === authorDid)) continue;
    const iri = compositionIri(key.slice('composition:'.length));
    found.delete(iri);
    found.set(iri, { iri });
  }
  const listed = [...found.values()].reverse();
  // What the author's record still says about an authoring act: when, under what title, and that it made the whole.
  for (const rec of statements) {
    if (rec.voided) continue;
    const s = rec.statement;
    if (obj(s.verb).id !== AUTHORED_VERB) continue;
    const o = obj(s.object);
    if (obj(o.definition).type !== PLAY_TYPES.composition) continue;
    const iri = ours(o.id);
    if (!iri) continue;
    const entry = found.get(iri);
    if (!entry) continue;   // only what the index holds as theirs
    const at = typeof s.timestamp === 'string' ? s.timestamp : rec.stored;
    entry.root = true;
    if (!entry.at || at > entry.at) { entry.at = at; const title = nameOf(o); if (title) entry.title = title; }
  }
  // Roots with a known time first, newest first; then everything else in index order, newest first.
  const dated = listed.filter(c => c.at).sort((a, b) => (a.at! < b.at! ? 1 : a.at! > b.at! ? -1 : 0));
  return [...dated, ...listed.filter(c => !c.at)].slice(0, limit);
}

/** The compositions a learner has played, the last played first, at most `limit`. */
export function playedCompositions(statements: readonly StoredStatement[], limit: number): PlayedComposition[] {
  const played = new Map<string, PlayedComposition & { scoredAt?: string }>();
  const touch = (iri: string, at: string): PlayedComposition & { scoredAt?: string } => {
    const entry = played.get(iri) ?? { iri, at, finished: false };
    if (at > entry.at) entry.at = at;
    played.set(iri, entry);
    return entry;
  };
  for (const rec of statements) {
    if (rec.voided) continue;
    const s = rec.statement;
    const ctx = obj(s.context);
    if (obj(ctx.extensions)[PLAY_EXT.contextKind] !== 'training') continue;
    const at = typeof s.timestamp === 'string' ? s.timestamp : rec.stored;
    const verb = obj(s.verb).id;
    const o = obj(s.object);
    if (verb === ADL_COMPLETED && obj(o.definition).type === PLAY_TYPES.composition) {
      const iri = ours(o.id);
      if (!iri) continue;
      const entry = touch(iri, at);
      entry.finished = true;
      const title = nameOf(o);
      if (title) entry.title = title;
      const score = obj(obj(s.result).score);
      if (typeof score.raw === 'number' && typeof score.max === 'number' && (!entry.scoredAt || at >= entry.scoredAt)) {
        entry.score = { raw: score.raw, max: score.max };
        entry.scoredAt = at;
      }
      continue;
    }
    if (verb !== ADL_EXPERIENCED) continue;
    // A step names its root composition first among its groupings, or as its parent when it has none.
    const activities = obj(ctx.contextActivities);
    const grouping = Array.isArray(activities.grouping) ? activities.grouping : [];
    const parent = Array.isArray(activities.parent) ? activities.parent : [];
    const iri = ours(obj(grouping[0] ?? parent[0]).id);
    if (iri) touch(iri, at);
  }
  return [...played.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)
    .map(({ scoredAt: _scoredAt, ...entry }) => entry);
}
