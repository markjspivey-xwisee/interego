/** Verify the native workbench projection against itself and, optionally, the Python oracle. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
type Value = ReturnType<typeof JSON.parse>;
type Row = Record<string, Value>;

function canonical(value: Value, path = ''): Value {
  if (path === 'meta.built') return '<build time>';
  if (path.startsWith('semantic.reasoning.') && /(^|\.)seconds$/u.test(path)) return '<measured duration>';
  if (Array.isArray(value)) {
    const rows = value.map(v => canonical(v, path));
    // These ontology schemes are RDF sets; their display semantics are keyed by id.
    if (path === 'statuses' || path === 'methods') rows.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));
    return rows;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], path ? path + '.' + k : k)]));
  return value;
}
function difference(a: Value, b: Value, path = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return path + ': array lengths ' + a.length + ' / ' + b.length;
    for (let i = 0; i < a.length; i++) { const d = difference(a[i], b[i], path + '[' + i + ']'); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    if (JSON.stringify(ak) !== JSON.stringify(bk)) return path + ': object keys differ (' + ak.join(', ') + ' / ' + bk.join(', ') + ')';
    for (const k of ak) { const d = difference(a[k], b[k], path + '.' + k); if (d) return d; }
    return null;
  }
  return path + ': ' + JSON.stringify(a) + ' / ' + JSON.stringify(b);
}
export interface AppDataCheckResult { checks: number; concepts: number; parity: boolean | null; }
export function checkAppData(dataFile: string, oracleFile?: string): AppDataCheckResult {
  const d: Row = JSON.parse(readFileSync(dataFile, 'utf8')), errors: string[] = []; let checks = 0;
  const check = (ok: unknown, label: string): void => { checks++; process.stdout.write((ok ? 'PASS ' : 'FAIL ') + label + '\n'); if (!ok) errors.push(label); };
  const cs: Row[] = d.concepts, ids = new Set(cs.map(c => c.id));
  const n = (key: string, count: number): void => check(d.meta.counts[key] === count, key + ' count is derived from the actual data (' + count + ')');
  n('concepts', cs.length); n('sources', d.sources.length); n('evidence', cs.reduce((sum, c) => sum + c.ev.length, 0));
  n('altLabels', cs.reduce((sum, c) => sum + c.a.length, 0)); n('broader', cs.reduce((sum, c) => sum + c.b.length, 0));
  n('related', Math.floor(cs.reduce((sum, c) => sum + c.r.length, 0) / 2));
  n('enactments', d.enactments.length); n('mappings', d.mappings.length); n('roleCaps', d.roleCaps.length); n('inherited', d.inherited.length);
  n('actions', Object.keys(d.actions).length); n('releases', d.releases.length); n('grounded', cs.filter(c => c.pv === 'g').length);
  n('links', cs.reduce((sum, c) => sum + (c.md?.length || 0) + (c.mx?.length || 0), 0)); n('suggestions', d.suggestions.length);
  n('unesco', d.mappings.filter((m: Row) => m.v === 'UNESCO Thesaurus').length);
  n('ownCrosswalks', cs.reduce((sum, c) => sum + (c.xm?.length || 0), 0)); n('ownUnesco', cs.reduce((sum, c) => sum + (c.xm || []).filter((x: Value[]) => x[1].startsWith('http://vocabularies.unesco.org/')).length, 0));
  n('adopted', cs.reduce((sum, c) => sum + (c.xm || []).filter((x: Value[]) => x[3]).length, 0));
  check(ids.size === cs.length, 'concept identifiers are unique');
  check(cs.every(c => c.f.includes(c.pf) && ['b', 'n', 'r'].every(k => c[k].every((id: string) => ids.has(id)))), 'all field and relationship targets exist');
  check(cs.every(c => c.ev.every((e: Row) => Number.isInteger(e.s) && d.sources[e.s])), 'all evidence records reference an actual rights-bearing source');
  check(cs.every(c => c.di.startsWith('https://id.i2idl.org/') && c.pv === (c.ev.some((e: Row) => e.r === 'd') ? 'g' : 's')), 'active definitions preserve I2IDL identity and evidence-derived provenance');
  check(d.meta.license.holder && d.meta.license.file.includes('/blob/' + d.meta.commit + '/') && d.meta.license.name === 'CC BY 4.0', 'copyright and licence cite the pinned upstream commit');
  check(d.enactments.every((e: Row) => ids.has(e.c) && d.actions[e.a]) && d.roleCaps.every((e: Row) => ids.has(e.c) && d.actions[e.a]), 'enactments and role capabilities point to actual actions and concepts');
  check(d.mappings.every((m: Row) => ids.has(m.c) && !['adopted', 'superseded'].includes(m.s)), 'review queue contains only current open proposals on known concepts');
  check(d.semantic.bridges.every((b: Row) => ids.has(b.c) && b.m) && cs.every(c => d.semantic.categories.some((x: Row) => x.id === c.rc)), 'every semantic classification and bridge is traced to its source');
  check(d.semantic.reasoning.classify.sound && d.semantic.reasoning.classify.complete && d.semantic.reasoning.rules.agree && d.semantic.reasoning.disjointCheck.agree, 'reasoning evidence reports soundness, completeness and rule/disjointness agreement');
  check(d.releases.at(-1).v === d.meta.release && d.releases.at(-1).commit === d.meta.commit && d.releases.at(-1).n === cs.length, 'release history ends at the pinned glossary projection');
  check(cs.every(c => c.h0 || (c.h || []).some(([, row]: Value[]) => row.add)), 'every current concept has a baseline or added event');
  if (d.layout) check(JSON.stringify([...ids].sort()) === JSON.stringify(Object.keys(d.layout.xy).sort()), 'deterministic map covers all concepts');
  let parity: boolean | null = null;
  if (oracleFile) {
    const oracle = JSON.parse(readFileSync(oracleFile, 'utf8')), diff = difference(canonical(d), canonical(oracle));
    parity = diff == null;
    check(parity, 'native app data matches the independent Python oracle' + (diff ? ': ' + diff : ' (only measured build durations ignored)'));
  }
  if (errors.length) throw new Error('App data checks failed:\n' + errors.join('\n'));
  return { checks, concepts: cs.length, parity };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: check-app-data.ts <native-data.json> [python-oracle-data.json]');
  process.stdout.write(JSON.stringify(checkAppData(process.argv[2], process.argv[3])) + '\n');
}
