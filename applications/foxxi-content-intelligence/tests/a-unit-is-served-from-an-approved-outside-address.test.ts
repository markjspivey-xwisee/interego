/**
 * A cmi5 package's unit may be served from an address outside the package, where the operator
 * approved that address.
 *
 * Every file of a hosted package is served in a sandbox with an opaque origin, so that nothing of
 * the bridge's is a package's own. A browser gives a page in that state no microphone and no
 * camera. Found 2026-11-20: a unit that holds a live voice call, launched from a hosted package,
 * was refused its microphone before it asked for a call. cmi5 lets a course structure give a unit
 * an absolute address; such a unit is served by whoever serves that address, in an origin of its
 * own, and the sandbox for a package's files stays as it is.
 *
 * Which addresses is the operator's to say (FOXXI_CMI5_OUTSIDE_AU_PREFIXES). With none said, no
 * unit is served from outside, which is how it was.
 *
 * Checked here: the functions of src/scorm-hosting.ts, and what the LMS builds for a launch. The
 * bridge's own wiring of the setting (bridge/server.ts) is read as text at the end; the bridge is
 * not started.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HostedPackages, aboutFrom, cmi5OutsideUnits, cmi5PackageUnits, hostedPackageCourse, outsideUnitAllowed, outsideUnitPrefixes, OUTSIDE_UNITS_MAX } from '../src/scorm-hosting.js';
import { buildCmi5Launch } from '../src/cmi5-lms.js';
import type { Cmi5AuNode } from '../src/cmi5-course.js';
import type { TenantId } from '../src/tenant-context.js';

const BRIDGE = 'https://bridge.example';
const SHA = 'b'.repeat(64);
const DOCS = 'https://docs.example/courses/';
const PLAYER = `${DOCS}player/index.html`;
const au = (attrs: string, url: string, inner = ''): string =>
  `<au id="https://publisher.example/au/${encodeURIComponent(url)}" ${attrs}><title><langstring lang="en-US">Unit</langstring></title><url>${url}</url>${inner}</au>`;
const structure = (...units: string[]): string =>
  `<?xml version="1.0"?><courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd"><course id="https://publisher.example/course"><title><langstring lang="en-US">Course</langstring></title></course>${units.join('')}</courseStructure>`;

describe('the operator\'s list of where a unit may be served from', () => {
  it('is https addresses ending in a slash, and names anything else it was given', () => {
    expect(outsideUnitPrefixes(`${DOCS}, https://other.example/  https://DOCS.example/courses/`)).toEqual({ prefixes: [DOCS, 'https://other.example/'], ignored: [] });
    const bad = ['http://docs.example/', 'https://docs.example/courses', 'https://docs.example/a/?x=1', 'https://user:pw@docs.example/', 'https://docs.example/#top', 'docs.example/', 'javascript:alert(1)//', '*'];
    expect(outsideUnitPrefixes(bad.join(' '))).toEqual({ prefixes: [], ignored: bad });
    for (const none of [undefined, '', '  ', 7, null]) expect(outsideUnitPrefixes(none)).toEqual({ prefixes: [], ignored: [] });
  });

  it('approves an address that begins with an entry, as a browser would resolve it, and no other', () => {
    const list = [DOCS];
    for (const yes of [PLAYER, `${DOCS}`, `${DOCS}a/b/c.html?scenario=x`, 'HTTPS://DOCS.EXAMPLE/courses/unit.html', 'https://docs.example:443/courses/unit.html']) expect(outsideUnitAllowed(yes, list), yes).toBe(true);
    for (const no of [
      'https://docs.example/course', 'https://docs.example/other/unit.html', 'https://docs.example/courses/../other/unit.html', 'https://docs.example/courses/%2e%2e/other/unit.html',
      'https://docs.example.evil.example/courses/unit.html', 'https://evil.example/https://docs.example/courses/', 'http://docs.example/courses/unit.html',
      'https://user@docs.example/courses/unit.html', `${PLAYER}#frag`, 'https://docs.example:8443/courses/unit.html', '//docs.example/courses/unit.html', 'index.html', '',
    ]) expect(outsideUnitAllowed(no, list), no).toBe(false);
    // With nothing approved, nothing is.
    expect(outsideUnitAllowed(PLAYER, [])).toBe(false);
  });
});

describe('what a course structure says of units served from outside', () => {
  it('is each such unit\'s address, moveOn, mastery score and launch parameters, and no unit that is a file of the package', () => {
    const xml = structure(
      au('moveOn="CompletedAndPassed" masteryScore="0.8"', PLAYER, '<launchParameters>call=live</launchParameters>'),
      au('moveOn="Passed"', 'index.html'),
      `<block id="https://publisher.example/block"><title><langstring lang="en-US">Block</langstring></title>${au('', 'https://elsewhere.example/unit.html')}</block>`,
    );
    expect(cmi5OutsideUnits(xml)).toEqual([
      { url: PLAYER, moveOn: 'CompletedAndPassed', masteryScore: 0.8, launchParameters: 'call=live' },
      { url: 'https://elsewhere.example/unit.html' },
    ]);
    // What it says of the package's own files is read as before, and says nothing of these.
    expect(cmi5PackageUnits(xml, ['index.html'])).toEqual({ 'index.html': { moveOn: 'Passed' } });
  });

  it('takes no address that is not plain https, takes one address once, and stops at a limit', () => {
    const not = ['http://docs.example/unit.html', 'https://user:pw@docs.example/unit.html', `${PLAYER}#x`, 'ftp://docs.example/unit.html', '//docs.example/unit.html', 'javascript:alert(1)', 'data:text/html,hi'];
    expect(cmi5OutsideUnits(structure(...not.map((u) => au('', u))))).toBeUndefined();
    expect(cmi5OutsideUnits(structure(au('moveOn="Passed"', PLAYER), au('moveOn="Completed"', PLAYER)))).toEqual([{ url: PLAYER, moveOn: 'Passed' }]);
    const many = Array.from({ length: OUTSIDE_UNITS_MAX + 5 }, (_, i) => au('', `${DOCS}unit-${i}.html`));
    expect(cmi5OutsideUnits(structure(...many))).toHaveLength(OUTSIDE_UNITS_MAX);
    for (const none of ['<manifest/>', 'not xml', '']) expect(cmi5OutsideUnits(none)).toBeUndefined();
  });
});

describe('the course a hosted package becomes', () => {
  const about = { title: 'Refund call', launchable: [] as string[], outside: [{ url: 'https://elsewhere.example/unit.html' }, { url: PLAYER, moveOn: 'CompletedAndPassed' as const, launchParameters: 'call=live' }] };

  it('has a unit at an outside address only where the operator approved it', () => {
    // No list, as on every bridge before this: the package has nothing to play.
    expect(hostedPackageCourse(BRIDGE, SHA, about).structure).toEqual([]);
    expect(hostedPackageCourse(BRIDGE, SHA, about, []).structure).toEqual([]);
    const course = hostedPackageCourse(BRIDGE, SHA, about, [DOCS]);
    expect(course.id).toBe(`${BRIDGE}/scorm/packages/${SHA}`);
    expect(course.structure).toEqual([{ kind: 'au', id: `${BRIDGE}/scorm/packages/${SHA}/au/outside/1`, title: 'Refund call', url: PLAYER, moveOn: 'CompletedAndPassed', launchMethod: 'AnyWindow', launchParameters: 'call=live' }]);
  });

  it('keeps a unit\'s id when the list changes, and a package\'s own files as they were', () => {
    const both = hostedPackageCourse(BRIDGE, SHA, { ...about, launchable: ['index.html'] }, [DOCS, 'https://elsewhere.example/']).structure as Cmi5AuNode[];
    expect(both.map((a) => a.id.split('/au/')[1])).toEqual(['0', 'outside/0', 'outside/1']);
    expect(both.map((a) => a.title)).toEqual(['Refund call (1 of 3)', 'Refund call (2 of 3)', 'Refund call (3 of 3)']);
    expect(both[0]!.url).toBe(`${BRIDGE}/scorm/packages/${SHA}/files/index.html`);
    const one = hostedPackageCourse(BRIDGE, SHA, { ...about, launchable: ['index.html'] }, [DOCS]).structure as Cmi5AuNode[];
    expect(one.map((a) => a.id.split('/au/')[1])).toEqual(['0', 'outside/1']);
    // An authoring tool's own export launches nothing, whatever is said of it and whatever the list.
    expect(hostedPackageCourse(BRIDGE, SHA, { title: 'An export', launchable: [], exportOf: 'h5p', outside: [{ url: PLAYER }] }, [DOCS]).structure).toEqual([]);
    // A package with no outside unit is the course it always was, whatever the list.
    const plain = { title: 'A SCORM course', launchable: ['index.html'] };
    expect(hostedPackageCourse(BRIDGE, SHA, plain, [DOCS])).toEqual(hostedPackageCourse(BRIDGE, SHA, plain));
  });

  it('is launched at that address, with the launch\'s own parameters added to it', () => {
    const unit = (hostedPackageCourse(BRIDGE, SHA, about, [DOCS]).structure as Cmi5AuNode[])[0]!;
    const launch = buildCmi5Launch({
      au: { id: unit.id, url: unit.url, moveOn: unit.moveOn, title: unit.title, launchParameters: unit.launchParameters! },
      learner: { id: 'did:web:id.example:users:learner-1' }, lrsEndpoint: `${BRIDGE}/xapi`, fetchBaseUrl: `${BRIDGE}/cmi5/fetch`, authoritativeSource: 'did:web:bridge.example', tenant: 'lens:outside-unit' as TenantId,
    });
    const u = new URL(launch.launchUrl);
    expect(`${u.origin}${u.pathname}`).toBe(PLAYER);
    expect([u.searchParams.get('endpoint'), u.searchParams.get('registration')]).toEqual([`${BRIDGE}/xapi`, launch.registration]);
    expect(u.searchParams.get('fetch')).toMatch(new RegExp(`^${BRIDGE}/cmi5/fetch/`));
  });
});

describe('a package\'s description', () => {
  it('keeps well-formed outside units, with or without files of its own, and drops the rest', () => {
    const body = (launchable: string[], outside: unknown) => ({ packageSha256: SHA, title: 'Refund call', launchable, outside });
    expect(aboutFrom(SHA, body([], [{ url: PLAYER, moveOn: 'CompletedAndPassed', masteryScore: 2, launchParameters: 'call=live', extra: true }, { url: 'http://docs.example/x' }, 'no', null, { url: PLAYER, moveOn: 'Passed' }]))).toEqual({
      title: 'Refund call', launchable: [], outside: [{ url: PLAYER, moveOn: 'CompletedAndPassed', launchParameters: 'call=live' }],
    });
    expect(aboutFrom(SHA, body(['index.html'], [{ url: PLAYER }]))).toEqual({ title: 'Refund call', launchable: ['index.html'], outside: [{ url: PLAYER }] });
    // Nothing to launch, inside or out, is still not a description.
    for (const none of [undefined, [], 'x', [{ url: 'index.html' }]]) expect(aboutFrom(SHA, body([], none))).toBeNull();
    // An export launches nothing, whatever is beside it.
    expect(aboutFrom(SHA, { ...body([], [{ url: PLAYER }]), exportOf: 'h5p' })).toEqual({ title: 'Refund call', launchable: [], exportOf: 'h5p' });
    // One kept before outside units were reads as it did.
    expect(aboutFrom(SHA, { packageSha256: SHA, title: 'Refund call', launchable: ['index.html'] })).toEqual({ title: 'Refund call', launchable: ['index.html'] });
  });

  it('is kept beside the package and read back with its outside units', async () => {
    const put: { url: string; body: unknown }[] = [];
    const fetchFn = (async (input: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PUT') { put.push({ url: String(input), body: JSON.parse(String(init.body)) }); return new Response('', { status: 201 }); }
      const kept = put.find((p) => p.url === String(input));
      return kept ? new Response(JSON.stringify(kept.body), { status: 200 }) : new Response('', { status: 404 });
    }) as typeof fetch;
    const store = new HostedPackages({ podUrl: 'https://pod.example/tenant/', fetch: fetchFn });
    await store.keepAbout(SHA, { title: 'Refund call', launchable: [], outside: [{ url: PLAYER, moveOn: 'CompletedAndPassed' }] });
    expect(put).toHaveLength(1);
    expect(put[0]!.body).toEqual({ packageSha256: SHA, title: 'Refund call', launchable: [], outside: [{ url: PLAYER, moveOn: 'CompletedAndPassed' }] });
    // A second store, as after a restart, reads it from the pod.
    const again = new HostedPackages({ podUrl: 'https://pod.example/tenant/', fetch: fetchFn });
    expect(await again.about(SHA)).toEqual({ title: 'Refund call', launchable: [], outside: [{ url: PLAYER, moveOn: 'CompletedAndPassed' }] });
    // Nothing to launch at all is not kept.
    await store.keepAbout('c'.repeat(64), { title: 'Empty', launchable: [] });
    expect(put).toHaveLength(1);
  });
});

describe('the bridge\'s wiring of the setting', () => {
  const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');

  it('reads the list once from FOXXI_CMI5_OUTSIDE_AU_PREFIXES and warns of an entry it ignores', () => {
    expect(server.match(/process\.env\.FOXXI_CMI5_OUTSIDE_AU_PREFIXES/g)).toHaveLength(1);
    expect(server).toContain('const outsideAuPrefixes = outsideUnitPrefixes(process.env.FOXXI_CMI5_OUTSIDE_AU_PREFIXES);');
    expect(server).toMatch(/for \(const entry of outsideAuPrefixes\.ignored\) bridgeWarn\(/);
  });

  it('builds every hosted package\'s course with that list: on upload, on restore, and in the listing', () => {
    // Each call in the bridge passes the list; a call without it would make a course with no outside unit.
    const calls = [...server.matchAll(/hostedPackageCourse\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) expect(args, args).toContain('outsideAuPrefixes.prefixes');
    expect(server).toMatch(/attachHostedPackageRoutes\(app, \{\s*packages: hostedPackages,\s*bridgeBaseUrl,\s*outsidePrefixes: outsideAuPrefixes\.prefixes,/);
  });

  it('tells whoever brought a package which of its outside units are not approved', () => {
    expect(server).toContain('const notApproved = (outside ?? []).filter(u => !outsideUnitAllowed(u.url, outsideAuPrefixes.prefixes)).map(u => u.url);');
    expect(server).toMatch(/hosted: false,\s*hostedWhy: notApproved\.length/);
    expect(server).toContain('...(notApproved.length ? { outsideUnitsNotApproved: notApproved } : {}),');
  });
});
