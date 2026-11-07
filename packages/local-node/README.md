# Local node runtime

`@interego/local-node` is an opt-in developer runtime. It starts a real file-backed Community Solid Server and an authenticated HTTP gateway bound to loopback. CSS listens on a private Unix socket or Windows named pipe, so it has no second TCP port bypassing the gateway. The package bundles its CSS configuration and dependency; it does not run a package installer at startup.

```ts
import { resolveDeploymentConfig } from '@interego/deployment-config';
import { startLocalNode } from '@interego/local-node';

const config = resolveDeploymentConfig({
  profile: 'local',
  dataDir: '/absolute/durable/user-data/interego',
});
const node = await startLocalNode(config);
// Use node.podUrl and { fetch: node.fetch } with @interego/solid.
// Encrypt private content with the existing publisher's encryption options.
await node.stop();
```

`startLocalNode(config, { port?, startupTimeoutMs? })` returns the actual `baseUrl`, `podUrl`, a credential-bearing `fetch`, and an idempotent asynchronous `stop`. Port zero requests a temporary port; keep the same endpoint for later runs when stored descriptors contain its URLs. The authenticated fetch refuses other origins and HTTP redirects. No credential is included in returned status or URLs.

Data lives under the explicit `dataDir`: `pod/` contains the Solid resources, `service-credential` contains a random local service credential, and `runtime.lock` excludes a second writer. On POSIX the data directory must be owned by the current user with private permissions (`0700`). The credential and lock are created with mode `0600`; Windows uses the user's filesystem access controls and requires a fully qualified local drive path. An existing damaged credential causes startup to fail. A leftover lock after a process crash requires checking the old process has stopped before removing that lock. Graceful `stop` releases it automatically. Back up encrypted content and its encryption keys separately; this runtime does not manage the user's content keys.

Every gateway read and write requires the service credential. The bound HTTP host and browser origin must match the gateway, and only the configured pod namespace is served. Content encryption remains the publisher's responsibility: arbitrary plaintext written to CSS remains plaintext on disk. Filesystem access by another process running as the same user is outside this HTTP boundary.

The gateway supports `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS`. Writes accept Turtle, TriG, N-Triples, N-Quads, JOSE envelopes, plain text or binary (`application/octet-stream`); only an optional UTF-8 charset parameter is accepted. Use `application/octet-stream` for opaque JSON. JSON/JSON-LD representations and request-selected remote profiles are refused, and `PATCH`/`POST` are not included. Read negotiation is restricted to those media types and wildcards without remote profiles. These limits prevent a request from activating CSS's remote context loaders or executable update languages. Startup component discovery is scoped to CSS's bundled graph and its own ComponentsJS context, independent of other packages installed by the host.

This profile does not start hosted identity or relay services, public pinning, federation transports, or notification subscriptions. Starting with federation enabled is refused because the transport is not included. Hosted services remain separate. Consumer installation, OS-backed owner-key custody, account migration, recovery, per-client credentials and portable endpoint binding are follow-up work.
