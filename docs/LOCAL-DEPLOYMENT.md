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
| Owner key custody and recovery | Caller-managed; Windows app adds separate protected notes/sign-in keys and encrypted backups | Existing hosted account model | Private bridge key configuration required |
| MCP tools | Windows app adds scoped local notes tools and optional remote MCP access through a saved user-owned address or temporary link; low-level runtime has no adapter | Existing tool surface retained | Six P2P tools |
| Hosted OAuth | Not required or started | Existing flow retained | Not included |
| Solid notifications | Gateway support pending | Existing service | Not included |
| Cross-pod Solid federation | Transport not included | Existing selected sharing/discovery | Separate Solid composition required |
| Encrypted relay sharing | Transport not included | Separate bridge composition required | Explicit selected-relay configuration |
| Reliable cross-domain offline delivery | Not guaranteed | Not guaranteed | Durable outbox pending |

The explicit configuration model can represent federation intent. The bare local storage runtime refuses `federation.enabled: true` because it does not implement a transport. The Windows app now separately composes `@interego/pod-federation` with its optional HTTPS bridge for [invited local-to-local and local-to-hosted snapshot sharing](../applications/pod-desktop/POD-SHARING.md). Its Solid storage stays on loopback; peer routes have separate keys, permissions and explicit owner consent. Sharing starts off on every app launch. Pairing an agent does not enable federation. Existing hosted sharing remains available; reliable offline delivery remains a later capability.

The Windows app's optional web bridge uses a separate OAuth-gated MCP listener. A permanent user-owned Cloudflare hostname is the default setup choice; an externally managed HTTPS gateway and a temporary Quick Tunnel remain alternatives. The storage runtime remains on loopback. Stable addresses retain Windows-protected OAuth registrations and token hashes across process restarts; pausing closes transport, while Disconnect and Forget remove authorization. Pending browser consent and authorization codes remain ephemeral. Saved authority binds the public origin, fixed loopback port, pod and permission policy. Access is disabled after every app launch and resumes only by owner action. The provider can process in-transit tool traffic. Cloudflare's remotely managed route configuration belongs to the user; the app checks its own public route and requires a dedicated tunnel rather than claiming to override other provider routes. The low-level capability matrix does not imply this consumer adapter exists on every local host.

The Windows app also offers a separate [native-held sign-in identity](../applications/pod-desktop/LOCAL-IDENTITY.md), an exact-origin Chrome/Edge companion and approval for every sign-in. It completes the existing hosted identity/OAuth protocol through a one-use relay handoff, without enabling the public bridge or federation. A fresh credential creates a separate hosted owner; existing-account linking and local game storage are separate capabilities. This app adapter does not change the low-level runtime's capability matrix or make hosted identity a dependency of local note storage.

## Hypermedia and linked data in a local installation

The local pod is already an authoritative HTTP resource server. It does not need a second cached copy of its own data to support local use. The Windows note reader [discovers descriptors and follows the declared encrypted distribution](../applications/pod-desktop/src/controller.ts), then decrypts with the local owner's key. The kernel already provides [dereference and act](../packages/core/src/kernel/index.ts), [descriptor-driven affordance following](../packages/core/src/affordance/follow.ts), and [JSON-LD/Hydra/SHACL response decoration](../packages/core/src/kernel/hypermedia.ts).

The current Windows notes adapter exposes four scoped MCP tools. Its client projection retains note values and connection authorship but does not yet expose a general linked-data entrypoint, descriptors or advertised action controls. A stable bridge URL and saved OAuth pairing fix transport and authorization continuity; they do not by themselves provide full substrate parity. The [local storage gateway](../packages/local-node/src/index.ts) also intentionally rejects uncontrolled JSON-LD context loading and unsupported mutation paths.

The next L3 adapter slice should preserve the existing resource model:

1. Expose an authenticated entrypoint with links to resources the current connection may use. A note's canonical graph identity remains `urn:graph:pod-note:<uuid>`; the adapter must actually resolve that identity within its permitted namespace.
2. Return canonical IRIs, described-by and alternate-representation links, negotiated media types and current permission-filtered controls. Place bridge access URLs alongside original identities and any signed representations. Rewriting signed triples to a tunnel hostname would change the signed content.
3. Follow the descriptor's advertised target, action, method and media type through the existing core follower; expose and enforce the advertised input shape in the scoped adapter. A small discovery/dereference/act tool surface can carry those controls without adding a new MCP tool for every resource operation. Its action allowlist must preserve read/append limits; notes permissions must not become arbitrary URL fetch or unrestricted kernel action authority.
4. Preserve the original base for relative IRIs and use inline or explicitly controlled JSON-LD contexts. [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/) defines base-IRI and context processing; a local access URL is not a substitute for a resource's original base.

An optional private representation cache can later retain authorized external linked data for offline reading. Each entry needs its source IRI, actual landed URL, media type, negotiated representation, authorization context, validators such as ETag, retrieval time, freshness and verification evidence. It must separate users and permissions, respect `Vary` and cache directives, and revalidate where required under [HTTP caching rules](https://www.rfc-editor.org/rfc/rfc9111.html). Decrypted private snapshots require local encryption and explicit retention permission. The hosted relay's bounded descriptor cache and [freshness](../deploy/mcp-relay/tests/descriptor-cache-freshness.test.ts) / [republish](../deploy/mcp-relay/tests/descriptor-cache-republish.test.ts) tests provide useful race and invalidation patterns, rather than an offline cache ready for reuse.

Offline local actions can run against the authoritative local pod. A cached remote representation is a dated snapshot; its advertised remote actions still need an online endpoint and current authorization. Stale cached authorization must never authorize a write, and remote actions should not be queued or retried silently. Outbound dereferencing and any cache would be explicit capabilities independent of pod federation. This PR documents that boundary; it does not add a general web proxy or enable remote context fetching.

## Verification

Build the workspace before running the tests: they import the built packages.

```sh
npm run build
npx vitest run tests/deployment-config.test.ts tests/stdio-config.test.ts tests/local-node.test.ts
```

The local-node integration suite starts real CSS, publishes encrypted content through `@interego/solid`, stops and restarts the runtime over the same directory, and checks discovery and decryption. It records and refuses non-loopback TCP connections during the flow, exercises unauthorized and foreign-origin requests, and checks conflicting startup and cleanup. Existing stdio compatibility tests remain the regression gate for its tool and protocol surface.
