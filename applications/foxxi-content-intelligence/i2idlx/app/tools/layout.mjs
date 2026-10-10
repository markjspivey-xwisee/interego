// Deterministic whole-glossary map: node app/tools/layout.mjs <data.json> <layout.json>
// Concepts are pulled toward their primary field's anchor, so the 12 fields become regions ("continents"),
// and the editorial links (related, broader) pull neighbors together across them. d3-force's default random
// source is a fixed-seed LCG, so the same input always yields the same map.
import fs from "node:fs";
import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide } from "d3-force";

const [, , inPath, outPath] = process.argv;
const data = JSON.parse(fs.readFileSync(inPath, "utf8"));
const C = data.concepts;
const fields = data.collections.field.map((f) => f.id);

// Order fields around the ring so strongly linked fields sit side by side (greedy chain on link weight).
const w = new Map();
const key = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
const idx = new Map(C.map((c, i) => [c.id, i]));
for (const c of C) for (const r of [...c.r, ...c.b]) {
  const o = C[idx.get(r)];
  if (o.pf !== c.pf) w.set(key(c.pf, o.pf), (w.get(key(c.pf, o.pf)) || 0) + 1);
}
const order = [fields[0]];
const left = new Set(fields.slice(1));
while (left.size) {
  const last = order[order.length - 1];
  let best = null, bw = -1;
  for (const f of [...left].sort()) {
    const v = w.get(key(last, f)) || 0;
    if (v > bw) { bw = v; best = f; }
  }
  order.push(best);
  left.delete(best);
}
const W = 1600, H = 1100, R = 470;
const anchor = new Map(order.map((f, i) => {
  const a = (i / order.length) * Math.PI * 2 - Math.PI / 2;
  return [f, [W / 2 + R * Math.cos(a) * 1.3, H / 2 + R * Math.sin(a) * 0.92]];
}));

const nodes = C.map((c, i) => {
  const [ax, ay] = anchor.get(c.pf);
  const j = (i * 7919) % 360;
  return { id: c.id, f: c.pf, deg: c.r.length + c.b.length + c.n.length, x: ax + 30 * Math.cos(j), y: ay + 30 * Math.sin(j) };
});
const links = [];
for (const c of C) {
  for (const r of c.r) if (c.id < r) links.push({ source: c.id, target: r, kind: "r" });
  for (const b of c.b) links.push({ source: c.id, target: b, kind: "b" });
}

const sim = forceSimulation(nodes)
  .force("link", forceLink(links).id((d) => d.id).distance((l) => (l.kind === "b" ? 26 : l.source.f === l.target.f ? 40 : 90))
    .strength((l) => (l.kind === "b" ? 0.6 : l.source.f === l.target.f ? 0.22 : 0.035)))
  .force("charge", forceManyBody().strength((d) => -36 - d.deg * 2.2).distanceMax(260))
  .force("x", forceX((d) => anchor.get(d.f)[0]).strength(0.16))
  .force("y", forceY((d) => anchor.get(d.f)[1]).strength(0.16))
  .force("collide", forceCollide((d) => 8 + Math.sqrt(d.deg) * 1.5).iterations(2))
  .stop();
for (let i = 0; i < 900; i++) sim.tick();

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
const pad = 40, sx = (W - 2 * pad) / (maxX - minX), sy = (H - 2 * pad) / (maxY - minY), s = Math.min(sx, sy);
const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
const xy = {};
for (const n of nodes) xy[n.id] = [Math.round((n.x - minX) * s + ox), Math.round((n.y - minY) * s + oy)];
const mx = W / 2, my = H / 2;
const regions = order.map((f) => {
  const ms = nodes.filter((n) => n.f === f);
  const cx = ms.reduce((a, n) => a + xy[n.id][0], 0) / ms.length;
  const cy = ms.reduce((a, n) => a + xy[n.id][1], 0) / ms.length;
  // label at the cluster's outer edge, away from the middle of the map
  const ds = ms.map((n) => Math.hypot(xy[n.id][0] - cx, xy[n.id][1] - cy)).sort((a, b) => a - b);
  const rad = ds[Math.floor(ds.length * 0.8)] || 20;
  const dx = cx - mx, dy = cy - my, len = Math.hypot(dx, dy) || 1;
  const lx = Math.min(W - 60, Math.max(60, cx + (dx / len) * (rad + 34)));
  const ly = Math.min(H - 20, Math.max(24, cy + (dy / len) * (rad + 34)));
  return { f, x: Math.round(lx), y: Math.round(ly), cx: Math.round(cx), cy: Math.round(cy), n: ms.length };
});
fs.writeFileSync(outPath, JSON.stringify({ w: W, h: H, xy, regions, order }));
process.stdout.write(`layout: ${nodes.length} nodes, ${links.length} links, ${order.length} regions\n`);
