/** Existing stdio settings, resolved without reading ambient process state. */
export interface StdioConfig {
  readonly cssPort: number;
  readonly podName: string;
  readonly baseUrl: string;
  readonly homePod: string;
  readonly agentId: string;
  readonly ownerWebId: string;
  readonly ownerName: string | undefined;
  readonly did: string;
  readonly knownPodsRaw: string;
  readonly directoryUrl: string | undefined;
  readonly identityUrl: string;
  readonly ipfsProvider: 'pinata' | 'web3storage' | 'local-unpinned';
  readonly ipfsApiKey: string;
  readonly isLocal: boolean;
}

/**
 * Compatibility adapter for the stdio entry point. Its existing ambient-key
 * pinning behavior is intentional here; explicit local deployment profiles use
 * resolveDeploymentConfig instead and never infer cloud services from env.
 */
export function resolveStdioConfig(env: Readonly<Record<string, string | undefined>>): StdioConfig {
  const cssPort = parseInt(env['CG_PORT'] ?? '3456');
  const podName = env['CG_POD_NAME'] ?? 'agent';
  const baseUrl = env['CG_BASE_URL'] ?? `http://localhost:${cssPort}/`;
  const homePod = env['CG_HOME_POD'] ?? `${baseUrl}${podName}/`;
  const pinata = env['PINATA_API_KEY'] ?? '';
  const web3 = env['WEB3STORAGE_TOKEN'] ?? '';
  const explicit = env['CG_IPFS_PROVIDER'];
  const ipfsProvider = explicit === 'pinata' || explicit === 'web3storage' ? explicit
    : explicit === 'local' || explicit === 'local-unpinned' ? 'local-unpinned'
    : pinata ? 'pinata' : web3 ? 'web3storage' : 'local-unpinned';
  const ipfsApiKey = env['CG_IPFS_API_KEY']
    ?? (ipfsProvider === 'pinata' ? pinata : ipfsProvider === 'web3storage' ? web3 : '');
  // Preserve the existing adapter's mode decision along with its endpoints.
  // Reworking this alone would route setup_identity through a different branch
  // while that handler still derives its destination from baseUrl. New explicit
  // local profiles use resolveDeploymentConfig's strict loopback validation.
  const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
  return Object.freeze({
    cssPort, podName, baseUrl, homePod,
    agentId: env['CG_AGENT_ID'] ?? 'urn:agent:claude-code:local',
    ownerWebId: env['CG_OWNER_WEBID'] ?? `https://id.example.com/${podName}/profile#me`,
    ownerName: env['CG_OWNER_NAME'] ?? undefined,
    did: env['CG_DID'] ?? `did:web:${podName}.local`,
    knownPodsRaw: env['CG_KNOWN_PODS'] ?? '',
    directoryUrl: env['CG_DIRECTORY_URL'] ?? undefined,
    identityUrl: env['CG_IDENTITY_URL'] ?? 'https://identity.interego.xwisee.com',
    ipfsProvider, ipfsApiKey, isLocal,
  });
}
