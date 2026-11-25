/**
 * A unit of a hosted cmi5 package fetches its own auth-token: the bridge does not fetch it first.
 *
 * ★ WHY. Every document a hosted package serves used to get the whole sandbox bootstrap, which
 * reads the cmi5 launch and fetches the auth-token for the SCORM runtime that follows it. That is
 * what a SCORM SCO needs. A cmi5 unit is cmi5 content: it reads the same launch and fetches the
 * token itself, and the fetch URL is good once (cmi5 section 8.2). So the bridge spent the token,
 * the unit's own fetch was answered 401 "fetch token already used", and no hosted cmi5 unit could
 * start. Found on the deployed bridge, 2026-11-25, by hosting a cmi5 package and opening its
 * launch in a browser.
 *
 * Now a document of a package with a cmi5 course structure gets only the stand-in for web storage.
 */
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { SANDBOX_BOOTSTRAP, SANDBOX_STORAGE_SHIM, launchesItself, withRuntime } from '../src/scorm-hosting.js';

const RUNTIME = 'https://bridge.example/scorm/runtime/scorm-rte.js';
const PAGE = '<!DOCTYPE html><html><head><title>Unit</title></head><body><script>/* the unit\'s own cmi5 launch */</script></body></html>';
const STRUCTURE = '<?xml version="1.0"?><courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd"><course id="https://publisher.example/course"><title><langstring lang="en-US">Course</langstring></title></course><au id="https://publisher.example/au/1" moveOn="CompletedAndPassed" masteryScore="0.8"><title><langstring lang="en-US">Unit</langstring></title><url>au/index.html</url></au></courseStructure>';
const MANIFEST = '<?xml version="1.0"?><manifest identifier="pkg" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"><organizations/><resources/></manifest>';

function zipOf(files: Record<string, string>): AdmZip {
  const zip = new AdmZip();
  for (const [name, text] of Object.entries(files)) zip.addFile(name, Buffer.from(text, 'utf8'));
  return new AdmZip(zip.toBuffer());
}

describe('which packages launch their own units', () => {
  it('is a package with a cmi5 course structure at its root, and no SCORM manifest', () => {
    expect(launchesItself(zipOf({ 'cmi5.xml': STRUCTURE, 'au/index.html': PAGE }))).toBe(true);
    expect(launchesItself(zipOf({ 'imsmanifest.xml': MANIFEST, 'index.html': PAGE }))).toBe(false);
    // Both: played as SCORM, as before.
    expect(launchesItself(zipOf({ 'imsmanifest.xml': MANIFEST, 'cmi5.xml': STRUCTURE, 'index.html': PAGE }))).toBe(false);
    // Casing is the importer's: it finds either file whatever its case, the SCORM manifest first.
    expect(launchesItself(zipOf({ 'IMSMANIFEST.XML': MANIFEST, 'cmi5.xml': STRUCTURE, 'index.html': PAGE }))).toBe(false);
    expect(launchesItself(zipOf({ 'CMI5.XML': STRUCTURE, 'au/index.html': PAGE }))).toBe(true);
    // A structure that is not at the root is not the package's.
    expect(launchesItself(zipOf({ 'docs/cmi5.xml': STRUCTURE, 'index.html': PAGE }))).toBe(false);
  });
});

describe('what a unit that launches itself is served', () => {
  const served = withRuntime(Buffer.from(PAGE, 'utf8'), RUNTIME, { ownLaunch: true }).toString('utf8');

  it('gets the stand-in for web storage, and the page as it was', () => {
    expect(served).toBe(PAGE.replace('<head>', `<head><script>${SANDBOX_STORAGE_SHIM}</script>`));
  });

  it('is given nothing that reads its launch or fetches its token', () => {
    expect(SANDBOX_STORAGE_SHIM).not.toMatch(/fetch|URLSearchParams|location|__foxxiPlayerConfig/);
    expect(served).not.toContain('__foxxiPlayerConfig');
    expect(served).not.toContain(RUNTIME);
  });

  it('still cannot end its script early or change as it is sent', () => {
    expect(SANDBOX_STORAGE_SHIM).not.toMatch(/<\/|\\|\$\{/);
  });

  it('goes into an XHTML document as character data', () => {
    const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body/></html>';
    expect(withRuntime(Buffer.from(xhtml), RUNTIME, { xml: true, ownLaunch: true }).toString()).toContain(`<script><![CDATA[${SANDBOX_STORAGE_SHIM}]]></script>`);
  });
});

describe('what a SCORM document is served', () => {
  it('is unchanged: the whole bootstrap, which begins with the same storage stand-in, then the runtime', () => {
    const served = withRuntime(Buffer.from(PAGE, 'utf8'), RUNTIME).toString('utf8');
    expect(served).toBe(PAGE.replace('<head>', `<head><script>${SANDBOX_BOOTSTRAP}</script><script src="${RUNTIME}"></script>`));
    const shared = SANDBOX_STORAGE_SHIM.slice(0, SANDBOX_STORAGE_SHIM.lastIndexOf('})();')).trimEnd();
    expect(SANDBOX_BOOTSTRAP.startsWith(shared)).toBe(true);
    expect(SANDBOX_BOOTSTRAP).toContain("fetch(fetchUrl, { method: 'POST' })");
  });
});
