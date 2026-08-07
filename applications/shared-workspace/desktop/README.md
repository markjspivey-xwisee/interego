# Interego Workspace — desktop shell

Against the **live** relay, with no fixtures anywhere in it:

    boot -> sign in -> lobby (who you are, your inbox, the workspaces you accepted)
         -> create a workspace / invite somebody / accept an invitation
         -> channel: roster, stream, canvas
         -> post an entry, save the canvas, meet a 412 and merge forward

Everything it knows about the substrate comes from **`@interego/workspace-client`** — the same
module the published artifact's script is generated from. This package holds a window, two
sign-in flows and a key. It does not parse Turtle, name a member's documents, decide who is
seated, verify a grant, work out where an entry goes in a chain, or decide whether a save
became the head.

---

## Everything it can do, and the two things it cannot

| flow | where the decision is made | driven live |
|---|---|---|
| create a workspace (five documents, in order, on your own pod) | `createWorkspace` | yes |
| invite by handle, grant on your pod, LDN notice | `sendInvite` | yes |
| accept, from an inbox item that is **verified first** | `verifyGrantIri` + `acceptGrant` | yes |
| switch between the workspaces you have accepted | `listWorkspaces` + `verifyWorkspaceEntry` | yes |
| revoke a grant you published | `revokeGrant` | yes |
| post an entry onto your own pod, compare-and-swap safe | `postEntry` | yes |
| canvas: create, save, forced stale 412, merge forward | `readCanvas` / `saveCanvas` / `mergeForward` | yes |
| renew the bearer with no user present | `refreshBearer` here + the relay's `refresh_token` grant | yes |

**Not signed and not notarised.** `npm run package` produces an unsigned Windows build;
SmartScreen will warn on first run and that warning is correct. There is no code-signing
certificate for this project and notarisation needs an Apple Developer account nobody here
holds. Out of scope — see *Packaging* below.

**Not pushed — polled.** The channel updates by re-reading on a timer, not by subscription, and
the shell says so on screen in the transport's own words rather than claiming "live". See
*The watch* below for the measurement.

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
src/auth.ts       the two flows: SIWE against /oauth/verify, RFC 8252 loopback + PKCE,
                  and refreshBearer — renewal with no user present
src/secrets.ts    safeStorage, and an explicit refusal when it is not available
src/main.ts       the privileged half — holds the bearer, renews it, exposes the IPC channels
src/preload.ts    the whole surface the renderer gets: describe, sign in, call a tool,
                  read the session and be told when it changes
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
pod. Measured again while this shell was built: **16.7 s** for a brand-new wallet, **1.8 s** for
one whose pod already existed, and **30.0 s** for the packaged app's first run. The boot
checklist counts up and names the step rather than showing a spinner.

---

## The watch, and why it re-reads instead of subscribing

`RelayMcpTransport.watchTool()` used to return `null` and every caller polled on its own. Before
replacing that, the relay was **asked what a watch could actually be**
(`tools/probe-watch-live.ts`, two bearers, two real pods, 2026-08-06):

```
GET /notifications/<slug of my OWN pod>   -> 400 {"error":"pod_url_rejected",
                                                  "detail":"pod URL must use https"}
GET /notifications/<slug of ANOTHER pod>  -> 404 {"error":"unknown_pod_slug"}
GET /sse                                  -> 200 text/event-stream
```

The per-pod SolidNotifications channel is the one shaped right — its events carry `podUrl`,
`descriptorUrl`, `graphUrl` and an eventType — and it is **unreachable on this deployment in
both directions**. Outward: its gate runs every pod URL through `assertPublicPodUrl`, and this
fleet's pods *are* `http://css.railway.internal:3456/…`, so the relay's own guard rejects the
relay's own pods before authorization is even considered. Inward: the same gate requires the
slug's pod to be a prefix of the bearer's own, so even repaired it could never open a channel on
**another member's** log — which is the only thing a workspace watch is for.

`GET /sse` connects and is not a subscription. It re-sends the last five entries of a
recent-activity ring every 2 s, and the frames carry a `resource` with no pod and no graph IRI.
Measured 2026-08-06: 5 frames in 8 s, four of them identical. A reader cannot tell which graph
an event is about, or a new one from a repeat.

**One line of that measurement was also a security finding.** This paragraph used to add "one
process-global ring, not a per-pod queue" as evidence the channel was too coarse to watch on.
The ring was fed by *every* pod's publish and `/sse` sits behind a gate that checks only that a
bearer is valid — so any authenticated client received the descriptor URL and timestamp of every
write on the fleet, on pods it had no relationship with. Reproduced on 2026-08-07 with two
disposable identities (`tools/probe-notification-scope-live.ts`) and closed the same day: the
ring is keyed by pod, `/sse` serves only the connection's own, and `get_pod_status` returns
`recentNotifications` only to the pod's proven owner. See
`deploy/mcp-relay/notification-log.ts`.

The conclusion below is unchanged and now holds more strongly: scoped to your own pod, this
channel cannot carry another member's log even in principle.

So there is nothing to subscribe to, and what got built is what the interface's own
`refetchInterval` option already describes: **re-read on a timer, fire an event only when the
answer changes**. That is a real event — the answer to this exact read differs from last time —
and it is not what a push would be, so the difference is published on
`Transport.watchDescription` and printed under the composer instead of the word "live".

One implementation, not two: `pollingWatch` lives in the module and is bound by *both*
`RelayMcpTransport` (main process) and the renderer's own bridge. Without the second binding the
desktop had **no watch at all** — the renderer drives a `ConnectorTransport` over IPC, whose
`watchTool` returns null when the host object has none, so every log fell straight to the
one-shot fallback and the channel never moved again. That was found by driving the renderer in a
document; typechecking could not see it.

---

## Packaging

```sh
npm run package --workspace @interego/workspace-desktop
```

Produces, in `applications/shared-workspace/desktop/release/`:

| artifact | size | what it is |
|---|---|---|
| `Interego Workspace-0.1.0-win.zip` | ~81 MB | portable. Unzip, run the `.exe`. Nothing installed. |
| `Interego Workspace-0.1.0-setup.exe` | ~111 MB | NSIS, per-user, no elevation prompt |
| `win-unpacked/` | ~181 MB | the same app, not archived |

**Unsigned, and not notarised.** `signAndEditExecutable: false` and `forceCodeSigning: false` in
`electron-builder.yml` are deliberate: there is no certificate. Windows SmartScreen warns on
first run of the `.exe` and the warning is accurate — the binary is not signed by anybody it
recognises. macOS notarisation needs an Apple Developer account; neither is in scope here, and
neither is faked.

`electronVersion` is pinned in `electron-builder.yml` because this is an npm **workspace**:
electron-builder looks for `electron` in the package's own `node_modules`, npm hoists it to the
repo root, and the range `^33.0.0` is not something it will guess from. If the two diverge the
package step fails loudly rather than packaging against a runtime nobody tested.

---

## What is tested, and how

| | |
|---|---|
| `tests/workspace-desktop-renderer.test.ts` | **the renderer, driven as a real script in a real DOM.** esbuild bundles `src/renderer.ts` the same way `npm run build` does, jsdom loads the shipping `index.html`, and the whole of `@interego/workspace-client` runs unstubbed. Exactly one thing is scripted: `window.interego`, the IPC channel. 34 cases, each one a sentence the shell must or must not be able to put on screen. |
| `tests/workspace-client-membership.test.ts` | the writers, grant verification, the canvas outcomes, the role-label rule. |
| `tools/drive-membership-live.ts` | the same module functions against the **live fleet**, two real identities, two real pods. |

The bundle is built **inside** the renderer test rather than read from `dist/`, so a stale build
cannot hide a change — that has happened twice in this repo, once hiding a fix and once hiding a
removal.

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
