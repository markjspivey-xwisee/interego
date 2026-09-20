/**
 * The follower: discover → dereference → validate → act, the way the kernel's `act` verb and
 * the relay's `invoke_affordance` do it. It never composes a URL from knowledge of the
 * bridge: it reads the manifest or a judgment's descriptor, finds the affordance or control by
 * its iep:action, validates the payload against the declared input shape, and follows the
 * declared hydra:target. Declarative controls (no target) it performs locally when it knows
 * how (running the selected tests) and otherwise hands to a person.
 */

import { spawnSync } from 'node:child_process';
import { Parser, Store, DataFactory, type Term } from 'n3';
import { HMD, HYDRA, IEP } from './descriptor.js';
import { parseShapes, validate, type ValidationReport } from './shacl-lite.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export interface ResolvedAffordance {
  readonly subject: string;
  readonly action: string;
  readonly method: string;
  readonly target?: string;
  readonly expects?: string;
  readonly arguments?: Record<string, unknown>;
  readonly declarative: boolean;
  readonly title?: string;
}

/** True when `action` names the verb: urn:iep:action:jev-harness:<verb> or .../jev-harness/<verb>. */
export function actionMatches(action: string, verb: string): boolean {
  const tail = action.split(/[:/]/).filter(Boolean).slice(-2).join('/');
  return tail === `jev-harness/${verb}` || action.endsWith(`:${verb}`) || action.endsWith(`/${verb}`);
}

/** Every affordance or control in a Turtle/TriG document. */
export function affordancesIn(document: string, baseIri?: string): ResolvedAffordance[] {
  const store = new Store();
  const parser = baseIri ? new Parser({ baseIRI: baseIri }) : new Parser();
  store.addQuads(parser.parse(document));
  const out: ResolvedAffordance[] = [];
  const seen = new Set<string>();
  const subjects = new Set<Term>();
  for (const q of store.getQuads(null, DataFactory.namedNode(`${IEP}action`), null, null)) subjects.add(q.subject);
  for (const s of subjects) {
    const key = s.termType === 'BlankNode' ? `_:${s.value}` : s.value;
    if (seen.has(key)) continue;
    seen.add(key);
    const read = (pred: string): string | undefined => store.getQuads(s, DataFactory.namedNode(pred), null, null)[0]?.object.value;
    const action = read(`${IEP}action`);
    if (!action) continue;
    const isControl = store.getQuads(s, DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(`${HMD}Control`), null).length > 0;
    const target = read(`${HYDRA}target`);
    const argsRaw = store.getQuads(s, null, null, null).find((q) => q.predicate.value.endsWith('#argumentsJson'))?.object.value;
    let args: Record<string, unknown> | undefined;
    if (argsRaw) { try { args = JSON.parse(argsRaw) as Record<string, unknown>; } catch { args = undefined; } }
    const declRaw = store.getQuads(s, null, null, null).find((q) => q.predicate.value.endsWith('#declarative'))?.object.value;
    const expects = read(`${IEP}inputShape`) ?? (store.getQuads(s, DataFactory.namedNode(`${HYDRA}expects`), null, null)[0]?.object.termType === 'NamedNode' ? read(`${HYDRA}expects`) : undefined);
    out.push({
      subject: key,
      action,
      method: (read(`${HYDRA}method`) ?? 'POST').toUpperCase(),
      ...(target ? { target } : {}),
      ...(expects ? { expects } : {}),
      ...(args ? { arguments: args } : {}),
      declarative: declRaw === 'true' || (!target && isControl),
      ...(read('http://purl.org/dc/terms/title') ?? read(`${HYDRA}title`) ? { title: (read('http://purl.org/dc/terms/title') ?? read(`${HYDRA}title`))! } : {}),
    });
  }
  return out;
}

export function findAffordance(document: string, verb: string, baseIri?: string): ResolvedAffordance | undefined {
  const all = affordancesIn(document, baseIri);
  return all.find((a) => actionMatches(a.action, verb) && a.subject.startsWith('urn:control:'))
    ?? all.find((a) => actionMatches(a.action, verb));
}

export interface Fetcher { (url: string, init?: RequestInit): Promise<Response> }

/**
 * Fetch without connection reuse, retried once on a transport failure. A follower chain can
 * pause for a long local test run between two calls; a pooled keep-alive socket the bridge
 * closed meanwhile surfaces as a bare "fetch failed" on the next hop (measured on the first
 * dogfood run). `Connection: close` avoids the stale socket and the retry covers the rest.
 */
async function fetchFresh(fetchImpl: Fetcher, url: string, init: RequestInit): Promise<Response> {
  const withClose: RequestInit = { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Connection: 'close' } };
  try {
    return await fetchImpl(url, withClose);
  } catch (err) {
    if (!/fetch failed|ECONNRESET|socket hang up/i.test(String((err as Error).message) + String((err as { cause?: Error }).cause?.message ?? ''))) throw err;
    return fetchImpl(url, withClose);
  }
}

/** GET a Turtle/TriG document (manifest, descriptor or judgment). */
export async function dereference(url: string, fetchImpl: Fetcher = fetch): Promise<{ text: string; contentType: string }> {
  const res = await fetchFresh(fetchImpl, url, { headers: { Accept: 'application/trig, text/turtle;q=0.9, text/markdown;q=0.5' } });
  if (!res.ok) throw new Error(`dereference ${url} responded ${res.status}`);
  return { text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
}

/** Validate a payload against the shape the affordance declares, fetching the shapes document from the bridge that owns the target. */
export async function validateAgainstShape(aff: ResolvedAffordance, payload: unknown, fetchImpl: Fetcher = fetch): Promise<ValidationReport | null> {
  if (!aff.expects || !aff.target) return null;
  const origin = new URL(aff.target).origin;
  const res = await fetchFresh(fetchImpl, `${origin}/ns/jev-harness`, { headers: { Accept: 'text/turtle' } });
  if (!res.ok) return null;
  const shapes = parseShapes(await res.text());
  const shape = shapes.get(aff.expects);
  if (!shape) return null;
  return validate(shape, payload);
}

export interface ActResult {
  readonly status: number;
  readonly body: unknown;
}

export async function act(aff: ResolvedAffordance, payload: unknown, fetchImpl: Fetcher = fetch): Promise<ActResult> {
  if (!aff.target) throw new Error(`control ${aff.action} is declarative; it has no target to follow`);
  const method = aff.method === 'GET' ? 'GET' : 'POST';
  const res = await fetchFresh(fetchImpl, aff.target, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

export interface RunResult {
  readonly command: string;
  readonly exitCode: number;
  readonly log: string;
  readonly failedTests: string[];
}

/** Perform the declarative run-selected-tests control locally. */
export function runSelectedTests(args: Record<string, unknown>, cwd: string): RunResult {
  const tests = Array.isArray(args['tests']) ? (args['tests'] as string[]) : [];
  const mode = args['mode'] === 'full' ? 'full' : 'subset';
  const cmdArgs = ['vitest', 'run', '--reporter=default', ...(mode === 'full' ? [] : tests)];
  const command = `npx ${cmdArgs.join(' ')}`;
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', cmdArgs, { cwd, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
  const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const failed = new Set<string>();
  for (const m of log.matchAll(/(?:FAIL|×|✖|✗)\s+([\w@./+-]+\.(?:test|spec|check)\.[cm]?[jt]sx?)/g)) if (m[1]) failed.add(m[1]);
  return { command, exitCode: r.status ?? -1, log, failedTests: [...failed] };
}

export function mergeArguments(prefilled: Record<string, unknown> | undefined, overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(prefilled ?? {}) };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) out[k] = v;
  return out;
}
