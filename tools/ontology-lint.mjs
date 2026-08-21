#!/usr/bin/env node
// Ontology consistency lint.
//
// Scans TS source for `<prefix>:<Term>` emissions and verifies each
// term exists in the corresponding `docs/ns/<prefix>.ttl` ontology.
// Catches the drift pattern where runtime code invents new predicates
// or classes without defining them, which erodes the protocol's
// self-description guarantee.
//
// Exit non-zero when any undefined term is found. Intended to run in
// CI so drift never lands on master.
//
// Known-external namespaces (W3C, common vocabs) are ignored — we
// don't own those, so a reference to `dcat:Distribution` is always OK.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT = resolve(__dirname, '..');

// ── Config ───────────────────────────────────────────────────

const OWNED_NAMESPACES = {
  // prefix    : ontology file
  iep:         'docs/ns/iep.ttl',      // L1 protocol — Interego Protocol (was cg:)
  ieh:        'docs/ns/harness.ttl',   // L1 harness (was cgh:)
  cg:          'docs/ns/iep.ttl',      // @deprecated alias of iep: (legacy "Context Graphs")
  cgh:         'docs/ns/harness.ttl',  // @deprecated alias of ieh:
  iprot:       'docs/ns/iep.ttl',      // tolerated synonym
  a2ap:       'docs/ns/a2a.ttl',      // A2A interop profile (published conformance profile)
  pgsl:       'docs/ns/pgsl.ttl',
  ie:         'docs/ns/interego.ttl',
  align:      'docs/ns/alignment.ttl',
  hyprcat:    'docs/ns/hyprcat.ttl',
  hypragent:  'docs/ns/hypragent.ttl',
  hela:       'docs/ns/hela.ttl',
  sat:        'docs/ns/sat.ttl',
  cts:        'docs/ns/cts.ttl',
  olke:       'docs/ns/olke.ttl',
  amta:       'docs/ns/amta.ttl',
  // L2 pattern ontologies
  abac:       'docs/ns/abac.ttl',
  registry:   'docs/ns/registry.ttl',
  passport:   'docs/ns/passport.ttl',
  // Domain ontologies (L3)
  code:       'docs/ns/code.ttl',
  // Compliance / regulatory mapping (L3)
  'eu-ai-act': 'docs/ns/eu-ai-act.ttl',
  'nist-rmf':  'docs/ns/nist-rmf.ttl',
  soc2:       'docs/ns/soc2.ttl',
  // ★ `demo:` IS DELIBERATELY NOT OWNED HERE, and the reason is a real limitation of this check.
  // Demo scenarios bind `demo:` to FOUR different namespaces and use it for BOTH vocabulary
  // (`demo:Hypothesis`, `demo:statement`) and minted instance names
  // (`demo:second-contact-escalation`). This lint keys on the PREFIX, not the binding, so it
  // cannot tell a term that should be declared from an instance that should not — owning it
  // would demand a declaration for every name a scenario invents. The vocabulary that was
  // squatting `iep:` now lives in docs/ns/demo.ttl and dereferences; that was the defect.
};

// There is deliberately no EXTERNAL_PREFIXES list here. One existed and was dead: this
// linter iterates OWNED_NAMESPACES (line 232) and never looks at any other prefix, so
// external vocabularies are excluded by CONSTRUCTION, not by an allowlist. A second list
// naming `rdf`/`sh`/`prov`/... only looked like it was doing that work, and would have
// drifted out of agreement with the real rule the first time either changed.

const SCAN_PATHS = [
  // Substrate kernel + every per-vertical @interego/* package.
  'packages',
  'deploy/identity',
  'deploy/mcp-relay',
  'mcp-server',
  // Vertical applications — the layer with the highest domain-term pressure,
  // so their use of CORE prefixes (iep:/ieh:/pgsl:/…) is self-description-checked
  // too. Vertical-OWNED prefixes (fxs:/lpc:/…) are unowned here and ignored.
  'applications',
  /**
   * ★★ `integrations/` WAS MISSING, AND THAT IS EXACTLY WHERE THE UNDECLARED TERM SURVIVED.
   *
   * `integrations/compliance-overlay` cited `eu-ai-act:Article10` and `nist-rmf:MG-3.1` as
   * `dct:conformsTo` targets. Neither was declared anywhere. This lint checks precisely that —
   * every owned-namespace term a source file emits must exist in its docs/ns/*.ttl — and it would
   * have caught both on the commit that introduced them, except that it never looked in this
   * directory. The allowlist file's own header records this same bug class being caught in
   * `packages/ops`; one directory over, it was unguarded.
   *
   * The consequence was not cosmetic: the compliance scorer counted those citations as no evidence,
   * so every EU AI Act and NIST RMF descriptor the project's own bridge produced scored `missing`.
   */
  'integrations',
  /**
   * ★★ `demos/` WAS UNSCANNED, AND IT HELD 33 UNDECLARED TERMS.
   *
   * Among them: a dead `iep:` prefix bound to the pre-rename namespace (404), `sat:SemioticFacet`
   * under the wrong prefix, `iep:Constitution` where the substrate declares
   * `iep:ConstitutionalPolicy`, and thirteen game / query / metric terms minted straight into the
   * PROTOCOL namespace — `iep:gameId`, `iep:winner`, `iep:moves`, `iep:rowCount`.
   *
   * That is the third directory this lint could not see (after `integrations/` and most of
   * `applications/`), and each time the same shape: real drift, invisible, in a place nobody
   * thought to point the check at. A demo publishes descriptors to real pods; its vocabulary is
   * as public as anything else.
   */
  'demos',
];

// Known-drift baseline. Entries here are terms emitted by code that
// aren't yet in the ontology — tracked so CI doesn't block on
// accumulated pre-existing drift, but new drift still fails. Over
// time, items migrate OUT of this file INTO docs/ns/<prefix>.ttl and
// the allowlist shrinks. A grown allowlist is a signal to schedule
// an ontology-definition pass.
const ALLOWLIST_PATH = 'tools/ontology-lint.allowlist.txt';

const TS_EXTS = new Set(['.ts', '.mts', '.cts']);

// ── Ontology extraction ─────────────────────────────────────

/**
 * Parse a .ttl file and return the set of locally-defined term names
 * (the Xxx in `prefix:Xxx a owl:Class`, `prefix:xxx a owl:ObjectProperty`,
 * etc.). Approximate parser — matches bare `prefix:Name ` at the start
 * of declarations, which covers how every ontology in this project is
 * written. Also picks up `a prefix:Xxx` on the right-hand side since
 * individuals of owned classes are also "defined".
 */
function extractDefinedTerms(ttlPath, prefix) {
  const body = readFileSync(ttlPath, 'utf8');
  const defined = new Set();
  // Lines like: `iep:Foo a owl:Class ;` or `iep:foo a owl:ObjectProperty ;`
  // ★ A dotted control identifier is ONE local name, not a stem plus punctuation.
  // `soc2:CC6.1` and `nist-rmf:Govern.1.1` are declared with the dot IN the name.
  // Without the `(?:\.[0-9]+)*` tail this regex matched `CC6`, then demanded `\s+a\s`,
  // found `.`, and captured NOTHING — so every dotted declaration in soc2.ttl and
  // nist-rmf.ttl was invisible to the lint, and eleven allowlist entries existed only to
  // paper over that. Numeric segments ONLY, measured: every dotted term declared under
  // docs/ns/ has digits after the dot; a dot followed by letters is prose or property
  // access (`iep:TemporalFacet.validFrom` in a tool description string).
  const defRegex = new RegExp(`(?:^|\\n)\\s*${prefix}:([A-Za-z][A-Za-z0-9_-]*(?:\\.[0-9]+)*)\\s+a\\s`, 'g');
  let m;
  while ((m = defRegex.exec(body)) !== null) {
    defined.add(m[1]);
  }
  // Individuals referenced as `a iep:Xxx` — our existing iep:canPublish etc.
  // are defined by `iep:canPublish a iep:Affordance`. Since Affordance is
  // already defined by the first regex, no extra work here.
  return defined;
}

/**
 * Every local name that appears in SUBJECT position in a .ttl — i.e. at the start of a line.
 * Broader than extractDefinedTerms (which requires `a <type>`), because a control may be
 * described with only an rdfs:label and still be a real, resolvable subject.
 */
function extractSubjects(body, prefix) {
  const subjects = new Set();
  const re = new RegExp(`(?:^|\\n)${prefix}:([A-Za-z][A-Za-z0-9_-]*(?:\\.[0-9]+)*)\\s`, 'g');
  let m;
  while ((m = re.exec(body)) !== null) subjects.add(m[1]);
  return subjects;
}

/**
 * ★ THE OTHER DIRECTION: a PUBLISHED scope that names a control nothing defines.
 *
 * The scan above asks "does every term the CODE emits exist in the ontology?". That question has
 * a mirror image, and nothing asked it. Now that the compliance engine reads its control roster
 * out of each framework's `iep:ControlSet` instead of a frozen array, a member IRI that resolves
 * to nothing is not a documentation nit — it is a denominator entry that NO evidence can ever
 * satisfy. Every report would carry a permanently-`missing` control and a score depressed by a
 * typo, with no way to tell that apart from a genuine gap.
 *
 * This is deliberately a dangling-reference check and not a "controls must be in scope" check.
 * The inverse cannot be written precisely: nist-rmf.ttl declares function-level individuals
 * (nist-rmf:MG) and short-code aliases (nist-rmf:MG-1.2) alongside controls, and no published
 * property separates them from scope members. A gate that guessed would need an allowlist to stay
 * quiet, and an allowlisted gate is the thing it replaces.
 */
function checkControlSets() {
  const problems = [];
  // Several prefixes share one file (iep/cg/iprot all resolve to iep.ttl), so iterate FILES.
  // Keyed on the prefix that owns the file's own terms — the first prefix pointing at it.
  const seen = new Set();
  for (const [prefix, file] of Object.entries(OWNED_NAMESPACES)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const path = resolve(ROOT, file);
    let body;
    try { body = readFileSync(path, 'utf8'); } catch { continue; }
    /**
     * An INSTANCE of the class, not a mention of it. `body.includes('iep:ControlSet')` also matched
     * docs/ns/iep.ttl, which merely DECLARES the term (`iep:ControlSet a owl:Class`) and publishes
     * no scope of its own — so the zero-members rule below reported the ontology that defines the
     * vocabulary as a broken user of it.
     */
    if (!/\ba\s+iep:ControlSet\b/.test(body)) continue;
    const subjects = extractSubjects(body, prefix);
    // `iep:control` objects run to the clause terminator. A `;` or `.` only ends a clause when
    // whitespace-delimited — the dots inside `soc2:CC6.1` never are, so they stay part of the name.
    //
    // The leading indent requires PREDICATE position. Without it this matched `iep:control`'s own
    // declaration in iep.ttl (`iep:control a owl:ObjectProperty ;`, at column 0) and read the type
    // as a member list — a check that reported the term defining it as its own dangling reference.
    const listRe = /(?:^|\n)[ \t]+iep:control\b([\s\S]*?)(?:\s[;.](?:\s|$))/g;
    /**
     * ★★ A GATE THAT MATCHED NOTHING PRINTED THE SAME LINE AS A GATE THAT CHECKED EVERYTHING.
     *
     * The file is only examined at all because it contains `iep:ControlSet`, so it publishes a
     * scope by construction. If the member-list regex then matches zero times, the honest reading
     * is "this check could not parse the thing it exists to check" — but `problems` stayed empty
     * and the run printed "every published iep:control member resolves" and exited 0. Any legal
     * reformatting that the regex does not anticipate (a full-IRI predicate, the list on the same
     * line as the subject) would silently disarm it, and the output would be indistinguishable
     * from a real pass.
     *
     * Counting what was actually inspected is the difference between "clean" and "blind". A file
     * that declares a ControlSet and yields no members is now a failure in its own right.
     */
    let membersSeen = 0;
    let m;
    while ((m = listRe.exec(body)) !== null) {
      for (const raw of m[1].split(',')) {
        const member = raw.trim();
        if (!member) continue;
        // A `#` comment inside the object list is Turtle, not a member.
        if (member.startsWith('#')) continue;
        membersSeen++;
        const parts = /^([A-Za-z][A-Za-z0-9_-]*):([A-Za-z][A-Za-z0-9_-]*(?:\.[0-9]+)*)$/.exec(member);
        if (!parts) { problems.push({ file, member, why: 'not a parseable CURIE' }); continue; }
        if (parts[1] !== prefix) { problems.push({ file, member, why: `foreign prefix (expected ${prefix}:)` }); continue; }
        if (!subjects.has(parts[2])) problems.push({ file, member, why: 'named by iep:control but declared nowhere in this ontology' });
      }
    }
    if (membersSeen === 0) {
      problems.push({
        file,
        member: '(none parsed)',
        why: 'declares an iep:ControlSet but this check parsed ZERO members from it — the scope is '
          + 'unverified, not verified-clean. Either the member list is written in a form this check '
          + 'does not read (a full-IRI predicate, or the list inline on the subject line), or the '
          + 'scope is empty. Both are failures: the engine still reads this file for its roster.',
      });
    }
  }
  return problems;
}

// ── TS source scan ──────────────────────────────────────────

// Test files use ILLUSTRATIVE, deliberately-fake namespace terms as fixtures
// (iep:q, iep:verifyAndDelete, iep:AskInputShape, …) — they are NOT production
// emissions and must never be linted as ontology drift. The `tests/` directory is
// skipped below; this also skips co-located test files (foo.test.ts, foo.spec.ts,
// and the relay's _*-test.ts convention), so a NEW test file can never re-break
// this lint. Keep this in sync with the vitest/tsx test globs.
const TEST_FILE_RE = /(?:\.(?:test|spec)|-test)\.[mc]?ts$/;

function* walkFiles(dir) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'tests' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      yield* walkFiles(full);
    } else if (TS_EXTS.has(full.slice(full.lastIndexOf('.'))) && !TEST_FILE_RE.test(entry)) {
      yield full;
    }
  }
}

// Map JS template-variable names (e.g. `${CG}Foo`, `${CGH_NS}Foo`) back
// to the lint prefix they emit. Code that constructs full IRIs via
// template literals over a namespace constant is otherwise invisible to
// the curie-only refRegex below — which is how iep:MintResult /
// iep:ToolResult / iep:RelayEntryPoint drift accumulated unnoticed even
// with ontology-lint in CI.
const TEMPLATE_VAR_TO_PREFIX = {
  IEP: 'iep', IEP_NS: 'iep',
  IEH: 'ieh', IEH_NS: 'ieh',
  // CG/CGH are retained TS symbols whose VALUES are now the iep:/ieh: namespaces,
  // so their template terms live in iep.ttl / harness.ttl.
  CG: 'iep', CG_NS: 'iep',
  CGH: 'ieh', CGH_NS: 'ieh',
  PGSL: 'pgsl', PGSL_NS: 'pgsl',
  IE: 'ie', IE_NS: 'ie', INTEREGO: 'ie', INTEREGO_NS: 'ie',
  ALIGN: 'align', ALIGN_NS: 'align', ALIGNMENT: 'align', ALIGNMENT_NS: 'align',
  HYPRCAT: 'hyprcat', HYPRCAT_NS: 'hyprcat',
  HYPRAGENT: 'hypragent', HYPRAGENT_NS: 'hypragent',
  HELA: 'hela', HELA_NS: 'hela',
  SAT: 'sat', SAT_NS: 'sat',
  CTS: 'cts', CTS_NS: 'cts',
  OLKE: 'olke', OLKE_NS: 'olke',
  AMTA: 'amta', AMTA_NS: 'amta',
  ABAC: 'abac', ABAC_NS: 'abac',
  REGISTRY: 'registry', REGISTRY_NS: 'registry',
  PASSPORT: 'passport', PASSPORT_NS: 'passport',
  CODE: 'code', CODE_NS: 'code',
  EU_AI_ACT: 'eu-ai-act', EU_AI_ACT_NS: 'eu-ai-act', EUAI: 'eu-ai-act', EUAI_NS: 'eu-ai-act',
  NIST_RMF: 'nist-rmf', NIST_RMF_NS: 'nist-rmf', NISTRMF: 'nist-rmf', NISTRMF_NS: 'nist-rmf',
  SOC2: 'soc2', SOC2_NS: 'soc2',
  // The publish gate's constraint components (deploy/mcp-relay/shape-body.ts). Its two
  // pre-existing terms were emitted for months and declared nowhere, because the constant
  // used to carry HALF the local name (`…/iep#shape` + `Unfetchable`) — so the term this
  // scanner saw was `Unfetchable`, which is not the term the relay emits. A namespace
  // constant that stops short of the `#` is the one shape this check cannot see through;
  // the constant was split at the `#` in the same change that added this entry.
  PUBLIC_SHAPE_NS: 'iep',
};

function findReferencesInFile(tsPath, prefixes) {
  const body = readFileSync(tsPath, 'utf8');
  const refs = [];
  // Scan line-by-line for `prefix:Term`, skipping `//` line comments.
  // The earlier string-bounded regex missed any term that appeared after
  // the first inner quote of a multi-line template literal (e.g. the
  // SHACL shapes Turtle, which embeds 28 `"` characters in sh:message
  // strings). Negative lookbehind for `:` or word-char still skips
  // matches inside longer URIs like `urn:iep:my-context`.
  // ★ `-` and `.` are CURIE boundaries too, and the term carries its dotted suffix.
  //
  // The old lookbehind rejected only `:` and word chars, so the CSS in
  // deploy/identity/server.ts (`style="...text-align:center..."`) matched as
  // `align:center`, and mcp-server/server.ts (`'urn:agent:claude-code:local'`) matched as
  // `code:local`. Two allowlist entries existed solely to silence that. A prefixed name can
  // never be preceded by `-` or `.`; either one means the match started mid-token. Measured
  // cost of adding them: 2 occurrences out of 1699, both those false positives.
  //
  // The `(?:\.[0-9]+)*` tail keeps `soc2:CC6.1` whole so it can be compared against the
  // declaration in soc2.ttl. Truncating to `soc2:CC6` was not merely noisy — it is
  // many-to-one, so allowlisting the stem `soc2:CC3` silently covered the UNDECLARED
  // `soc2:CC3.2` emitted by packages/ops/src/index.ts. An allowlist keyed on a truncated
  // token cannot be safe.
  //
  // ★★ THE HYPHEN BELONGS IN THE LOCAL NAME, AND LEAVING IT OUT MADE THIS CHECK PASS ON A
  // TERM THAT DID NOT EXIST.
  //
  // The declaration side (extractDefinedTerms) has always accepted `[A-Za-z0-9_-]`; this
  // usage side accepted only `[A-Za-z0-9_]`. So `nist-rmf:MG-3.1` was scanned as the term
  // `MG` — and `nist-rmf:MG` is declared, as the NamedIndividual for the *Manage function*.
  // A reference to a control that exists nowhere therefore resolved, via truncation, to a
  // real term of an entirely different kind. Every `MG-*`, `GV-*`, `MP-*` and `MS-*` control
  // in the codebase was unchecked, because its function-level individual absorbed it.
  //
  // This is the same many-to-one truncation hazard the comment above records for dots
  // (`soc2:CC3` covering an undeclared `soc2:CC3.2`), left unfixed for hyphens. The rule is
  // the general one: a local name must be compared WHOLE, so the two sides of this lint must
  // agree on where a local name ends. They now use the same character class.
  const refRegex = new RegExp(
    `(?<![-:.\\w])(${prefixes.join('|')}):([A-Za-z][A-Za-z0-9_-]*(?:\\.[0-9]+)*)`,
    'g',
  );
  const templateVars = Object.keys(TEMPLATE_VAR_TO_PREFIX);
  /**
   * ★★ THE SAME TRUNCATION AS `refRegex`, IN ITS SIBLING — FIXED ONE AND MISSED THE OTHER.
   *
   * The local-name class here was `[A-Za-z0-9_]*`, so a template emission of `${SOC2_NS}CC8.1`
   * was compared as the term `CC8`, which is declared nowhere, and the lint reported an undeclared
   * term for a citation that was correct. The mirror image of the `nist-rmf:MG-3.1` -> `MG` bug:
   * there truncation HID a real defect by landing on a declared term, here it INVENTED one by
   * landing on nothing.
   *
   * Both directions come from the same cause — the two sides of this lint disagreeing about where
   * a local name ends — so the class is now identical in all three places that need it
   * (declaration, CURIE usage, template usage).
   */
  const tmplRegex = new RegExp(
    `\\$\\{(${templateVars.join('|')})\\}([A-Za-z][A-Za-z0-9_-]*(?:\\.[0-9]+)*)`,
    'g',
  );
  let offset = 0;
  // ★ BLOCK comments must be stripped too, not just `//` lines.
  //
  // A `/** ... */` doc comment that EXPLAINS a term — "a prefixed name like iep:High
  // ends at whitespace" — was read as code emitting `iep:High`, and the lint demanded a
  // declaration for a term nothing emits. That is the same failure mode as a guard that
  // fires on its own explanation: the honest fix is documenting the hazard, and the lint
  // punished exactly that.
  //
  // Comment regions are blanked with SPACES rather than removed, so every match's index
  // still lines up with the real file offset the allowlist records.
  let inBlock = false;
  const stripComments = (raw) => {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      if (inBlock) {
        if (raw[i] === '*' && raw[i + 1] === '/') { inBlock = false; out += '  '; i++; }
        else out += ' ';
        continue;
      }
      if (raw[i] === '/' && raw[i + 1] === '*') { inBlock = true; out += '  '; i++; continue; }
      if (raw[i] === '/' && raw[i + 1] === '/') { out += ' '.repeat(raw.length - i); break; }
      out += raw[i];
    }
    return out;
  };

  for (const rawLine of body.split('\n')) {
    const line = stripComments(rawLine);
    let m;
    refRegex.lastIndex = 0;
    while ((m = refRegex.exec(line)) !== null) {
      refs.push({ prefix: m[1], term: m[2], path: tsPath, offset: offset + m.index });
    }
    tmplRegex.lastIndex = 0;
    while ((m = tmplRegex.exec(line)) !== null) {
      const prefix = TEMPLATE_VAR_TO_PREFIX[m[1]];
      if (prefix) {
        refs.push({ prefix, term: m[2], path: tsPath, offset: offset + m.index });
      }
    }
    offset += rawLine.length + 1;
  }
  return refs;
}

// ── Main ─────────────────────────────────────────────────────

const prefixes = Object.keys(OWNED_NAMESPACES);
const definedByPrefix = {};
for (const [prefix, file] of Object.entries(OWNED_NAMESPACES)) {
  definedByPrefix[prefix] = extractDefinedTerms(resolve(ROOT, file), prefix);
}

// Load the allowlist (one `prefix:term` per line). Missing-file = empty.
const allowlist = new Set();
try {
  const body = readFileSync(resolve(ROOT, ALLOWLIST_PATH), 'utf8');
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    allowlist.add(trimmed);
  }
} catch { /* no allowlist — strict mode */ }

const missing = []; // { prefix, term, path }

for (const scanPath of SCAN_PATHS) {
  const absScan = resolve(ROOT, scanPath);
  for (const tsFile of walkFiles(absScan)) {
    const refs = findReferencesInFile(tsFile, prefixes);
    for (const ref of refs) {
      if (!definedByPrefix[ref.prefix].has(ref.term)) {
        // Case-insensitive fallback — most of the ontology is case-
        // sensitive but some old code uses mixed case.
        const lowerMatch = [...definedByPrefix[ref.prefix]]
          .some(t => t.toLowerCase() === ref.term.toLowerCase());
        if (lowerMatch) continue;
        // Allowlist — pre-existing drift that is known and tracked.
        if (allowlist.has(`${ref.prefix}:${ref.term}`)) continue;
        missing.push(ref);
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────

const scopeProblems = checkControlSets();
if (scopeProblems.length > 0) {
  console.error(`\u2717 Ontology lint: ${scopeProblems.length} published iep:control member(s) resolve to nothing.\n`);
  for (const p of scopeProblems) {
    console.error(`  ${p.member}`);
    console.error(`      in ${p.file} \u2014 ${p.why}`);
  }
  console.error(`\nA scope member that names no declared subject is a control no evidence can ever`);
  console.error(`satisfy: it sits in the denominator of every report as a permanent 'missing'.\n`);
}

if (missing.length === 0 && scopeProblems.length === 0) {
  console.log(`\u2713 Ontology lint: every owned-namespace reference in TS is defined (or allowlisted),`);
  console.log(`  and every published iep:control member resolves.`);
  console.log(`  prefixes checked:    ${prefixes.join(', ')}`);
  console.log(`  allowlisted drift:   ${allowlist.size} term(s) in ${ALLOWLIST_PATH}`);
  console.log(`  defined term counts:`);
  for (const p of prefixes) {
    console.log(`    ${p}: ${definedByPrefix[p].size}`);
  }
  process.exit(0);
}

// Group by (prefix, term) for readable output
const grouped = new Map();
for (const r of missing) {
  const key = `${r.prefix}:${r.term}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(r.path);
}

if (grouped.size > 0) {
console.error(`\u2717 Ontology lint: found ${grouped.size} undefined term(s) emitted by code.`);
console.error(`  Every owned-namespace reference in TS must have a matching`);
console.error(`  declaration in its docs/ns/<prefix>.ttl file.\n`);
for (const [qn, paths] of [...grouped.entries()].sort()) {
  const uniq = [...new Set(paths.map(p => relative(ROOT, p).replace(/\\/g, '/')))];
  console.error(`  ${qn}`);
  for (const p of uniq.slice(0, 5)) {
    console.error(`      in ${p}`);
  }
  if (uniq.length > 5) console.error(`      ... and ${uniq.length - 5} more`);
}
console.error(`\nFix: either add the term to the appropriate docs/ns/*.ttl file`);
console.error(`or change the TS emission to use an existing term.`);
}
process.exit(1);
