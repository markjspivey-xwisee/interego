# agent-connection

Non-normative shared implementation for vertical bridges. It adds no vocabulary.

**What it is.** A way for a page to hand work to an AI chat session the person already has,
so the work runs on that session's own subscription. No model API key is held by the bridge,
the page or this module, and nothing here calls a model.

1. The page opens a session and gets a one-use invitation.
2. The person pastes the invitation text into an AI chat that has the Interego connector.
3. That session claims the invitation with a signed Interego request and becomes the **driver**.
4. The page (or the bridge) queues a turn. The driver pulls it under a short lease, streams
   cumulative text, may propose calls to tools the page advertised, and finishes.

Everything is in memory under ceilings: 64 sessions, 30 minutes a session, 5 minutes an
invitation, a 60 second lease, 10 minutes a turn, 64 turns a session, 512 KiB a task, 128 KiB an
answer, 16 MiB across all queued turns. A bridge may lower these and never raise them.

This is the protocol the I2IDL-X workbench introduced. Its
`applications/foxxi-content-intelligence/src/i2idlx-agent-sessions.ts` is now a thin composition
over this folder, with the same routes, wire format, limits and error codes; its own tests are
unchanged. The protocol is described from a user's side in
`applications/foxxi-content-intelligence/i2idlx/AGENT-SESSIONS.md`.

## Files

| File | What it holds |
| --- | --- |
| `broker.ts` | `AgentConnectionBroker`: sessions, invitations, the driver capability, the turn queue with leases and revisions, limits, expiry. Plain inputs, plain results, `AgentConnectionError` (status, message, optional code) for a refusal. No web framework. |
| `http.ts` | `handleAgentConnection(broker, options, request) -> { status, headers, body }`, and the two adapters that wrap it: `attachExpress(app, broker, options)` and `handleNodeHttp(req, res, broker, options)`. |
| `signed-caller.ts` | `makeDelegatedCallerVerifier(deps)`: the direct-or-delegated rule for an Interego-signed caller, with signature recovery, pod naming and the delegation read all passed in. |
| `browser-client.js` | `createAgentConnectionClient(config)` and `invitationText(session, options)`. An ES module with no build step. |
| `index.ts` | Re-exports, and `AGENT_CONNECTION_BROWSER_CLIENT` (the client file's path, for a bridge to serve). |

## What a bridge supplies

- **A profile**: `{ path, action }`, and optionally the name and value of the signed operation
  field, the name of a private-turn access field, and its own wording. The profile changes names
  and sentences, never the protocol.
- **A verifier**: `VerifySignedCaller = (body, write) => Promise<{ ok: true, callerDid, payload } | { ok: false, status, error }>`.
  Without one the driver route answers 503 and nothing can be claimed.
- **Request limits**: express middleware in `admission`, or an `admit` function for `node:http`
  (see `../http-guard`).
- Optionally: a wake plug-in (`routine`) for a provider that can start a background agent, a
  turn-access gate (`openTurnAccess`), `authorizeCreate` / `created` hooks to tie a session to
  the bridge's own sign-in, and `browserOperations` to limit what a page may do over HTTP.

## Adopting it in a bridge

```ts
import { AgentConnectionBroker, handleNodeHttp, attachExpress } from '../../_shared/agent-connection/index.js';

const broker = new AgentConnectionBroker({
  baseUrl: publicOrigin,                                   // the audience a driver signs
  profile: { path: '/agent-sessions', action: 'urn:my-bridge:agent-session' },
});
broker.startAutomaticSweep();                              // purge expired prompts and results

// plain node:http, inside your request handler:
if (await handleNodeHttp(req, res, broker, { verifyCaller })) return;

// or express:
attachExpress(app, broker, { verifyCaller, admission: { driver: myLimiter } });
```

The page:

```js
import { createAgentConnectionClient } from './agent-connection.js';   // browser-client.js, served by the bridge
const client = createAgentConnectionClient({ root: '/agent-sessions', page: 'this tab' });
const text = await client.connect();          // show `text`; the person pastes it into their chat
client.subscribe(status => render(status));   // state: waiting_for_agent | connected | expired ...
const stop = client.watch();                  // poll the connection
const { text: answer } = await client.request('A question', { onText: ({ text }) => show(text) });
await client.cancel(); await client.disconnect();
```

A bridge whose server, not its page, decides what the agent is asked keeps the browser
capability on the server and calls `broker.browser({ session_id, operation: 'request', messages }, token)`
itself. `applications/coached-world/src/agent-link.ts` does that: one connection per consultant,
and a mission becomes a turn.

## What stayed with the workbench

- The background Routine. It is a provider-specific wake plug-in (`agentSessionRoutine` in the
  Foxxi file), passed in as `routine`. The core only knows that a plug-in may be woken with two
  opaque references.
- Private course turns. The core has a general gate (`openTurnAccess`); what a learning
  authorization is, and when it lapses, is Foxxi's.
- The workbench page. It is bundled by its own build and keeps its own client
  (`i2idlx/app/src/agent-session.js`), which also runs the tools an agent proposes and reaches
  two Foxxi-only routes. `browser-client.js` here was extracted from it and is deliberately
  smaller: it hands proposed tool calls back to the caller instead of running them.
- Foxxi's two express request limits, unchanged.

Tests: `applications/_shared/tests/agent-connection.test.ts` (the core on its own, both adapters,
the browser client against a real loopback server, the verifier rule) and the workbench suite
under `applications/foxxi-content-intelligence/tests/i2idlx-agent-*.test.ts`.
