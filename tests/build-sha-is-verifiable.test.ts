/**
 * A deploy nobody can confirm is not a deploy — and the one mechanism this repository has
 * for confirming one could pass for a service it never contacted.
 *
 * ★ THE FALSE-GREEN, measured 2026-08-03. `.github/workflows/deploy-railway.yml` declared
 * `verify_url` as a free-text dispatch input pre-filled with RELAY's /health — for every
 * service. tools/railway-redeploy.mjs then polls that URL until `j.build` equals the tag it
 * deployed. Dispatch `service=identity tag=7c9124af…` with the default left in place and it
 * polls RELAY, reads relay's build (which really was 7c9124af…), finds it EQUAL, prints
 * "serving … — verified" and exits 0 — while identity still runs an older image.
 *
 * The mirror failure was just as bad: for any service with no `build` field the poll could
 * NEVER match, so it burned its whole window and exited 1, which trained people to blank
 * the flag and take the "nothing has confirmed the new code is serving" branch instead.
 * Twelve of thirteen images had no build field, because build-ghcr.yml appends
 * `GIT_SHA=${{ github.sha }}` to EVERY matrix leg and only Dockerfile.relay declared a
 * matching ARG — Docker treats an unconsumed build-arg as a WARNING, so all twelve were
 * handed their own commit sha at build time, dropped it, and built green.
 *
 * The fix is a derivation, not a rule: the verify target comes from the service being
 * deployed. The double here is a plain array of host strings — Railway's actual return
 * shape — so it can EXPRESS the failure: an implementation that returns the same host for
 * every service is exactly what these cases distinguish.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootProofFor, healthPathFor, SERVICES, serviceNames, verifyUrlFor } from '../tools/railway-services.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

describe('the verify URL is derived from the service being deployed', () => {
  it('derives identity from ITS OWN domain and health path', () => {
    expect(verifyUrlFor('identity', ['identity.interego.xwisee.com'], undefined))
      .toEqual({ ok: true, url: 'https://identity.interego.xwisee.com/health' });
  });

  it('answers a DIFFERENT host per service, which is the whole point', () => {
    // If this returned the same URL for both, every assertion in this file would be
    // satisfied by an implementation that ignores its `service` argument.
    const a = verifyUrlFor('main', ['interego.xwisee.com'], undefined);
    const b = verifyUrlFor('relay', ['relay.interego.xwisee.com'], undefined);
    expect(a).toEqual({ ok: true, url: 'https://interego.xwisee.com/health' });
    expect(b).toEqual({ ok: true, url: 'https://relay.interego.xwisee.com/health' });
  });

  it('uses the gate its own /healthz, not /health', () => {
    // /health on the gate is PROXIED to CSS, so it would report the upstream's health as
    // the gate's. The path is a property of the code, so it belongs in the table.
    expect(verifyUrlFor('css-gate', ['gate.interego.xwisee.com'], undefined))
      .toEqual({ ok: true, url: 'https://gate.interego.xwisee.com/healthz' });
  });

  it('★ REFUSES relay’s health URL when the service being deployed is identity', () => {
    // THE FALSE-GREEN, stated as a test. This exact pair — service=identity, the workflow
    // default verify_url — printed "verified" for a rollout that never happened.
    const r = verifyUrlFor('identity', ['identity.interego.xwisee.com'], 'https://relay.interego.xwisee.com/health');
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/relay\.interego\.xwisee\.com/);
  });

  it('ACCEPTS an override on a host Railway reports for THAT service', () => {
    // Without this the guard could be "refuse every override", which passes the case above
    // while removing a legitimate escape hatch (a *.up.railway.app host, or a custom domain
    // not yet in DNS).
    expect(verifyUrlFor('identity', ['identity.interego.xwisee.com', 'identity-abc.up.railway.app'],
      'https://identity-abc.up.railway.app/health'))
      .toEqual({ ok: true, url: 'https://identity-abc.up.railway.app/health' });
  });

  it('refuses css by name, with the reason, rather than inventing a probe for it', () => {
    // css has NO public domain and 500s on any Host other than css.railway.internal:3456,
    // so an external probe would fail every deploy of a single-replica service on a shared
    // store. Excluded deliberately, not overlooked.
    const r = verifyUrlFor('css', [], undefined);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/css\.railway\.internal/);
    expect(healthPathFor('css').ok).toBe(false);
  });

  it('refuses a service Railway reports no domain for, rather than guessing a hostname', () => {
    const r = verifyUrlFor('dashboard', [], undefined);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/no domain/);
  });

  it('refuses an unknown service name and a prototype-reachable one', () => {
    expect(verifyUrlFor('nope', ['x.example'], undefined).ok).toBe(false);
    // `constructor` is a plausible-looking name a plain property read answers with a
    // function, whose `.health` is undefined.
    expect(verifyUrlFor('constructor', ['x.example'], undefined).ok).toBe(false);
  });

  it('refuses an override that is not a URL at all', () => {
    expect(verifyUrlFor('relay', ['relay.interego.xwisee.com'], 'relay.interego.xwisee.com/health').ok).toBe(false);
  });

  it('every service this repo builds either has a health path or states why not', () => {
    // Guards against a new service joining SERVICES with no `health` key and silently
    // becoming undeployable through the sanctioned path — or worse, deployable and
    // unverifiable, which is the state twelve of thirteen were in.
    for (const name of serviceNames()) {
      const entry = SERVICES[name]!;
      if (entry.repo === null) continue; // upstream datastore, not built here
      const h = healthPathFor(name);
      if (h.ok) expect(h.path).toMatch(/^\//);
      else expect(h.reason.length, `${name}: refusal must carry a reason`).toBeGreaterThan(20);
    }
  });
});

describe('a portless service is verified from its own deployment logs', () => {
  it('★ discord has NO health path and is still deployable — the pair that used to be impossible', () => {
    // THE BLOCKER, stated as a test. `health: null` made healthPathFor refuse, and
    // railway-redeploy treated that refusal as fatal, so the one service in this table that
    // binds no port could not be deployed through the sanctioned path at all — while its
    // runbook said it would "deploy without an HTTP probe". Both halves are asserted here:
    // there is no URL to derive, AND there is something to verify against.
    expect(healthPathFor('discord').ok).toBe(false);
    expect(verifyUrlFor('discord', [], undefined).ok).toBe(false);
    expect(bootProofFor('discord')).toEqual({ ok: true, needle: 'discord: bot online' });
  });

  it('★ the declared needle is a line the bot really prints', () => {
    // The failure this catches is a rename: the needle is a string in one file and the log
    // call is a string in another, and nothing but this couples them. Get it wrong and every
    // deploy of the bot times out four minutes after a container that booted perfectly.
    const proof = bootProofFor('discord');
    expect(proof.ok).toBe(true);
    const needle = (proof as { needle: string }).needle;
    expect(read('applications/shared-workspace/discord/src/main.ts')).toContain(needle);
  });

  it('the needle is the LAST boot line, so both credentials AND the gateway have been exercised', () => {
    // "The process started" would be satisfied by a container that then failed to
    // authenticate to Discord and failed to sign in to the relay. main.ts prints this only
    // after `rest.me()` (the bot token worked) and `session.open()` (the bot key worked).
    const src = read('applications/shared-workspace/discord/src/main.ts');
    const needle = (bootProofFor('discord') as { needle: string }).needle;
    expect(src.indexOf(needle)).toBeGreaterThan(src.indexOf('await session.open()'));
    expect(src.indexOf(needle)).toBeGreaterThan(src.indexOf('await rest.me()'));
    // ★ AND IT IS GATED ON THE GATEWAY'S OWN READY, which the previous needle was not. Registering
    // commands is two HTTPS calls; it was printed happily by a container whose WebSocket never came
    // up, which is precisely the state that went unnoticed for 75 minutes. Asserting the guard here
    // stops the needle drifting back to something a dead bot can still print.
    expect(src).toContain("l.startsWith('gateway ready as')");
    expect(src.indexOf(needle)).toBeGreaterThan(src.indexOf("l.startsWith('gateway ready as')"));
  });

  it('★ css declares the line MEASURED off its own live logs, so it has a deploy path at all', () => {
    // css used to be refused here, on the reasoning that nothing in this repository decides
    // what it prints so any needle would be invented. Right about the method, wrong about
    // the conclusion: the answer to "we cannot make one up" is to measure one. Leaving it
    // refused left the fleet's one stateful singleton — the service holding every pod's
    // data — with NO sanctioned way to ship an urgent fix, so the first attempt would have
    // been improvised under pressure against the thing that must not be improvised against.
    expect(healthPathFor('css').ok).toBe(false);
    expect(bootProofFor('css')).toEqual({ ok: true, needle: 'Listening to server at' });
  });

  it("css's needle is the LAST boot line, emitted only after the store has answered", () => {
    // ★ The coupling that keeps this honest is NOT in this file — it is in
    // integrations/pgsl-css-accessor/test/server.it.ts, which boots a real CSS over a real
    // Postgres and asserts the string is printed and that a read succeeds after it. What is
    // checkable from tracked files here is the VERSION the measurement was taken against:
    // the needle comes from @solid/community-server's ServerInitializer, the image installs
    // it with `npm ci` from the lockfile below, and a major bump could rename or reorder it.
    // Getting that wrong does not fail loudly — it makes every css deploy time out four
    // minutes after a container that booted perfectly, and the reflex then is to re-run the
    // deploy, which SIGTERMs the healthy container.
    const lock = JSON.parse(read('integrations/pgsl-css-accessor/package-lock.json')) as {
      packages: Record<string, { version?: string }>;
    };
    expect(lock.packages['node_modules/@solid/community-server']?.version).toBe('7.1.9');
  });

  it('the live-boot test asserts the SAME string the deploy tool looks for', () => {
    // ★ TWO COPIES OF ONE STRING, AND THIS IS WHAT STOPS THEM DRIFTING. server.it.ts runs in
    // an isolated deployment-shaped tree that contains the accessor and pgsl-store and
    // nothing else — `tools/` is not copied there — so it CANNOT import the needle and has
    // to restate it. A drifted copy is worse than no coupling: the boot test would keep
    // passing against a string the deploy tool no longer uses, so the one assertion that a
    // css rollout landed would be unbacked while looking covered.
    const needle = (bootProofFor('css') as { needle: string }).needle;
    expect(read('integrations/pgsl-css-accessor/test/server.it.ts'))
      .toContain(`const BOOT_PROOF = '${needle}';`);
  });

  it('the portless verification asks Railway to FILTER, because css out-logs a plain tail', () => {
    // ★ MEASURED 2026-08-09: a 500-line unfiltered tail of css's steady-state output spans
    // 12.7 seconds, because css logs a line per HTTP request and the fleet polls it. The
    // previous implementation fetched that tail and searched it in JS — unconditionally fine
    // for the silent discord bot, a RACE for css, whose boot line survives an unfiltered tail
    // only while the new container is under ~500 lines old. §7b does not start until §5 has
    // seen SUCCESS and nothing bounds that wait. Assert the query carries the needle to the
    // server, and that the count deciding crash-loop-or-not is still this repository's own
    // case-sensitive comparison rather than Railway's looser match.
    const src = read('tools/railway-redeploy.mjs');
    expect(src).toMatch(/deploymentLogs\(deploymentId:\$id,limit:\$limit,filter:\$filter\)/);
    expect(src).toMatch(/filter: needle/);
    expect(src).toMatch(/\.filter\(m => m\.includes\(needle\)\)/);
  });

  it('a declared singleton cannot be deployed while its live settings allow two containers', () => {
    // A rollout is the one moment Railway deliberately runs the old container and the new
    // one, so the replica settings are a PRECONDITION of deploying css — not background
    // tidiness. They were enforced nowhere on this path: the fleet audit reports them on a
    // schedule and the settings tool writes them, but a deploy dispatched in between would
    // have proceeded and the audit that catches it runs after the damage.
    const src = read('tools/railway-redeploy.mjs');
    expect(src).toMatch(/singletonViolations\(/);
    // Before §3 repoints anything — a guard that runs after the mutation is a report.
    // Anchored on the line §3 prints AFTER mutating, not on `serviceInstanceUpdate`: that
    // name also appears in this file's header and in a refusal message, both above §3, so
    // the ordering assertion would have passed without testing anything.
    expect(src.indexOf('singletonViolations([{')).toBeLessThan(src.indexOf("console.log('image repointed')"));
  });

  it('refuses an unknown service name and a prototype-reachable one', () => {
    expect(bootProofFor('nope').ok).toBe(false);
    expect(bootProofFor('constructor').ok).toBe(false);
  });

  it('a service with a health path does not also get a log needle', () => {
    // Two verifications would mean a choice, and a choice means a branch that can pick the
    // weaker one. Exactly one applies per service.
    for (const name of serviceNames()) {
      const entry = SERVICES[name]!;
      if (entry.repo === null) continue;
      const both = healthPathFor(name).ok && bootProofFor(name).ok;
      expect(both, `${name}: declares BOTH a health path and a bootProof`).toBe(false);
    }
  });

  it('railway-redeploy still verifies portless services instead of skipping them', () => {
    // ★ The tempting "fix" for the blocker was `if (!verify.ok) { warn; skip }` — which is the
    // "Railway reports success, but nothing has confirmed the new code is serving" branch this
    // file's own history deleted. Assert the deploy path calls the derivation AND polls logs.
    const src = read('tools/railway-redeploy.mjs');
    expect(src).toMatch(/bootProofFor\(/);
    expect(src, 'the proof must come from the deployment this run triggered').toMatch(/deploymentLogs\(deploymentId:\$id/);
    // Every exit from the log poll is a decision; none of them is "carry on regardless".
    expect(src).toMatch(/verifyFromLogs/);
  });
});

describe('the deploy path cannot be told which service to verify', () => {
  const WORKFLOW = '.github/workflows/deploy-railway.yml';

  it('deploy-railway.yml no longer takes a verify_url input', () => {
    // The input WAS the defect: a free-text field, pre-filled with one service's URL, used
    // for all of them. Making it `required: true` did not help — the default was already
    // filled in, so "required" changed nothing about what got submitted.
    expect(read(WORKFLOW)).not.toMatch(/^\s{6}verify_url:/m);
    expect(read(WORKFLOW)).not.toMatch(/inputs\.verify_url/);
  });

  it('railway-redeploy.mjs derives the URL instead of reading a flag straight through', () => {
    const src = read('tools/railway-redeploy.mjs');
    expect(src, 'the tool must call the derivation, not trust the flag').toMatch(/verifyUrlFor\(/);
    // A `domains` query is what makes the derivation possible at all; without it the tool
    // would have to transcribe hostnames, which is the class of claim that rots.
    expect(src).toMatch(/domains\(projectId:/);
  });

  it('the GHCR pre-check asks the tracked table instead of re-deriving the image name', () => {
    // `interego-${{ inputs.service }}` is right for thirteen of sixteen services and WRONG
    // for css (interego-css-pgsl) — the exact inline derivation tools/railway-services.mjs
    // exists to delete. Two places computing the image name can disagree about which image
    // is being checked versus deployed.
    const src = read(WORKFLOW);
    expect(src).not.toMatch(/interego-\$\{\{\s*inputs\.service/);
    expect(src).toMatch(/railway-services\.mjs image/);
  });

  it('the post-deploy check runs, and gets the history it needs to be meaningful', () => {
    const src = read(WORKFLOW);
    expect(src, 'a floor nothing reads is a comment').toMatch(/railway-pins\.mjs --check/);
    // ★ Without full history `git show -s` and `git rev-list --count` cannot answer for any
    // pinned sha, every service reports UNKNOWN-COMMIT, and the step goes red for a reason
    // that has nothing to do with production — which is how a check gets ignored.
    expect(src, 'the check needs full history or it is red for the wrong reason').toMatch(/fetch-depth:\s*0/);
  });
});
