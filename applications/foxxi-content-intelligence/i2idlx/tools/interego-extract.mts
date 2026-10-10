// Runs Interego's own affordance extractor over a Turtle file.
// Usage: ICORE=<path to interego packages/core/src> tsx interego-extract.mts <file.ttl> <base IRI>
import { readFileSync } from 'node:fs';
const { extractAffordancesFromTurtle } = await import(`${process.env.ICORE}/kernel/affordance-extraction.ts`);
const [file, base] = process.argv.slice(2);
const ttl = readFileSync(file, 'utf8');
const strict = extractAffordancesFromTurtle(ttl, base);
const lax = extractAffordancesFromTurtle(ttl, base, { requireTarget: false });
process.stdout.write(JSON.stringify({ strictCount: strict.length, projectionCount: lax.length }) + '\n');
