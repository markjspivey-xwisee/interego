# Local and hosted deployment configuration

**Layer 3 implementation documentation.** Local installation is being developed as a supported deployment alongside the hosted relay. The foundation supplies an explicit configuration model, an importable durable local storage runtime, and a capability matrix. The separate [Interego Windows application](../applications/pod-desktop/README.md) composes it into a consumer installer with local encrypted notes and backup/restore. The low-level runtime does not replace the existing stdio MCP server or hosted account flow.

## Shared configuration

`@interego/deployment-config` resolves explicit `local` and `hosted` profiles without reading environment variables or starting services. Pod location and federation are independent settings. Local configuration requires an absolute durable data directory, defaults to a loopback HTTP endpoint, computes CIDs locally without public pinning, and has no hosted identity or relay dependency. Federation defaults off locally. Configuring peers or relays while it is off is rejected.

```ts
import { resolveDeploymentConfig, capabilitiesFor } from '@interego/deployment-config';
import { startLocalNode } from '@interego/local-node';

const config = resolveDeploymentConfig({
  profile: 'local',
  dataDir: '/absolute/path/to/interego-data',
  federation: { enabled: false },
});
const node = await startLocalNode(config);
try {
  // Existing @interego/solid operations use node.podUrl and node.fetch.
  // Encrypt private graph content through the publisher's encryption options.
  console.log(node.podUrl, capabilitiesFor('local'));
} finally {
  await node.stop();
}
```

On Windows, use an absolute local path such as `C:/Users/your-name/AppData/Local/Interego/data`. Application code should obtain the user's application-data location from the host rather than hard-code a username. Keep the same configured endpoint across restarts while persisted descriptors refer to its URLs. An ephemeral port is useful for isolated tests; the runtime's returned URLs are authoritative.

The configuration's `instanceId` scopes connection and credential caches. It is not a DID, a portable owner identity, or proof of a migration. Switching profiles alone does not copy data or link accounts.

`resolveStdioConfig(env)` preserves the existing stdio environment contract, including explicit `CG_HOME_POD` precedence and legacy cloud pinning configuration. The stdio entry point now consumes that shared resolver. Its build stages the shared compiled resolver into the public MCP package, avoiding a runtime dependency on a private workspace package. It remains a separate adapter: selecting the new local runtime does not launch stdio MCP. Its legacy mode selection remains unchanged; the explicit local deployment resolver supplies the new strict loopback and offline defaults.

## Runtime boundary

The local runtime bundles its own Community Solid Server configuration and dependency. It stores resources beneath the supplied data directory, excludes concurrent writers with a lock, and exposes a credential-gated loopback HTTP endpoint. Its backing CSS server listens through a private Unix socket or Windows named pipe rather than a second TCP port.

Every gateway read and write requires authorization. Host and browser-origin checks reject unrelated callers. The returned fetch function carries the service credential only to this node and refuses redirects. This initial gateway supports GET, HEAD, PUT, DELETE, and OPTIONS with bounded media types. It rejects JSON-LD contexts, conversion profiles, and PATCH until a controlled conversion path exists, so those paths cannot trigger external loading. Graph encryption remains the publisher's responsibility; arbitrary plaintext writes remain plaintext on disk. The service credential does not replace content encryption keys, and other processes running as the same OS user remain inside the local trust boundary.

Graceful shutdown releases the lock. The low-level runtime fails closed on a leftover `runtime.lock` after a crash. The Windows application supplies conservative recovery of a demonstrably dead process's lock while holding its single-instance lock, a Windows-protected notes key, and portable encrypted notes backups. Other hosts must supply their own key custody and recovery. Per-client authorization and endpoint migration remain later milestones.

## Capability matrix

The machine-readable authority is `CAPABILITY_MATRIX` / `capabilitiesFor()` in `@interego/deployment-config`. The local column describes the new storage runtime, not full parity with stdio MCP or hosted applications.

| Capability | Local runtime | Hosted relay | Personal bridge |
|---|---|---|---|
| Solid pod storage | Durable file-backed CSS | Existing hosted storage | Separate Solid composition required |
| Encrypted graph payloads | Existing publisher with caller-owned keys | Existing encrypted publishing | Separate encrypted P2P shares |
| Owner key custody and recovery | Caller-managed; Windows app adds protected notes key and notes backup/restore | Existing hosted account model | Private bridge key configuration required |
| MCP tools | Windows app adds scoped local notes tools; low-level runtime has no adapter | Existing tool surface retained | Six P2P tools |
| Hosted OAuth | Not required or started | Existing flow retained | Not included |
| Solid notifications | Gateway support pending | Existing service | Not included |
| Cross-pod Solid federation | Transport not included | Existing selected sharing/discovery | Separate Solid composition required |
| Encrypted relay sharing | Transport not included | Separate bridge composition required | Explicit selected-relay configuration |
| Reliable cross-domain offline delivery | Not guaranteed | Not guaranteed | Durable outbox pending |

The explicit configuration model can represent federation intent. This first local runtime refuses `federation.enabled: true` because it does not yet implement a transport. Existing hosted and personal-bridge federation behavior is unchanged. The Windows installer is a separate consumer preview with its own packaged lifecycle check and [revocable agent connections](../applications/pod-desktop/AGENT-CONNECTIONS.md). Pairing a local agent does not enable federation. Optional local federation and offline delivery remain later milestones.

## Verification

Build the workspace before running the tests: they import the built packages.

```sh
npm run build
npx vitest run tests/deployment-config.test.ts tests/stdio-config.test.ts tests/local-node.test.ts
```

The local-node integration suite starts real CSS, publishes encrypted content through `@interego/solid`, stops and restarts the runtime over the same directory, and checks discovery and decryption. It records and refuses non-loopback TCP connections during the flow, exercises unauthorized and foreign-origin requests, and checks conflicting startup and cleanup. Existing stdio compatibility tests remain the regression gate for its tool and protocol surface.
