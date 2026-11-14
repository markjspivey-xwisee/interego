/**
 * Ceilings for the tables callers fill before anyone has verified them.
 */

/** The most pending sign-in challenges, and the most sessions, one process keeps. */
export const MAX_CHALLENGES = 5_000;
export const MAX_SESSIONS = 5_000;

/** Drop the oldest entries until the map holds at most `max`. A Map keeps insertion order. */
export function bound<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
}

/**
 * How much history one process keeps. A filler consultant settles a mission every few seconds
 * for as long as the process runs, so every list that records what happened has a ceiling and
 * drops its oldest rows first. The current head of each territory, pact and agent is held apart
 * from these lists, so a superseding descriptor still names the one it replaces after that one
 * has been dropped: the reference is an IRI, and it stays a valid one.
 */
export const MAX_PUBLISHED_GRAPHS = 2_000;
/** Per origin: the world's own statements and the ones read from outside each keep this many. */
export const MAX_STATEMENTS = 2_000;
/** The newest lessons one agent's descriptor carries, and the newest scores kept for it. */
export const MAX_AGENT_LESSONS = 100;
export const MAX_AGENT_SCORES = 500;
/** The most consultants one world admits. Past it the world answers `world-full`. */
export const MAX_CONSULTANTS = 5_000;
/** The most guests the in-process door keeps an anchor for at one time. */
export const MAX_LOCAL_GUESTS = 1_000;
/** The most (limit, client) windows the rate limiter remembers. */
export const MAX_RATE_CLIENTS = 20_000;

/** Drop from the front of a list until it holds at most `max`. Returns how many went. */
export function trim<T>(list: T[], max: number): number {
  const over = list.length - max;
  if (over <= 0) return 0;
  list.splice(0, over);
  return over;
}
