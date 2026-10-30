# Interego Wallet

A Manifest V3 browser extension for choosing an Interego connection, inspecting pod context, and reviewing a selected passage before saving it as a private memory. This first version targets desktop Chrome and Chromium-based Edge and has no runtime dependencies or build step.

## Why a wallet?

OpenLink YouID provides a useful precedent: a browser interface for selecting hyperlink-based identities backed by verifiable credentials. Virtuoso's WebID implementation connects an identity URI to a public key in its profile graph. Interego benefits from the same visible identity choice, extended to context and consent: **which identity is connected, what context is available, and what exactly is being sent where?**

Hosted connections use the relay's existing identity flow and live tool affordances. Local connections use the installed pod's explicit OAuth approval and scoped MCP notes adapter. The extension does not issue certificates, hold private identity keys, implement WebID-TLS, or provide a website-facing wallet API. A local note connection, configured label or successfully retrieved descriptor does not by itself establish a person's identity. Hosted authenticated agents and relay-reported signature status are displayed with their source; local access is labeled as an approved connection rather than a verified human identity.

## Install locally

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**, choose **Load unpacked**, and select this `applications/browser-wallet` directory. Select the directory containing `manifest.json`; no compilation is needed.
3. Pin **Interego Wallet** to the toolbar.
4. On an ordinary HTTPS page, click the toolbar icon to open the wallet. Choose **Hosted Interego**, enter the HTTPS relay origin, choose the requested access, and select **Connect identity**. For an installed pod, follow the local setup below.
5. Approve access to that relay origin when the browser requests it, then complete the relay's sign-in and consent flow.

The default connection requests `mcp:read`. Choose **Read and save private notes** explicitly when connecting if you need `mcp:write`. The relay must advertise compatible OAuth metadata, a public-client registration flow, and the required tool affordances. The extension follows the advertised contracts rather than accepting arbitrary remote actions.

## Connect an installed local pod

1. Set up the [Windows app's secure web bridge](../pod-desktop/AGENT-CONNECTIONS.md). A saved user-owned HTTPS address is recommended so the destination remains stable. Keep Interego and your PC running; this version does not connect the browser directly to a loopback HTTP endpoint.
2. In the extension, choose **Interego installed on my computer**. It displays the actual ID of this installed extension. Copy that ID into browser extension access in Interego's **Connections** panel and save it. An unpacked extension's ID can change if its installation path changes.
3. Enable the bridge in Interego, enter its HTTPS address in the extension, and choose read access or read and save access. The bridge must permit those same operations. A save-only bridge cannot supply this wallet's note list and read-back check.
4. Allow browser access to that exact HTTPS origin, then compare and approve the OAuth request in the native Interego app. Allowing an extension ID permits its browser-origin requests; it does not approve note access by itself.
5. Refresh the list, open a note, or review a selected passage before saving it. The extension uses only `interego_status`, `interego_search_notes`, `interego_read_note`, and `interego_save_note`. Read access maps to `notes:read`; read and save maps to `notes:read notes:create`. It does not expose the local storage endpoint, pod content key, backup files or unrestricted URL access.

Local note references retain their canonical `urn:graph:pod-note:<uuid>` identities. The installed adapter resolves them over authenticated MCP; it does not return a full signed descriptor. The UI describes this limit rather than presenting note access as cryptographic human identity verification. Local saves are encrypted by the installed pod. The bridge provider can process the traffic passing through its HTTPS connection, including readable notes; this is not end-to-end encryption through the provider.

The local OAuth access token and rotating refresh token stay in `chrome.storage.session`, isolated from page content and the wallet's display state. The worker refreshes the short-lived access token within the current browser session. If a refresh result is uncertain, it clears that authority and asks you to reconnect rather than replaying the old token. Closing the browser ends that local session; approved pairings stored by the native app do not make the browser's forgotten credentials recoverable.

For a local connection, **Forget this connection** first removes browser credentials and attempts one bounded OAuth-session revocation. If the bridge is offline or revocation is uncertain, the UI says so; use **Disconnect** in the native Interego app to revoke the saved grant. Notes already stored remain intact. Removing the extension ID from Interego blocks subsequent extension-origin requests, while native grant revocation remains the authority for all clients.

This connection does not enable federation. Pod-to-pod sharing is a separate owner-controlled permission.

## Using a local identity to sign into hosted Hallowmarch

That is a valid architectural goal, but this extension currently grants context access; it is not a website sign-in provider. The installed pod's notes encryption key is also not a hosted login credential. This change enables the extension to read and save local notes without changing Hallowmarch's account or save rules.

The [current Hallowmarch identity adapter](https://github.com/markjspivey-xwisee/hallowmarch/blob/fix/native-transport-recovery-20261019/server/gaming/player-identity.js) uses its server's configured OAuth provider, canonical owner and agent DIDs, delegation registry owner, and trusted pod bases. It does not accept an arbitrary pod address or an extension's chosen account label. Its owner check and game-session binding protect against connecting another person's character; replacing them with local connection metadata would not establish ownership.

A complete local-held identity path needs a separately composed identity-provider and game-storage adapter: a persistent owner signing identity distinct from note encryption, a site-issued challenge bound to the intended origin and game session, explicit native consent to the site and requested capabilities, independently verifiable public identity/key material, and access links for the selected game resources on the owner's reachable pod. Existing characters need an explicit owner-verified linking or migration ceremony. Personal save access and learning export consent must remain separate. Those contracts must be implemented and tested with the game's owner-verification flow before claiming local-pod Hallowmarch sign-in. No Hallowmarch production configuration, identity policy, character save or learning rule was changed or deployed here.

## Use

- **Inspect context:** choose a connected identity, refresh its recent context, and open a descriptor. This is a bounded recent list, not a full pod export.
- **Capture a passage:** select text on a web page, then click the toolbar icon. The temporary `activeTab` grant lets the extension collect the selection and page metadata for review. It does not continuously monitor browsing. Browser-protected pages cannot be captured.
- **Save a private memory:** edit the title, passage, optional source URL, and purpose. Choose **Review private save**, inspect the exact note and destination, then choose **Approve private save**. Preparing a review does not save anything.
- **Check the result:** the extension rereads the returned descriptor and records a local receipt. A failed or uncertain readback must not be treated as verified persistence or blindly retried.
- **Forget a connection:** this clears browser connection state and removes its origin permission when no remaining connection needs it. For a hosted connection, manage server-side authorization at the provider or relay. For a local connection, the extension also attempts OAuth-session revocation as described above. Forgetting never deletes saved notes.

Private `remember` saves are encrypted by the relay for the current session agent. The relay receives the plaintext to perform this encryption; this is **relay-managed encryption, not client-side end-to-end encryption**. Other agents sharing the same pod may be unable to read those notes. Review the selected agent before saving.

## Storage and permissions

OAuth uses authorization code flow with PKCE and state. Access tokens are held only in `chrome.storage.session`; hosted refresh tokens are discarded, and local rotating refresh tokens are held only in that same temporary session area. No tokens are persisted in durable local storage. Closing or restarting the browser ends the authenticated browser session. Non-secret connection metadata and the last 50 save receipts are held locally. Receipts contain metadata rather than the captured passage; local storage should still be considered sensitive because titles and source links can reveal context.

`identity` supports the relay sign-in flow, `storage` holds session and local state, and `activeTab` plus `scripting` support user-invoked selection capture. HTTPS relay access is requested through optional host permissions for the selected origin. There are no persistent content scripts, externally connectable website bridge, remote runtime scripts, analytics, or certificate/key custody in this version. External strings are rendered as text, and privileged requests are handled in the extension worker.

## Validate

Use Node.js 22 or newer. The deterministic tests and package checks require no dependency installation:

```sh
npm --prefix applications/browser-wallet test
npm --prefix applications/browser-wallet run check
```

The optional browser smoke test runs the real extension worker and UI in an isolated Chromium profile against an offline relay fixture. OAuth, permission dialogs, and the network boundary are replaced by fixtures; this is not evidence of a live account sign-in or a live save.

```sh
npm --prefix applications/browser-wallet run test:browser
```

The smoke runner can use an externally installed Playwright module and Chromium executable through `PLAYWRIGHT_MODULE` (absolute path to Playwright's `index.mjs`) and `CHROMIUM_PATH`. Otherwise it imports the installed `playwright` package and uses its Chromium. Set `WALLET_SCREENSHOT` to an output image path to save a UI screenshot. Playwright is a test prerequisite only and is not shipped with the extension. The CI workflow runs only the dependency-free tests and package checks. The smoke includes local mode, actual installed extension-ID display, note read, reviewed single save, session refresh rotation and Forget with an offline provider fixture. The desktop's `browser-wallet-bridge.test.ts` separately exercises the real OAuth and MCP bridge handlers with an exact extension origin, native approval and session revocation; only its external HTTPS hop and storage executor are fixtures. Neither test establishes a live provider connection or Hallowmarch sign-in.

`npm --prefix applications/browser-wallet run test:live` checks the default relay's public catalog and OAuth metadata with read-only requests. It does not sign in, register a client, or save anything. In an extracted standalone package, run `npm test`, `npm run check`, or `npm run test:live` from the package directory instead.

For manual verification, connect with read access and confirm that saving is unavailable; reconnect with save access, capture a selection, cancel its first review, then approve a new review and inspect its receipt. Confirm that forgetting a connection clears local access, while already saved memories remain on the relay. Use a test account for live save verification.

## Design references

- [OpenLink YouID source and identity-selection model](https://github.com/OpenLinkSoftware/youid)
- [YouID profile, NetID list, and OS credential-storage guide](https://community.openlinksw.com/t/how-to-guide-self-sovereign-identity-using-netid-tls-via-a-youid-generated-profile-document/4440)
- [Virtuoso WebID protocol support](https://docs.openlinksw.com/virtuoso/vfoafssl/)
- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [identity flow](https://developer.chrome.com/docs/extensions/reference/api/identity), [storage](https://developer.chrome.com/docs/extensions/reference/api/storage), and [extension security](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)

The implementation is original Interego code; YouID is a design reference, not a copied dependency.
