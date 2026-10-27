/**
 * jsonld and rdf-canonize are declared at exact versions, the ones the root lockfile installs, in
 * every manifest that names them.
 *
 * Three tests pin values computed over RDFC-1.0 canonical N-Quads: an eddsa-rdfc-2022 proofValue
 * (applications/_shared/tests/eddsa-rdfc-2022.test.ts), the AMEP `semanticCid` the relay gives a
 * memory (deploy/mcp-relay/_amep-seed-test.ts) and an I2IDL-X fingerprint. They run against the
 * root lockfile. The relay, dashboard and PGSL browser images do not install from it. Their app
 * stage (deploy/Dockerfile.relay, .dashboard, .pgsl-browser) rewrites a package.json and runs
 * `npm install` with no lockfile over packed `@interego/*` tarballs, so each image gets what the
 * relay's and core's manifests declare. Under `^9.0.0` and `^5.0.0` that is the newest 9.x and 5.x
 * on the day of the build. A release that moved one canonical byte would re-address every new
 * memory in the next relay image while CI, on the lockfile's copy, stayed green.
 *
 * An exact version settles it. npm puts the pinned copy at the top of the tree, and jsonld's own
 * `rdf-canonize: ^5.0.0` edge resolves to that copy rather than to a newer release. `npm install
 * jsonld@<v>` writes a caret by default, so the next upgrade would undo this silently; this test
 * is what notices. To upgrade, change the version in every manifest at once and regenerate the
 * lockfile. The three pinned values then say whether the bytes moved.
 *
 * One version for the whole tree, not only for the manifests those images read: two surfaces with
 * different canonicalizers can give the same graph two content addresses.
 *
 * A walk of the working tree rather than `git ls-files`, like the other source guards here, so the
 * base-without-verticals job runs it over the tree it keeps.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'scratchpad']);
const CANONICALIZERS = ['jsonld', 'rdf-canonize'] as const;
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

type Manifest = Partial<Record<(typeof FIELDS)[number], Record<string, string>>>;
type Lockfile = { packages: Record<string, { version?: string }> };

function manifests(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'package.json') out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as Lockfile;

/** Every copy of `name` the root lockfile installs, as `path@version`. */
function installed(name: string): string[] {
  return Object.entries(lock.packages)
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([path, entry]) => `${path}@${entry.version ?? '?'}`);
}

describe('jsonld and rdf-canonize are declared at the exact versions CI tests', () => {
  it('the root lockfile installs one copy of each, so every package and test uses the same one', () => {
    for (const name of CANONICALIZERS) {
      const copies = installed(name);
      expect(copies, `${name}: a second copy means some code canonicalizes with a version the pinned values were not checked against`)
        .toHaveLength(1);
      expect(copies[0]).toMatch(new RegExp(`^node_modules/${name}@\\d+\\.\\d+\\.\\d+$`));
    }
  });

  it('every manifest that names them declares exactly that version, not a range', () => {
    const declaring = new Set<string>();
    const wrong: string[] = [];
    for (const file of manifests()) {
      const rel = relative(ROOT, file).split('\\').join('/');
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      for (const field of FIELDS) {
        for (const name of CANONICALIZERS) {
          const spec = manifest[field]?.[name];
          if (spec === undefined) continue;
          declaring.add(rel);
          const version = lock.packages[`node_modules/${name}`]?.version;
          if (spec !== version) wrong.push(`${rel} ${field}.${name} is "${spec}"; the lockfile installs ${version}`);
        }
      }
    }
    // The manifests a lockfile-less image reads. If the walk stopped finding them, this test
    // would pass on any tree.
    expect([...declaring], 'the walk did not reach the manifests the relay and core tarball installs read')
      .toEqual(expect.arrayContaining(['package.json', 'packages/core/package.json', 'deploy/mcp-relay/package.json']));
    expect(wrong, 'declare the exact version (npm install --save-exact), in every manifest at once').toEqual([]);
  });
});
