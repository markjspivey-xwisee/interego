/**
 * Two independent ways a Railway pin can be a lie, and `--check` used to exit 0 on both.
 *
 * ★ FRESHNESS — "the pin is not master." On 2026-08-03 build-ghcr.yml built all fourteen
 * images at 7c9124a and every leg passed. `relay` was repinned; `foxxi-bridge`, `bridge`
 * and `acme-id` were not. tools/railway-pins.mjs printed `sha … SUCCESS … ok` for a
 * service 63 commits behind — a row identical in every column to relay's, which was
 * current. The tool held that 40-hex sha, ran inside a checkout of the repository the sha
 * names, and never compared the two.
 *
 * ★ DEPLOY AGREEMENT — "the pin was written but never shipped." `identity` was pinned to a
 * commit stamped 2026-07-30T16:36Z while its live deployment had been created
 * 2026-07-29T00:27Z — forty hours BEFORE the commit existed, which is arithmetically
 * impossible for an honest deploy. Fourteen of fifteen sha-pinned services sat 4–6 hours
 * on the correct side of that inequality; identity sat forty hours on the wrong side.
 * Both timestamps were already being fetched by collectPins; nothing related them.
 *
 * The two are SEPARATE fields, not two values of one, because a service can be both — and
 * a service whose pin is stale AND unshipped is the one an operator most needs both halves
 * of. The fixtures below use the MEASURED numbers so they are the defect, not a paraphrase.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  annotate, annotateFreshness, collectPins, deployAgreement, gitCommitAt, gitFacts, hasDisagreement,
} from '../tools/railway-pins.mjs';
import type { GitFacts, PinRow } from '../tools/railway-pins.mjs';
import { resolveImageRepo, serviceNames } from '../tools/railway-services.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const PREFIX = 'ghcr.io/markjspivey-xwisee';

// ★ THE DOUBLE ANSWERS DIFFERENTLY PER SHA. A double returning one canned answer cannot
// distinguish the fold from an implementation that hardcodes a verdict, and would let the
// constant-return mutants live.
const AT_HEAD = 'a'.repeat(40);
const BEHIND_63 = 'b'.repeat(40);
const BEHIND_6 = 'c'.repeat(40);
const OFF_MASTER = 'd'.repeat(40);
const NOT_HERE = 'e'.repeat(40);

const git: GitFacts = {
  head: AT_HEAD,
  known: (sha) => sha !== NOT_HERE,
  isAncestorOfHead: (sha) => sha !== OFF_MASTER && sha !== NOT_HERE,
  commitsSince: (sha) => ({ [AT_HEAD]: 0, [BEHIND_63]: 63, [BEHIND_6]: 6 }[sha] ?? -1),
};

/**
 * Every freshness row carries an HONEST deploy pair (deployment created after the commit
 * it was built from). That is a control, not decoration: without it the deploy axis reads
 * UNVERIFIED, `hasDisagreement` is true on every row for that reason, and each assertion
 * below would pass without the freshness axis working at all.
 */
const row = (service: string, sha: string): PinRow =>
  annotateFreshness(annotate({
    service,
    image: `${PREFIX}/interego-${service}:${sha}`,
    deployedAt: '2026-08-03T20:09:15.577Z',
    pinnedCommitAt: '2026-08-03T20:05:20.000Z',
  }), git);

describe('pin freshness — is production running master?', () => {
  it('a service on master is current and contributes no disagreement', () => {
    const r = row('relay', AT_HEAD);
    expect(r.freshness).toBe('current');
    expect(r.behind).toBe(0);
    expect(hasDisagreement([r])).toBe(false);
  });

  // The reproduction, as a test: this row is what the tool printed as `ok` for four days.
  it('★ a sha-pinned, SUCCESSful, repo-agreeing service 63 commits behind is BEHIND by 63', () => {
    const r = row('foxxi-bridge', BEHIND_63);
    expect(r.tagKind).toBe('sha');
    expect(r.agreement).toBe('ok'); // every pre-existing axis says healthy
    expect(r.freshness).toBe('BEHIND');
    expect(r.behind).toBe(63);
    expect(hasDisagreement([r])).toBe(true);
  });

  it('reports each service its OWN distance, not a shared verdict', () => {
    expect(row('bridge', BEHIND_63).behind).toBe(63);
    expect(row('acme-id', BEHIND_6).behind).toBe(6);
  });

  it('a pin that is not an ancestor of HEAD is DIVERGED, not merely behind', () => {
    const r = row('dashboard', OFF_MASTER);
    expect(r.freshness).toBe('DIVERGED');
    expect(r.behind).toBeNull();
    expect(hasDisagreement([r])).toBe(true);
  });

  it('a pin this clone does not have is UNKNOWN-COMMIT, distinct from DIVERGED', () => {
    // `git merge-base --is-ancestor` exits 1 for a real non-ancestor and 128 for an object
    // this clone lacks. Collapsing the two reports production as running off-master code
    // every time this runs in a shallow clone — a false alarm in the tool whose whole
    // value is being believed.
    expect(row('identity', NOT_HERE).freshness).toBe('UNKNOWN-COMMIT');
  });

  it('a mutable tag and an upstream datastore carry no freshness verdict', () => {
    expect(annotateFreshness(annotate({ service: 'css', image: `${PREFIX}/interego-css-pgsl:redis6` }), git).freshness)
      .toBe('n/a');
    expect(annotateFreshness(annotate({ service: 'postgres', image: 'postgres:16' }), git).freshness).toBe('n/a');
  });

  it('with no git facts the axis says UNCHECKED and does not fabricate a verdict', () => {
    const r = annotateFreshness(annotate({ service: 'relay', image: `${PREFIX}/interego-relay:${BEHIND_63}` }), null);
    expect(r.freshness).toBe('UNCHECKED');
  });
});

// ── The deploy-agreement axis ────────────────────────────────────────────────
// Rows are built directly rather than through the git double, because this axis reads
// two TIMESTAMPS and nothing else.
const dated = (service: string, sha: string, deployedAt: string | null, pinnedCommitAt: string | null): PinRow =>
  annotateFreshness(annotate({ service, image: `${PREFIX}/interego-${service}:${sha}`, deployedAt, pinnedCommitAt }), null);

describe('deploy agreement — was the pin ever actually shipped?', () => {
  it('★ identity: a deployment created BEFORE its pinned commit existed is STALE-DEPLOY', () => {
    // Measured. Pin aac273d31f80…, `git show -s --format=%cI` = 2026-07-30T16:36:30Z;
    // latestDeployment.createdAt = 2026-07-29T00:27:53.051Z. Forty hours earlier, so the
    // container cannot be that image: the pin was written (serviceInstanceUpdate) and
    // never shipped (no serviceInstanceDeployV2). Production was serving 2f3bdb8.
    const r = dated('identity', 'aac273d31f8028782df219b1fd1a53cbdbb77bf4',
      '2026-07-29T00:27:53.051Z', '2026-07-30T16:36:30.000Z');
    expect(r.agreement).toBe('ok'); // the pre-existing axis said healthy throughout
    expect(r.deployAgreement).toBe('STALE-DEPLOY');
    expect(hasDisagreement([r])).toBe(true);
  });

  it('relay: the honest 4-minute build+deploy gap reads ok', () => {
    // Without this case "always return STALE-DEPLOY" passes the case above. Measured pair:
    // commit 2026-08-03T20:05:20Z, deployment created 2026-08-03T20:09:15.577Z.
    const r = dated('relay', '7c9124af0d597e900b82a3e8cef31d569c5419cf',
      '2026-08-03T20:09:15.577Z', '2026-08-03T20:05:20.000Z');
    expect(r.deployAgreement).toBe('ok');
    expect(hasDisagreement([r])).toBe(false);
  });

  it("can't-tell is NOT fine: an undatable pin or an undeployed service is UNVERIFIED", () => {
    // This is the exact SHAPE of the original bug — a can't-tell that read as an
    // agreement. A fix that reintroduces it must not be able to go green.
    const noCommit = dated('bridge', 'f'.repeat(40), '2026-08-03T00:00:00Z', null);
    expect(noCommit.deployAgreement).toBe('UNVERIFIED');
    expect(hasDisagreement([noCommit])).toBe(true);

    const neverDeployed = dated('bridge', 'f'.repeat(40), null, '2026-08-03T00:00:00Z');
    expect(neverDeployed.deployAgreement).toBe('UNVERIFIED');
    expect(hasDisagreement([neverDeployed])).toBe(true);
  });

  it('a datastore and a digest pin stay quiet rather than going permanently red', () => {
    const pg = annotateFreshness(annotate({ service: 'postgres', image: 'postgres:16', deployedAt: null }), null);
    expect(pg.deployAgreement).toBe('n/a');
    expect(hasDisagreement([pg])).toBe(false);

    const digest = annotateFreshness(
      annotate({ service: 'relay', image: `${PREFIX}/interego-relay@sha256:${'0'.repeat(64)}`, deployedAt: null }), null);
    expect(digest.tagKind).toBe('digest');
    expect(digest.deployAgreement).toBe('n/a');
    expect(hasDisagreement([digest])).toBe(false);
  });

  it('a MISMATCHed repo is not clobbered by the deploy verdict — both stay readable', () => {
    const r = annotateFreshness(annotate({
      service: 'relay',
      image: `${PREFIX}/interego-WRONG:${'1'.repeat(40)}`,
      deployedAt: '2026-07-01T00:00:00Z',
      pinnedCommitAt: '2026-08-01T00:00:00Z',
    }), null);
    expect(r.agreement).toBe('MISMATCH');
    expect(r.deployAgreement).toBe('STALE-DEPLOY');
  });

  it('deployAgreement is a pure function of the row, callable on its own', () => {
    expect(deployAgreement({
      service: 'relay', builtHere: true, tagKind: 'sha', deployedAt: 'nonsense', pinnedCommitAt: 'x',
    })).toBe('UNVERIFIED');
  });
});

describe('gitCommitAt refuses anything that is not a 40-hex sha, without spawning git', () => {
  it('rejects an upstream tag and a shell-injection attempt', () => {
    expect(gitCommitAt('16')).toBeNull();
    expect(gitCommitAt('$(touch pwned)')).toBeNull();
    expect(gitCommitAt('redis6')).toBeNull();
    expect(gitCommitAt('')).toBeNull();
    // 40 hex but absent from this clone: still null, never a throw.
    expect(gitCommitAt('e'.repeat(40))).toBeNull();
  });

  it('reads a real commit date out of this clone as ISO-8601', () => {
    const facts = gitFacts();
    if (!facts) return; // no git / not a checkout: nothing to assert against
    const at = gitCommitAt(facts.head);
    expect(at, 'HEAD is in this clone, so its committer date must be readable').toBeTruthy();
    // ★ BOTH ZONE SPELLINGS. `Z` and `+00:00` are the same instant and both are ISO-8601;
    // which one git renders depends on the committer's timezone, so a pattern accepting only
    // the offset form passes on a developer box and reds on a UTC CI runner. Measured here:
    // this clone gives `+00:00`, the Actions runner gave `2026-08-04T16:01:20Z`. The
    // assertion is about the SHAPE being machine-readable, not about which zone it renders.
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/);
  });

  it('reads the COMMITTER date, not the author date', () => {
    // ★ %cI vs %aI is not pedantry. A rebased or cherry-picked commit keeps its ORIGINAL
    // author date, which can predate the commit landing on the branch build-ghcr.yml builds
    // from by days. Dating a pin by %aI would quietly WIDEN the window in which a container
    // that predates its own pin still measures as honest — i.e. it would hide the exact
    // defect deployAgreement() exists to catch.
    //
    // The two are equal on most commits, so the assertion has to find one where they are
    // not. It searches this clone rather than hard-coding a sha, because a hard-coded one
    // rots and a shallow clone has neither. If the clone genuinely contains no such commit
    // this cannot be tested here, and it says so by skipping rather than by asserting
    // something that would pass under either format.
    let log: string;
    try {
      log = execFileSync('git', ['-C', REPO, 'log', '-n', '400', '--format=%H %aI %cI'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return; // no git, or no history to search
    }
    const rebased = log.split('\n')
      .map((l) => l.trim().split(' '))
      .find((p) => p.length === 3 && p[1] !== p[2]);
    if (!rebased) return; // no commit in range has differing dates — genuinely untestable here
    const [sha, authorAt, committerAt] = rebased as [string, string, string];
    expect(gitCommitAt(sha), `${sha} must be dated by %cI (${committerAt}), not %aI (${authorAt})`)
      .toBe(committerAt);
  });

  it('refuses an ABBREVIATED sha even though git would happily resolve it', () => {
    // ★ This is the assertion that gives the `{40}` teeth. Loosening the guard to
    // /^[0-9a-f]+$/ — an easy "tidy-up" — passes every case above, because `16` and
    // `redis6` still fail at git and still come back null. The only input that separates
    // the two regexes is a SHORT hex string git CAN resolve. And the distinction is real,
    // not pedantry: `beef123` is a perfectly plausible mutable tag, and dating it would
    // hand the deploy-agreement axis a commit the pin never named.
    const facts = gitFacts();
    if (!facts) return;
    const abbrev = facts.head.slice(0, 8);
    expect(gitCommitAt(abbrev), `${abbrev} is not a 40-hex pin and must not be dated`).toBeNull();
  });
});

/**
 * THE WIRING. No annotate-only test can see a fix that is correct in the pure function and
 * never invoked — collectPins is where `pinnedCommitAt` is populated and where the git
 * facts are folded in.
 *
 * The double answers DIFFERENTLY per serviceId, which railway-pins.mjs's own header
 * demands of a double: one that returns a canned answer for every serviceId cannot tell a
 * correct implementation from one that queries the same service sixteen times.
 */
function railwayDouble(perService: Record<string, { tag: string; deployedAt: string }>) {
  const names = serviceNames();
  const idOf = (n: string) => `svc-${n}`;
  const nameOf = Object.fromEntries(names.map((n) => [idOf(n), n]));
  return async (query: string, variables: Record<string, unknown> = {}) => {
    if (query.includes('projectToken')) return { projectToken: { projectId: 'proj', environmentId: 'env' } };
    if (query.includes('project(id:')) {
      return { project: { name: 'robust-integrity', services: { edges: names.map((n) => ({ node: { id: idOf(n), name: n } })) } } };
    }
    const service = nameOf[String(variables.s)];
    if (service === undefined) throw new Error(`double asked about unknown serviceId ${String(variables.s)}`);
    if (query.includes('serviceInstanceLimitOverride')) return { serviceInstanceLimitOverride: null };
    const r = resolveImageRepo(service);
    const repo = r.ok ? r.repo : `upstream/${service}`;
    const spec = perService[service] ?? { tag: AT_HEAD, deployedAt: '2026-08-03T00:00:00Z' };
    return {
      serviceInstance: {
        source: { image: `${repo}:${spec.tag}` },
        // css is a declared singleton, so it must be given compliant settings or every
        // assertion below would pass on a singleton violation instead of on its own axis.
        numReplicas: 1,
        overlapSeconds: 0,
        drainingSeconds: null,
        latestDeployment: { id: 'dep', status: 'SUCCESS', createdAt: spec.deployedAt },
      },
    };
  };
}

describe('both axes, wired through collectPins', () => {
  it('carries a BEHIND pin and a STALE-DEPLOY pin all the way into --check', async () => {
    const commitDates: Record<string, string> = {
      [BEHIND_63]: '2026-07-01T00:00:00Z',
      [AT_HEAD]: '2026-07-01T00:00:00Z',
      // identity's real pin: committed AFTER the deployment below was created.
      'aac273d31f8028782df219b1fd1a53cbdbb77bf4': '2026-07-30T16:36:30.000Z',
    };
    const { rows } = await collectPins(
      railwayDouble({
        'foxxi-bridge': { tag: BEHIND_63, deployedAt: '2026-08-03T00:00:00Z' },
        identity: { tag: 'aac273d31f8028782df219b1fd1a53cbdbb77bf4', deployedAt: '2026-07-29T00:27:53.051Z' },
      }),
      git,
      (tag: string) => commitDates[tag] ?? null,
    );

    const bridge = rows.find((r) => r.service === 'foxxi-bridge');
    expect(bridge?.freshness).toBe('BEHIND');
    expect(bridge?.behind).toBe(63);
    expect(bridge?.deployAgreement).toBe('ok'); // it shipped; it is just old

    const identity = rows.find((r) => r.service === 'identity');
    expect(identity?.agreement).toBe('ok');
    expect(identity?.deployAgreement).toBe('STALE-DEPLOY');
    expect(identity?.pinnedCommitAt).toBe('2026-07-30T16:36:30.000Z');

    expect(hasDisagreement(rows)).toBe(true);
  });

  it('is green when every service is on master and every deploy postdates its commit', async () => {
    // The control. Without it, "always red" passes every assertion above.
    const { rows } = await collectPins(
      railwayDouble({}),
      git,
      () => '2026-07-01T00:00:00Z',
    );
    expect(rows).toHaveLength(serviceNames().length);
    expect(rows.filter((r) => r.freshness === 'current').length).toBeGreaterThan(10);
    expect(hasDisagreement(rows)).toBe(false);
  });
});

/**
 * The Dockerfile/health PAIR. Weak individually and said so plainly: this is a source-text
 * assertion, not a behavioural one — it cannot prove the container emits the field, only
 * that both halves of the mechanism are present. Its teeth are the PAIRING. Adding the ENV
 * without the /health field (or the reverse) leaves `railway-redeploy.mjs --verify-url`
 * reading "(no build field)" until it times out, which is the silent state identity was in
 * for its entire history: every identity deploy this stack has done was unverified.
 */
describe('identity can report which build it is', () => {
  it('bakes the sha build-ghcr.yml already passes it', () => {
    expect(read('deploy/Dockerfile.identity')).toMatch(/^ARG GIT_SHA=unset$/m);
    expect(read('deploy/Dockerfile.identity')).toMatch(/^ENV INTEREGO_BUILD_SHA=\$GIT_SHA$/m);
  });

  it('and surfaces it at /health, where --verify-url reads exactly `j.build`', () => {
    expect(read('deploy/identity/server.ts')).toMatch(/build: process\.env\['INTEREGO_BUILD_SHA'\]/);
  });
});
