/**
 * A learner finds the SCORM packages this bridge hosts on their Learn page and launches one as a
 * cmi5 course, signed as themselves; an operator hosts one from the LMS content panel.
 *
 * ★ WHY. The bridge hosts uploaded packages, each document in a sandbox of its own, and plays them
 * through the signed cmi5 launch (src/scorm-hosting.ts). A person had no way to reach any of it:
 * the upload was an MCP tool, the list did not exist, and the launch was a signed POST. Now:
 * - the bridge lists what it hosts at `GET /scorm/packages`, linked from its entry point as
 *   `scorm-packages`, so a page and an agent find it the same way;
 * - the Learn page lists them and launches one with the `foxxi.cmi5_launch_signed` affordance, as
 *   the learner, and opens the launch in a tab of its own (the package cannot be framed here, being
 *   sandboxed on the bridge), with no opener and no referrer handed to it;
 * - the operator's LMS content panel hosts a package with `foxxi.upload_scorm_package`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { hostedPackagesFrom, launchUrlFrom } from '../dashboard-app/src/learn/hosted-packages.js';
import { attachHypermediaRoutes } from '../src/hypermedia-resources.js';

const SHA = 'a'.repeat(64);
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('what the Learn page reads of the bridge', () => {
  it('keeps only the well-formed packages of a listing', () => {
    const good = { packageSha256: SHA, href: `https://b.example/scorm/packages/${SHA}`, course: { id: `https://b.example/scorm/packages/${SHA}`, title: 'Refunds' }, aus: [{ id: 'https://b.example/au/0', title: 'Refunds' }, { id: 7 }] };
    expect(hostedPackagesFrom({ packages: [
      good,
      { ...good, packageSha256: 'not-a-sha' },
      { ...good, href: 'javascript:alert(1)' },
      { ...good, course: { id: 'javascript:alert(1)', title: 'x' } },
      { ...good, course: { id: good.course.id } },
      null,
    ] })).toEqual([{ ...good, aus: [{ id: 'https://b.example/au/0', title: 'Refunds' }] }]);
    expect(hostedPackagesFrom({})).toEqual([]);
    expect(hostedPackagesFrom(null)).toEqual([]);
  });

  it('opens only an http(s) launch URL', () => {
    expect(launchUrlFrom({ launchUrl: `https://b.example/scorm/packages/${SHA}/files/index.html?endpoint=x` })).toBe(`https://b.example/scorm/packages/${SHA}/files/index.html?endpoint=x`);
    for (const bad of [{ launchUrl: 'javascript:alert(1)' }, { launchUrl: 'data:text/html,x' }, { launchUrl: 7 }, {}, null]) expect(launchUrlFrom(bad)).toBeNull();
  });
});

describe('the Learn page', () => {
  const card = read('../dashboard-app/src/components/HostedPackagesCard.tsx');
  it('lists what the entry point links, and launches with the signed cmi5 launch, as the learner', () => {
    expect(card).toContain("const listHref = linkOf(entry, 'scorm-packages');");
    expect(card).toContain("const launcher = useAffordance('foxxi.cmi5_launch_signed');");
    expect(card).toContain('launchUrlFrom(await postSigned(launcher.href, signerFor(session), { course_id: p.course.id }))');
    // The list needs no signature: it is fetched plainly, not signed.
    expect(card).toMatch(/fetch\(listHref, \{ headers: \{ Accept: 'application\/json' \} \}\)/);
    expect(read('../dashboard-app/src/components/LearnPanel.tsx')).toContain('<HostedPackagesCard session={session} />');
  });

  it('opens a launch in a tab of its own, handing it no opener and no referrer', () => {
    expect(card).toContain('<a href={l.url} target="_blank" rel="noopener noreferrer">');
    expect(card).not.toMatch(/window\.open|<iframe/);
  });
});

describe('the operator\'s LMS content panel', () => {
  it('hosts a package with foxxi.upload_scorm_package, and says so, or why not', () => {
    const panel = read('../dashboard-app/src/components/LmsContentPanel.tsx');
    expect(panel).toContain("type Tool = 'upload' | 'host' | 'oneroster' | 'launch';");
    expect(panel).toContain("{origin && tool === 'host' && <HostPackage origin={origin} bearer={bearer} />}");
    expect(panel).toMatch(/mcpCall\(origin, bearer, 'foxxi\.upload_scorm_package', \{ zip_base64: await fileToBase64\(file\),/);
    expect(panel).toContain("{result?.hosted === false && <div style={{ color: 'var(--bad)', fontSize: 12 }}>Read, but not hosted: {result.hostedWhy ?? 'the bridge did not say why'}</div>}");
  });
});

describe('the entry point', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    attachHypermediaRoutes(app, { selfBaseUrl: 'https://bridge.example', affordances: [] });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('links the packages hosted here, so a page and an agent find them the same way', async () => {
    const entry = await (await fetch(`${base}/api/foxxi/v1`)).json() as { _links: Record<string, { href: string }> };
    expect(entry._links['scorm-packages']?.href).toBe('https://bridge.example/scorm/packages');
  });
});
