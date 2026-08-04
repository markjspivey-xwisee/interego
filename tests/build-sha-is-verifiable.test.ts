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
import { healthPathFor, SERVICES, serviceNames, verifyUrlFor } from '../tools/railway-services.mjs';

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
