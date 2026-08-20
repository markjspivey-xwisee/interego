/**
 * The compliance scorer's control roster is PUBLISHED DATA, read at runtime.
 *
 * It used to be `FRAMEWORK_CONTROLS`, a frozen TypeScript array. That array said SOC 2 had 16
 * controls; `docs/ns/soc2.ttl` published 25. So a report reading "100% — 16 of 16" was scoring a
 * roster nine controls short of the one the project publishes about itself, and nothing could tell
 * the two apart from the outside.
 *
 * These tests are split deliberately:
 *
 *   - The `parseControlSet` cases use synthetic Turtle, so they pin the PARSER's behaviour exactly
 *     (aliasing, refusal, membership) without depending on what today's ontology happens to say.
 *   - The `loadControlSet` / `generateFrameworkReport` cases read the REAL published ontologies,
 *     because a parser proven correct against a fixture proves nothing about the file actually
 *     shipped. The frozen array is imported purely to assert the live scope has OVERTAKEN it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join as joinPath, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IRI } from '@interego/core';
import {
  type AuditableDescriptor,
  FRAMEWORK_CONTROLS,
  generateFrameworkReport,
  loadControlSet,
  parseControlSet,
} from '@interego/compliance';

const NS = 'https://markjspivey-xwisee.github.io/interego/ns/';

const descriptor = (id: string, controls: string[], at = '2026-08-01T00:00:00.000Z'): AuditableDescriptor => ({
  id: id as IRI,
  publishedAt: at,
  evidenceForControls: controls as IRI[],
});

describe('the roster comes from the ontology, not from a frozen array', () => {
  it('reads every SOC 2 control the ontology publishes, and there are more than the array held', () => {
    const scope = loadControlSet('soc2');
    expect(scope.scopeSource).toBe('published');
    expect(scope.scopeIri).toBe(`${NS}soc2#AuditScope`);
    // The exact published count. A control added to soc2.ttl but not to its iep:ControlSet — or
    // the engine quietly reverting to the array — moves this number.
    expect(scope.controls).toHaveLength(25);
    expect(scope.controls.length).toBeGreaterThan(FRAMEWORK_CONTROLS['soc2'].length);
  });

  it('reads the published scope for all three frameworks', () => {
    for (const [framework, expected] of [['soc2', 25], ['nist-rmf', 10], ['eu-ai-act', 9]] as const) {
      const scope = loadControlSet(framework);
      expect(scope.scopeSource, framework).toBe('published');
      expect(scope.controls.length, framework).toBe(expected);
    }
  });
});

describe('a control is satisfied by any spelling the ontology publishes for it', () => {
  /**
   * eu-ai-act:Article12's own rdfs:comment says it is "used as a dct:conformsTo control target in
   * compliance evidence; realized structurally by eu-ai-act:LoggedAction". The project's own bridge
   * followed that instruction — and the scorer, matching only the canonical structural IRI, counted
   * it as no evidence at all. Every EU AI Act descriptor the repo produced scored `missing`.
   */
  it('counts an article-form citation as evidence for the structural control', () => {
    const report = generateFrameworkReport('eu-ai-act', [
      descriptor('urn:test:a', [`${NS}eu-ai-act#Article12`]),
      descriptor('urn:test:b', [`${NS}eu-ai-act#Article10`]),
    ]);
    const byIri = new Map(report.entries.map(e => [String(e.controlIri), e]));
    expect(byIri.get(`${NS}eu-ai-act#LoggedAction`)?.status).toBe('satisfied');
    expect(byIri.get(`${NS}eu-ai-act#DataGovernanceAttestation`)?.status).toBe('satisfied');
  });

  it('counts a NIST short code as evidence for the control it abbreviates', () => {
    const report = generateFrameworkReport('nist-rmf', [
      descriptor('urn:test:c', ['nist-rmf:MG-1.2' as IRI]),
    ]);
    const entry = report.entries.find(e => String(e.controlIri).endsWith('#Manage.1.2'));
    expect(entry?.status).toBe('satisfied');
  });

  it('does not count a citation of something outside the scope', () => {
    const report = generateFrameworkReport('soc2', [
      descriptor('urn:test:d', ['soc2:NotAControlAtAll' as IRI]),
    ]);
    expect(report.summary.satisfied).toBe(0);
    expect(report.summary.overallScore).toBe(0);
  });
});

describe('parseControlSet', () => {
  const scoped = (extra: string): string => `
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix iep:  <${NS}iep#> .
@prefix demo: <${NS}demo#> .

demo:One a owl:NamedIndividual ; rdfs:label "Control one" .
demo:Two a owl:NamedIndividual ; rdfs:label "Control two" .
demo:Untabled a owl:NamedIndividual ; rdfs:label "Published but out of scope" .
${extra}
demo:AuditScope a iep:ControlSet ;
    rdfs:label "Demo scope" ;
    iep:control demo:One, demo:Two .
`;

  it('takes membership from iep:control, not from rdf:type', () => {
    const set = parseControlSet(scoped(''), 'demo');
    expect(set.scopeSource).toBe('published');
    expect(set.controls.map(c => c.label).sort()).toEqual(['Control one', 'Control two']);
    // Untabled is a published individual of the same type and is deliberately NOT scored:
    // inferring membership from rdf:type would be the engine guessing at someone else's modelling.
    expect(set.controls.some(c => String(c.iri).endsWith('#Untabled'))).toBe(false);
  });

  it('folds an rdfs:seeAlso alias into the control it points at', () => {
    const set = parseControlSet(scoped('demo:AliasOfOne rdfs:seeAlso demo:One .'), 'demo');
    const one = set.controls.find(c => String(c.iri).endsWith('#One'));
    expect(one?.aliases.has(`${NS}demo#AliasOfOne`)).toBe(true);
    expect(one?.aliases.has('demo:AliasOfOne')).toBe(true);
    // An alias is a spelling of an existing control, never an additional one.
    expect(set.controls).toHaveLength(2);
  });

  /**
   * ★ An absent scope must not be reported as an empty published one.
   *
   * Returning `{ controls: [], scopeSource: 'published' }` produced a report with
   * `totalControls: 0`, `missing: 0` and `overallScore: 0/0` — NaN, which serialises to null and
   * reads as "nothing outstanding" at the exact moment the scope failed to load.
   */
  it('refuses a document that publishes no scope rather than returning an empty one', () => {
    const noScope = `
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix demo: <${NS}demo#> .
demo:One a owl:NamedIndividual ; rdfs:label "Control one" .
`;
    expect(() => parseControlSet(noScope, 'demo')).toThrow(/no iep:ControlSet/);
  });
});

/**
 * ★★ THE ONE CONDITION LOCAL TESTS CANNOT SEE: the package installed where no docs/ns is reachable.
 *
 * The relay — the only deployed service that scores these reports — installs @interego/compliance
 * from a tarball into /app/node_modules and ships no docs/ns. Every walk from there terminates at
 * the filesystem root, so `loadControlSet` selects the frozen fallback array while every test in
 * this repo, run from a tree that HAS docs/ns, proves the published one. Green here, wrong there.
 *
 * These cases run a REAL child process against the built package, because the resolution happens
 * once at module scope off `import.meta.url` and an in-process test cannot re-run it. Nesting the
 * copy deeper than the walk's 8-level bound reproduces the container's condition exactly while
 * leaving node's own dependency resolution intact.
 */
describe('the deployment can be told where the ontologies are', () => {
  const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const PROBE = joinPath(REPO, 'node_modules', '.ns-probe');
  // 8 nested segments puts the repo root out of reach of resolveNsDir's bounded walk.
  const DEEP = joinPath(PROBE, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'compliance');
  const NSDIR = joinPath(PROBE, 'nsdir');

  beforeAll(() => {
    rmSync(PROBE, { recursive: true, force: true });
    mkdirSync(DEEP, { recursive: true });
    mkdirSync(NSDIR, { recursive: true });
    cpSync(joinPath(REPO, 'packages', 'compliance', 'dist'), joinPath(DEEP, 'dist'), { recursive: true });
    cpSync(joinPath(REPO, 'packages', 'compliance', 'package.json'), joinPath(DEEP, 'package.json'));
    for (const f of ['soc2.ttl', 'nist-rmf.ttl', 'eu-ai-act.ttl']) {
      cpSync(joinPath(REPO, 'docs', 'ns', f), joinPath(NSDIR, f));
    }
  });
  afterAll(() => rmSync(PROBE, { recursive: true, force: true }));

  /**
   * Load soc2's scope in a fresh process from the relocated package, and score one descriptor
   * against it so the ALIAS behaviour of that scope is observable too, not just its width.
   */
  const probe = (nsDir?: string): { source: string; count: number; absoluteCitationSatisfied: boolean } => {
    const entry = pathToFileURL(joinPath(DEEP, 'dist', 'index.js')).href;
    const absolute = `${NS}soc2#CC6.1`;
    const script = `const m = await import(${JSON.stringify(entry)});`
      + `const s = m.loadControlSet('soc2');`
      + `const r = m.generateFrameworkReport('soc2', [{`
      + ` id: 'urn:probe', publishedAt: '2026-08-01T00:00:00.000Z',`
      + ` evidenceForControls: [${JSON.stringify(absolute)}] }]);`
      + `process.stdout.write(JSON.stringify({ source: s.scopeSource, count: s.controls.length,`
      + ` absoluteCitationSatisfied: r.summary.satisfied === 1 }));`;
    const env = { ...process.env };
    if (nsDir === undefined) delete env['INTEREGO_NS_DIR'];
    else env['INTEREGO_NS_DIR'] = nsDir;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env, encoding: 'utf8', cwd: REPO,
    });
    return JSON.parse(out) as { source: string; count: number; absoluteCitationSatisfied: boolean };
  };

  it('falls back VISIBLY when the ontologies are out of reach and nothing points at them', () => {
    const r = probe(undefined);
    expect(r.source).toBe('fallback');
    // The degradation is legible in the report rather than silent — that is the whole contract.
    expect(r.count).toBe(FRAMEWORK_CONTROLS['soc2'].length);
  });

  /**
   * ★★ A DEGRADED SCOPE MUST STILL RECOGNISE THE EVIDENCE THE SYSTEM EMITS.
   *
   * The fallback built its alias set from the frozen array's CURIE alone. Everything downstream —
   * `controlIri` on every report entry, and the `dct:conformsTo` targets compliance-overlay writes
   * — is the ABSOLUTE IRI. So a fallback deployment scored 0 of 16 rather than 16 of 16: not a
   * narrower answer but a confidently wrong one, produced by the path whose entire job is to
   * degrade safely. Asserted in the fallback process specifically, because in the published path
   * this passes for a different reason.
   */
  it('still matches an absolute-IRI citation while degraded', () => {
    const r = probe(undefined);
    expect(r.source).toBe('fallback');
    expect(r.absoluteCitationSatisfied).toBe(true);
  });

  it('reads the published scope when INTEREGO_NS_DIR points at them, as the relay image sets it', () => {
    const r = probe(NSDIR);
    expect(r.source).toBe('published');
    expect(r.count).toBe(25);
  });

  it('degrades visibly rather than crashing when the configured directory is missing', () => {
    const r = probe(joinPath(PROBE, 'does-not-exist'));
    expect(r.source).toBe('fallback');
  });
});
