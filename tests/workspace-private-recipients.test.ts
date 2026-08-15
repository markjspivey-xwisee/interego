/**
 * A PRIVATE WORKSPACE MUST NOT BECOME N SILOS.
 *
 * ── ★★ THE FAILURE THIS PINS ────────────────────────────────────────────────
 *
 * Entries live on their AUTHOR's pod. `visibility: 'shared'` seals a payload to that pod's own
 * registered agents unioned with `share_with` — so with no `share_with`, the union is just the
 * author. Every entry in a "private" channel would be encrypted to the one person who wrote it.
 *
 * Nothing about that looks wrong from the writing side: the publish returns 200, the entry appears
 * in the chain, the descriptor is well formed. It is only wrong from everybody else's side, where
 * the channel reads as a list of records none of which will open — and it cannot be repaired
 * afterwards, because an envelope's recipients are fixed when it is written.
 *
 * So the writers FAIL CLOSED: private with no recipients is a refusal, not a publish. Refusing
 * costs a message; publishing costs the record.
 */

import { describe, it, expect } from 'vitest';
import { postEntry } from '../packages/workspace-client/src/entry.js';
import { saveCanvas } from '../packages/workspace-client/src/canvas.js';
import { recipientsFor } from '../packages/workspace-client/src/recipients.js';
import { WorkspaceClient } from '../packages/workspace-client/src/substrate.js';
import type { Seat } from '../packages/workspace-client/src/seats.js';

const WEBID = (p: string): string => 'https://identity.interego.xwisee.com/users/' + p + '/profile#me';
const seat = (pod: string, over: Partial<Seat> = {}): Seat => ({
  graph: 'urn:graph:' + pod, grantUrl: null, grantCid: null, role: 'Contributor',
  grantedTo: WEBID(pod), pod, seated: true, why: null, ...over,
} as Seat);

/** Records every `publish_context` argument set, and answers plausibly. */
function recordingClient(): { client: WorkspaceClient; published: Record<string, unknown>[] } {
  const published: Record<string, unknown>[] = [];
  const tx = {
    callTool: (name: string, input: Record<string, unknown>) => {
      if (name === 'discover_context') return Promise.resolve({ pod: 'u-a', entries: [] });
      if (name === 'publish_context') {
        published.push(input);
        return Promise.resolve({ published: true, descriptorUrl: 'https://css.example/u-a/x.ttl', status: 'committed' });
      }
      return Promise.resolve({});
    },
  };
  return { client: new WorkspaceClient('https://relay.example', tx as never), published };
}

const ENTRY = {
  podName: 'u-a', streamIri: 'https://relay.example/ns/u-a/wsp-stream',
  workspace: 'https://relay.example/ns/u-a/wsp', body: 'hello', entryShape: null,
  author: { kind: 'principal', webId: WEBID('u-a') } as const,
};
const CANVAS = {
  canvasIri: 'https://relay.example/ns/u-a/wsp-canvas', podName: 'u-a',
  workspace: 'https://relay.example/ns/u-a/wsp', slug: 'wsp', body: 'notes',
  ifMatch: null, previousCid: null,
};

describe('★★ a private write with no recipients is refused, not published', () => {
  it('refuses an entry rather than sealing it to its author alone', async () => {
    const { client, published } = recordingClient();
    const out = await postEntry(client, { ...ENTRY, visibility: 'private' });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(String(out.body['message'])).toContain('seal it to you alone');
    // The point of failing closed: nothing reached the relay.
    expect(published).toHaveLength(0);
  });

  it('refuses a canvas save for the same reason', async () => {
    const { client, published } = recordingClient();
    const out = await saveCanvas(client, { ...CANVAS, visibility: 'private' });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(String(out.body['message'])).toContain('seal it to you alone');
    expect(published).toHaveLength(0);
  });

  it('★ and an EMPTY recipient list is refused too — it is not a shorter list, it is nobody', async () => {
    const { client } = recordingClient();
    const out = await postEntry(client, { ...ENTRY, visibility: 'private', shareWith: [] });
    expect(out.kind).toBe('refused');
  });
});

describe('what actually reaches the relay', () => {
  it('★★ sends share_with for a private entry', async () => {
    const { client, published } = recordingClient();
    const out = await postEntry(client, { ...ENTRY, visibility: 'private', shareWith: [WEBID('u-b')] });
    expect(out.kind).toBe('accepted');
    expect(published[0]?.['visibility']).toBe('shared');
    expect(published[0]?.['share_with']).toEqual([WEBID('u-b')]);
  });

  it('★ and sends NO share_with for a public one, which would imply an audience the plaintext has not got', async () => {
    const { client, published } = recordingClient();
    await postEntry(client, { ...ENTRY, visibility: 'public', shareWith: [WEBID('u-b')] });
    expect(published[0]?.['visibility']).toBe('public');
    expect(published[0]).not.toHaveProperty('share_with');
  });

  it('★ the canvas sends it too', async () => {
    const { client, published } = recordingClient();
    // `awaitTries: 0` because this asserts what was SENT, not what the pod did with it — the
    // head-settling loop would otherwise poll a fake that never settles.
    await saveCanvas(client, { ...CANVAS, visibility: 'private', shareWith: [WEBID('u-b')], awaitTries: 0 });
    expect(published[0]?.['visibility']).toBe('shared');
    expect(published[0]?.['share_with']).toEqual([WEBID('u-b')]);
  });
});

describe('recipientsFor joins "is it private" to "who is in it"', () => {
  const roster = { seats: [seat('u-a'), seat('u-b')], grantsFound: 2, grantsRead: 2 };

  it('gives no list at all for a public workspace', () => {
    const r = recipientsFor('public', roster);
    expect(r.ok).toBe(true);
    // undefined, NOT [] — the writers only send `share_with` when they are actually encrypting,
    // and an empty array is the value that means "nobody".
    if (r.ok) expect(r.shareWith).toBeUndefined();
  });

  it('gives every seated member for a private one', () => {
    const r = recipientsFor('private', roster);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.shareWith).toEqual([WEBID('u-a'), WEBID('u-b')]);
  });

  it('★★ refuses when the workspace is private and no roster was read', () => {
    // The state a caller is in before the members list loads. Publishing here would seal to the
    // author alone — the exact silo this file exists for — so it is a refusal.
    const r = recipientsFor('private', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('roster has not been read');
  });

  it('★ and passes the truncated-roster refusal through rather than encrypting to what it read', () => {
    const r = recipientsFor('private', { seats: [seat('u-a')], grantsFound: 40, grantsRead: 25 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('roster is incomplete');
  });
});
