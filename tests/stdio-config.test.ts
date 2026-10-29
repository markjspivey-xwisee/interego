import { describe, expect, it } from 'vitest';
import { resolveStdioConfig } from '@interego/deployment-config';

describe('stdio configuration compatibility', () => {
  it('preserves existing defaults without reading the ambient environment', () => {
    expect(resolveStdioConfig({})).toEqual({
      cssPort: 3456,
      podName: 'agent',
      baseUrl: 'http://localhost:3456/',
      homePod: 'http://localhost:3456/agent/',
      agentId: 'urn:agent:claude-code:local',
      ownerWebId: 'https://id.example.com/agent/profile#me',
      ownerName: undefined,
      did: 'did:web:agent.local',
      knownPodsRaw: '',
      directoryUrl: undefined,
      identityUrl: 'https://identity.interego.xwisee.com',
      ipfsProvider: 'local-unpinned', ipfsApiKey: '', isLocal: true,
    });
  });

  it('preserves explicitly configured hosted endpoints and identity settings', () => {
    expect(resolveStdioConfig({
      CG_PORT: '4567', CG_POD_NAME: 'person', CG_BASE_URL: 'https://store.example/',
      CG_HOME_POD: 'https://other.example/private/', CG_AGENT_ID: 'did:key:zAgent',
      CG_OWNER_WEBID: 'https://owner.example/#me', CG_OWNER_NAME: 'Owner',
      CG_DID: 'did:key:zAgent', CG_IDENTITY_URL: 'https://identity.example',
      CG_KNOWN_PODS: 'https://peer.example/', CG_DIRECTORY_URL: 'https://directory.example/catalog',
    })).toMatchObject({
      cssPort: 4567, podName: 'person', baseUrl: 'https://store.example/',
      homePod: 'https://other.example/private/', agentId: 'did:key:zAgent',
      ownerWebId: 'https://owner.example/#me', ownerName: 'Owner', did: 'did:key:zAgent',
      identityUrl: 'https://identity.example', knownPodsRaw: 'https://peer.example/',
      directoryUrl: 'https://directory.example/catalog', isLocal: false,
    });
  });

  it('retains legacy base-url mode selection independently of the home-pod override', () => {
    expect(resolveStdioConfig({ CG_HOME_POD: 'https://remote.example/person/' }).isLocal).toBe(true);
    expect(resolveStdioConfig({ CG_BASE_URL: 'https://remote.example/', CG_HOME_POD: 'http://127.0.0.1:4567/person/' }).isLocal).toBe(false);
    expect(resolveStdioConfig({ CG_BASE_URL: 'http://127.0.0.1:4567/' }).isLocal).toBe(true);
    expect(resolveStdioConfig({ CG_BASE_URL: 'https://remote.example/' }).isLocal).toBe(false);
  });

  it('retains legacy pinning precedence while honoring an explicit local provider', () => {
    const env = { PINATA_API_KEY: 'pinata-test', WEB3STORAGE_TOKEN: 'web3-test' };
    expect(resolveStdioConfig(env)).toMatchObject({ ipfsProvider: 'pinata', ipfsApiKey: 'pinata-test' });
    expect(resolveStdioConfig({ ...env, CG_IPFS_PROVIDER: 'web3storage' })).toMatchObject({ ipfsProvider: 'web3storage', ipfsApiKey: 'web3-test' });
    expect(resolveStdioConfig({ ...env, CG_IPFS_PROVIDER: 'local' })).toMatchObject({ ipfsProvider: 'local-unpinned', ipfsApiKey: '' });
    expect(resolveStdioConfig({ ...env, CG_IPFS_API_KEY: 'explicit-test' }).ipfsApiKey).toBe('explicit-test');
  });
});
