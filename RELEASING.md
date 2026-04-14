# Releasing

This document describes how to publish new versions of the two npm packages in this repo:

- **`@interego/core`** — the TypeScript library (root `package.json`)
- **`@interego/mcp`** — the MCP server for AI agents (`mcp-server/package.json`)

Publishing happens automatically in CI on git tag push. You should never run `npm publish` from your local machine.

## One-time setup

You need to create an npm token and store it as a GitHub repo secret. This is the **only** manual step for the publish flow to work.

### 1. Create an npm Granular Access Token

1. Sign in at [npmjs.com](https://www.npmjs.com/) (must have write access to the `@interego` personal scope — by default every npm user can publish to their own `@<username>` scope)
2. Go to **Profile → Access Tokens → Generate New Token → Granular Access Token**
3. Settings:
   - **Token name:** `context-graphs-github-actions`
   - **Expiration:** your call (90 days for safety, 1 year for convenience)
   - **Packages and scopes:** select `@interego/core` and `@interego/mcp`
   - **Permissions:** `Read and write`
   - **Allowed IPv4 ranges:** leave empty (GitHub Actions runners use dynamic IPs)
4. Click **Generate Token** and copy it (starts with `npm_…`)

### 2. Store it as a GitHub repo secret

```bash
gh secret set NPM_TOKEN
# paste the token when prompted
```

You can verify it's set with `gh secret list` — you should see `NPM_TOKEN` alongside the `AZURE_*` secrets.

## How to release a new version

```bash
# 1. Bump versions in BOTH package.json files
#    Use semver: PATCH for fixes, MINOR for features, MAJOR for breaking changes
#
#    Edit package.json              → "version": "0.3.0"
#    Edit mcp-server/package.json   → "version": "0.5.0"
#                                  → "@interego/core": "^0.3.0"
#
#    The MCP server's library dep range MUST match the new library version
#    or the published mcp-server tarball won't install for users.

# 2. Commit the version bump
git add package.json mcp-server/package.json
git commit -m "Release v0.3.0"

# 3. Tag and push
git tag v0.3.0
git push && git push --tags
```

That's it. The [`publish-npm.yml`](.github/workflows/publish-npm.yml) workflow will:

1. Run the full test suite (642 tests across 20 files)
2. Build the library and publish it to npm with provenance attestation
3. Wait for the new library version to appear on the npm registry
4. Build the MCP server against the freshly published library
5. Publish the MCP server to npm with provenance attestation
6. Show a summary in the GitHub Actions run

You can watch it live:

```bash
gh run watch
```

## Dry runs

To test the workflow without actually publishing:

```bash
gh workflow run publish-npm.yml -f dry_run=true
```

This builds and validates everything but uses `npm publish --dry-run` instead of a real publish. Useful before bumping a version to make sure the build succeeds and the package contents are what you expect.

## Releasing manually (emergency only)

If GitHub Actions is down and you absolutely need to publish from your laptop:

```bash
# Authenticate to npm
npm login

# Library
npm run build
npm test
npm publish --provenance --access public

# Wait ~30 seconds for the registry to settle
sleep 30

# MCP server
cd mcp-server
npm install   # pulls the just-published library from the public registry
npm run build
npm publish --provenance --access public
```

Avoid this path when possible — the CI flow is reproducible, audited, and uses provenance attestations bound to the specific commit.

## What gets published

### `@interego/core` tarball contents

(controlled by `"files"` in root `package.json`)

- `dist/` — compiled library (~5MB after build)
- `src/` — TypeScript sources for downstream type resolution
- `docs/ns/` — the canonical OWL/RDFS/SHACL ontology files (`pgsl.ttl`, `harness.ttl`, `alignment.ttl`, etc.)
- `README.md`
- `LICENSE`

### `@interego/mcp` tarball contents

(controlled by `"files"` in `mcp-server/package.json`)

- `dist/` — compiled `server.js` + `pod-registry.js` with their `.d.ts` and source maps
- `README.md`
- `LICENSE` (symlinked or copied from root)

## Versioning policy

We follow [Semantic Versioning 2.0](https://semver.org/):

| Bump | When |
|---|---|
| **MAJOR** (`1.0.0 → 2.0.0`) | Any breaking change to the public API of either package, or any breaking change to the canonical ontology IRIs |
| **MINOR** (`0.2.0 → 0.3.0`) | New exported functions, new MCP tools, new ontology classes/properties, new SKOS concepts |
| **PATCH** (`0.2.0 → 0.2.1`) | Bug fixes, doc updates, dependency bumps, internal refactors |

The library and the MCP server can have **independent versions** — they do not need to march in lockstep. The MCP server's dependency range on the library should always pin to a compatible MAJOR (e.g. `^0.2.0` accepts `0.2.x` and `0.3.x` but not `1.0.0`).

## Troubleshooting

### "@interego/core@X.Y.Z is not in this registry"

The `publish-mcp-server` job waits up to 5 minutes for the library to propagate. If it times out, the npm registry was unusually slow or the library publish failed. Re-run the workflow with `gh run rerun <run-id>` once the library shows up at `npm view @interego/core`.

### "403 Forbidden" on publish

Either the `NPM_TOKEN` secret is missing/expired, or it doesn't have write access to the `@interego` scope. Regenerate the token (see one-time setup above) and `gh secret set NPM_TOKEN` again.

### "tag v0.X.Y already exists"

Tags are immutable and so are published npm versions. If you need to fix a botched release, bump to the next patch version (`0.X.Y+1`) — never re-use a published version number.
