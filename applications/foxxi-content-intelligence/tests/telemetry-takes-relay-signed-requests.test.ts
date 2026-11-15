/**
 * The telemetry capture-settings and query routes take a relay-signed request whose payload holds
 * the relay's own fields, `client_id` included, and still refuse any other key they do not know.
 *
 * Both routes verify the signature (bindSignedCaller), set the signer's fields aside, and hand the
 * rest to a closed validator: `updateCapturePreferences` refuses any key but server_enabled,
 * client_enabled and expected_revision ("invalid capture setting: <key>"), and `normalizeQuery`
 * any key outside its query fields ("unsupported query field: <key>"); either becomes the route's
 * 400. Before this, the routes set aside agent_id, subject_pod_url and timestamp only, so a relay
 * that also signs `client_id` would have had every chat agent's settings change and query
 * refused. This drives the route's own steps, after the signature check, with such a payload:
 * the helper the routes call, then the validator each one feeds. The bridge module listens at
 * import, so the wiring (both routes call the helper, and nothing else sets the fields aside) is
 * read from its source, as the other Foxxi route tests do.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RELAY_SIGNED_FIELDS, withoutRelaySignedFields } from '../src/relay-signed-fields.js';
import { updateCapturePreferences, type CaptureStore } from '../../llm-telemetry/capture.js';
import { normalizeQuery } from '../../llm-telemetry/service.js';

const observer = 'did:web:identity.example:agents:mcp-client-u-pk-aaaa11112222';
/** What the relay adds to a payload it signs for that agent. */
const relay = {
  agent_id: observer,
  timestamp: '2026-11-09T12:00:00.000Z',
  subject_pod_url: 'https://pod.example/u-pk-aaaa11112222/',
  client_id: 'https://bridge.example/ui/oauth/client.json',
};

function captureStore(): CaptureStore {
  const records: unknown[] = [];
  return { now: () => '2026-11-09T12:00:01.000Z', load: async () => records, persist: async (r) => { records.push({ ...r }); return true; } };
}

describe('telemetry routes take what the relay signs', () => {
  it('set aside exactly the signer\'s fields: agent_id, timestamp, subject_pod_url and client_id', () => {
    expect([...RELAY_SIGNED_FIELDS].sort()).toEqual(['agent_id', 'client_id', 'subject_pod_url', 'timestamp']);
    expect(withoutRelaySignedFields({ ...relay, server_enabled: true, expected_revision: 0 })).toEqual({ server_enabled: true, expected_revision: 0 });
  });

  it('capture/update: a relay-signed settings change with client_id is applied, not refused', async () => {
    const store = captureStore();
    const preferences = await updateCapturePreferences(observer, withoutRelaySignedFields({ ...relay, server_enabled: true }), store);
    expect(preferences).toMatchObject({ server_enabled: true, client_enabled: false, revision: 1, observer });
  });

  it('capture/update: any other unlisted field is still refused with 400', async () => {
    await expect(updateCapturePreferences(observer, withoutRelaySignedFields({ ...relay, server_enabled: true, pod_name: 'another-fictional-pod' }), captureStore()))
      .rejects.toMatchObject({ status: 400, message: 'invalid capture setting: pod_name' });
  });

  it('query: a relay-signed query with client_id is read, nested or flat', () => {
    const nested = withoutRelaySignedFields({ ...relay, query: { kind: 'tool-completed', limit: 5 } });
    expect(normalizeQuery(nested.query ?? nested)).toEqual({ kind: 'tool-completed', limit: 5 });
    const flat = withoutRelaySignedFields({ ...relay, kind: 'tool-completed' });
    expect(normalizeQuery(flat.query ?? flat)).toEqual({ kind: 'tool-completed' });
    const bare = withoutRelaySignedFields({ ...relay });
    expect(normalizeQuery(bare.query ?? bare)).toEqual({});
  });

  it('query: any other unlisted field is still refused', () => {
    const options = withoutRelaySignedFields({ ...relay, pod_name: 'another-fictional-pod' });
    expect(() => normalizeQuery(options.query ?? options)).toThrow('unsupported query field: pod_name');
  });

  it('both routes in the bridge call the helper, and set nothing aside by hand', () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const captureAt = server.indexOf("if (operation === 'telemetry-capture-read' || operation === 'telemetry-capture-update') {");
    const queryAt = server.indexOf("} else if (operation === 'telemetry-query') {");
    expect(captureAt).toBeGreaterThan(-1);
    expect(queryAt).toBeGreaterThan(-1);
    expect(server.slice(captureAt, captureAt + 400)).toMatch(/const settings = withoutRelaySignedFields\(bound\.payload\);/);
    expect(server.slice(queryAt, queryAt + 500)).toMatch(/const options = withoutRelaySignedFields\(bound\.payload\);/);
    expect(server).not.toMatch(/subject_pod_url:\s*_\w+[^}]*\.\.\.(?:settings|options)\s*\}\s*=\s*bound\.payload/);
  });
});
