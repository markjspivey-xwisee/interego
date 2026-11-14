/** Mulberry32. Same seed, same stream, so a pack's opening position does not drift between processes. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function pick<T>(items: readonly T[], rng: () => number): T {
  if (items.length === 0) throw new Error('nothing to pick');
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('nothing to pick');
  return item;
}
