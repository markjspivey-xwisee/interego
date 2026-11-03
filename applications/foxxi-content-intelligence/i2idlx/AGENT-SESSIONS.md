# Standalone conversations and optional agent executors

Interpretant's standalone workbench owns its embedded conversation, selected intervention,
source passages, glossary tools, streaming text display and follow-up history. Its
executor is optional and replaceable. ChatGPT and Claude hosted views remain optional
clients; neither is the workbench's core runtime.

## Pair an existing agent

Open **Connect**, create an agent connection and explicitly copy its private connection
request into an existing AI-agent conversation that can invoke Interego actions. The
request includes a short-lived, one-use invitation. It contains no model API key and
does not expose the browser's session capability.

The invited agent uses its existing authenticated Interego connection to claim the
invitation. The server binds the verified actor and issues a separate driver capability.
The agent must retain both the session identifier and its driver capability for subsequent
requests. A different conversation with the same surface identity is not authorized by
that identity alone. No invitation grants access to a pod, learner records or team notes.

After the connection is verified, **Ask** runs inside the standalone workbench.
**Interventions** retrieves the selected course, hosted package or supplied material for
each question, attaches citation IDs and the pinned glossary, and uses the same executor.
Changing the selected material clears that intervention's conversation. Changing the
question or perspective retains recent turns.
The existing live Orchestrate sandbox uses the same connection and retains its staged
human-approval flow. The transport accepts its plain prompts and no-argument page tools,
and preserves cumulative text across tool rounds so its final handoffs remain intact.

The external agent processes queued requests through the returned, bounded driver
protocol. It can emit cumulative answer text, finish a response, or request one of the
exact browser tools advertised with the turn. Executable functions stay in the browser;
the protocol carries only names, schemas, arguments and actual results. Unadvertised
tools and unsupported argument schemas cannot execute. Paired-agent glossary lookups
exclude team annotations. Streaming is displayed only when real text arrives.

The agent must remain active and renew its turn lease using the protocol. An ordinary
ChatGPT or Claude conversation is not an unattended inference service. The workbench
shows an unattached or expired executor rather than inventing a model response. Stop,
disconnect, invitation replacement, expiry and stale revisions reject later results.

## State and authority

The separate `/i2idlx/api/agent-sessions` routes maintain bounded, ephemeral exchanges.
They do not change the existing public, stateless, read-only `/i2idlx/mcp` tool contract.
Driver operations require the existing signed caller verifier, an explicit invitation
claim, and the resulting session-scoped driver capability. Browser operations require
their independent in-memory capability. Tokens do not travel in URLs or browser storage.

Sessions are limited to 30 minutes, invitations to 5 minutes, active turn leases to
60 seconds and individual requests to 10 minutes. The deployment bounds sessions,
creation rate, message/tool/result sizes and total retained exchange bytes. Signed driver
traffic also has a process-wide 600-request-per-minute admission budget before signature
and delegation verification. This bounds authorization work and admission-store size
without trusting proxy IPs. A restart ends these ephemeral connections.
Transcript state belongs to the open browser; this
change does not claim durable chat history or automatically write a pod, xAPI statement,
assessment, completion or learner record. Explicit encrypted persistence is a separate
capability, not a side effect of asking a question.

## Executor choices

An existing active MCP-capable agent can drive the exchange now without a new model
API key. A user-owned local companion can implement the same interface. Existing
explicit host adapters and the previous optional browser API fallback remain separate.
No vendor credential is copied to Railway by this transport.

Direct subscription-sharing integrations require their provider's actual eligibility:

- OpenAI's [Sign in with ChatGPT documentation](https://developers.openai.com/siwc/token-sharing-open-source)
  documents open-source/local integrations; [hosted/commercial clients](https://developers.openai.com/siwc/request-client-id)
  require the applicable client approval. The workbench does not advertise an approved
  hosted OAuth connection it has not obtained.
- A user-owned [Claude Code session](https://code.claude.com/docs/en/headless) can act
  as an executor. [Hosted product conditions](https://code.claude.com/docs/en/legal-and-compliance)
  are distinct from a generic third-party Claude subscription API. The transport does
  not share an operator's login or remove native authentication controls.

These adapters are progressively optional. Registering an app, pairing an agent and
successfully completing a real model turn are separate evidence.

## Verification

`tests/i2idlx-agent-sessions.test.ts` exercises identity and capability separation,
one-use invitations, leases/revisions, cancellation, expiry and resource bounds.
`app/tools/agent-session-check.mjs` exercises the actual browser transport with a
deterministic exchange double, including streaming, local tool results, original
Orchestrate input forms, cumulative handoff offsets and aborts.
`app/tools/agent-session-http-check.mjs` repeats the browser exchange over real loopback
HTTP with the actual Express router and middleware; its verifier and model remain explicit
deterministic fixtures.
`app/tools/ask-engine-check.mjs` exercises the actual hook body for stale asynchronous
requests, adapters that ignore cancellation, and intervention source attachment.

These checks make no model or production requests. A real deployed browser/agent
round trip is required before claiming subscription-agent acceptance.
