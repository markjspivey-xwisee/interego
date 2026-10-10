// Ranked, typo-tolerant search over labels, alternate labels, definitions and editorial notes.
import { C } from "./data.js";

export const norm = (s) =>
  (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘]/g, "'")
    .toLowerCase();
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

const IDX = C.map((c) => {
  const label = norm(c.l);
  const alts = c.a.map(norm);
  const lt = tokens(c.l);
  const at = c.a.flatMap(tokens);
  return {
    c, label, alts, lt, at, all: new Set([...lt, ...at]),
    def: norm(c.d), defT: new Set(tokens(c.d)), expl: norm(c.x), explT: new Set(tokens(c.x)),
    initials: lt.filter((t) => !["and", "of", "the", "for", "in", "a", "to"].includes(t)).map((t) => t[0]).join(""),
  };
});

function edits(a, b, max) {
  // Damerau-Levenshtein (optimal string alignment) with an early exit
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const fuzzyHit = (q, set) => {
  if (q.length < 4) return false;
  const max = q.length >= 8 ? 2 : 1;
  for (const t of set) if (Math.abs(t.length - q.length) <= max && edits(q, t, max) <= max) return true;
  return false;
};
const prefixHit = (q, set) => {
  for (const t of set) if (t.startsWith(q)) return true;
  return false;
};

/** → [{c, score, why}] best first. why: "label" | "alt" | "definition" | "note" | "fuzzy" */
export function search(query, limit = 50) {
  const q = norm(query).trim();
  if (!q) return [];
  const qt = tokens(q);
  const out = [];
  for (const x of IDX) {
    let s = 0, why = "label";
    if (x.label === q) s = 1000;
    else if (x.alts.includes(q)) { s = 950; why = "alt"; }
    else if (x.label.startsWith(q)) s = 820 - Math.min(60, x.label.length - q.length);
    else if (x.alts.some((a) => a.startsWith(q))) { s = 760; why = "alt"; }
    else if (qt.length > 1 && x.initials === q.replace(/[^a-z0-9]/g, "")) s = 720;
    else if (q.length >= 2 && x.initials === q && q.length >= 3) s = 700;
    else if (x.label.includes(q)) s = 640 - Math.min(80, x.label.indexOf(q));
    else if (x.alts.some((a) => a.includes(q))) { s = 600; why = "alt"; }
    else if (qt.length && qt.every((t) => prefixHit(t, x.all))) {
      s = 520 + qt.filter((t) => prefixHit(t, new Set(x.lt))).length * 12;
      why = qt.some((t) => prefixHit(t, new Set(x.lt))) ? "label" : "alt";
    } else if (q.length >= 3 && x.def.includes(q)) { s = 380; why = "definition"; }
    else if (qt.length && qt.every((t) => prefixHit(t, x.all) || x.defT.has(t))) { s = 330; why = "definition"; }
    else if (qt.length && qt.every((t) => prefixHit(t, x.all) || fuzzyHit(t, x.all))) { s = 300; why = "fuzzy"; }
    else if (q.length >= 4 && x.expl.includes(q)) { s = 240; why = "note"; }
    else if (qt.length && qt.every((t) => x.defT.has(t) || x.explT.has(t) || prefixHit(t, x.all))) { s = 200; why = "definition"; }
    if (s) out.push({ c: x.c, score: s + Math.min(20, x.c.r.length) / 10, why });
  }
  out.sort((a, b) => b.score - a.score || a.c.l.localeCompare(b.c.l));
  return out.slice(0, limit);
}

/** Split text into [{t, hit}] runs highlighting the query's tokens (prefix matches). */
// Normalize one character at a time so indexes stay aligned with the original text ("…" would become "...").
const normKeep = (text) => Array.from(text).map((ch) => { const n = norm(ch); return n.length === ch.length ? n : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch; }).join("");

export function highlight(text, query) {
  const qt = tokens(query).filter((t) => t.length >= 2);
  if (!qt.length || !text) return [{ t: text || "", hit: false }];
  const n = normKeep(text);
  const marks = new Array(text.length).fill(false);
  for (const t of qt) {
    let i = 0;
    while ((i = n.indexOf(t, i)) !== -1) {
      const prev = i === 0 ? " " : n[i - 1];
      if (!/[a-z0-9]/.test(prev)) for (let k = i; k < i + t.length && k < marks.length; k++) marks[k] = true;
      i += t.length;
    }
  }
  const runs = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.hit === marks[i]) last.t += text[i];
    else runs.push({ t: text[i], hit: marks[i] });
  }
  return runs;
}

/** A short snippet of the definition around the first query hit. */
export function snippet(text, query, len = 120) {
  const n = normKeep(text);
  const qt = tokens(query).filter((t) => t.length >= 3);
  let at = -1;
  for (const t of qt) { const i = n.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
  if (at <= 40) return text.length > len ? text.slice(0, len).replace(/\s+\S*$/, "") + "…" : text;
  const start = Math.max(0, at - 40);
  const s = text.slice(start, start + len).replace(/^\S*\s+/, "").replace(/\s+\S*$/, "");
  return "…" + s + (start + len < text.length ? "…" : "");
}
