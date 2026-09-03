/**
 * WHAT IMAGE IS THE CONTAINER MADE OF? Asked when the service cannot be asked anything.
 *
 * ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────
 *
 * `tools/railway-running-build.ts` asks each service's own `/health` what build it serves,
 * which is the strongest possible answer: it proves the new CODE is executing. Four services
 * cannot answer it, and its header says so plainly — `postgres` and `redis` are upstream
 * images this repository does not build, and `css` and `discord` bind no externally reachable
 * health path. Their deploy-time evidence is a boot line in one deployment's logs, and a boot
 * line names no build sha.
 *
 * That was recorded as "cannot answer this question at all". It is true of THAT question and
 * not of every question. Railway resolves an image reference to a digest before it starts a
 * container and reports it as `deployment.meta.imageDigest` — `tools/railway-redeploy.mjs`
 * already reads that field to tell a failed pull from a failed application. Comparing it to
 * the digest GHCR serves for the pinned tag establishes that the running container was created
 * from exactly the image CI built for that commit.
 *
 * ── ★ IT IS A WEAKER CLAIM, AND IT IS REPORTED AS A WEAKER CLAIM ─────────────
 *
 * A digest match says the CONTAINER IS MADE OF THE RIGHT BITS. It does not say the process
 * inside it is healthy, and it does not say this container is the one taking traffic — both of
 * which a `/health` answer does say. So this never merges into the "asked and answered"
 * sentence; it is its own axis with its own count, and a service covered only by it is
 * described as digest-verified rather than as running.
 *
 * A MISMATCH, though, is unambiguous and severe: the pin says one image and the live container
 * is made of another, which is the "deploy that never swapped" failure that
 * `railway-running-build.ts` was written for, caught on the only axis available for these two.
 *
 * ── WHY NOT `docker buildx imagetools inspect` ──────────────────────────────
 *
 * Because this repository does not use Docker locally — "we dont use docker locally we use
 * github" — so a check that shells out to it is a check that only runs in CI, on a tool whose
 * whole purpose is to be runnable by hand against the live fleet. The registry HTTP API needs
 * nothing installed.
 */

/** Media types a manifest may be served as. Sending all four avoids a 404 on OCI-only images. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface DigestReport {
  readonly service: string;
  /** The digest Railway says the live container was started from. */
  readonly running: string | null;
  /** The digest the registry serves for the pinned tag. */
  readonly registry: string | null;
  readonly verdict: 'digest-verified' | 'DIGEST-MISMATCH' | 'digest-unavailable';
  /** Printed verbatim under the service name. Always says WHICH half was missing. */
  readonly reason: string;
}

/** Minimal shape this module needs from a pin row, so tests can hand it a literal. */
export interface DigestSubject {
  readonly service: string;
  readonly deployId?: string | null;
  readonly repo?: string | null;
  readonly tag?: string | null;
  readonly kind?: string | null;
}

type Gql = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

/**
 * The digest Railway resolved for the live deployment.
 *
 * Returns null rather than throwing when the field is absent — an absent digest is a real and
 * informative state (Railway never resolved the tag, so nothing was pulled), not an error, and
 * the caller reports it as unavailable rather than as a mismatch.
 */
export async function runningDigest(gql: Gql, deployId: string): Promise<string | null> {
  const d = await gql('query($id:String!){ deployment(id:$id){ meta } }', { id: deployId }) as
    { deployment?: { meta?: { imageDigest?: unknown } } };
  const digest = d?.deployment?.meta?.imageDigest;
  return typeof digest === 'string' && digest.startsWith('sha256:') ? digest : null;
}

/**
 * The digest GHCR serves for `<repo>:<tag>`.
 *
 * ★ THE TOKEN EXCHANGE IS NOT OPTIONAL EVEN FOR A PUBLIC PACKAGE. GHCR answers /v2/ with 401
 * and a WWW-Authenticate pointing at its token endpoint; a bare request returns 401 for
 * everything, which would make every service report unavailable and look like a fleet-wide
 * outage of this axis. These packages are additionally NOT linked to the repository, so the
 * Basic credential is what makes a private manifest readable at all.
 */
export async function registryDigest(
  repo: string,
  tag: string,
  ghToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ digest: string } | { error: string }> {
  const path = repo.replace(/^ghcr\.io\//, '');
  if (!path || path === repo) return { error: `not a ghcr.io image: ${repo}` };
  const scope = encodeURIComponent(`repository:${path}:pull`);
  const auth: Record<string, string> = ghToken
    ? { authorization: `Basic ${Buffer.from(`x:${ghToken}`).toString('base64')}` }
    : {};
  let token: string;
  try {
    const tr = await fetchImpl(`https://ghcr.io/token?scope=${scope}&service=ghcr.io`, { headers: auth });
    if (!tr.ok) return { error: `ghcr token endpoint answered ${tr.status}` };
    token = String(((await tr.json()) as { token?: unknown }).token ?? '');
    if (!token) return { error: 'ghcr token endpoint returned no token' };
  } catch (e) {
    return { error: `ghcr token endpoint unreachable: ${(e as Error).message}` };
  }
  try {
    const r = await fetchImpl(`https://ghcr.io/v2/${path}/manifests/${tag}`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
    });
    if (!r.ok) return { error: `manifest ${tag} answered ${r.status}` };
    const digest = r.headers.get('docker-content-digest');
    if (!digest) return { error: 'registry returned no docker-content-digest header' };
    return { digest };
  } catch (e) {
    return { error: `ghcr manifest unreachable: ${(e as Error).message}` };
  }
}

/**
 * Verify one service by digest.
 *
 * Every "cannot" path returns `digest-unavailable` WITH the reason, never a pass. A check that
 * cannot run must not look like a check that ran and was happy — that is the same fail-open
 * this fleet tooling has been bitten by twice.
 */
export async function verifyByDigest(
  gql: Gql,
  row: DigestSubject,
  ghToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DigestReport> {
  const base = { service: row.service, running: null, registry: null } as const;
  if (!row.deployId) {
    return { ...base, verdict: 'digest-unavailable', reason: 'Railway reports no deployment for this service' };
  }
  if (!row.repo || !row.tag) {
    return { ...base, verdict: 'digest-unavailable', reason: 'the pin names no repository and tag to compare against' };
  }
  const running = await runningDigest(gql, row.deployId);
  if (!running) {
    return {
      ...base,
      verdict: 'digest-unavailable',
      reason: 'the live deployment carries no imageDigest, so Railway never resolved its tag',
    };
  }
  const reg = await registryDigest(row.repo, row.tag, ghToken, fetchImpl);
  if ('error' in reg) {
    return {
      ...base,
      running,
      verdict: 'digest-unavailable',
      reason: `could not read the registry digest for ${row.tag}: ${reg.error}`,
    };
  }
  if (reg.digest !== running) {
    return {
      service: row.service,
      running,
      registry: reg.digest,
      verdict: 'DIGEST-MISMATCH',
      reason: `the live container is made of ${running}, but ${row.tag} in the registry is ${reg.digest}`
        + ' — the pin moved and the container did not',
    };
  }
  return {
    service: row.service,
    running,
    registry: reg.digest,
    verdict: 'digest-verified',
    reason: `the live container is byte-identical to ${row.tag} as built by CI`,
  };
}

/** True when this report must fail the audit. Unavailable is not a disagreement; mismatch is. */
export function isDigestDisagreement(r: DigestReport): boolean {
  return r.verdict === 'DIGEST-MISMATCH';
}

/** One sentence per state, naming services rather than absorbing them into a count. */
export function digestHeadline(reports: readonly DigestReport[]): string {
  if (!reports.length) return '';
  const ok = reports.filter((r) => r.verdict === 'digest-verified');
  const bad = reports.filter((r) => r.verdict === 'DIGEST-MISMATCH');
  const na = reports.filter((r) => r.verdict === 'digest-unavailable');
  const lines: string[] = [];
  if (ok.length) {
    lines.push(
      `${ok.length} service(s) that cannot be asked were verified by image digest instead — `
      + `${ok.map((r) => r.service).join(', ')} `
      + '— so the container is made of the image its pin names, though nothing here proves the '
      + 'process inside it is healthy.');
  }
  if (bad.length) {
    lines.push(`★ ${bad.length} service(s) are running a DIFFERENT image than their pin names: `
      + `${bad.map((r) => r.service).join(', ')}.`);
  }
  if (na.length) {
    lines.push(`${na.length} service(s) could not be digest-checked either: `
      + `${na.map((r) => `${r.service} (${r.reason})`).join('; ')}.`);
  }
  return lines.join('\n');
}
