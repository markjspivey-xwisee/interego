/**
 * The relay image must carry the ontologies its compliance scorer reads, and point at them.
 *
 * ★★ THE CODE FIX IS INERT WITHOUT THE IMAGE. `loadControlSet` reads each framework's published
 * `iep:ControlSet` at runtime, and the relay is the only deployed service that scores those
 * reports. But the relay installs `@interego/compliance` from a TARBALL into `/app/node_modules`,
 * so the package's own upward walk for `docs/ns` terminates at the filesystem root. Measured: in
 * that layout the scorer selects the frozen fallback array — 16 SOC 2 controls instead of the
 * published 25 — and reports it as a legitimate `fallback`, with every local test still green.
 *
 * Two things therefore have to stay true together, and neither is visible from the other:
 * the image must contain the ttl files, and it must tell the package where they are. This test is
 * the only place those two facts meet. It derives the framework list from the package rather than
 * restating it, so publishing a fourth framework fails here until its ontology is shipped too.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_CONTROLS } from '@interego/compliance';

const DOCKERFILE = fileURLToPath(new URL('../deploy/Dockerfile.relay', import.meta.url));
const body = readFileSync(DOCKERFILE, 'utf8');

/**
 * ★ STAGE-AWARE, because a multi-stage Dockerfile resets everything at each `FROM`.
 *
 * These helpers first read the whole file: `runtimeWorkdir()` returned the last `WORKDIR`
 * ANYWHERE, and the `ENV` assertion matched anywhere too. Dockerfile.relay declares `WORKDIR /app`
 * in both the build stage and the runtime stage, so deleting the runtime one — which would leave
 * the image with `/` as its working directory and `INTEREGO_NS_DIR` pointing at a path that no
 * longer exists — left the test green, reading the BUILD stage's value and reporting it as the
 * runtime's. Likewise an `ENV` in a build stage does not reach the final image at all. A test
 * asserting a runtime property has to know where the runtime starts.
 */
const runtimeStage = ((): string => {
  const froms = [...body.matchAll(/^FROM\s/gm)];
  const last = froms.at(-1);
  if (last === undefined) throw new Error('Dockerfile.relay has no FROM — this guard is reading the wrong file');
  return body.slice(last.index);
})();

/** `WORKDIR` in force for the final image — the last one declared IN THE RUNTIME STAGE. */
function runtimeWorkdir(): string {
  const all = [...runtimeStage.matchAll(/^WORKDIR\s+(\S+)/gm)].map(m => m[1]!);
  return all.at(-1) ?? '/';
}

/** Resolve a runtime-stage destination (possibly `./x`) against the runtime WORKDIR. */
function absolute(dest: string): string {
  const cleaned = dest.replace(/\/$/, '');
  if (cleaned.startsWith('/')) return cleaned;
  return `${runtimeWorkdir().replace(/\/$/, '')}/${cleaned.replace(/^\.\//, '')}`;
}

describe('the relay image carries the published control rosters', () => {
  it('parses a runtime stage at all — a vacuous pass here would hide every assertion below', () => {
    expect(runtimeStage.length).toBeGreaterThan(0);
    expect(runtimeStage.length).toBeLessThan(body.length);
    expect(runtimeWorkdir()).toMatch(/^\//);
  });

  it('declares INTEREGO_NS_DIR in the RUNTIME stage, where the running process can read it', () => {
    // An ENV in a build stage configures the builder and never reaches the final image.
    expect(runtimeStage).toMatch(/^ENV\s+INTEREGO_NS_DIR=\S+/m);
  });

  it('ships every framework ontology the scorer reads', () => {
    for (const framework of Object.keys(FRAMEWORK_CONTROLS)) {
      const copied = new RegExp(`^COPY\\s+docs/ns/${framework.replace('.', '\\.')}\\.ttl\\s+(\\S+)`, 'm');
      expect(body, `docs/ns/${framework}.ttl is not COPYed into the relay image`).toMatch(copied);
    }
  });

  /**
   * The load-bearing one. The build stage writes the ttls to some path; a later
   * `COPY --from=build <src> <dest>` carries that path into the runtime stage, possibly renaming
   * it; and INTEREGO_NS_DIR names where the running process looks. If any of the three moves
   * independently, the relay silently scores against the fallback array — a failure that produces
   * a plausible number rather than an error, which is why it is asserted rather than trusted.
   */
  it('points INTEREGO_NS_DIR at the directory those ontologies actually land in at runtime', () => {
    const nsDir = /^ENV\s+INTEREGO_NS_DIR=(\S+)/m.exec(runtimeStage)?.[1];
    expect(nsDir, 'INTEREGO_NS_DIR is not set in the relay image runtime stage').toBeTruthy();

    // Only the runtime stage's `COPY --from=` lines put anything in the final image.
    const stageCopies = [...runtimeStage.matchAll(/^COPY\s+--from=\S+\s+(\S+)\s+(\S+)/gm)]
      .map(m => ({ src: m[1]!.replace(/\/$/, ''), dest: absolute(m[2]!) }));

    for (const framework of Object.keys(FRAMEWORK_CONTROLS)) {
      const dest = new RegExp(`^COPY\\s+docs/ns/${framework}\\.ttl\\s+(\\S+)`, 'm').exec(body)?.[1];
      expect(dest, `no COPY for docs/ns/${framework}.ttl`).toBeTruthy();
      const buildDir = dest!.slice(0, dest!.lastIndexOf('/'));

      // Carry the build-stage directory through whichever --from=build COPY contains it.
      const carrier = stageCopies.find(c => buildDir === c.src || buildDir.startsWith(`${c.src}/`));
      expect(carrier, `${buildDir} is never copied into the runtime stage`).toBeTruthy();
      const runtimeDir = `${carrier!.dest}${buildDir.slice(carrier!.src.length)}`;

      expect(
        runtimeDir,
        `${framework}.ttl lands at ${runtimeDir} but INTEREGO_NS_DIR points at ${nsDir}`,
      ).toBe(nsDir);
    }
  });
});
