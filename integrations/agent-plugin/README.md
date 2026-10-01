# Interego workflow plugin

This package adds five portable Agent Skills to the existing Interego service. It does not deploy a server, define another domain ontology, or duplicate Foxxi's generated service skills.

| Workflow | Purpose |
| --- | --- |
| `interego-resume-work` | Recover current project state and continue authorized work |
| `interego-discover-compose` | Follow live capabilities and compose a working service sequence |
| `interego-improve-performance` | Diagnose a gap, choose an intervention, test application |
| `interego-coordinate-transfer` | Prepare authorized handoffs and verify transfer |
| `interego-evaluate-retain` | Compare outcomes and retain versioned evidence |

The portable distribution contains standard `plugin.json`, `mcp.json`, and `skills/` paths. The verified Streamable HTTP endpoint is `https://relay.interego.xwisee.com/mcp`, as documented by the existing relay integration guide. Authentication is the existing OAuth host flow; no tokens are packaged.

An account distribution reuses a verified installed app ID through the OpenAI extension and `.app.json`. It deliberately omits `mcp.json` to avoid adding a second copy of the same connection. Generate it only with the actual app ID obtained from installed metadata. The app ID is a binding, not a credential.

`interego-workflows/runtime/bootstrap.md` is the same versioned workflow guidance for runtimes that cannot load plugin files. A runtime may embed it in its existing instructions after normal host checks. It does not enable plugins, hooks, tools, identities, sharing, or durable storage. Crown must retain its pinned runtime, legal-action gateway, owner boundary, and code-owned performance cycle.

Build and verify with Node 20 or later:

```sh
node integrations/agent-plugin/build.mjs --out /absolute/output/directory
node integrations/agent-plugin/build.mjs --out /absolute/output/directory --app-id VERIFIED_APP_ID --app-key VERIFIED_APP_KEY
node --test integrations/agent-plugin/build.test.mjs
```

The builder emits a contained ZIP, a file-hash manifest, and a bootstrap module that exposes its version and SHA-256. Generated output belongs outside this source directory. Source changes are versioned with the Interego repository.

Acceptance requires live discovery, an authorized task, durable readback, and reuse in an independent authorized session. Unit/structural checks and a repeated read in the same session are narrower evidence. Installation, service authorization, and host permissions remain separate from plugin publication.
