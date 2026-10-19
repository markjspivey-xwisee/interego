# Interpretant inside ChatGPT

The private `I2IDL-X Workbench` plugin connects to the dedicated, public,
read-only MCP App endpoint on the existing Foxxi deployment:
`https://foxxi-bridge.interego.xwisee.com/i2idlx/mcp`.
The ordinary website and the general Interego/Foxxi MCP server remain available.

`i2idlx_workbench` accepts `{}` and provides global and conversation entrypoints.
Its MCP App resource serves the existing generated workbench HTML, with the
ChatGPT mode enabled before the application bundle runs. It uses the same
reviewed v0.0.93 definitions, graph projection and proposed enrichment as the
website. The plugin source is in `chatgpt-plugin/i2idlx-workbench/`.

The App keeps Lexicon, Map, Compare, Annotate, Review, Packs, Insights,
Semantics and Agents. Ask and Orchestrate prepare explicit requests and send
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
ChatGPT App acceptance; verify the installed tool and interactive App separately.
