#!/usr/bin/env tsx
/**
 * A call that cannot work is refused before it is accepted.
 *
 * ★ WHY THIS EXISTS. `publish_context` called without `graph_iri` or `graph_content`
 * returned `{"published": true, "status": "pending"}` and then failed on the deferred
 * write with `TypeError: The "string" argument must be of type string … Received
 * undefined`. The caller was told the publish succeeded; the refusal arrived later, on a
 * background task, naming no argument. Both fields are `required` in the inputSchema and
 * `tools/call` validates nothing, so the schema was decoration.
 *
 * Reproduced at the substrate boundary before any of this was written:
 *
 *     publish(descriptor, undefined, pod)   → TypeError: The "string" argument …
 *     ContextDescriptor…describes(undefined) → describes: [null], and the publish then
 *                                              spends 8 manifest-CAS attempts before
 *                                              reporting "concurrent writer clobbered us"
 *
 * ★ AND WHY PRESENCE ALONE WAS NOT THE FIX. The first version of the gate tested
 * `undefined | null | ''`, so every one of the 19 gated tools still passed with all of its
 * required arguments set to `42`, and the quoted defect reproduced character for
 * character. Re-measured against the real `publish()`:
 *
 *     graph_content: 42  → {"published": true}, then TypeError: … Received type number (42)
 *     graph_iri: {}      → publish RESOLVES, and the bytes on the pod read
 *                          `iep:describes <[object%20Object]>` — a fabricated IRI,
 *                          content-addressed and, on the compliance path, pinned
 *     compose operator "unoin" → byte-identical to OVERRIDE, echoing the typo back
 *
 * So the gate checks the TYPE its schema declares, not just presence, and `compose`'s
 * closed vocabulary as well. The cases below pin both, and pin that they stay DISTINCT:
 * an absent argument is reported as missing, a mistyped one as invalid, never both.
 *
 * ★ Mutation-checked, each applied on its own and the suite re-run. Counts are measured on
 * THIS version of the suite, not carried over — the type half changed what several of the
 * older mutants cost:
 *
 *     reverting `satisfies` to `return true`  (i.e. the presence-only gate)   fails 15
 *     mistyping `descriptors` as `object` against its published schema        fails  9
 *     declaring `graph_iri` as `any`                                          fails  5
 *     dropping `compose.operator`'s `values`                                  fails  4
 *     removing `compose.operator` from the table entirely                     fails  4
 *     treating JSON `null` as present                                         fails  2
 *     making `retryable` true                                                 fails  2
 *     letting an array satisfy `kind: 'object'`                               fails  1
 *
 * The four type/vocabulary mutants above also trip the schema-drift check independently, so
 * the table cannot be quietly retyped away from what `tools/list` advertises.
 *
 * ★ The `null` mutant is why the null case asserts its CLASSIFICATION and not just that the
 * call was refused. With types checked, deleting the null branch still leaves `null`
 * failing `typeof x === 'string'`, so the call is refused either way and a one-assertion
 * version of that case dropped from 3 kills to 1 — the guard looked fine while the
 * documented meaning of `null` had been deleted underneath it.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/required-args.test.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ENFORCED_REQUIRED_ARGS,
  invalidRequiredArgs,
  missingRequiredArgs,
  requiredArgsRefusal,
} from '../required-args.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const serverSrc = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

function main(): void {
  console.log('\nthe refusal arrives instead of the success, not after it');

  // ── The headline: publish_context ───────────────────────────────────────────
  const noGraph = requiredArgsRefusal('publish_context', { pod_name: 'markj' });
  ok(noGraph !== null, '★ publish_context with neither graph argument is refused');
  ok(
    noGraph?.missing.join(',') === 'graph_iri,graph_content',
    'and BOTH missing arguments are named, not just the first',
    JSON.stringify(noGraph?.missing),
  );
  ok(
    noGraph!.message.includes('`graph_iri`') && noGraph!.message.includes('`graph_content`'),
    '…in the prose too, so a human or an LLM reading the message can act on it',
    noGraph?.message,
  );

  // ★ The two fields a client branches on. A missing argument is not a transient
  // condition: this relay already shipped one 503/retryable:true for an if_match that
  // could never work, and a client that believes `retryable` loops until it gives up.
  ok(noGraph?.code === 400, '★ the code is 400 — the request is wrong, not the relay', String(noGraph?.code));
  ok(noGraph?.retryable === false, '★ retryable is FALSE — no resend supplies an absent argument', String(noGraph?.retryable));
  ok(noGraph?.error === 'missing_required_argument', 'the error slug is machine-stable', noGraph?.error);

  ok(
    requiredArgsRefusal('publish_context', { graph_iri: 'urn:graph:x' })?.missing.join(',') === 'graph_content',
    'one supplied and one absent names only the absent one',
  );
  ok(
    requiredArgsRefusal('publish_context', { graph_content: '<a> <b> "c" .' })?.missing.join(',') === 'graph_iri',
    '…and symmetrically for the other',
  );
  ok(
    requiredArgsRefusal('publish_context', { graph_iri: 'urn:graph:x', graph_content: '<a> <b> "c" .' }) === null,
    'a complete call is not refused',
  );

  // ── What "absent" means ─────────────────────────────────────────────────────
  //
  // JSON has no `undefined`, so a client that means "I have nothing here" sends `null`.
  // It reaches `publish()` exactly as `undefined` does and throws the same TypeError, so
  // it has to be the same refusal.
  {
    // ★ `null` must land in `missing`, NOT in `invalid`. Once the gate checks types, a
    // null would ALSO fail `typeof x === 'string'`, so the call is refused either way and
    // a mutation that deletes the null branch still looks "safe" from the outside. It is
    // not: the two lists are what a client branches on, and "you sent null, which must be
    // a string" invites a caller to send `"null"`. Absence is the true statement, so this
    // pins the CLASSIFICATION and not merely the refusal.
    const nulls = requiredArgsRefusal('publish_context', { graph_iri: null, graph_content: null });
    ok(
      nulls?.missing.length === 2,
      '★ JSON null is absent — it reaches publish() exactly as undefined does',
      JSON.stringify(nulls?.missing),
    );
    ok(
      nulls?.invalid.length === 0 && nulls.error === 'missing_required_argument',
      '★ …and it is classified as ABSENT, never as a wrongly-typed value that arrived',
      JSON.stringify(nulls?.invalid),
    );
  }
  ok(
    requiredArgsRefusal('pgsl_resolve', { uri: '   ' })?.missing.join(',') === 'uri',
    '★ a whitespace-only string is absent — it is not an IRI and never becomes one',
  );
  ok(
    requiredArgsRefusal('publish_context', { graph_iri: 'urn:graph:x', graph_content: '' }) !== null,
    'an empty string is absent for a string argument',
  );

  // ── The type, not just the presence ─────────────────────────────────────────
  //
  // ★ THIS IS THE HALF THE FIRST VERSION MISSED. Everything here was measured passing the
  // presence-only gate, reaching the handler, and producing exactly the failures this
  // module exists to replace.
  {
    // `graph_content: 42` → {"published": true}, then, on the background task,
    // `TypeError: The "string" argument must be of type string … Received type number (42)`.
    const n = requiredArgsRefusal('publish_context', { graph_iri: 'urn:graph:x', graph_content: 42 });
    ok(n !== null, '★ a NUMBER where Turtle belongs is refused — it reached publish() and threw');
    ok(
      n?.invalid.length === 1 && n.invalid[0]!.name === 'graph_content',
      '…and the refusal names the argument, which the TypeError never did',
      JSON.stringify(n?.invalid),
    );
    ok(
      n?.invalid[0]?.received === 'number (42)' && n.invalid[0]?.expected === 'a string',
      '…and says what arrived and what was wanted, both',
      JSON.stringify(n?.invalid[0]),
    );
    ok(
      n?.missing.length === 0 && n.error === 'invalid_required_argument',
      '★ a MISTYPED argument is not reported as an absent one — the message must stay true',
      `missing=${JSON.stringify(n?.missing)} error=${n?.error}`,
    );
    ok(
      n?.message.includes('`graph_content`') === true && !/without/.test(n.message),
      '…so the prose says "was called with", never "was called without", for a value that arrived',
      n?.message,
    );
    ok(n?.code === 400 && n.retryable === false, 'a mistyped argument is 400 / retryable:false too');
  }
  {
    // ★ The one that does not throw. `describes({})` SERIALIZES: the publish resolves and
    // the descriptor on the pod reads `iep:describes <[object%20Object]>` — content-
    // addressed, and pinned to IPFS on the compliance path.
    for (const [label, value] of [
      ['an object', {} as unknown],
      ['a JSON-LD node object', { '@id': 'urn:graph:x' } as unknown],
      ['an array', ['urn:graph:x'] as unknown],
      ['a boolean', true as unknown],
    ] as const) {
      const r = requiredArgsRefusal('publish_context', { graph_iri: value, graph_content: '<a> <b> "c" .' });
      ok(
        r !== null && r.invalid.some(i => i.name === 'graph_iri'),
        `★ graph_iri as ${label} is refused — unchecked it publishes a FABRICATED IRI`,
        JSON.stringify(r?.invalid),
      );
    }
  }
  {
    // ★ compose's silent OVERRIDE is a VALUE problem. "unoin" produced a composition
    // byte-identical to override and reported the typo back as the operator.
    const typo = requiredArgsRefusal('compose', { descriptors: [{ id: 'urn:a' }], operator: 'unoin' });
    ok(typo !== null, '★ an operator OUTSIDE the vocabulary is refused — it silently performs an OVERRIDE');
    ok(
      typo?.invalid[0]?.received === '"unoin"',
      '…and the refusal quotes the value back, so the typo is visible',
      JSON.stringify(typo?.invalid[0]),
    );
    ok(
      typo?.invalid[0]?.expected === 'one of: union, intersection, restriction, override',
      '…and lists the whole vocabulary, so the caller does not have to go and read the schema',
      JSON.stringify(typo?.invalid[0]),
    );
    for (const good of ['union', 'intersection', 'restriction', 'override']) {
      ok(
        requiredArgsRefusal('compose', { descriptors: [{ id: 'urn:a' }], operator: good }) === null,
        `every published operator is accepted — ${good}`,
      );
    }
  }
  {
    // The structural kinds. `restrict` reads `selector.kind`; an array has none, so an
    // array is not the `object` this argument means.
    ok(
      invalidRequiredArgs('restrict', { descriptor: {}, selector: [] }).some(i => i.name === 'selector'),
      '★ an ARRAY does not satisfy an object-typed argument — restrict reads selector.kind',
    );
    ok(
      invalidRequiredArgs('restrict', { descriptor: {}, selector: { kind: 'facet-types' } }).length === 0,
      'a real object satisfies it',
    );
    ok(
      invalidRequiredArgs('compose', { descriptors: {}, operator: 'union' }).some(i => i.name === 'descriptors'),
      'an object does not satisfy an array-typed argument',
    );
  }

  // ★ NOT refused. The gate says "you cannot have meant this", not "this is falsy" — the
  // difference is the difference between a true statement about the request and a guess.
  ok(
    missingRequiredArgs('compose', { descriptors: [], operator: 'union' }).length === 0
    && invalidRequiredArgs('compose', { descriptors: [], operator: 'union' }).length === 0,
    '★ an empty ARRAY is a value AND a well-typed one — compose already answers that in words',
  );
  {
    // ★ `mint.content` is the reason `ArgKind` has an 'any'. Its schema declares no type,
    // because mint is content-addressed over whatever it is handed — a value, a list, a
    // descriptor. Type-checking it would refuse the kinds the tool exists to serve.
    for (const [label, value] of [
      ['0', 0 as unknown], ['false', false as unknown], ['a list', [1, 2] as unknown],
      ['a descriptor', { id: 'urn:a' } as unknown],
    ] as const) {
      ok(
        requiredArgsRefusal('mint', { content: value }) === null,
        `★ mint accepts ${label} — its schema declares NO type, and that is deliberate`,
      );
    }
    ok(
      requiredArgsRefusal('mint', {})?.missing.join(',') === 'content',
      '…but absent is still absent, even for an untyped argument',
    );
  }

  // ── compose: the silent one ─────────────────────────────────────────────────
  //
  // An absent `operator` does not throw. It falls past union and intersection into the
  // `else` branch of kernel compose(), which is OVERRIDE — later operands win — and the
  // result comes back reporting `operator: undefined`. Nothing in that answer says a
  // choice was made for you.
  ok(
    requiredArgsRefusal('compose', {
      descriptors: [{ id: 'urn:a' }, { id: 'urn:b' }],
    })?.missing.join(',') === 'operator',
    '★ compose without an operator is refused — absent, it silently performs an OVERRIDE',
  );

  // ── The table is a decision, not a derivation ───────────────────────────────
  //
  // ★ WHAT THIS PINS: that the table stays CLOSED at the 19 tools someone chose. It does
  // not re-check that these 14 refuse well — that was established by measurement, once,
  // against the running relay, and is recorded here rather than re-asserted:
  //
  //     remember 3937, record_trajectory_step 4052, notify_agent 5875, render_hmd 4526,
  //     publish_node 6698, get_current_head 6766, reduce_chain 7248,
  //     interrogative_route 6471/6476, invoke_affordance 6873 (throws, but names the
  //     argument), promote, verify_agent / register_agent / revoke_agent, set_reachability
  //
  // An earlier version of this loop was NAMED for that measurement — "it already refuses
  // by name" — while asserting only `!(tool in table)`, which is true by construction of
  // the table it reads. The name now says what the assertion checks, because a test whose
  // name claims more than its body checks is a false witness, and the next reader trusts
  // the name.
  for (const untouched of [
    'remember', 'record_trajectory_step', 'notify_agent', 'render_hmd', 'publish_node',
    'get_current_head', 'reduce_chain', 'interrogative_route', 'invoke_affordance', 'promote',
    'verify_agent', 'register_agent', 'revoke_agent', 'set_reachability',
  ]) {
    ok(
      !(untouched in ENFORCED_REQUIRED_ARGS) && missingRequiredArgs(untouched, {}).length === 0,
      `${untouched} is still OUT of the table — gating it would be a behaviour change, so it must be deliberate`,
    );
  }
  ok(
    missingRequiredArgs('a_tool_that_does_not_exist', {}).length === 0,
    'an unknown tool is not this module\'s to judge (dynamic pod-authored tools land here)',
  );

  // ── The table cannot drift from the schemas it enforces ─────────────────────
  //
  // ★ Every enforced argument must be `required` in that tool's own inputSchema, AND the
  // `kind` this table checks must be the `type` that schema publishes. Without the first
  // the gate could demand an argument the tool never advertised; without the second it
  // could refuse a TYPE the tool never advertised — both are refusals no reader of
  // `tools/list` could have predicted, which is the "the schema is not the guard"
  // complaint from the other direction.
  {
    const schemaRequired = new Map<string, Set<string>>();
    // tool → arg → the `type:` its schema declares ('' when it declares none, as mint does)
    const schemaType = new Map<string, Map<string, string>>();
    const schemaEnum = new Map<string, Map<string, string[]>>();
    let current: string | null = null;
    const lines = serverSrc.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const named = /^ {4}name: '([a-z0-9_]+)',\s*$/.exec(line);
      if (named) current = named[1]!;
      const req = /^ {6}required: \[(.*)\],\s*$/.exec(line);
      if (req && current) {
        schemaRequired.set(current, new Set([...req[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!)));
      }
      // A property line inside an inputSchema: `        <name>: { … }`, possibly wrapping.
      // Accumulate until the property's own braces balance, so a nested object
      // (restrict.selector) is read whole rather than truncated at the first `}` — and
      // stop exactly there, so the next property's text is not swept in.
      const prop = /^ {8}([a-z0-9_]+): \{(.*)$/.exec(line);
      if (prop && current) {
        const chunks: string[] = [];
        let depth = 1;
        for (let j = i; depth > 0 && j < lines.length; j++) {
          const raw = j === i ? prop[2]! : lines[j]!;
          let end = raw.length;
          for (let k = 0; k < raw.length; k++) {
            if (raw[k] === '{') depth++;
            else if (raw[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
          }
          chunks.push(raw.slice(0, end).trim());
        }
        const text = chunks.join(' ');
        // ★ ONLY the property's OWN `type:` / `enum:` — the ones at ITS brace depth.
        // `restrict.selector` nests `kind: { type: 'string', enum: ['facet-types'] }`, and a
        // depth-blind regex read that inner vocabulary as the selector's own, which made
        // this check report drift against a table that was correct. A guard that fires on
        // correct input is one that gets deleted rather than obeyed.
        const atTop = (key: string): string | null => {
          let d = 0;
          for (let k = 0; k < text.length; k++) {
            const ch = text[k]!;
            if (ch === '{' || ch === '[') d++;
            else if (ch === '}' || ch === ']') d--;
            else if (d === 0 && text.startsWith(key, k)) return text.slice(k + key.length);
          }
          return null;
        };
        const t = /^\s*'([a-z]+)'/.exec(atTop('type:') ?? '');
        if (!schemaType.has(current)) schemaType.set(current, new Map());
        schemaType.get(current)!.set(prop[1]!, t ? t[1]! : '');
        const en = /^\s*\[([^\]]*)\]/.exec(atTop('enum:') ?? '');
        if (en) {
          if (!schemaEnum.has(current)) schemaEnum.set(current, new Map());
          schemaEnum.get(current)!.set(prop[1]!, [...en[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!));
        }
      }
    }
    const drifted: string[] = [];
    for (const [tool, specs] of Object.entries(ENFORCED_REQUIRED_ARGS)) {
      const declared = schemaRequired.get(tool);
      if (!declared) { drifted.push(`${tool}: no top-level required[] found in its schema`); continue; }
      for (const spec of specs) {
        if (!declared.has(spec.name)) drifted.push(`${tool}.${spec.name} is enforced but not declared required`);
        const published = schemaType.get(tool)?.get(spec.name);
        if (published === undefined) { drifted.push(`${tool}.${spec.name}: no property found in its schema`); continue; }
        // `kind: 'any'` is the honest reading of a property that publishes no `type` — and
        // it is only honest while the schema still publishes none.
        const expected = spec.kind === 'any' ? '' : spec.kind;
        if (published !== expected) {
          drifted.push(`${tool}.${spec.name}: table says ${spec.kind}, schema says ${published || '(untyped)'}`);
        }
        // ★ BIDIRECTIONAL. The table may not invent a vocabulary the schema does not
        // publish, AND it may not omit one the schema does: an enforced argument whose
        // schema declares an `enum` is exactly the `compose.operator` shape, where an
        // out-of-vocabulary value is silently honoured instead of refused. Checking only
        // `spec.values &&` would let the next such argument be gated for type alone and
        // keep that defect.
        const publishedEnum = schemaEnum.get(tool)?.get(spec.name);
        if (JSON.stringify(spec.values ?? null) !== JSON.stringify(publishedEnum ?? null)) {
          drifted.push(`${tool}.${spec.name}: vocabulary ${JSON.stringify(spec.values ?? null)} != schema ${JSON.stringify(publishedEnum ?? null)}`);
        }
      }
    }
    ok(drifted.length === 0,
      '★ every enforced argument\'s NAME, TYPE and vocabulary match that tool\'s published inputSchema',
      drifted.join('; '));
  }

  // ── The wiring. `server.ts` starts a listener on import, so this is read as source ──
  //
  // Same technique publish-defer.test.ts and identity-attribution-gates.test.ts use, and
  // for the same reason: the alternative is no witness at all. Both sites are pinned
  // because they cover different callers — the registry covers all FOUR wire transports,
  // the handler entry covers `handleRemember` and `handleRecordTrajectoryStep`, which
  // call `handlePublishContext` directly and never touch the registry.
  ok(
    /const TOOLS: Record<string, ToolEntry> = gateRequiredArgs\(\{/.test(serverSrc),
    '★ the registry is wrapped once, so all four dispatch transports are covered',
  );
  // The span is generous ON PURPOSE and is NOT the positional guarantee. What sits between
  // the function signature and this call is the comment explaining why the refusal is here,
  // and that comment grows whenever a new failure mode is documented — it went past a
  // 2 000-character bound the moment the `describes(<non-string>)` case was written up,
  // failing this assertion over a file that was entirely correct. A check that fires on its
  // own documentation gets loosened in a hurry by whoever hits it, which is worse than
  // loosening it deliberately here. The real ordering guarantee is the next block, which
  // compares the guard's offset against the bootstrap PUT and the mutex.
  ok(
    /async function handlePublishContext\(args: ToolArgs\): Promise<string> \{[\s\S]{0,6000}?requiredArgsRefusal\('publish_context', args\)/.test(serverSrc),
    '★ …and publish_context also checks at its own entry, for the two internal callers',
  );
  ok(
    /if \(!entry\) throw new Error\(`ENFORCED_REQUIRED_ARGS names an unregistered tool/.test(serverSrc),
    '★ a table entry naming no real tool fails the BOOT rather than guarding nothing',
  );
  {
    // ★ THE COMMENT ABOVE gateRequiredArgs IS A CHECKED FACT, NOT A BELIEF.
    //
    // It used to read "Every dispatcher fills `pod_url` / `agent_id` from the auth context
    // BEFORE calling the handler", which sized the gate's blast radius — and it was false
    // for three of the four dispatchers it named. Only `/mcp` fills `pod_url`; `/tool/:name`
    // and `/messages` fill `agent_id`/`owner_webid`/`pod_name` and deliberately not
    // `pod_url` (it is a TARGET there), and the interop path injects nothing.
    //
    // A wrong comment about coverage is worse than a missing one, because the next person
    // to add a `pod_url`-keyed tool sizes their change by it. So the count is asserted: if
    // someone adds a second injection site, this fails and the comment gets re-read rather
    // than silently becoming true-by-accident or false in a new way.
    // Comments are stripped first — the comment being pinned QUOTES `args.pod_url =` to
    // name what it is talking about, and a scan that counted its own documentation would
    // report 2 and fail on a correct file. Block comments, then whole-line `//` and jsdoc
    // `*` continuations only: stripping from a mid-line `//` would eat the `//` in every
    // URL literal and could hide a real assignment.
    const code = serverSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    // `=` not `==`, and whitespace-insensitive, so a reformat cannot silently zero this out.
    const injections = [...code.matchAll(/args\.pod_url\s*=(?!=)/g)].length;
    ok(injections === 1,
      '★ exactly ONE dispatcher injects pod_url — the comment above gateRequiredArgs says so by name',
      `found ${injections} \`args.pod_url =\` assignment sites`);
  }
  {
    // The refusal must be reached before the pod-bootstrap PUT: a call that can never
    // write should not create a container or take the per-pod write lock on its way out.
    const body = serverSrc.slice(serverSrc.indexOf('async function handlePublishContext'));
    const guardAt = body.indexOf("requiredArgsRefusal('publish_context', args)");
    const bootstrapAt = body.indexOf('if (!bootstrappedPods.has(podUrl))');
    const mutexAt = body.indexOf('return await withPodMutex(podUrl');
    ok(guardAt > 0 && guardAt < bootstrapAt && guardAt < mutexAt,
      '★ and it refuses BEFORE the pod-bootstrap PUT and before the per-pod mutex',
      `guard@${guardAt} bootstrap@${bootstrapAt} mutex@${mutexAt}`);
  }

  if (fail > 0) {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, 0 failed\n`);
}

main();
