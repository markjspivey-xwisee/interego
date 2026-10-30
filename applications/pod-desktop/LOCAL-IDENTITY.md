# Sign in with an identity held on this computer

This Windows preview adds a separate local sign-in credential. The Windows app holds its private signing key, protected with Windows storage. Hosted Interego remains available. Signing in does not enable federation or the public bridge, and does not grant access to local notes.

## Set up

1. Install Interego, set up your local space and open **Identity**. Choose **Create local identity**. A new key creates a separate hosted account when first used; it does not automatically attach to an existing account or recover Hallowmarch progress.
2. Back up the identity using its separate encrypted identity backup. Keep the file and its passphrase safely. The notes backup does not include this credential. Restore an identity backup before creating a replacement key on another computer.
3. Install the matching Interego Wallet preview in Chrome or Edge. In its local sign-in settings, copy its extension ID. In the Windows app's Identity page, explicitly allow that exact extension ID. This registers a per-user browser companion without an administrator prompt.
4. In the wallet, explicitly enable local sign-in for the supported hosted relay. Open a site's normal Interego login page. The relay must include the local identity handoff from this change; existing deployed versions require an update first.
5. Choose the installed-app sign-in button. Compare the code shown in the browser and Interego. Check the identity provider, callback destination and requested permissions in the native app. Approve only a sign-in you started. Each request needs a new approval.

The first preview trusts only the configured pair `https://relay.interego.xwisee.com` and `https://identity.interego.xwisee.com`. A page cannot supply a different trusted identity provider. Existing hosted sign-in choices remain available. Chrome/Edge registration uses the standard installed `%APPDATA%/Interego` profile; isolated development profiles are not registered automatically.

## What stays local

The signing key and encrypted recovery export stay in the native app. The browser companion has a separate, short-lived transport credential, not the signing key. The extension receives the comparison code, request status and validated OAuth callback; it never receives the private key or raw signature. An allowed extension ID permits requests, while native approval authorizes one specific sign-in.

The existing identity protocol signs the provider host and fresh nonce. The relay's one-use handoff and existing OAuth PKCE/state checks bind that challenge to the pending client, callback, permissions and resource. The native approval displays these server-derived details. The signature alone is not a website-specific authorization document.

The hosted identity provider still verifies the credential, and the website still receives its normal hosted identity and pod authorization. Hallowmarch's existing owner, registry, pod-location and callback checks are preserved. This feature does not move game saves into the local pod or migrate an existing hosted account. Adding a local key to an existing account needs an explicit authenticated account-linking flow.

## Disconnect and recover

Remove the allowed extension IDs to disconnect browser access on this PC. Pending requests are cancelled. Removing a key needs explicit confirmation: retain its encrypted backup and another working sign-in method first. Losing the only credential and its backup can prevent access to that account. Received/shared notes and notes grants are managed separately.

Uninstall removes only this app's Chrome/Edge companion registration, while preserving the data folder. Reinstall and explicitly save the allowed extension IDs to register it again. Other processes acting as your Windows user are inside the local trust boundary.

## Verification boundary

Tests cover real Ed25519 proof verification, strict relay handoff/PKCE/state, native consent and encrypted recovery; a real Windows console companion uses DPAPI and interoperates with the encrypted local transport. An isolated integration imports Hallowmarch's unchanged login adapter and checks owner mismatch and callback replay refusal. These are not claims of a deployed website login or a live vendor account test.
