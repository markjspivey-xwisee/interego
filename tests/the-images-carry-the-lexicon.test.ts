/**
 * Every image that bundles @interego/pgsl must be able to READ the published lexicon.
 *
 * ★ THE FAILURE THIS EXISTS TO PREVENT, because it has already happened once in this repo.
 * @interego/compliance was changed to read its control roster from the published ontologies
 * instead of a frozen array — correct, tested, and completely inert in production, because
 * the relay image did not contain docs/ns. Every /audit surface went on quietly serving the
 * roster the ontologies had replaced. The fix was measured only after someone thought to ask
 * what the deployed image actually resolved.
 *
 * docs/ns/pgsl-lexicon.ttl is the same shape of change and would fail the same way. It is
 * worse in one respect: the fallback is behaviourally IDENTICAL, so nothing downstream would
 * ever look wrong. The image would simply never read the published copy, and "the knowledge
 * lives in data now" would be true only of the repo.
 *
 * ★ THE MEMBERSHIP RULE IS STRUCTURAL, not a list. Any Dockerfile that copies `packages/`
 * wholesale bundles packages/pgsl and can therefore reach the expansion path, so it needs
 * the lexicon. Deriving the set this way means a NEW image is covered the day it is added,
 * which a hand-kept list would not be — and it is why the set has no exceptions to allowlist.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = join(REPO, 'deploy');
const LEXICON = 'docs/ns/pgsl-lexicon.ttl';

/** Dockerfiles that copy the whole workspace, and so ship packages/pgsl. */
function imagesBundlingPgsl(): { name: string; body: string }[] {
  return readdirSync(DEPLOY)
    .filter(f => f.startsWith('Dockerfile.'))
    .map(name => ({ name, body: readFileSync(join(DEPLOY, name), 'utf8') }))
    .filter(({ body }) => /^COPY packages\/ \.\/packages\/$/m.test(body));
}

describe('the published lexicon reaches the images that use it', () => {
  const images = imagesBundlingPgsl();

  it('finds images to check at all', () => {
    // A scan that matched nothing would report full coverage while checking nothing.
    expect(images.length).toBeGreaterThan(0);
  });

  it.each(images.map(i => i.name))('%s COPYs the lexicon', name => {
    const body = images.find(i => i.name === name)!.body;
    expect(body, `${name} bundles packages/pgsl but never COPYs ${LEXICON}`)
      .toMatch(new RegExp(`^COPY ${LEXICON.replace(/[./]/g, '\\$&')}\\s+(\\S+)`, 'm'));
  });

  /**
   * ★ THE LOAD-BEARING ONE. Copying the file somewhere is not the same as the package being
   * able to find it. resolveNsDir checks INTEREGO_NS_DIR FIRST and, when it is set, does not
   * walk upward at all — so in a pinned image the lexicon must be in that exact directory.
   * The relay pins it, which is why a COPY to /app/docs/ns would have looked right and read
   * nothing.
   */
  it.each(images.map(i => i.name))('%s puts it where that image will actually look', name => {
    const body = images.find(i => i.name === name)!.body;
    const dest = new RegExp(`^COPY ${LEXICON.replace(/[./]/g, '\\$&')}\\s+(\\S+)`, 'm').exec(body)?.[1];
    expect(dest, `no COPY for ${LEXICON} in ${name}`).toBeTruthy();
    const landsIn = dirname(dest!.replace(/\\/g, '/'));

    const pinned = /^ENV INTEREGO_NS_DIR=(\S+)/m.exec(body)?.[1];
    if (pinned === undefined) {
      // Unpinned: the package walks up from packages/pgsl/dist, so ./docs/ns under the
      // workdir is what it reaches. Verified against a simulated image layout.
      expect(landsIn, `${name} does not pin INTEREGO_NS_DIR, so the lexicon must land in `
        + `./docs/ns for the upward walk to find it, not ${landsIn}`)
        .toMatch(/(^|\/)docs\/ns$/);
      return;
    }
    // Pinned: the build stage writes to some path that a later `COPY --from` rehomes under
    // /app, so strip that one prefix and require the REST to match exactly.
    //
    // ★ This compared `pinnedTail.split('/').pop()` — the last segment only — and a mutant
    // that moved the relay's lexicon to ./docs/ns while INTEREGO_NS_DIR still pointed at
    // /app/relay-docs/ns passed clean. Both paths end in "ns", so the assertion had decayed
    // to "the destination contains the letters ns", which is the precise mistake this test
    // was written to catch, made by the test.
    const wantDir = pinned.replace(/^\/app\//, '').replace(/^\//, '');
    const gotDir = landsIn.replace(/^\.\//, '').replace(/^\//, '');
    expect(gotDir, `${name} lands the lexicon in ${landsIn} but pins INTEREGO_NS_DIR at `
      + `${pinned}. A pinned directory disables the upward walk entirely, so the file has to `
      + 'be in that exact directory or the image reads nothing.')
      .toBe(wantDir);
  });
});
