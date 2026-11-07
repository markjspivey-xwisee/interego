import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_MATRIX,
  capabilitiesFor,
  resolveDeploymentConfig,
  type DeploymentConfigInput,
} from '@interego/deployment-config';

const local = { profile: 'local', dataDir: '/var/lib/interego/owner' } as const;
const resolveUnknown = (value: unknown) => resolveDeploymentConfig(value as DeploymentConfigInput);

afterEach(() => vi.unstubAllEnvs());

describe('explicit deployment profiles', () => {
  it('defaults a local profile to durable local storage and no external services', () => {
    const config = resolveDeploymentConfig(local);
    expect(config).toMatchObject({
      profile: 'local', dataDir: local.dataDir,
      baseUrl: 'http://127.0.0.1:3456/', podName: 'agent', podUrl: 'http://127.0.0.1:3456/agent/',
      ipfsProvider: 'local-unpinned', identityUrl: null, relayUrl: null,
      federation: { enabled: false, knownPods: [], externalRelays: [], inboundAuthors: [] },
    });
  });

  it('does not inherit pinning credentials, hosted endpoints or peers from process.env', () => {
    vi.stubEnv('PINATA_API_KEY', 'ambient-test-credential');
    vi.stubEnv('CG_IPFS_PROVIDER', 'pinata');
    vi.stubEnv('CG_KNOWN_PODS', 'https://peer.example/owner/');
    vi.stubEnv('CG_IDENTITY_URL', 'https://identity.example/');
    vi.stubEnv('EXTERNAL_RELAYS', 'wss://relay.example/');
    expect(resolveDeploymentConfig(local)).toEqual(resolveDeploymentConfig({ ...local }));
    expect(resolveDeploymentConfig(local).federation.enabled).toBe(false);
    expect(resolveDeploymentConfig(local).ipfsProvider).toBe('local-unpinned');
    expect(resolveDeploymentConfig(local).identityUrl).toBeNull();
  });

  it.each([
    ['http://localhost:4050', 'http://localhost:4050/owner/'],
    ['http://127.0.0.1:4050/', 'http://127.0.0.1:4050/owner/'],
    ['http://[::1]:4050/', 'http://[::1]:4050/owner/'],
  ])('normalizes the loopback base %s and derives the pod URL', (baseUrl, expectedPodUrl) => {
    expect(resolveDeploymentConfig({ ...local, baseUrl, podName: 'owner' }).podUrl).toBe(expectedPodUrl);
  });

  it.each([
    'http://localhost.example:3456/', 'http://127.0.0.1.example:3456/',
    'http://example.com/localhost/', 'http://192.168.1.4:3456/',
    'http://0.0.0.0:3456/', 'http://[::]:3456/',
    'https://localhost:3456/', 'http://localhost:3456/pods/',
    'http://user:password@localhost:3456/', 'http://localhost:3456/?secret=value',
    'http://localhost:3456/#fragment', 'http://localhost:3456/?', 'http://localhost:3456/#', 'http://localhost:0/', 'localhost:3456',
  ])('rejects an unsuitable local API URL: %s', (baseUrl) => {
    expect(() => resolveDeploymentConfig({ ...local, baseUrl })).toThrow();
  });

  it('normalizes POSIX and Windows data paths without consulting the current directory', () => {
    expect(resolveDeploymentConfig({ ...local, dataDir: '/var/lib/interego/./owner/' }).dataDir).toBe(local.dataDir);
    expect(resolveDeploymentConfig({ ...local, dataDir: 'C:\\Users\\owner\\Interego\\data\\' }).dataDir).toBe('C:\\Users\\owner\\Interego\\data');
  });

  it.each([
    '', 'data', './data', '~/data', '/', 'C:\\', 'C:data', '\\data',
    '\\\\server\\share\\data', '//server/share/data', 'file:///data',
    '/data\nother', ' C:\\data', 'C:\\data\\invalid?name',
  ])('rejects a missing, ambiguous or invalid durable data directory: %s', (dataDir) => {
    expect(() => resolveDeploymentConfig({ ...local, dataDir })).toThrow();
  });

  it.each(['../owner', '..', '.', '/owner', 'owner/other', 'owner?key', 'owner#fragment', 'owner name', ''])('rejects an unsafe pod path segment: %s', (podName) => {
    expect(() => resolveDeploymentConfig({ ...local, podName })).toThrow();
  });

  it('normalizes configured hosted endpoints without changing the selected pod', () => {
    const config = resolveDeploymentConfig({
      profile: 'hosted', baseUrl: 'https://store.example/pods', podName: 'fallback',
      podUrl: 'https://store.example/owner', relayUrl: 'https://relay.example',
      identityUrl: 'https://identity.example', ipfsProvider: 'pinata',
    });
    expect(config).toMatchObject({
      profile: 'hosted', baseUrl: 'https://store.example/pods/',
      podUrl: 'https://store.example/owner/', relayUrl: 'https://relay.example/',
      identityUrl: 'https://identity.example/', ipfsProvider: 'pinata', federation: { enabled: true },
    });
    expect(config).not.toHaveProperty('dataDir');
  });

  it('requires hosted storage explicitly and does not invent identity or relay services', () => {
    expect(() => resolveUnknown({ profile: 'hosted' })).toThrow();
    expect(resolveDeploymentConfig({ profile: 'hosted', baseUrl: 'https://store.example/' })).toMatchObject({
      identityUrl: null, relayUrl: null, ipfsProvider: 'local-unpinned',
    });
  });

  it.each([
    { profile: 'local', dataDir: local.dataDir, relayUrl: 'https://relay.example/' },
    { profile: 'local', dataDir: local.dataDir, ipfsProvider: 'pinata' },
    { profile: 'hosted', baseUrl: 'https://store.example/', dataDir: local.dataDir },
    { profile: 'local', dataDir: local.dataDir, baseUrl: null },
    { profile: 'hosted', baseUrl: 'https://store.example/', ipfsProvider: null },
    { profile: 'local', dataDir: local.dataDir, federaton: { enabled: true } },
    { profile: 'unknown' }, null, [],
  ])('rejects fields from another profile, misspellings and malformed inputs', (input) => {
    expect(() => resolveUnknown(input)).toThrow();
  });

  it('scopes local credentials by durable data root and hosted credentials by selected endpoints', () => {
    const first = resolveDeploymentConfig(local);
    const movedPort = resolveDeploymentConfig({ ...local, baseUrl: 'http://127.0.0.1:4050/' });
    const otherRoot = resolveDeploymentConfig({ ...local, dataDir: '/var/lib/interego/other' });
    const hosted = resolveDeploymentConfig({ profile: 'hosted', baseUrl: first.baseUrl });
    const otherHosted = resolveDeploymentConfig({ profile: 'hosted', baseUrl: first.baseUrl, relayUrl: 'https://relay.example/' });
    expect(first.instanceId).toBe(movedPort.instanceId);
    expect(first.instanceId).not.toBe(otherRoot.instanceId);
    expect(first.instanceId).not.toBe(hosted.instanceId);
    expect(hosted.instanceId).not.toBe(otherHosted.instanceId);
  });

  it('returns deeply frozen output without retaining caller-owned arrays', () => {
    const knownPods = ['https://peer.example/owner'];
    const config = resolveDeploymentConfig({ ...local, federation: { enabled: true, knownPods } });
    knownPods.push('https://later.example/owner/');
    expect(config.federation.knownPods).toEqual(['https://peer.example/owner/']);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.federation)).toBe(true);
    expect(Object.isFrozen(config.federation.knownPods)).toBe(true);
    expect(Object.isFrozen(config.federation.externalRelays)).toBe(true);
  });
});

describe('federation configuration', () => {
  it.each([
    { knownPods: ['https://peer.example/owner/'] },
    { directoryUrl: 'https://directory.example/list' },
    { externalRelays: ['wss://relay.example/'] },
    { inboundAuthors: ['peer-author'] },
  ])('rejects nonempty federation settings when local federation is off', (federation) => {
    expect(() => resolveDeploymentConfig({ ...local, federation })).toThrow(/enabled/);
    expect(() => resolveDeploymentConfig({ profile: 'hosted', baseUrl: 'https://store.example/', federation: { enabled: false, ...federation } })).toThrow(/enabled/);
  });

  it('accepts explicit opt-in, normalizes peers and removes duplicate endpoints', () => {
    const config = resolveDeploymentConfig({ ...local, federation: {
      enabled: true, knownPods: ['https://peer.example/owner', 'https://peer.example/owner/'],
      directoryUrl: 'https://directory.example/list', externalRelays: ['wss://relay.example'], inboundAuthors: ['alice', 'alice'],
    } });
    expect(config.federation).toEqual({
      enabled: true, knownPods: ['https://peer.example/owner/'], directoryUrl: 'https://directory.example/list',
      externalRelays: ['wss://relay.example/'], inboundAuthors: ['alice'],
    });
    expect(capabilitiesFor('local').find(c => c.id === 'cross-pod-federation')?.support).toBe('not-included');
  });

  it.each([
    { enabled: 'false' }, { enabled: true, knownPods: 'https://peer.example/' },
    { enabled: true, knownPods: ['file:///data'] }, { enabled: true, externalRelays: ['https://relay.example/'] },
    { enabled: true, inboundAuthors: [''] }, { enabled: true, directoryURL: 'https://directory.example/' },
  ])('rejects malformed federation contracts', (federation) => {
    expect(() => resolveUnknown({ ...local, federation })).toThrow();
  });
});

describe('capability disclosure', () => {
  it('distinguishes the local storage runtime, hosted MCP relay and six-tool personal bridge', () => {
    const support = (surface: 'local' | 'hosted' | 'personal-bridge', id: string) => capabilitiesFor(surface).find(c => c.id === id)?.support;
    expect(support('local', 'solid-pod-storage')).toBe('available');
    expect(support('local', 'mcp-tools')).toBe('not-included');
    expect(support('local', 'hosted-oauth')).toBe('not-included');
    expect(support('local', 'solid-notifications')).toBe('not-included');
    expect(support('hosted', 'mcp-tools')).toBe('available');
    expect(support('personal-bridge', 'solid-pod-storage')).toBe('not-included');
    expect(support('personal-bridge', 'encrypted-relay-sharing')).toBe('requires-configuration');
    expect(capabilitiesFor('hosted').find(c => c.id === 'cross-pod-federation')?.detail).toContain('only within its deployment');
    for (const surface of ['local', 'hosted', 'personal-bridge'] as const) {
      expect(support(surface, 'durable-offline-delivery')).toBe('not-guaranteed');
      const capabilities = capabilitiesFor(surface);
      expect(new Set(capabilities.map(c => c.id)).size).toBe(capabilities.length);
      expect(Object.isFrozen(capabilities)).toBe(true);
      expect(capabilities.every(Object.isFrozen)).toBe(true);
    }
    expect(Object.isFrozen(CAPABILITY_MATRIX)).toBe(true);
  });
});
