// Editorial health checks over the embedded I2IDL release (shared by Insights and the editorial packet).
import { C, byId } from "./data.js";

let cached = null;
export function health() {
  if (cached) return cached;
  const isolated = C.filter((c) => c.r.length === 0 && c.b.length === 0 && c.n.length === 0);
  const noRelated = C.filter((c) => c.r.length === 0);
  const synth = C.filter((c) => c.pv === "s");
  const single = C.filter((c) => c.ev.length === 1);
  const asym = C.flatMap((c) => c.r.filter((x) => !byId.get(x).r.includes(c.id)).map((x) => [c.id, x]));
  const inv = C.flatMap((c) => c.b.filter((x) => !byId.get(x).n.includes(c.id)).map((x) => [c.id, x]));
  const m = new Map();
  for (const c of C) for (const a of [c.l, ...c.a]) { const k = a.toLowerCase(); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(c.id); }
  const altClash = [...m.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => ({ form: k, ids: [...s] }));
  const adapted = C.filter((c) => c.ev.some((e) => e.an));
  cached = { isolated, noRelated, synth, single, asym, inv, altClash, adapted };
  return cached;
}
