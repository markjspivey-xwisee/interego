# Interego Workspace — desktop shell

A walking skeleton. It does exactly this, against the **live** relay, and nothing else:

    boot -> sign in -> open a workspace -> render the roster and the stream ->
    post a message that lands on your own pod

Everything it knows about the substrate comes from **`@interego/workspace-client`** — the same
module the published artifact's script is generated from. This package holds a window, two
sign-in flows and a key. It does not parse Turtle, name a member's documents, decide who is
seated, or work out where an entry goes in a chain.

---

## Build and run on Windows

Prerequisites: Node 20+ and npm. Nothing else — no Rust, no C++ toolchain, no Python.

```sh
# from the repo root
npm install
npm run build --workspace @interego/workspace-client
npm run build --workspace @interego/workspace-desktop

# run it
cd applications/shared-workspace/desktop
npx electron .
```

`npm start` from this directory does the build and the run in one step.

### If the window never appears and you see "Cannot read properties of undefined (reading 'whenReady')"

Your shell has `ELECTRON_RUN_AS_NODE=1` set — every terminal spawned by an Electron-based
editor or agent inherits it, and it makes Electron behave as plain Node, so `require('electron')`
returns a path string instead of the API. Measured on this machine, from a Git Bash spawned by
Claude Code. Clear it for the run:

```sh
env -u ELECTRON_RUN_AS_NODE npx electron .          # bash
$env:ELECTRON_RUN_AS_NODE=$null; npx electron .     # PowerShell
```

### Headless check against the live relay

`selftest.js` runs the shell's own main-process modules — real `safeStorage`, real SIWE
ceremony, real `POST /mcp` — and prints what came back. It is not a mock; the only thing it
replaces is the human pressing buttons.

```sh
cd applications/shared-workspace/desktop

# wallet path: sign in, read a workspace, and append a real, public entry
env -u ELECTRON_RUN_AS_NODE \
  INTEREGO_SELFTEST_KEY=0x... \
  INTEREGO_SELFTEST_WORKSPACE=https://relay.interego.xwisee.com/ns/POD/NAME \
  INTEREGO_SELFTEST_POST=1 \
  ../../../node_modules/electron/dist/electron.exe dist/selftest.js

# browser-delegated path, with the WebAuthn gesture scripted
env -u ELECTRON_RUN_AS_NODE \
  INTEREGO_SELFTEST_PASSKEY=path/to/credential.json \
  ../../../node_modules/electron/dist/electron.exe dist/selftest.js
```

---

## The two ways to sign in

Both end at the **same** credential — an OAuth bearer minted by the relay's own authorization
server at `POST /token`. SIWE and WebAuthn are two ways of satisfying `POST /oauth/verify` for
one pending authorization, not two token types. What differs is the pod the relay provisions,
and that is permanent:

| Sign-in | Where the secret is | Pod prefix | Browser needed |
|---|---|---|---|
| Wallet key on this machine | OS secret store (`safeStorage`) | `u-eth-...` | no |
| Sign in in my browser (passkey / Windows Hello) | the platform authenticator | `u-pk-...` | yes |

### Why the passkey path opens your browser instead of doing it in-app

Measured: the WebAuthn ceremony's `clientDataJSON.origin` must be
`https://identity.interego.xwisee.com` — the **identity server** — even though the proof is
POSTed to the **relay's** `/oauth/verify`. A renderer loaded from `file://` has origin
`file://` and can never satisfy that. So the app opens the relay's own sign-in page in the
system browser and receives the authorization code back over a **loopback** redirect
(`http://127.0.0.1:<os-assigned port>/callback`), with PKCE. That is RFC 8252, and it is also
the only way the authenticator is a real one rather than a soft key this process generated.

Not an embedded webview: an embedded webview can read what you type into it, which defeats the
point of delegating the ceremony. Not a custom URL scheme: another installed program can claim
one. The loopback socket binds `127.0.0.1` only, so nothing off this machine can reach it.

### What the OS secret store does and does not protect

The wallet key is encrypted by the operating system before it touches disk — DPAPI on Windows,
scoped to your Windows user account. That defeats an attacker who copies the file off the
machine. **It does not defeat software already running as you**, because DPAPI binds the
ciphertext to the *user*, not to this application. It is the same protection Chrome gives
cookies. If the OS store is unavailable the wallet path **refuses** rather than writing a
plaintext key, because a "secret store" that quietly writes cleartext is worse than none.

Nothing is written to the repo, and nothing is written in plaintext anywhere.

---

## Shape

```
src/auth.ts       the two flows: SIWE against /oauth/verify, and RFC 8252 loopback + PKCE
src/secrets.ts    safeStorage, and an explicit refusal when it is not available
src/main.ts       the privileged half — holds the bearer, exposes three IPC channels
src/preload.ts    the whole surface the renderer gets: describe, sign in, call a tool
src/renderer.ts   draws; every substrate decision comes from @interego/workspace-client
src/selftest.ts   the headless live run above
```

**The bearer never crosses the IPC boundary.** The renderer asks for a tool call by name and
arguments; the main process attaches the credential. The renderer is the half that displays
bytes other people wrote, so it is the half that must not hold a token.

**Nothing here fetches a descriptor URL.** They come back as
`http://css.railway.internal:3456/...`, an address inside the fleet — unreachable from a
laptop. `get_descriptor` is the only way to turn one into bytes, and it is what the client uses.

**Cold start is 12-16 s on a fresh identity**, because the first pod-aware call provisions a
pod. The sign-in screen counts up and names the step rather than showing a spinner.

---

## Why Electron and not Tauri

Tauri is the better shape — no bundled Chromium, ~10 MB instead of ~200 MB — and this machine
already has what its native half needs: WebView2 151.0.4129.59, MSVC 14.44.35207, Windows SDK
10.0.26100.0. What it does **not** have is a Rust toolchain: `cargo --version` and
`rustc --version` both answer *command not found*. Shipping a Tauri app from here would mean
shipping one that had never been built or run.

Two smaller reasons point the same way. The wallet path needs secp256k1 signing and an OS
secret store in the privileged process, which Electron gives in TypeScript (`ethers`,
`safeStorage`); Tauri would need Rust for both. And the loopback receiver is a Node HTTP
server, which *is* the Electron main process and would be a Rust task there.

**What would change to switch:** nothing in `@interego/workspace-client`, and nothing in
`auth.ts` beyond the transport of three IPC calls. That surface was kept to three channels for
this reason.
