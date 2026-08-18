/**
 * WHAT is 1.2 MB in a review-record response, and what would a usable projection contain?
 *
 * A delegate called review-record and got 1,228,985 characters — more than any context it can bring
 * to the task — with no narrower projection advertised anywhere on the affordance. It could tell us
 * the review now answers and could not tell us what it said. A performance record an agent cannot
 * read is barely better than the empty one it replaced.
 *
 * This measures the response by KEY so the fix targets the actual bulk rather than the suspected
 * one: `include_clr: false` changed the payload by 106 bytes, which already refutes the obvious guess.
 *
 *   npx tsx applications/foxxi-content-intelligence/tools/review-record-weight.ts
 */
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const BRIDGE = (process.env.FOXXI_BRIDGE_URL ?? 'https://foxxi-bridge.interego.xwisee.com').replace(/\/$/, '');
const enc = new TextEncoder();
const sha = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

interface Wallet { privateKey: string; address: string }

async function envelope(w: ethers.Wallet, args: Record<string, unknown>) {
  const payload = { ...args, agent_id: `did:ethr:${w.address.toLowerCase()}`, timestamp: new Date().toISOString() };
  const sp = JSON.stringify(payload);
  return { _signature: await w.signMessage(`sha256:${sha(sp)}`), _signed_payload: sp };
}

/** Recursive byte weight of every top-level and second-level key, biggest first. */
function weigh(obj: unknown, prefix = '', out: Array<[string, number]> = []): Array<[string, number]> {
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const size = JSON.stringify(v)?.length ?? 0;
    const path = prefix ? `${prefix}.${k}` : k;
    out.push([path, size]);
    // One level deeper for the heavy branches only — enough to name the culprit, not a full walk.
    if (size > 50_000 && !Array.isArray(v)) weigh(v, path, out);
    if (size > 50_000 && Array.isArray(v) && v.length) {
      out.push([`${path}[] (${v.length} items, ~${Math.round(size / v.length)}B each)`, size]);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync('.interego/maintainer.json', 'utf8')) as Wallet;
  const w = new ethers.Wallet(raw.privateKey);
  console.log(`bridge=${BRIDGE}\nsubject=${w.address.toLowerCase()}\n`);

  const body = await envelope(w, { include_clr: false });
  const t0 = Date.now();
  const r = await fetch(`${BRIDGE}/agent/review-record`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  const ms = Date.now() - t0;
  console.log(`HTTP ${r.status} · ${text.length.toLocaleString()} chars · ${ms}ms\n`);
  if (!r.ok) { console.log(text.slice(0, 600)); process.exit(1); }

  const j = JSON.parse(text) as Record<string, unknown>;
  const rows = weigh(j).sort((a, b) => b[1] - a[1]).slice(0, 18);
  const pct = (n: number): string => `${((n / text.length) * 100).toFixed(1)}%`;
  console.log('WEIGHT BY KEY');
  for (const [k, size] of rows) {
    console.log(`  ${String(size).padStart(9)}  ${pct(size).padStart(6)}  ${k}`);
  }

  const subj = j.subject as Record<string, unknown> | undefined;
  console.log(`\nstatementCount=${subj?.statementCount} latticeStatements=${subj?.latticeStatements} source=${subj?.statementSource}`);
  console.log('top-level keys:', Object.keys(j).join(', '));

  /**
   * ★ THE COMPARISON THAT MATTERS: what a caller gets by DEFAULT versus what it can ask for. The
   * defect was never "the full record is big" — it is that the big one was the only one on offer and
   * nothing advertised an alternative. A default that stays flat as history grows is the fix; the
   * ratio below is the evidence for it.
   */
  const full = await fetch(`${BRIDGE}/agent/review-record`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await envelope(w, { include_clr: false, projection: 'inline' })),
  });
  const fullText = await full.text();
  const linksRes = await fetch(`${BRIDGE}/agent/review-record`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await envelope(w, { include_clr: false, projection: 'links' })),
  });
  const linksText = await linksRes.text();
  console.log(`\nPROJECTIONS`);
  console.log(`  inline (default): ${fullText.length.toLocaleString()} chars`);
  console.log(`  links  (opt-in) : ${linksText.length.toLocaleString()} chars`);
  const ratio = fullText.length > 0 ? (linksText.length / fullText.length) : 1;
  console.log(`  links is ${(ratio * 100).toFixed(1)}% of inline`);
  try {
    const lj = JSON.parse(linksText) as { elr?: { experiences?: Record<string, unknown> } };
    const c = lj.elr?.experiences;
    console.log(`  experiences -> ${String(c?.['@type'])} totalItems=${String(c?.['hydra:totalItems'])}`);
  } catch { /* the size line above already reports whether it answered */ }

  /**
   * ★★ ONE AGENT MUST SEE ONLY ITS OWN. The three stores a review reads are each keyed by the
   * subject (lens:<agent>, the per-label lattice, the subject's own pod), so isolation is meant to be
   * structural — but "meant to be" is what the last four blockers all had in common. This walks the
   * FULL projection and names any actor that is not the subject.
   */
  const fullJson = JSON.parse(fullText) as Record<string, unknown>;
  const fullElr = (fullJson.elr ?? {}) as Record<string, unknown>;
  const actors = new Set<string>();
  for (const key of ['experiences', 'performanceRecords']) {
    const arr = fullElr[key];
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      const s = JSON.stringify(it);
      for (const m of s.matchAll(/(0x[0-9a-fA-F]{40})|(u-(?:pk|eth|did)-[0-9a-z]+)|(eth-[0-9a-f]{12})/g)) actors.add(m[0].toLowerCase());
    }
  }
  const me = w.address.toLowerCase();
  const mine = new Set([me, `eth-${me.slice(2, 14)}`]);
  const foreign = [...actors].filter(a => !mine.has(a));
  console.log(`\nISOLATION (full projection, ${(fullElr.experiences as unknown[] | undefined)?.length ?? 0} experiences + ${(fullElr.performanceRecords as unknown[] | undefined)?.length ?? 0} performance records)`);
  console.log(`  identifiers seen: ${actors.size}`);
  if (foreign.length === 0) console.log('  ✓ every identifier in the record is the subject');
  else console.log(`  ✗ FOREIGN IDENTIFIERS PRESENT (${foreign.length}): ${foreign.slice(0, 8).join(', ')}`);

  /**
   * ★ THE LINKS PROJECTION MUST CARRY A FOLLOWABLE ADDRESS, not just a smaller payload. A collection
   * reference with no `hydra:view` is a truncation that hid itself, which is the failure this whole
   * refactor is about wearing the opposite mask.
   */
  const linksElr = (JSON.parse(linksText) as { elr?: Record<string, unknown> }).elr ?? {};
  const coll = linksElr.experiences as Record<string, unknown> | undefined;
  if (coll && coll['@type'] === 'hydra:Collection') {
    const view = coll['hydra:view'] as Record<string, unknown> | undefined;
    console.log(`\nLINKS (experiences): totalItems=${String(coll['hydra:totalItems'])}`);
    console.log(`  followable address: ${view ? `${String(view.method)} ${String(view.target)}` : '✗ MISSING — a reference with no view is a hidden truncation'}`);
  } else {
    console.log('\n✗ experiences is not a hydra:Collection — the links projection did not apply');
  }
}
main().catch(e => { console.error('review-record-weight error:', e); process.exit(2); });
