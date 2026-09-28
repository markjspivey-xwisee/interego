/**
 * THE RELAY'S CODE NAMES NO VERTICAL; THE DEPLOYMENT THAT COMPOSES ONE NAMES IT.
 *
 * Two of the relay's settings used to default to one vertical's host: the tier-2 resolver behind
 * `/ns/pgsl/:kind/:hash` (PGSL_NODE_RESOLVER) and a roster entry behind
 * `/ns/iep/action/<vertical>/<verb>` (IEP_ACTION_VERTICALS). Nothing in the repository set
 * either, so the production relay ran on those code defaults. #366 removed them from the code;
 * this pins where they went — the `reference` image, which is what production builds
 * (`deploy/images.json`) — so the live relay keeps resolving the ids it resolved before, while
 * the neutral `runtime` image composes nothing.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tierTwoResolver } from '../deploy/mcp-relay/pgsl-node-store.js';
import { relayActionRoster, resolveActionTarget } from '../deploy/mcp-relay/action-authority.js';

interface Stage { readonly name: string; readonly env: Map<string, string> }

/** The Dockerfile's stages, in order, with each stage's own single-line `ENV k=v` settings. */
function stages(dockerfile: string): Stage[] {
  const out: Stage[] = [];
  for (const raw of dockerfile.split(/\r?\n/)) {
    const line = raw.trim();
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) { out.push({ name: from[1] ?? '', env: new Map() }); continue; }
    const env = /^ENV\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (env && out.length > 0) {
      const value = env[2]!.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
      out[out.length - 1]!.env.set(env[1]!, value);
    }
  }
  return out;
}

const docker = readFileSync(new URL('../deploy/Dockerfile.relay', import.meta.url), 'utf8');
const images = JSON.parse(readFileSync(new URL('../deploy/images.json', import.meta.url), 'utf8')) as {
  images: Array<{ image: string; dockerfile: string; target?: string }>;
};
const byName = new Map(stages(docker).map(s => [s.name, s]));

describe('the relay image composes its verticals in the image, not in the code', () => {
  it('production builds the reference target', () => {
    const relay = images.images.find(i => i.image === 'interego-relay');
    expect(relay?.dockerfile).toBe('deploy/Dockerfile.relay');
    expect(relay?.target).toBe('reference');
  });

  it('the reference image names the tier-2 lattice its node ids fall back to', () => {
    const value = byName.get('reference')?.env.get('PGSL_NODE_RESOLVER');
    expect(value).toBe('https://foxxi-bridge.interego.xwisee.com/agent/lattice');
    // The value survives the relay's own parse unchanged, so it is a resolver and not "none".
    expect(tierTwoResolver(value)).toBe(value);
  });

  it('the reference image names the vertical manifests its action ids redirect to', () => {
    const value = byName.get('reference')?.env.get('IEP_ACTION_VERTICALS');
    const roster = relayActionRoster('https://relay.interego.xwisee.com', value);
    expect(resolveActionTarget(roster, 'foxxi', 'review-record').target)
      .toBe('https://foxxi-bridge.interego.xwisee.com/affordances');
    expect(resolveActionTarget(roster, 'relay', 'publish_context').target)
      .toBe('https://relay.interego.xwisee.com/.well-known/operations');
  });

  it('the neutral images compose nothing', () => {
    for (const name of ['base-runtime', 'runtime']) {
      const stage = byName.get(name);
      expect(stage, name).toBeDefined();
      expect(stage!.env.has('PGSL_NODE_RESOLVER'), name).toBe(false);
      expect(stage!.env.has('IEP_ACTION_VERTICALS'), name).toBe(false);
    }
    // And a relay started with neither setting answers only for itself.
    expect(tierTwoResolver(undefined)).toBeUndefined();
    expect(Object.keys(relayActionRoster('https://relay.test', undefined))).toEqual(['relay']);
  });
});
