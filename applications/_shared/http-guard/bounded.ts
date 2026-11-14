/**
 * A ceiling for a table that callers fill before anyone has verified them.
 */

/** Drop the oldest entries until the map holds at most `max`. A Map keeps insertion order. */
export function bound<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
}
