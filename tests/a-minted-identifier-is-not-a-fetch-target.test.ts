/**
 * THE RELAY MINTED IDENTIFIERS IT WOULD NOT ITSELF ACCEPT BACK.
 *
 * `CSS_URL` is `http://css.railway.internal:3456/` in production — where the relay reads and writes
 * from inside the cluster, and resolvable nowhere else. It was also the base every pod IDENTIFIER
 * was composed against, including the `subject_pod_url` that `sign_request` stamps into a SIGNED
 * payload. That value does not stay at the relay: a vertical binds its writes to it and carries it
 * into the documents it publishes.
 *
 * ★ MEASURED, LIVE, AND REPORTED THREE TURNS RUNNING by a delegate reading its own record: an IEEE
 * P2997 Enterprise Learner Record whose `id` and every `provenance.rawDataLocations` entry named
 * `css.railway.internal`. That is the artifact most likely to be handed to a reader who has never
 * heard of this deployment, and it named its own evidence at an address that resolves nowhere.
 *
 * ★ AND THE PROOF IT WAS INCOHERENT RATHER THAN MERELY AWKWARD: `assertPublicPodUrl`, in the SAME
 * MODULE, refuses any `.internal` host outright. The relay was handing out identifiers it would
 * refuse if the holder passed them back.
 *
 * Same shape as `subject_pod_url` answering both "whose pod am I" and "whose record am I asking
 * for": one value, right for one purpose, read for another. Routing is unchanged — this is one
 * direction, applied only where a value stops being ours.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicStoreSpelling, assertPublicPodUrl } from '../deploy/mcp-relay/url-rewrite.js';

const INTERNAL = 'http://css.railway.internal:3456/';
const PUBLIC = 'https://gate.interego.xwisee.com/';

describe('an identifier that leaves the relay is spelled publicly', () => {
  it('re-spells a pod on the internal store origin', () => {
    expect(publicStoreSpelling(`${INTERNAL}u-eth-03f52e15b9df/`, INTERNAL, PUBLIC))
      .toBe('https://gate.interego.xwisee.com/u-eth-03f52e15b9df/');
  });

  it('carries the whole path, query and fragment through untouched', () => {
    expect(publicStoreSpelling(`${INTERNAL}u-eth-abc/context-graphs/1787.ttl?v=2#frag`, INTERNAL, PUBLIC))
      .toBe('https://gate.interego.xwisee.com/u-eth-abc/context-graphs/1787.ttl?v=2#frag');
  });

  it('★ and the result is one the relay will accept back — which the input was not', () => {
    const minted = publicStoreSpelling(`${INTERNAL}u-eth-abc/`, INTERNAL, PUBLIC);
    expect(() => assertPublicPodUrl(minted)).not.toThrow();
    // The whole incoherence in one line: what the relay used to hand out. It is refused twice
    // over — for being plain http, and (assert it directly, or the second rule goes untested
    // behind the first) for the `.internal` label.
    expect(() => assertPublicPodUrl(`${INTERNAL}u-eth-abc/`)).toThrow(/must use https/);
    expect(() => assertPublicPodUrl('https://css.railway.internal:3456/u-eth-abc/')).toThrow(/internal-only/);
  });
});

describe('and nothing else moves', () => {
  it('a URL on any other origin is returned untouched', () => {
    for (const u of [
      'https://relay.interego.xwisee.com/ns/iep',
      'https://example.org/x',
      'http://localhost:3456/pod/',
    ]) expect(publicStoreSpelling(u, INTERNAL, PUBLIC)).toBe(u);
  });

  it('★ EXACT ORIGIN, never a prefix — the shape that leaked a write bearer once already', () => {
    // `url.startsWith(internalBase)` is how `https://gate.interego.xwisee.com.<attacker>/…` got
    // treated as ours in round 26. A different port or scheme is a different origin, full stop.
    expect(publicStoreSpelling('http://css.railway.internal:9999/x/', INTERNAL, PUBLIC))
      .toBe('http://css.railway.internal:9999/x/');
    expect(publicStoreSpelling('http://css.railway.internal.attacker.example/x/', INTERNAL, PUBLIC))
      .toBe('http://css.railway.internal.attacker.example/x/');
  });

  it('it is idempotent, and a no-op when the deployment has one host', () => {
    const once = publicStoreSpelling(`${INTERNAL}p/`, INTERNAL, PUBLIC);
    expect(publicStoreSpelling(once, INTERNAL, PUBLIC)).toBe(once);
    // Unconfigured (CSS_PUBLIC_URL defaults to CSS_URL): behave exactly as before.
    expect(publicStoreSpelling(`${INTERNAL}p/`, INTERNAL, INTERNAL)).toBe(`${INTERNAL}p/`);
  });

  it('an unparseable input is returned rather than thrown over', () => {
    expect(publicStoreSpelling('not a url', INTERNAL, PUBLIC)).toBe('not a url');
    expect(publicStoreSpelling('', INTERNAL, PUBLIC)).toBe('');
  });
});

describe('the relay applies it where the value stops being its own, and nowhere else', () => {
  const src = readFileSync(join(
    dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'mcp-relay', 'server.ts',
  ), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

  it('sign_request stamps the public spelling', () => {
    expect(code.some((l) => /const podUrl = asPublicPodUrl\(await selfPodUrl\(args\)\)/.test(l))).toBe(true);
  });

  it('★ but selfPodUrl itself is unchanged, so no comparison acquires a second spelling', () => {
    // The trap this avoids is the one that has now cost five sites: two halves of a comparison
    // spelled differently. Ownership checks (`callerOwnPod`, `recipientKeyFor`) and every fetch
    // stay on CSS_URL; only the value that leaves is re-spelled.
    const at = src.indexOf('async function selfPodUrl');
    const fn = src.slice(at, src.indexOf('\n}\n', at) + 3);
    expect(fn).toMatch(/\$\{CSS_URL\}/);
    expect(fn, 'selfPodUrl must not re-spell — its callers compare with it').not.toMatch(/asPublicPodUrl|CSS_PUBLIC_URL/);
  });

  it('and CSS_PUBLIC_URL defaults to CSS_URL so an unconfigured deployment is unaffected', () => {
    expect(code.some((l) => /CSS_PUBLIC_URL = process\.env\['CSS_PUBLIC_URL'\] \?\? CSS_URL/.test(l))).toBe(true);
  });
});
