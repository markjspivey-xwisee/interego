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
