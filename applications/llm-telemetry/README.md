# LLM activity in Interego

Open `https://foxxi-bridge.interego.xwisee.com/llm-telemetry` with the existing Interego `render_hmd` tool. The interface provides sessions, drill-down timelines, filtered queries, reports, capture-gap insights and xAPI export pages. Every action follows the published affordance authority. Private results belong to the authenticated observer.

The [profile](https://foxxi-bridge.interego.xwisee.com/llm-telemetry/profile) has 19 verbs/templates, nine activity types and three typed extensions. It follows the [ADL xAPI Profile specification](https://github.com/adlnet/xapi-profiles/blob/master/xapi-profiles-structure.md). An observation stream deliberately permits missing or out-of-order lifecycle events; it does not certify a complete session. The official profile context is vendored in the test fixtures for offline JSON-LD verification.

## Choose either observer, both, or neither

Open **Capture settings** in the HyperMarkdown interface. The independent **Interego server** and **Client reporting** switches both default to off, and apply to the authenticated observer identity. Settings are signed through the existing `act` affordance and stored in private encrypted history. The interface also offers **Enable both** and **Disable both**.

| Choice | What can be recorded |
| --- | --- |
| Neither | No new automatic deliveries are accepted. Existing history remains readable. |
| Server only | Metadata for supported calls through the existing Interego MCP connection. No client installation is needed. |
| Client only | Reports from a collector installed in a supported host, with the host's hook trust or runtime instrumentation enabled. |
| Both | Both observation sources, identified separately in queries and reports. |

The server observer covers known tools called through the authenticated, write-capable OAuth `/mcp` transport in the reference deployment. It follows the same published, signed ingestion affordance as clients. It cannot see ordinary chat turns, calls to other servers, or provider token usage. It records tool name, caller identity, actual start/end times and an explicit error flag when available. It never receives prompts, tool arguments, results or credentials. It groups activity by UTC day, labelled `relay-day`, because the MCP connection does not attest a host chat session.

Server records arrive as a matched start/end pair after the call completes. An unconfirmed delivery does not change the original tool result; a receipt is attached in MCP metadata when available. There is no server retry queue. Consent and delivery each have a ten-second deadline; a timed-out delivery may still complete. The relay caches the initial opt-in lookup for up to thirty seconds, but every automatic delivery rechecks durable settings. A changed server consent revision refuses an in-flight delivery. Unavailable or conflicting preference history refuses automatic reporting.

Client opt-in authorizes intake; it does not install a collector or approve a host trust prompt. Disabling a switch refuses new deliveries for that channel. To stop a client collecting or queueing locally, also disable its hooks or adapter in that host. Explicit signed `manual-observation` submissions remain one-off actions, separate from either automatic opt-in.

When both sources observe an Interego call, the report counts **observations**, not unique operations. Use `capture_channel: server | client | manual` or `source` to inspect one source. The report flags possible overlap without guessing a correlation from timestamps.

Authenticated telemetry has its own per-observer limits per bridge process: 120 ingestion requests, 60 queries and 60 settings requests per minute. Ingestion/query exhaustion does not consume the settings allowance or the public model-call budget. A refusal returns HTTP 429 with `Retry-After`; unconfirmed server delivery still leaves the original MCP result intact.

Operators opt into observation modules with `INTEREGO_REQUEST_OBSERVERS`, a JSON array of local deployment module paths. The reference image includes this application's adapter; the plain relay image has no application observer configured. No new MCP tool is added.

## Set up client reporting through the existing connection

Open **Client reporting setup** from the activity interface or Capture settings. The hosted entry is `https://foxxi-bridge.interego.xwisee.com/llm-telemetry/setup`. It is an ordinary application affordance reached with Interego's existing generic tools; there is no new telemetry MCP tool or separate server to connect.

Choose the runtime and enter the exact name of its **existing** authenticated Interego MCP connection. The service provides a ready-to-download JSON configuration that calls the same signed ingestion affordance. Users do not build source code, install a second MCP connection, or copy authentication tokens.

| Client | Delivered integration |
| --- | --- |
| Codex CLI | Declarative MCP tool hooks for its documented event fields; host trust review required. |
| Claude Code CLI | Declarative MCP tool hooks using Claude's `prompt_id`; requires that field and `mcp_tool` hook support. |
| Claude Code VS Code extension | The same Claude Code hook configuration and shared settings. |
| Codex VS Code extension / ChatGPT Work | Server capture available; host installation/trust flow has not been verified. Setup explicitly says so and does not generate an unsupported install command. |
| Ordinary ChatGPT / Claude browser chat | Server capture through the normal connector. No automatic native conversation hooks are installed by connecting MCP. |

Configuration availability is not an attestation that a user's host has loaded, trusted, or executed it. The JSON must be merged into the selected host's hook settings, preserving unrelated configuration. An agent with access to that host can do the merge; hook review remains in that host. Windows uses the equivalent user-profile paths. Replace legacy Interego hooks instead of activating a second copy. Enable Client reporting for the identity connected in that client; consent is not automatically shared across different observer identities.

The setup response includes requirements, limitations, a download link, and a signed **Client reporting evidence** query. Send a fresh prompt and execute a supported tool after setup, then compare returned timestamps/session IDs with that test. Old records for the same source are not proof that a newly configured host is working. The implementation is tested with documented host-event fixtures, xAPI validation, and real HTTP setup/download routes; fixture replay is not a real client lifecycle test.

The configurations allowlist only metadata. They never include prompt text, replies, reasoning, tool arguments/results, transcript paths or credentials. Claude uses `prompt_id` where Codex uses `turn_id`; optional Claude model fields are not assumed. Claude's failure hook records an explicit tool failure; generic completion remains outcome-unknown. A session marker accompanies every delivered event, avoiding reliance on MCP availability at startup. Duplicate session/compaction keys coalesce. No SessionEnd is claimed. Generic `act` calls are excluded from tool hooks to prevent recursive reporting; Interego server capture remains available for ordinary calls to Interego.

Hook delivery has no durable retry queue; timestamps are receipt times and cannot establish execution latency. These configurations do not report token usage, cost or model identity. Use the runtime adapter for actual provider usage and precise event times. Native hosted tools and events a runtime does not expose remain outside its coverage.

Official contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Claude Code VS Code settings](https://code.claude.com/docs/en/vs-code). Claude `prompt_id` is documented from v2.1.196; the client must also support MCP tool hooks. A version number alone does not prove capability availability.

The previous `build-plugin.mjs` workflow and generated separate-connection bundle are retired. Use the hosted setup flow.

## Instrument any controlled runtime

Enable **Client reporting** for the adapter's authenticated observer first. `client.ts` accepts an authenticated MCP call function, a stable session identifier and a private outbox. No model vendor dependency is required.

```ts
const telemetry = new TelemetryClient({
  source: 'my-runtime', session_id: runtimeSessionId,
  call: (name, args) => interegoMcpClient.callTool({ name, arguments: args }),
  outbox: fileOutbox('/private/telemetry-outbox'),
  onError: error => reportTelemetryFailure(error),
});
await telemetry.record({ kind: 'session-observed', initiator_kind: 'human' });
const result = await telemetry.observe('model', { model: actualModelId, provider: providerId },
  () => invokeYourModel(),
  result => ({ input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens }));
await telemetry.flush();
```

Call `observe('tool', ...)` or `observe('agent', ...)` around actual work. Supply real parent agent, turn and trace identifiers when available. Adapt the optional usage extractor to the provider's actual response; never estimate absent values. The example token field names are illustrative, not a universal vendor response schema. Capture failures invoke `onError`; queued data is removed only after durable acknowledgement. One process owns each outbox directory; share one client instance within it. Schedule flush retries in the owning runtime, and call `record({kind:'session-ended'})` only when it actually ends. The adapter cannot keep running after its host exits.

## Query and export

Discover the `llm_telemetry.query` contract in the FOXXI affordance manifest. Submit flat query options or `{query:{...}}` in a signed envelope. Filters include session, source, model, event kind, capture mode and inclusive event-time bounds. `view` selects sessions, timeline, report or export. `limit` is 1–200; `offset` paginates events. Totals cover the full matching snapshot, with explicit source availability. Fix `until` for a bounded export and follow `next_offset`; late-arriving backfills can still change a later snapshot.

Ingestion accepts 1–20 events using the [event schema](https://foxxi-bridge.interego.xwisee.com/llm-telemetry/event-schema). Source event IDs are immutable within an observer/source. Reusing one with changed normalized metadata returns 409. A 502 can mean the LRS accepted an event but encrypted persistence failed: retry the identical event, not a newly minted replacement. The record actor is the signature-bound observer DID; subagents are runtime identities, not fabricated independent credential holders.

The live LRS remains the standard xAPI surface. Its in-memory lens can empty on restart. Reports additionally read a fresh encrypted `llm-telemetry-v1` PGSL snapshot, without merging unrelated learning records. Retrying an already persisted event can restore its exact LRS-assigned envelope. Neither unavailable history nor a conflicting record is silently treated as an empty history. Token and cost totals count only terminal model observations, so parent/tool summaries do not duplicate a generation's reported usage. Evidence IDs accompany deterministic insights; activity volume, usage and failure observations are not a quality or productivity score.

Telemetry persistence suppresses the shared writer's public descriptor projection. Event provenance and timing remain inside the authenticated LRS and encrypted history; receipts do not advertise unpublished descriptor addresses. The profile, event schema and interface shell remain public discovery resources.
