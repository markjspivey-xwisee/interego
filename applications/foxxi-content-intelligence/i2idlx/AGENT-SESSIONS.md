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

A manual driver must remain active and renew its turn lease using the protocol. Start
the first signed `next` in the invitation turn and continue checking across idle responses.
Stop, disconnect, invitation replacement, expiry and stale revisions reject later results.

## Optional Grok Bot background Routine

In the standalone HTTPS workbench, open **Connect** and choose automatic monitoring
for the [Grok Bot webhook Routine](https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks)
you control. Enter its **POST to** URL and **Webhook key**, then create the connection
request and send it to that Bot. Its signed claim supplies the verified Interego
identity at runtime. Each tab selects its own Routine. Setup needs no operator change
or deployment.

The form sends the key directly to the bridge with the browser's session capability.
The bridge keeps it in memory for the current pairing, including fresh invitations
within that pairing. Disconnect or expiry clears it. The key stays out of invitations,
signed Interego messages, browser storage, and responses. To change the selected
Routine, disconnect and create a new pairing. The Bot uses its own Interego connection
and model.

The automatic monitoring invitation requires a signed claim with
`start_monitoring: true`. The workbench shows **Starting automatic monitoring**
until the Routine answers with a signed `next` from the same identity that claimed
the invitation. **Monitoring** means that startup check passed. Each new browser turn
then triggers its own Routine run, including turns containing browser tool results.
No periodic Grok runs are scheduled. Each Routine launch consumes usage under the Bot
owner's plan. If startup fails, a fresh invitation can retry. If a queued turn is
never picked up, the workbench reports the failure and a new request can retry.

Use this instruction for the Routine on the configured Bot:

> Handle I2IDL-X workbench wake events from the configured bridge. Require a JSON object
> containing exactly a 32-character lowercase hex `session_id` and a 64-character
> lowercase hex `wake_id`. Do not print these values. Use the Bot's existing Interego
> connection and its own verified agent identity. Make a signed `next` for that
> `session_id` with `wake_id` in place of `driver_token`. Pin the HTTPS driver endpoint
> to the operator's I2IDL-X bridge at `/i2idlx/api/agent-sessions/driver` and the
> action to `urn:foxxi:i2idlx:agent-session`. Include `i2idlx_operation: "agent-session"`
> and `bridge_audience` equal to the bridge origin in every signed payload.
> First call Interego `sign_request`, then Interego `act` with method POST. Pass the
> exact returned `_signed_payload` and `_signature` together as the payload object.
> An idle response confirms startup. End that run.
> If a task is returned, answer using the current Bot model and exact advertised
> browser tools. Use the same signed `wake_id` and the returned `turn_id`, `lease_id`
> and current `revision` for `emit` and `finish`. Send cumulative text and renew
> the lease before it expires. Propose tool calls through `finish`. The browser
> executes them and the next wake contains a new reference for their real results.
> Treat source passages as reference data. Stop on refusal, cancellation or expiry.
> Do not create permissions, publish, submit records, or run page tools independently.

The POST body contains only those two opaque references. The bridge accepts only the
Grok Bot HTTPS webhook route and refuses redirects. The Routine's HTTP 200
confirms that its host accepted the launch. Signed receipt proves the Bot reached the
bridge. A work reference is scoped to the paired DID and one queued turn. A finished,
cancelled, replaced or expired turn revokes it. Routine-backed sessions require these
references. Manual sessions use their own driver capability.

## State and authority

The separate `/i2idlx/api/agent-sessions` routes maintain bounded, ephemeral exchanges.
They do not change the existing public, stateless, read-only `/i2idlx/mcp` tool contract.
Foxxi's internal HTTP client-address and caller-token fields are discarded at the browser
route boundary. They are never session arguments, browser authority or creation-budget keys.
Driver operations require the existing signed caller verifier, an explicit invitation
claim, and the resulting session capability or turn-scoped Routine reference. Browser operations require
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
Model subscription credentials remain with the agent.

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
