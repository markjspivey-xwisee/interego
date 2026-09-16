# LLM activity in Interego

Open `https://foxxi-bridge.interego.xwisee.com/llm-telemetry` with the existing Interego `render_hmd` tool. The interface provides sessions, drill-down timelines, filtered queries, reports, capture-gap insights and xAPI export pages. Every action follows the published affordance authority. Private results belong to the authenticated observer.

The [profile](https://foxxi-bridge.interego.xwisee.com/llm-telemetry/profile) has 19 verbs/templates, nine activity types and three typed extensions. It follows the [ADL xAPI Profile specification](https://github.com/adlnet/xapi-profiles/blob/master/xapi-profiles-structure.md). An observation stream deliberately permits missing or out-of-order lifecycle events; it does not certify a complete session. The official profile context is vendored in the test fixtures for offline JSON-LD verification.

## Connect a supported Codex host

Generate the personal plugin with `node applications/llm-telemetry/build-plugin.mjs /path/to/interego-telemetry`. Install that folder in Codex, connect its Interego MCP server, and review the host's hook trust request. Installing a plugin does not itself trust its hooks. No script in this project writes trust hashes or reads credentials.

The hook configuration calls the existing generic `act` tool with `sign_payload: true`. It sends only an explicit field allowlist. There are no command hooks and no transcript reads. Prompt text, answers, internal reasoning, arguments, tool results, filesystem paths and credentials are excluded. `UserPromptSubmit` does not attest that the initiator was a human, so that role remains unknown; controlled runtimes can report a known human or agent initiator explicitly.

The [host hook documentation](https://learn.chatgpt.com/docs/hooks) defines the capture boundary. Hosted web tools and any host paths that opt out of hooks are not covered. MCP hooks cannot handle SessionEnd. The first SessionStart can happen before MCP is ready. Failed hook deliveries are nonblocking and have no durable retry queue. Logical keys coalesce repeated SessionStart, Stop and compaction observations; these counts are observations, not exact occurrence counts. Hook timestamps are collector observation times, so reports do not infer tool execution latency from them. Tool completion does not attest domain success. Provider token usage is not exposed by these hooks and stays unknown.

The dashboard reports sources that actually delivered events. It does not claim to observe arbitrary ChatGPT chats, uninstalled hosts or inaccessible agent sessions. Use the runtime adapter when precise event times, usage and a retry queue are required.

## Instrument any controlled runtime

`client.ts` accepts an authenticated MCP call function, a stable session identifier and a private outbox. No model vendor dependency is required.

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

The live LRS remains the standard xAPI surface. Its in-memory lens can empty on restart. Reports additionally read a fresh encrypted `llm-telemetry-v1` PGSL snapshot, without merging unrelated learning records. Retrying an already persisted event can restore its exact LRS-assigned envelope. Neither unavailable history nor a conflicting record is silently treated as an empty history. Evidence IDs accompany deterministic insights; activity volume, usage and failure observations are not a quality or productivity score.
