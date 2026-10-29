# Interego Wallet

A Manifest V3 browser extension for choosing an Interego connection, inspecting pod context, and reviewing a selected passage before saving it as a private memory. This first version targets desktop Chrome and Chromium-based Edge and has no runtime dependencies or build step.

## Why a wallet?

OpenLink YouID provides a useful precedent: a browser interface for selecting hyperlink-based identities backed by verifiable credentials. Virtuoso's WebID implementation connects an identity URI to a public key in its profile graph. Interego benefits from the same visible identity choice, extended to context and consent: **which identity is connected, what context is available, and what exactly is being sent where?**

This extension uses the relay's existing identity flow and live tool affordances. It does not issue certificates, hold private identity keys, implement WebID-TLS, or provide a website-facing wallet API. A configured label or a successfully retrieved descriptor does not by itself establish a person's identity. The authenticated identity and any relay-reported signature status are displayed with their source.

## Install locally

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**, choose **Load unpacked**, and select this `applications/browser-wallet` directory. Select the directory containing `manifest.json`; no compilation is needed.
3. Pin **Interego Wallet** to the toolbar.
4. On an ordinary HTTPS page, click the toolbar icon to open the wallet. Enter the HTTPS relay origin, choose the requested access, and select **Connect identity**.
5. Approve access to that relay origin when the browser requests it, then complete the relay's sign-in and consent flow.

The default connection requests `mcp:read`. Choose **Read and save private notes** explicitly when connecting if you need `mcp:write`. The relay must advertise compatible OAuth metadata, a public-client registration flow, and the required tool affordances. The extension follows the advertised contracts rather than accepting arbitrary remote actions.

## Use

- **Inspect context:** choose a connected identity, refresh its recent context, and open a descriptor. This is a bounded recent list, not a full pod export.
- **Capture a passage:** select text on a web page, then click the toolbar icon. The temporary `activeTab` grant lets the extension collect the selection and page metadata for review. It does not continuously monitor browsing. Browser-protected pages cannot be captured.
- **Save a private memory:** edit the title, passage, optional source URL, and purpose. Choose **Review private save**, inspect the exact note and destination, then choose **Approve private save**. Preparing a review does not save anything.
- **Check the result:** the extension rereads the returned descriptor and records a local receipt. A failed or uncertain readback must not be treated as verified persistence or blindly retried.
- **Forget a connection:** this clears its local connection state and removes its browser origin permission when no remaining connection needs it. It does not revoke a server-side grant or delete memories already saved. Use the identity provider or relay to manage server-side authorization.

Private `remember` saves are encrypted by the relay for the current session agent. The relay receives the plaintext to perform this encryption; this is **relay-managed encryption, not client-side end-to-end encryption**. Other agents sharing the same pod may be unable to read those notes. Review the selected agent before saving.

## Storage and permissions

OAuth uses authorization code flow with PKCE and state. Access tokens are held only in `chrome.storage.session`; refresh tokens are not persisted. Closing or restarting the browser ends the local authenticated session. Non-secret connection metadata and the last 50 save receipts are held locally. Receipts contain metadata rather than the captured passage; local storage should still be considered sensitive because titles and source links can reveal context.

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

The smoke runner can use an externally installed Playwright module and Chromium executable through `PLAYWRIGHT_MODULE` (absolute path to Playwright's `index.mjs`) and `CHROMIUM_PATH`. Otherwise it imports the installed `playwright` package and uses its Chromium. Set `WALLET_SCREENSHOT` to an output image path to save a UI screenshot. Playwright is a test prerequisite only and is not shipped with the extension. The CI workflow runs only the dependency-free tests and package checks.

`npm --prefix applications/browser-wallet run test:live` checks the default relay's public catalog and OAuth metadata with read-only requests. It does not sign in, register a client, or save anything. In an extracted standalone package, run `npm test`, `npm run check`, or `npm run test:live` from the package directory instead.

For manual verification, connect with read access and confirm that saving is unavailable; reconnect with save access, capture a selection, cancel its first review, then approve a new review and inspect its receipt. Confirm that forgetting a connection clears local access, while already saved memories remain on the relay. Use a test account for live save verification.

## Design references

- [OpenLink YouID source and identity-selection model](https://github.com/OpenLinkSoftware/youid)
- [YouID profile, NetID list, and OS credential-storage guide](https://community.openlinksw.com/t/how-to-guide-self-sovereign-identity-using-netid-tls-via-a-youid-generated-profile-document/4440)
- [Virtuoso WebID protocol support](https://docs.openlinksw.com/virtuoso/vfoafssl/)
- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [identity flow](https://developer.chrome.com/docs/extensions/reference/api/identity), [storage](https://developer.chrome.com/docs/extensions/reference/api/storage), and [extension security](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)

The implementation is original Interego code; YouID is a design reference, not a copied dependency.
