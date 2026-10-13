/**
 * Read the credential fixtures (tests/support/credentials/*.json) into RDF the way a verifier reads a
 * credential — through the W3C VC 2.0 contexts and 1EdTech's Open Badges 3.0.3 and CLR 2.0.1 contexts,
 * in JSON-LD safe mode — and write each reading beside its fixture as N-Quads (<name>.nq). First
 * (re)writes the two fixtures Foxxi's own code produces (tests/support/credentials/foxxi-fixtures.ts).
 *
 * The test that uses them (tests/credentials-the-specs-allow-conform-in-both-readings.test.ts) has no
 * network and does not copy 1EdTech's contexts, which are 1EdTech's to distribute; so the readings are
 * made here, by whoever changes a fixture, and checked in. Each context must match the digest recorded
 * below — a context that changed upstream is a reason to look, not to regenerate blindly.
 *
 * usage: npx tsx applications/foxxi-content-intelligence/tools/read-credential-fixtures.ts [--contexts <dir>]
 *   --contexts  a directory holding the four contexts under their file names below, instead of
 *               fetching each from its URL.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jsonld from 'jsonld';
import { foxxiCourseCompletion, foxxiClr } from '../tests/support/credentials/foxxi-fixtures.js';

const DIR = fileURLToPath(new URL('../tests/support/credentials/', import.meta.url));
const CONTEXTS: Record<string, { file: string; sha256: string }> = {
  'https://www.w3.org/ns/credentials/v2': { file: 'credentials-v2.jsonld', sha256: '59955ced6697d61e03f2b2556febe5308ab16842846f5b586d7f1f7adec92734' },
  'https://www.w3.org/ns/credentials/undefined-terms/v2': { file: 'credentials-undefined-terms-v2.jsonld', sha256: '82dab514ba44eb18f5d1b0f638c5e140c6a556fbfb5089601bdc0fa5eb8b2581' },
  'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json': { file: 'ob-context-3.0.3.json', sha256: '3d34f4d4ef1bce691106e63798beb5e7b862ba841423f5ee1e53ab7ddf3bca84' },
  'https://purl.imsglobal.org/spec/clr/v2p0/context-2.0.1.json': { file: 'clr-context-2.0.1.json', sha256: '880f1902d4158f2f33ce06af41b90719977cd1ea337a9de2e41edb3ff5e543d6' },
};
const at = process.argv.indexOf('--contexts');
const local = at > 0 ? process.argv[at + 1] : undefined;

const cache = new Map<string, unknown>();
async function documentLoader(url: string): Promise<{ contextUrl: undefined; documentUrl: string; document: unknown }> {
  const known = CONTEXTS[url];
  if (!known) throw new Error(`a fixture names a context this tool does not know: ${url}`);
  if (!cache.has(url)) {
    const text = local ? readFileSync(join(local, known.file), 'utf8') : await (await fetch(url, { headers: { Accept: 'application/ld+json, application/json' } })).text();
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    if (digest !== known.sha256) throw new Error(`${url}: sha256 ${digest}, not the ${known.sha256} recorded — the context changed`);
    cache.set(url, JSON.parse(text));
  }
  return { contextUrl: undefined, documentUrl: url, document: cache.get(url) };
}

const write = (name: string, doc: unknown): void => writeFileSync(join(DIR, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
write('foxxi-course-completion', await foxxiCourseCompletion());
write('foxxi-clr', await foxxiClr());

// A document safe mode refuses has no reading: what the refusal says is written instead
// (<name>.refused.json), so the test can hold the validator to refusing it too.
for (const f of readdirSync(DIR).filter(n => n.endsWith('.json') && !n.endsWith('.refused.json')).sort()) {
  const doc = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as jsonld.JsonLdDocument;
  const base = join(DIR, f.replace(/\.json$/, ''));
  rmSync(`${base}.nq`, { force: true }); rmSync(`${base}.refused.json`, { force: true });
  try {
    const nq = await jsonld.toRDF(doc, { format: 'application/n-quads', documentLoader, safe: true } as unknown as jsonld.Options.ToRdf) as unknown as string;
    writeFileSync(`${base}.nq`, nq);
    console.log(`${f}: ${nq.trim().split('\n').length} quads`);
  } catch (e) {
    const event = (e as { details?: { event?: { code?: string; message?: string; details?: unknown } } }).details?.event;
    if (!event) throw e;
    writeFileSync(`${base}.refused.json`, `${JSON.stringify({ code: event.code, message: event.message, details: event.details }, null, 2)}\n`);
    console.log(`${f}: refused in safe mode — ${event.code}`);
  }
}
