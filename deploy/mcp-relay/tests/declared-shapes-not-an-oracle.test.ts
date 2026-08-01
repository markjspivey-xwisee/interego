#!/usr/bin/env tsx
/**
 * `list_declared_shapes` must answer "what does the fleet declare" WITHOUT becoming a
 * cross-tenant existence oracle.
 *
 * ★ WHY THE GAP EXISTED. The publish gate enforces a container's declared shapes, but
 * nothing could answer which shapes are declared and by whom, so exposure to a shape change
 * was unmeasurable. An earlier attempt inferred it from a publish probe and was refuted: the
 * gate 422s only when a declared shape VIOLATES the probe graph, so a shape that simply does
 * not target the probe's type looks exactly like no shape at all. That method detected 1 of
 * 12 shape documents and reported the other 11 as absent.
 *
 * ★ WHY THE SAFETY IS STRUCTURAL, not a promise. Two properties, both pinned below:
 *
 *   1. It accepts NO caller-supplied pod URL. Probing an arbitrary URL and reading back
 *      "declares X" / "not a pod" is precisely the leak to avoid. An empty input schema
 *      cannot be talked into it.
 *   2. It enumerates only the federation registry that `list_known_pods` already returns to
 *      every caller, and only declarations already anonymously fetchable — the same ones the
 *      gate reads. Nothing becomes visible that was not already.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/declared-shapes-not-an-oracle.test.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'server.ts'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nlist_declared_shapes is not an existence oracle');

// The declaration block, from `name:` to the annotations line that closes it.
const decl = src.match(/name: 'list_declared_shapes',[\s\S]*?annotations: \{[^}]*\}/)?.[0] ?? '';
ok('the tool is declared', decl.length > 0);

// ★ 1. NO INPUT. The oracle is only reachable through a caller-supplied target.
ok('it accepts no input properties at all',
  /inputSchema: \{ type: 'object', properties: \{\} \}/.test(decl),
  'a pod_url/target parameter would make arbitrary probing possible');
ok('specifically, it takes no pod url',
  !/pod_url|podUrl|target|url:/.test(decl.replace(/description:[\s\S]*?annotations/, 'annotations')),
  'the input schema must not name a URL parameter');

// ★ 2. Read-only, and honest about it in the annotations the client shows.
ok('it is annotated read-only and non-destructive',
  /readOnlyHint: true/.test(decl) && /destructiveHint: false/.test(decl));

const handler = src.match(/async function handleListDeclaredShapes[\s\S]*?\n\}/)?.[0] ?? '';
ok('the handler exists', handler.length > 0);

// ★ 3. It must enumerate the SAME registry list_known_pods does, not fetch a caller target.
ok('it enumerates the shared federation registry', /knownPodsWithSelf\(/.test(handler));
ok('it reads declarations through the gate\'s own fetcher',
  /fetchContainerShapes\(/.test(handler),
  'reading them any other way could see more than the gate can');
ok('the handler never reads a url out of args',
  !/args\.(pod_url|url|target)/.test(handler));

// ★ 4. Unreachable must not be reported as "declares nothing" — absence and unknown are
// different facts, and conflating them is how a fleet view becomes falsely reassuring.
ok('an unreachable pod is reported as an error, not as zero shapes',
  /error:/.test(handler) && /unreachable/.test(handler));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
