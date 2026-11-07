# `@interego/deployment-config`

Implementation configuration for explicit local and hosted deployments. This package reads no environment variables, creates no files, starts no services and makes no network requests.

```ts
import { resolveDeploymentConfig, capabilitiesFor } from '@interego/deployment-config';

const config = resolveDeploymentConfig({
  profile: 'local',
  dataDir: '/var/lib/interego/owner',
  baseUrl: 'http://127.0.0.1:3456/',
  podName: 'owner',
});
const capabilities = capabilitiesFor(config.profile);
```

Local profiles require a dedicated absolute local data directory and an HTTP loopback origin. Relative paths, filesystem roots, network shares, embedded URL credentials, query strings and fragments are rejected. Path validation is lexical: the runtime must still create the directory and check its ownership, permissions and writability. Local configuration always selects `local-unpinned` and has no hosted identity or relay endpoint. Existing stdio environment behavior is a separate compatibility adapter.

Federation defaults off for local profiles and on for explicit hosted profiles. Disabled federation rejects nonempty peer, directory, external-relay and inbound-author settings. Enabling federation in a configuration does not start a transport or imply that a runtime implements it; `@interego/local-node` currently provides local storage only. Hosted endpoints and pinning providers are caller supplied. Secrets are intentionally absent from this configuration.

`instanceId` scopes credentials and caches. A local scope follows its normalized data directory, and a hosted scope follows its selected pod, relay and identity endpoints. It is not a cryptographic identity, an owner identifier or proof that a migration occurred. Signed records must retain their original bytes and identifiers across migration.

All resolved objects, nested federation objects, arrays and capability entries are frozen. `CAPABILITY_MATRIX` and `capabilitiesFor('local' | 'hosted' | 'personal-bridge')` describe the respective runtime surfaces, including missing capabilities and delivery guarantees. They distinguish the local Solid runtime from the separate stdio MCP server and the six-tool personal P2P bridge. No vertical application is bundled.
