/**
 * Railway service name → GHCR image repository. The single tracked copy of a mapping
 * that was previously not written down anywhere and was instead re-derived, wrongly,
 * at each call site.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `tools/railway-redeploy.mjs` used to compute `interego-${service}` inline. That holds
 * for thirteen of the sixteen services and is wrong for three, so the assumption was
 * invisible until the day it wasn't — and the day it wasn't, it blocked a legitimate
 * deploy for a naming reason dressed up as a safety one: `css` runs
 * `interego-css-pgsl`, so pinning it was refused even though a sha-tagged image of it
 * exists. The guard was right and its reason was wrong, which is the worst combination
 * because the reason is what the next person reads.
 *
 * A branch (`if (service === 'css') …`) would have unblocked that one service and left
 * the derivation in place for the next one. The derivation is the defect, so it is gone:
 * every service name is enumerated here, and a name that is not in this table cannot be
 * resolved to an image at all.
 *
 * ── WHY A TABLE AND NOT A DERIVATION FROM SOMETHING ELSE ─────────────────────
 *
 * There is nothing to derive it from. build-ghcr.yml's matrix is the tracked source of
 * IMAGE names, but it does not know Railway SERVICE names, and `css` ↔ `interego-css-pgsl`
 * is exactly the pair that cannot be recovered from either side alone.
 *
 * ── WHY THIS TABLE DOES NOT GO STALE THE WAY services.json DID ───────────────
 *
 * Because it holds no claim about production. It says which image repository a service
 * runs, never which TAG — the tag is the live pin, it is held only by Railway, and
 * writing it into a file is what made deploy/railway/services.json misleading twice.
 * And `node tools/railway-pins.mjs` checks this table against the live API on every run,
 * so a service renamed or added in Railway is reported as a disagreement rather than
 * discovered by a failed deploy.
 *
 * ── VERIFICATION ─────────────────────────────────────────────────────────────
 * Every row below was read off the live Railway API on 2026-08-03 (project
 * `robust-integrity`, 16 services), not copied from services.json — which is wrong about
 * most of them.
 *
 * Run: node tools/railway-services.mjs image <service>
 *      node tools/railway-services.mjs list
 */

import { pathToFileURL } from 'node:url';

export const IMAGE_PREFIX = 'ghcr.io/markjspivey-xwisee';

/**
 * `repo: null` marks a service this repository does not build. Pointing one of those at
 * an interego image replaces a datastore with an application — and for `postgres` that
 * is a data-loss event, not an outage, because the volume stays mounted while something
 * that is not Postgres owns it. They are listed rather than omitted so that asking about
 * them gets a specific refusal instead of "unknown service", which reads like a typo.
 */
export const SERVICES = {
  // Thirteen services whose image really is `interego-<service>`. Spelled out rather
  // than generated: a loop that fills these in is the derivation this file replaced.
  //
  // `health` is the path on THAT service that reports its own build sha. It is a
  // property of the code in this repository, not a claim about production, so it does
  // not go stale the way a transcribed tag does — and it is what lets the verify URL be
  // DERIVED from the service being deployed instead of typed next to it. See
  // verifyUrlFor() for the false-green that derivation exists to kill.
  relay: { repo: 'interego-relay', health: '/health' },
  identity: { repo: 'interego-identity', health: '/health' },
  // The gate's own liveness path is /healthz, not /health: /health on the gate would be
  // proxied to CSS, so the gate would report the upstream's health as its own.
  'css-gate': { repo: 'interego-css-gate', health: '/healthz' },
  'foxxi-bridge': { repo: 'interego-foxxi-bridge', health: '/health' },
  // The runtime a shared-workspace member that is an agent runs in. Its own container so
  // that the agent's key, its storage and its runtime are three separable things — see
  // deploy/Dockerfile.wsp-bridge.
  'wsp-bridge': { repo: 'interego-wsp-bridge', health: '/health' },
  bridge: { repo: 'interego-bridge', health: '/health' },
  dashboard: { repo: 'interego-dashboard', health: '/health' },
  'pgsl-browser': { repo: 'interego-pgsl-browser', health: '/health' },
  microsite: { repo: 'interego-microsite', health: '/health' },
  main: { repo: 'interego-main', health: '/health' },
  'acme-id': { repo: 'interego-acme-id', health: '/health' },
  'foxxi-dashboard': { repo: 'interego-foxxi-dashboard', health: '/health' },
  'foxxi-microsite': { repo: 'interego-foxxi-microsite', health: '/health' },
  'foxxi-scorm-player': { repo: 'interego-foxxi-scorm-player', health: '/health' },

  // The shared-workspace Discord bot. `health: null`, DELIBERATELY and for the same class of
  // reason as css: it is a WORKER, not a server. It dials out to the Discord gateway and the
  // relay and binds no inbound port, so Railway gives it no public domain and there is nothing to
  // probe. Its liveness is read from the logs, where it prints its agent DID on boot. See
  // deploy/Dockerfile.discord and applications/shared-workspace/discord/DEPLOY.md.
  //
  // `bootProof` is what replaces the HTTP probe — see bootProofFor() for why a log line is a
  // real assertion here and not a weaker stand-in for one.
  discord: {
    repo: 'interego-discord',
    health: null,
    bootProof: 'discord: commands registered',
  },

  // The one that is not. `interego-css` has never existed at any tag; build-ghcr.yml
  // builds this service under `interego-css-pgsl` (matrix leg with a `prebuild` step for
  // packages/pgsl-store/dist).
  css: {
    repo: 'interego-css-pgsl',
    // ★ NO HEALTH PATH, DELIBERATELY — not overlooked. css has no public domain
    // (Railway's `domains` query returns [] for it), and it is locked to the internal
    // host: a request whose Host / X-Forwarded-Host is not css.railway.internal:3456
    // 500s. A probe from outside would therefore fail on a single-replica service
    // sitting on a shared store. Anyone "completing the sweep" by giving css a path is
    // reintroducing a known outage.
    health: null,
    // ★ SINGLETON — the only service in the fleet whose CORRECTNESS depends on exactly
    // one container existing. Its store is the shared Postgres-backed PGSL lattice, and
    // integrations/pgsl-css-accessor/docker-entrypoint.sh selects the PROCESS-LOCAL
    // memory resource-locker whenever REDIS_ADDR is empty — which it is in production
    // (the variable exists on the service, its value is ''). Two containers therefore
    // run two independent lockers over one store, so CSS's If-Match read-modify-write
    // (the relay's manifest CAS) can have BOTH containers pass the precondition and both
    // write: a lost update that answers 200.
    //
    // Declared here because it was previously enforced by nothing. numReplicas read
    // null on 2026-08-03, so the invariant was upheld by Railway's default of 1 rather
    // than by a setting, and no reader could tell a decision from an accident.
    singleton: true,
    // Railway's deploy sequence is: start new -> new active -> hold overlapSeconds ->
    // SIGTERM old -> hold drainingSeconds -> SIGKILL old. So overlapSeconds can only
    // SHRINK the two-container window (Railway's default is 20s) and drainingSeconds can
    // only LENGTHEN it. NEITHER closes it — the only mechanism Railway documents for
    // preventing two active deployments is an attached volume. drainingSeconds is
    // REFUSED rather than merely unset because it is the plausible-looking hardening
    // that makes this specific hazard worse, and leaving that to judgement is how it
    // gets set.
    maxOverlapSeconds: 0,
    drainingMustBeUnset: true,
  },

  // postgres is a singleton too, but Railway already enforces it: a service with an
  // attached volume cannot have two deployments mounted at once. It is NOT declared
  // `singleton` here because that would make --check demand an explicit numReplicas on a
  // service the platform already protects, i.e. noise. If the volume is ever detached,
  // this line is the one to revisit.
  postgres: { repo: null, upstream: 'postgres:16', health: null },
  redis: { repo: null, upstream: 'redis:7-alpine', health: null },
};

/**
 * Measured minimum container resources. A service capped BELOW its floor does not
 * degrade — it dies, and it dies wearing a disguise:
 *
 *   relay        below 1.0 CPU / 2 GiB: OOM-killed, surfacing as generic 502s with
 *                EMPTY logs (the process is gone before it writes anything).
 *   foxxi-bridge below 2 CPU / 4 GiB: surfaces as a bogus "issuer seed unset". The
 *                4 GiB is arithmetic, not taste — this service runs with
 *                NODE_OPTIONS=--max-old-space-size=3072 (read off the live service on
 *                2026-08-03), so V8 is licensed to grow old-space to 3 GiB and will not
 *                GC defensively to stay under a smaller cgroup cap. 3 GiB heap +
 *                off-heap (buffers, code, stacks) needs the 4th GiB.
 *                ★ Change that NODE_OPTIONS and this number is wrong.
 *
 * ── WHY THIS TABLE IS SAFE TO WRITE DOWN AND THE IMAGE TAG WAS NOT ──────────
 * Same rule as SERVICES above: it holds no claim about what production IS. It records
 * what production REQUIRES — a fact about the code, which changes only when the code
 * does. The live setting stays Railway's to state, and tools/railway-pins.mjs asks
 * Railway for it on every run.
 *
 * ── ONLY MEASURED SERVICES APPEAR ───────────────────────────────────────────
 * The other fourteen are absent, not zero. Inventing a plausible floor for a service
 * nobody has starved is the transcription-rot that made deploy/railway/services.json
 * misleading twice. An override on a service with no row here is reported as
 * UNKNOWN-FLOOR — an unreviewed cap on unmeasured code is the risky case, not the safe
 * one.
 *
 * Bytes, spelled out, because the units do not agree: Railway reports the plan ceiling
 * as memoryBytes 32000000000 (decimal GB), while these floors were measured and stated
 * in GiB. 2 GiB = 2147483648, 4 GiB = 4294967296. Comparing against the GiB value is
 * deliberately the stricter reading: a "2 GB" (2000000000) cap is below the point where
 * the relay was observed to survive, so flagging it is correct.
 */
export const LIMIT_FLOORS = {
  relay: { cpu: 1, memoryBytes: 2 * 1024 * 1024 * 1024 },
  'foxxi-bridge': { cpu: 2, memoryBytes: 4 * 1024 * 1024 * 1024 },
};

/**
 * Classify one service's live resource-limit override against its floor. Pure, so it is
 * cheap to mutation-check and so the fail-closed branches below are reachable from a
 * test.
 *
 * `override` is whatever `serviceInstanceLimitOverride` returned: `null` when no
 * override is set, otherwise a `ServiceInstanceLimit` scalar.
 *
 * ★ AN UNSET OVERRIDE IS A PASS. `null` means the plan ceiling applies (32 CPU / 32 GB
 * on 2026-08-03), which is above every floor here, and all sixteen services read null.
 * A classifier that called that a violation would report sixteen violations on day one
 * and be switched off.
 *
 * ★ AN UNRECOGNISED SHAPE IS NOT A PASS. The populated shape is INFERRED from
 * `serviceInstanceLimits` (the EFFECTIVE limits) sharing the `ServiceInstanceLimit`
 * return type — no override has ever been observed set on this project, so it has never
 * been seen populated. UNPARSED is that uncertainty made loud. Defaulting an unreadable
 * cap to "fine" is the fail-open class this repository keeps paying for.
 */
export function classifyLimit(service, override) {
  if (override === null || override === undefined) {
    return { verdict: 'none', reason: 'no override — the plan ceiling applies, and it is above every floor here' };
  }
  const cpu = override?.containers?.cpu;
  const memoryBytes = override?.containers?.memoryBytes;
  if (typeof cpu !== 'number' || typeof memoryBytes !== 'number') {
    return { verdict: 'UNPARSED', reason: `override set but not {containers:{cpu,memoryBytes}}: ${JSON.stringify(override)}` };
  }
  // ★ Object.hasOwn, NOT LIMIT_FLOORS[service] — for the reason spelled out on
  // resolveImageRepo below, but with a worse ending. Service names arrive from the live
  // Railway API. A service named `constructor` resolves through the prototype to a
  // truthy function whose `.cpu` is undefined; `cpu < undefined` is false, so BOTH
  // comparisons fall through and a starved service reports `ok`. The guard would fail
  // open on the one input it exists to catch.
  const floor = Object.hasOwn(LIMIT_FLOORS, service) ? LIMIT_FLOORS[service] : null;
  if (!floor) {
    return { verdict: 'UNKNOWN-FLOOR', cpu, memoryBytes, reason: `an override is set on "${service}", for which no floor has been measured` };
  }
  const under = [];
  if (cpu < floor.cpu) under.push(`cpu ${cpu} < floor ${floor.cpu}`);
  if (memoryBytes < floor.memoryBytes) under.push(`memoryBytes ${memoryBytes} < floor ${floor.memoryBytes}`);
  if (under.length) return { verdict: 'BELOW-FLOOR', cpu, memoryBytes, reason: under.join('; ') };
  return { verdict: 'ok', cpu, memoryBytes, reason: `at or above floor (cpu ${floor.cpu}, memoryBytes ${floor.memoryBytes})` };
}

/**
 * Which live serviceInstance rows violate a declared singleton. Pure — rows in,
 * violations out — so it is exercised against the exact shape production was in on
 * 2026-08-03 (numReplicas null, overlapSeconds null) with no Railway credential.
 *
 * ★ `row.numReplicas !== 1` treats `null` as a VIOLATION, deliberately. `null` is
 * Railway's "unset, platform default applies", and the default happens to be 1 — so a
 * null reads green while recording no decision at all. Accepting null here is the exact
 * defect this function exists to catch: an invariant held by a default rather than by a
 * setting, which survives until a console edit or a platform-default change flips it
 * with nothing to notice.
 *
 * ★ `?? 20` on overlapSeconds, not `?? 0`. Unset does not mean zero; it means Railway's
 * documented 20s default, i.e. a 20-second two-container window on every deploy.
 */
export function singletonViolations(rows) {
  const out = [];
  for (const row of rows ?? []) {
    // A service Railway could not be read for, or does not have, cannot be judged on
    // settings it did not report — reporting it twice (MISSING plus three settings
    // violations) is how a check stops being read.
    if (row.missingFromRailway || row.error) continue;
    if (!Object.hasOwn(SERVICES, row.service)) continue;
    const decl = SERVICES[row.service];
    if (!decl.singleton) continue;
    if (row.numReplicas !== 1) {
      out.push({
        service: row.service, setting: 'numReplicas', live: row.numReplicas ?? null, want: 1,
        why: 'a singleton must be pinned to one replica explicitly; null is the platform default, not a decision',
      });
    }
    if (typeof decl.maxOverlapSeconds === 'number' && (row.overlapSeconds ?? 20) > decl.maxOverlapSeconds) {
      out.push({
        service: row.service, setting: 'overlapSeconds', live: row.overlapSeconds ?? null, want: decl.maxOverlapSeconds,
        why: "unset means Railway's 20s default — a 20s window with two containers on every deploy",
      });
    }
    if (decl.drainingMustBeUnset && row.drainingSeconds !== null && row.drainingSeconds !== undefined) {
      out.push({
        service: row.service, setting: 'drainingSeconds', live: row.drainingSeconds, want: null,
        why: 'drainingSeconds is the SIGTERM->SIGKILL grace on the OLD container; on a singleton it can only LENGTHEN the two-container window',
      });
    }
  }
  return out;
}

/**
 * The path on `service` that reports its own build sha, or a refusal that says why not.
 *
 * Object.hasOwn for the same reason resolveImageRepo uses it: `constructor` is a
 * plausible-looking service name that a plain property read answers with a function.
 */
export function healthPathFor(service) {
  if (!Object.hasOwn(SERVICES, service)) {
    return { ok: false, reason: `unknown Railway service "${service}". Valid: ${serviceNames().join(', ')}` };
  }
  const path = SERVICES[service].health;
  if (!path) {
    return {
      ok: false,
      reason: `"${service}" has no externally reachable health path. css has no public domain and 500s ` +
        'on any Host other than css.railway.internal:3456, and the datastores are not built here.',
    };
  }
  return { ok: true, path };
}

/**
 * The line a PORTLESS service prints once it has finished booting, or a refusal that says
 * why that service cannot be verified this way.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * healthPathFor() refuses every service with `health: null`, and tools/railway-redeploy.mjs
 * treats that refusal as fatal — so a worker could not be deployed through the sanctioned
 * path AT ALL. That was not a considered exclusion, it was the HTTP assumption showing
 * through: the only verification the tool knew was "poll a URL until it reports the sha",
 * and a process that binds no port has no URL. `discord` was added to this table with
 * `health: null` and a comment saying its liveness is read from the logs, and
 * `applications/shared-workspace/discord/DEPLOY.md` told operators the deploy would
 * "deploy without an HTTP probe — the same path css takes". Neither was true of the code:
 * the tool died at the derivation, before it mutated anything, on the first dispatch.
 *
 * ── WHY A LOG LINE IS EVIDENCE AND NOT A WEAKER STAND-IN ─────────────────────
 *
 * The thing /health proves is not "an HTTP request succeeded" — it is "the code I just
 * deployed is the code now running", because the OLD container keeps serving when a pull
 * fails and its /health keeps answering 200. Railway's `deploymentLogs` are scoped to a
 * DEPLOYMENT ID, and railway-redeploy polls the id `serviceInstanceDeployV2` handed back,
 * so a line found there was necessarily written by the container that deploy started. With
 * §6's two assertions already in place (the pin is the image we asked for, and the live
 * deployment is the one we triggered) a boot line from that deployment is the same claim
 * the /health poll makes, obtained from the only surface a portless process has.
 *
 * ── WHY THE NEEDLE IS THE *LAST* BOOT LINE ───────────────────────────────────
 *
 * For discord it is `discord: commands registered`, which src/main.ts prints only after
 * BOTH credentials have been exercised: `rest.me()` (the Discord token authenticated) and
 * `session.open()` (the bot key signed in to the relay). "The process started" would have
 * been satisfied by a container that then refused both. A test asserts this string is still
 * present in main.ts, so renaming the log line fails the suite rather than the deploy.
 *
 * ── WHY css IS STILL REFUSED ─────────────────────────────────────────────────
 *
 * It is portless too, but nothing in this repository decides what it prints — it runs the
 * community Solid server under integrations/pgsl-css-accessor — and it is the one service
 * whose correctness depends on exactly one container existing. Inventing a plausible needle
 * for it is the transcription-rot the header of this file is about. Absent, not zero.
 */
export function bootProofFor(service) {
  if (!Object.hasOwn(SERVICES, service)) {
    return { ok: false, reason: `unknown Railway service "${service}". Valid: ${serviceNames().join(', ')}` };
  }
  const needle = SERVICES[service].bootProof;
  if (typeof needle !== 'string' || needle.length === 0) {
    return {
      ok: false,
      reason: `"${service}" declares no bootProof, so there is nothing to look for in its logs. ` +
        'Add the line it prints when it has finished booting to tools/railway-services.mjs — ' +
        'and pick the LAST one, not the first: "the process started" is satisfied by a container ' +
        'that then failed every credential it holds.',
    };
  }
  return { ok: true, needle };
}

/**
 * The verify URL is DERIVED from the service being deployed and from Railway's own
 * `domains` answer — never typed.
 *
 * ★ THE FAILURE THIS PREVENTS, measured on 2026-08-03. `.github/workflows/deploy-railway.yml`
 * declares `verify_url` as a free-text dispatch input pre-filled with RELAY's /health for
 * every service. Dispatching service=identity at tag 7c9124af… with that default left in
 * place polls RELAY, reads relay's build 7c9124af…, finds it equal to the tag, prints
 * "serving … — verified" and exits 0 — while identity is still running an older image.
 * The single assertion this repository has that a rollout landed could pass for a service
 * it never contacted.
 *
 * An override is still accepted (a *.up.railway.app host, a custom domain not yet in
 * DNS), but ONLY if its host is one Railway reports for THIS service. The host check is
 * the whole guard; without it the parameter is the defect again.
 *
 * `domains` is a plain array of host strings — the shape the caller gets from
 * `[...customDomains, ...serviceDomains].map(d => d.domain)`.
 */
export function verifyUrlFor(service, domains, override) {
  const health = healthPathFor(service);
  if (!health.ok) return health;
  const hosts = (domains ?? []).map((d) => String(d ?? '')).filter(Boolean);
  if (override) {
    let u;
    try {
      u = new URL(String(override));
    } catch {
      return { ok: false, reason: `--verify-url is not a URL: ${override}` };
    }
    if (!hosts.includes(u.hostname)) {
      return {
        ok: false,
        reason: `--verify-url points at ${u.hostname}, which Railway does not report as a domain of ` +
          `"${service}" (it reports: ${hosts.join(', ') || 'none'}). Verifying a rollout against a ` +
          'DIFFERENT service is how a deploy reports "verified" without contacting the thing it deployed.',
      };
    }
    return { ok: true, url: u.toString() };
  }
  if (hosts.length === 0) {
    return { ok: false, reason: `Railway reports no domain for "${service}", so no verify URL can be derived.` };
  }
  return { ok: true, url: `https://${hosts[0]}${health.path}` };
}

/** Service names in table order, for error messages that tell the caller what IS valid. */
export function serviceNames() {
  return Object.keys(SERVICES);
}

/**
 * Resolve a service name to the full GHCR repository that service runs.
 *
 * Returns a result rather than throwing so each caller keeps its own refusal format and
 * exit code — railway-redeploy.mjs exits 2 with a usage-shaped message, railway-pins.mjs
 * prints the disagreement in a column and keeps going.
 *
 * ★ `Object.hasOwn`, NOT `SERVICES[service]`. Service names reach here from a CLI
 * argument and from a workflow_dispatch input, and `css-gate` and `constructor` are
 * equally plausible-looking to the `/^[a-z0-9-]+$/` check upstream. A plain property read
 * answers `constructor` with a function inherited from Object.prototype, which is truthy,
 * whose `.repo` is `undefined` — so the caller would sail past the "unknown service"
 * refusal and pin production at `ghcr.io/markjspivey-xwisee/undefined`. Railway accepts
 * that pin, cannot pull it, and leaves the old container serving, so nothing looks wrong
 * until the next restart.
 */
export function resolveImageRepo(service) {
  if (!Object.hasOwn(SERVICES, service)) {
    return {
      ok: false,
      reason: `unknown Railway service "${service}". Valid: ${serviceNames().join(', ')}`,
    };
  }
  const entry = SERVICES[service];
  if (entry.repo === null) {
    return {
      ok: false,
      reason: `"${service}" is a datastore running the upstream image ${entry.upstream}. ` +
        'This repository does not build it, and repointing it at an interego image would ' +
        'replace the datastore with an application on top of its live volume.',
    };
  }
  return { ok: true, repo: `${IMAGE_PREFIX}/${entry.repo}` };
}

/**
 * CLI, so a shell step can ask the same question the scripts do instead of re-deriving it.
 * `.github/workflows/deploy-railway.yml` still spells `interego-${{ inputs.service }}` in
 * its GHCR existence pre-check; that file is outside this change's scope, but this is what
 * it needs to call.
 */
async function main(argv) {
  const [verb, service] = argv;
  if (verb === 'list') {
    for (const name of serviceNames()) {
      const r = resolveImageRepo(name);
      console.log(`${name.padEnd(20)} ${r.ok ? r.repo : `(${SERVICES[name].upstream} — not built here)`}`);
    }
    return 0;
  }
  if (verb === 'image' && service !== undefined) {
    const r = resolveImageRepo(service);
    if (!r.ok) { console.error(`error: ${r.reason}`); return 2; }
    console.log(r.repo);
    return 0;
  }
  console.error('usage: railway-services.mjs image <service>\n       railway-services.mjs list');
  return 2;
}

// Guarded so importing this table never runs the CLI. `pathToFileURL` because argv[1] is a
// backslash path on Windows and would never string-compare equal to an `import.meta.url`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
