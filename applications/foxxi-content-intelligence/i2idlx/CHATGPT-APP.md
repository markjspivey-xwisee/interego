# Interpretant inside ChatGPT

The private `I2IDL-X Workbench` account plugin is bound to a registered and
connected ChatGPT App. The App uses the dedicated, public, read-only MCP App
endpoint on the existing Foxxi deployment:
`https://foxxi-bridge.interego.xwisee.com/i2idlx/mcp`.
The ordinary website and general Interego/Foxxi MCP server remain available.

The current account package is version `0.1.1`, stored release
`pluginrel_6ad61b61986c8191b79d047fa7cce281` of private plugin
`plugins_6ad5b306aea88191963b1187ee5366c0`. Its `.app.json` references registered
App `asdk_app_6ad61a249a448191b66a156960d202db`; the connected App plugin is
`plugin_asdk_app_6ad61a249a448191b66a156960d202db`.

`i2idlx_workbench` accepts `{}` and provides global and conversation entrypoints.
Its MCP App resource serves the existing generated workbench HTML, with the
ChatGPT mode enabled before the application bundle runs. It uses the same
reviewed v0.0.93 definitions, graph projection and proposed enrichment as the
website. The exact stored account package source is in
`chatgpt-plugin/account/i2idlx-workbench/`. It contains an App binding and no MCP
connection file. Saving that source alone does not register or connect the App.

The original `chatgpt-plugin/i2idlx-workbench/` folder is a preserved, dormant
portable MCP alternative, not the current account package. That endpoint-based
package may work only in particular clients, including Desktop-oriented plugin
environments; its presence does not establish ChatGPT GUI compatibility. Package
one variant per archive, including hidden files. See
[the packaging notes](chatgpt-plugin/README.md).

The App keeps Lexicon, Map, Compare, Annotate, Review, Packs, Insights,
Semantics and Agents. It also provides an **Interventions** view for public
authored courses, hosted packages and any supplied intervention material; see
[intervention chat](INTERVENTION-CHAT.md) for its source and conversation contract.
Ask, Orchestrate and intervention chat prepare explicit requests and send
them through the standard MCP Apps `ui/message` bridge to the surrounding
ChatGPT conversation. This is not an awaitable sampling API. Answers and the
actual execution ledger are in the conversation; the GUI records delivery
only after the host acknowledges it. Previewing a task packet does not run
the model or the recipe. No OpenAI API key is required for this flow.

The plugin exposes bounded glossary search, Ask and Orchestrate packets, and
the existing classifier, SHACL, peer-term and source-version checks. Their
HTTP and MCP projections share the same execution logic and semantic capacity
limit. Source text is reference data, and no task packet establishes that a
check passed. A zero-target SHACL result is not applicable validation.
Attached concepts appear first in an Ask packet. Relevant question matches can
add further entries within the same 14-concept context limit.

The MCP App endpoint has no pod-write, identity, credential, voting or
publication operation. An available ChatGPT conversation grants no Interego
identity or authority. Workspace packs and UI drafts use browser convenience
storage where available; this is not durable pod persistence. Existing signed,
encrypted and conditional Interego workflows keep their own authorization.

Host integration follows the MCP Apps 2026-01-26 UI protocol and OpenAI MCP
Extensions entrypoint and display metadata. It is intended for compatible
ChatGPT Work/App surfaces; compatibility with Classic ChatGPT is not assumed.
The server supports the current and legacy MCP transports for connection.

Verification includes isolated host-protocol checks, MCP/HTTP route parity and
negative fixtures, plus browser checks against a clearly labeled simulated
parent host. Those simulated checks do not establish installation or actual
ChatGPT App acceptance. Actual ChatGPT testing on 2026-10-19 verified registration,
connection, the GUI, search, Map, Compare, Annotate, Agents, term attachment, live
Ask preview and a completed glossary-linked answer from the selected ChatGPT
conversation model. Handout, Markdown and CSV rendered for a two-term pack;
copied CSV matched the export. One initial render required a retry. Direct Blob
downloads failed in the real sandbox; the App now routes downloads through
capability-gated `ui/download-file`, leaving Copy and visible export text
available when the host does not offer downloads. Deployment and actual-host
download/lifecycle acceptance are separate from those observations.

## Actual ChatGPT acceptance

1. Open the private App. Confirm the original Interpretant GUI, `v0.0.93`, 420
   concepts and source attribution. Navigate Lexicon, Map, Compare, Annotate,
   Packs and Agents.
2. Search for Simulation, open its entry and select **Ask about this term**.
   Confirm the Simulation concept is attached. Ask: "What does the glossary mean
   by simulation, and how do reusable simulation materials differ from a live
   learning session?"
3. Use **Preview task context**, then **Ask ChatGPT**. Confirm a real
   `i2idlx_ask` call and cited answer in the conversation. A GUI receipt reading
   **Sent to ChatGPT** acknowledges handoff, not completion.
4. Request the source-version check in chat. Inspect its actual pinned/upstream
   versions, timestamp and hash. If testing Orchestrate, distinguish actual
   classifier and SHACL evidence from pending checks and proposed drafts.
5. In **Packs**, create a temporary two-term pack. Inspect Handout, Markdown and
   CSV exports, verify attribution, and test both **Save csv** and **Copy**.
   Confirm an actual downloaded file or pasted export rather than relying on a
   save toast. If copying is refused, inspect the warning and selectable export
   text fallback.
6. Resize, close and reopen the App. Record which local pack and form state
   actually survives. Browser convenience storage is not durable pod storage.

The host-dependent checks include GUI resource loading, conversation messages,
App-to-server calls, nested Handout preview, clipboard permission, Blob downloads
and widget lifecycle. Record observed results; do not infer a pass from server
health, registration, connection, simulated host checks or a tool listing.
