/**
 * A cmi5 package hosted on the bridge is satisfied by what its own course structure says.
 *
 * Every hosted unit used to move on when it completed or passed, written into the code. A SCORM
 * package has no rule of its own, so that is right for one. A cmi5 package says what satisfies each
 * unit, and a unit declared `CompletedAndPassed` was satisfied here by a `completed` alone: a
 * learner who failed and finished had satisfied it. Found on the first run against the deployed
 * bridge, 2026-11-15, where a package declaring `CompletedAndPassed` launched as `CompletedOrPassed`.
 */
import { describe, expect, it } from 'vitest';
import { aboutFrom, cmi5PackageUnits, hostedPackageCourse } from '../src/scorm-hosting.js';
import { buildCmi5Launch, observeCmi5Statement } from '../src/cmi5-lms.js';
import type { Cmi5AuNode } from '../src/cmi5-course.js';
import type { TenantId } from '../src/tenant-context.js';

const BRIDGE = 'https://bridge.example';
const SHA = 'a'.repeat(64);
const au = (attrs: string, url: string, inner = ''): string =>
  `<au id="https://publisher.example/au/${encodeURIComponent(url)}" ${attrs}><title><langstring lang="en-US">Unit</langstring></title><url>${url}</url>${inner}</au>`;
const structure = (...units: string[]): string =>
  `<?xml version="1.0"?><courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd"><course id="https://publisher.example/course"><title><langstring lang="en-US">Course</langstring></title></course>${units.join('')}</courseStructure>`;

describe('what a course structure says of the files a package launches', () => {
  it('is each unit\'s moveOn, mastery score and launch parameters, by the file its url names', () => {
    const xml = structure(
      au('moveOn="CompletedAndPassed" masteryScore="0.8"', 'index.html', '<launchParameters>scenario=refund</launchParameters>'),
      `<block id="https://publisher.example/block"><title><langstring lang="en-US">Block</langstring></title>${au('moveOn="Passed"', './deep/unit.html')}</block>`,
    );
    expect(cmi5PackageUnits(xml, ['index.html', 'deep/unit.html'])).toEqual({
      'index.html': { moveOn: 'CompletedAndPassed', masteryScore: 0.8, launchParameters: 'scenario=refund' },
      'deep/unit.html': { moveOn: 'Passed' },
    });
  });

  it('says nothing for a unit that leaves moveOn out, and nothing it cannot read', () => {
    expect(cmi5PackageUnits(structure(au('', 'index.html')), ['index.html'])).toBeUndefined();
    expect(cmi5PackageUnits(structure(au('moveOn="WhenItFeelsLikeIt" masteryScore="7"', 'index.html')), ['index.html'])).toBeUndefined();
    expect(cmi5PackageUnits(structure(au('moveOn="Completed" masteryScore="often"', 'index.html')), ['index.html'])).toEqual({ 'index.html': { moveOn: 'Completed' } });
  });

  it('speaks only of files the package launches, and the first unit speaks for a file two units name', () => {
    const xml = structure(au('moveOn="CompletedAndPassed"', 'index.html'), au('moveOn="NotApplicable"', 'index.html'), au('moveOn="Passed"', 'https://elsewhere.example/unit.html'));
    expect(cmi5PackageUnits(xml, ['index.html'])).toEqual({ 'index.html': { moveOn: 'CompletedAndPassed' } });
    expect(cmi5PackageUnits(xml, ['other.html'])).toBeUndefined();
  });

  it('reads nothing from a document that is not a course structure', () => {
    expect(cmi5PackageUnits('<manifest identifier="x"><organizations/></manifest>', ['index.html'])).toBeUndefined();
    expect(cmi5PackageUnits('not xml at all', ['index.html'])).toBeUndefined();
    expect(cmi5PackageUnits('', ['index.html'])).toBeUndefined();
  });
});

describe('a package\'s description', () => {
  const body = (units: unknown) => ({ packageSha256: SHA, title: 'Refund call', launchable: ['index.html'], units });

  it('keeps well-formed settings for the files it launches, and drops the rest', () => {
    expect(aboutFrom(SHA, body({ 'index.html': { moveOn: 'CompletedAndPassed', masteryScore: 0.8, launchParameters: 'scenario=refund' } }))).toEqual({
      title: 'Refund call', launchable: ['index.html'], units: { 'index.html': { moveOn: 'CompletedAndPassed', masteryScore: 0.8, launchParameters: 'scenario=refund' } },
    });
    expect(aboutFrom(SHA, body({ 'index.html': { moveOn: 'Sometimes', masteryScore: 2, launchParameters: 7 }, 'other.html': { moveOn: 'Passed' } }))).toEqual({ title: 'Refund call', launchable: ['index.html'] });
    expect(aboutFrom(SHA, body({ '__proto__': { moveOn: 'NotApplicable' } }))).toEqual({ title: 'Refund call', launchable: ['index.html'] });
    expect(aboutFrom(SHA, body('CompletedAndPassed'))).toEqual({ title: 'Refund call', launchable: ['index.html'] });
  });

  it('reads as before when it was kept before units were', () => {
    expect(aboutFrom(SHA, { packageSha256: SHA, title: 'Refund call', launchable: ['index.html'] })).toEqual({ title: 'Refund call', launchable: ['index.html'] });
  });
});

describe('the course a hosted package becomes', () => {
  it('gives a cmi5 unit the rule, mastery score and launch parameters its package declared', () => {
    const course = hostedPackageCourse(BRIDGE, SHA, { title: 'Refund call', launchable: ['index.html', 'two.html'], units: { 'index.html': { moveOn: 'CompletedAndPassed', masteryScore: 0.8, launchParameters: 'scenario=refund' } } });
    const [first, second] = course.structure as Cmi5AuNode[];
    expect(first).toMatchObject({ moveOn: 'CompletedAndPassed', masteryScore: 0.8, launchParameters: 'scenario=refund' });
    // A unit the structure says nothing of, like every SCORM SCO, moves on when it completed or passed.
    expect(second!.moveOn).toBe('CompletedOrPassed');
    expect(second).not.toHaveProperty('masteryScore');
    expect(second).not.toHaveProperty('launchParameters');
  });

  it('gives a SCORM package what it always had', () => {
    const course = hostedPackageCourse(BRIDGE, SHA, { title: 'A SCORM course', launchable: ['index.html'] });
    expect((course.structure as Cmi5AuNode[])[0]!.moveOn).toBe('CompletedOrPassed');
  });
});

describe('what the LMS records for a launch of such a unit', () => {
  const tenant = 'lens:hosted-move-on' as TenantId;
  const V = (verb: string) => `http://adlnet.gov/expapi/verbs/${verb}`;
  const launchOf = (learnerId: string, units?: Record<string, { moveOn: 'CompletedAndPassed' | 'Passed' }>) => {
    const unit = (hostedPackageCourse(BRIDGE, SHA, { title: 'Refund call', launchable: ['index.html'], ...(units ? { units } : {}) }).structure as Cmi5AuNode[])[0]!;
    return buildCmi5Launch({
      au: { id: unit.id, url: unit.url, moveOn: unit.moveOn, title: unit.title },
      learner: { id: learnerId }, lrsEndpoint: `${BRIDGE}/xapi`, fetchBaseUrl: `${BRIDGE}/cmi5/fetch`, authoritativeSource: 'did:web:bridge.example', tenant,
    });
  };
  /** The LMS shown the registration's statements so far; what it emitted, and whether the unit is satisfied. */
  const shown = async (launch: ReturnType<typeof launchOf>, verbs: string[]) => {
    const statements = verbs.map(verb => ({ actor: launch.actor, verb: { id: V(verb) }, object: { id: `${BRIDGE}/scorm/packages/${SHA}/au/0` }, context: { registration: launch.registration }, ...(verb === 'passed' ? { result: { success: true, score: { scaled: 1 } } } : {}) }));
    const emitted: string[] = [];
    const result = await observeCmi5Statement(statements[statements.length - 1]!, tenant, {
      statementsForRegistration: async () => statements,
      emit: (s) => { emitted.push(String((s['verb'] as { id?: string }).id)); },
    });
    return { satisfied: result?.satisfied, emitted };
  };
  const unitsAnd = { 'index.html': { moveOn: 'CompletedAndPassed' as const } };

  it('advertises the package\'s rule on the launch', () => {
    expect(launchOf('did:ethr:0x5555555555ee00000000000000000000000000a1', unitsAnd).launchData).toMatchObject({ moveOn: 'CompletedAndPassed' });
    expect(launchOf('did:ethr:0x5555555555ee00000000000000000000000000a2').launchData).toMatchObject({ moveOn: 'CompletedOrPassed' });
  });

  it('leaves a CompletedAndPassed unit unsatisfied by failed and completed', async () => {
    const launch = launchOf('did:ethr:0x5555555555ee00000000000000000000000000b1', unitsAnd);
    expect(await shown(launch, ['failed', 'completed'])).toEqual({ satisfied: false, emitted: [] });
  });

  it('leaves it unsatisfied by passed alone, and satisfies it by passed and completed', async () => {
    const launch = launchOf('did:ethr:0x5555555555ee00000000000000000000000000b2', unitsAnd);
    expect(await shown(launch, ['passed'])).toEqual({ satisfied: false, emitted: [] });
    const both = await shown(launch, ['passed', 'completed']);
    expect(both.satisfied).toBe(true);
    expect(both.emitted).toContain('https://w3id.org/xapi/adl/verbs/satisfied');
  });

  it('satisfies a unit with no declared rule by completed alone, as before', async () => {
    const launch = launchOf('did:ethr:0x5555555555ee00000000000000000000000000b3');
    expect((await shown(launch, ['failed', 'completed'])).satisfied).toBe(true);
  });
});
