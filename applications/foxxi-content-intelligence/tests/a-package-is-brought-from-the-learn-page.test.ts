/**
 * A signed-in person brings a package from the Learn page, a guest included.
 *
 * ★ WHY. Anyone who signs may bring a package to the bridge (foxxi.host_package_signed), but only
 * by composing the signed request themselves. The Learn page now reads a chosen file, signs it as
 * the session's identity and sends it, and says what the bridge answered.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_MAX_PACKAGE_BYTES, base64OfBytes, broughtFrom, whyNotBring } from '../dashboard-app/src/learn/bring-package.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SHA = 'c'.repeat(64);

describe('the file, as the signed payload carries it', () => {
  it('is the same base64 a server reads back, for a file larger than one piece', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => (i * 31 + 7) % 256);
    const encoded = base64OfBytes(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(base64OfBytes(new Uint8Array(0))).toBe('');
  });

  it('is refused before it is read when it is empty, or larger than a bridge takes by default', () => {
    expect(whyNotBring({ name: 'a.zip', size: 0 })).toMatch(/empty/);
    expect(whyNotBring({ name: 'a.zip', size: DEFAULT_MAX_PACKAGE_BYTES })).toBeNull();
    expect(whyNotBring({ name: 'a.zip', size: DEFAULT_MAX_PACKAGE_BYTES + 1 })).toMatch(/25 MB/);
    expect(whyNotBring({ name: 'a.zip', size: 2 * 1024 * 1024 }, 1024 * 1024)).toMatch(/2\.0 MB.*1 MB/);
  });
});

describe('what the bridge answered', () => {
  it('reads a package that plays, with its course to launch', () => {
    expect(broughtFrom({ hosted: true, packageSha256: SHA, packageTitle: 'Refunds', course: { id: 'https://b.example/scorm/packages/' + SHA, title: 'Refunds' } }))
      .toEqual({ hosted: true, playable: true, title: 'Refunds', courseId: 'https://b.example/scorm/packages/' + SHA, packageSha256: SHA });
  });

  it('reads an export kept to be folded, and why it launches nothing', () => {
    expect(broughtFrom({ hosted: true, playable: false, playableWhy: 'fold it first', packageSha256: SHA, packageTitle: 'Deck' }))
      .toEqual({ hosted: true, playable: false, title: 'Deck', packageSha256: SHA, why: 'fold it first' });
    // Kept, but with no course to launch: not presented as playable.
    expect(broughtFrom({ hosted: true, packageSha256: SHA })).toMatchObject({ hosted: true, playable: false, title: 'Untitled package' });
  });

  it('reads a package the bridge did not keep, in the bridge\'s own words', () => {
    expect(broughtFrom({ hosted: false, hostedWhy: 'the package names no launchable SCO' })).toEqual({ hosted: false, why: 'the package names no launchable SCO' });
    expect(broughtFrom({ status: 'failed', error: 'not a zip' })).toEqual({ hosted: false, why: 'not a zip' });
    // "hosted" with no usable id is not taken on trust.
    expect(broughtFrom({ hosted: true, packageSha256: 'nope' })).toMatchObject({ hosted: false });
    for (const body of [null, undefined, {}, 'text']) expect(broughtFrom(body)).toMatchObject({ hosted: false });
  });
});

describe('the Learn page', () => {
  const card = read('../dashboard-app/src/components/BringPackageCard.tsx');
  const learn = read('../dashboard-app/src/components/LearnPanel.tsx');
  const hosted = read('../dashboard-app/src/components/HostedPackagesCard.tsx');

  it('brings a package with the signed affordance, as the session, and is not shown where the bridge does not offer it', () => {
    expect(card).toContain("const host = useAffordance('foxxi.host_package_signed');");
    expect(card).toContain('if (!host) return null;');
    expect(card).toContain("postSigned(host.href, signerFor(session), { zip_base64, hinted_title: file.name.replace(/\\.zip$/i, '') })");
  });

  it('checks the file before reading it, and says what is brought is public', () => {
    expect(card.indexOf('const no = whyNotBring(file);')).toBeLessThan(card.indexOf('await file.arrayBuffer()'));
    expect(card).toContain('It is public once brought, so bring only what you may share.');
  });

  it('reads the list again once a package is hosted', () => {
    expect(card).toContain('if (brought.hosted) onHosted();');
    expect(learn).toContain('<BringPackageCard session={session} onHosted={() => setBrought(n => n + 1)} />');
    expect(learn).toContain('<HostedPackagesCard session={session} refresh={brought} />');
    expect(hosted).toContain('}, [listHref, refresh]);');
  });
});
