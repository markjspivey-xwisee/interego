# I2IDL-X Workbench plugin packages

There are two alternative package roots. Include only one in any plugin archive.

| Package root | Purpose | Connection |
| --- | --- | --- |
| `account/i2idlx-workbench/` | Source snapshot of the current private ChatGPT account plugin, version 0.1.1 | `.app.json` binds the registered I2IDL-X App |
| `i2idlx-workbench/` | Preserved portable endpoint package, version 0.1.0; dormant alternative | `mcp.json` names the public Foxxi MCP endpoint |

## Current account package

The account package was read back from the current stored private plugin release.
Its manifest, OpenAI overlay, App binding and SVG icon are preserved exactly,
including the platform-normalized author and default prompt.

- Private plugin: `plugins_6ad5b306aea88191963b1187ee5366c0`
- Stored release: `pluginrel_6ad61b61986c8191b79d047fa7cce281`
- Version: `0.1.1`
- Registered App: `asdk_app_6ad61a249a448191b66a156960d202db`
- Connected App plugin: `plugin_asdk_app_6ad61a249a448191b66a156960d202db`

The package has four files: `plugin.json`, `.app.json`,
`.codex-plugin/plugin.json` and `assets/icon.svg`. It has no MCP connection file.
The registered App owns the hosted connection to
`https://foxxi-bridge.interego.xwisee.com/i2idlx/mcp`; `.app.json` references that
App rather than declaring a second endpoint connection.

Registration and account connection are separate from saving these files.
Copying or archiving this source does not register an App, connect another
account, grant access, or publish the plugin publicly. Preserve the existing
plugin and App identities when maintaining this account package.

## Portable endpoint alternative

The original `i2idlx-workbench/` folder is retained unchanged. It connects directly
to the separately hosted MCP endpoint and is not the current account plugin
source. A portable MCP connection may be available only in particular clients,
including Desktop-oriented plugin environments; loading its manifest does not
establish that the GUI will open in a ChatGPT App surface. Verify transport and UI
support in the target host before treating this alternative as usable there.

Do not combine `apps` and portable MCP connection files into one package to try
to obtain both behaviors. Choose one package root and archive that root only,
including its hidden files. Do not archive this whole directory with both variants.

## Verification boundary

The server and generated GUI use the reviewed v0.0.93 source. Backend, protocol
and simulated-parent browser checks are separate from actual ChatGPT acceptance.
Actual ChatGPT testing on 2026-10-19 verified registration, connection, the
original GUI, v93 attribution, glossary search, Map, Compare, Annotate, Agents,
term attachment and live Ask context preview. The Ask button delivered a request
to the selected ChatGPT model and produced a completed glossary-linked answer.
A two-term pack rendered Handout, Markdown and CSV; copied CSV bytes matched.
The first initial render needed one retry. Direct Blob downloads failed in the
real sandbox, prompting the host-mediated download fix. Download and lifecycle
acceptance of that fix must be recorded separately after deployment.

See [CHATGPT-APP.md](../CHATGPT-APP.md) for the runtime behavior and acceptance
sequence. Server and UI changes use the existing Interego repository and Foxxi
deployment process; package-only edits do not deploy that code.
