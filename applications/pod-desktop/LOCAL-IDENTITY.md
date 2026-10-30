# Sign in with an identity held on this computer

This Windows preview adds a separate local sign-in credential. The Windows app holds its private signing key, protected with Windows storage. Hosted Interego remains available. Signing in does not enable federation or the public bridge, and does not grant access to local notes.

## Set up

1. Install Interego, set up your local space and open **Identity**. Choose **Create local identity**. To keep an existing account and Hallowmarch progress, link this key to that account before using it to sign in. Signing in with an unlinked key can create a separate hosted account.
2. Back up the identity using its separate encrypted identity backup. Keep the file and its passphrase safely. The notes backup does not include this credential. Restore an identity backup before creating a replacement key on another computer.
3. Install the matching Interego Wallet preview in Chrome or Edge. In its local sign-in settings, copy its extension ID. In the Windows app's Identity page, explicitly allow that exact extension ID. This registers a per-user browser companion without an administrator prompt.
4. In the wallet, explicitly enable local sign-in for the supported hosted relay. For an existing account, separately enable account linking for the identity provider and follow the linking steps below first. The updated hosted services must be deployed before the new options are available.
5. Choose the installed-app sign-in button. Compare the code shown in the browser and Interego. Check the identity provider, callback destination and requested permissions in the native app. Approve only a sign-in you started. Each request needs a new approval.

The first preview trusts only the configured pair `https://relay.interego.xwisee.com` and `https://identity.interego.xwisee.com`. A page cannot supply a different trusted identity provider. Existing hosted sign-in choices remain available. Chrome/Edge registration uses the standard installed `%APPDATA%/Interego` profile; isolated development profiles are not registered automatically.

## What stays local

The signing key and encrypted recovery export stay in the native app. The browser companion has a separate, short-lived transport credential, not the signing key. The extension receives the comparison code, request status and validated OAuth callback; it never receives the private key or raw signature. An allowed extension ID permits requests, while native approval authorizes one specific sign-in.

The existing identity protocol signs the provider host and fresh nonce. The relay's one-use handoff and existing OAuth PKCE/state checks bind that challenge to the pending client, callback, permissions and resource. The native approval displays these server-derived details. The signature alone is not a website-specific authorization document.

The hosted identity provider still verifies the credential, and the website still receives its normal hosted identity and pod authorization. Hallowmarch's existing owner, registry, pod-location and callback checks are preserved. Account linking adds a credential to the same account: its canonical owner DID, user ID and pod stay the same. Game saves remain in that existing hosted pod.

## Link an existing account and keep its progress

1. Keep your local key on this PC and make its encrypted identity backup. In the wallet, enable **Account linking** for `https://identity.interego.xwisee.com`; this is a separate browser-site permission from signing in through the relay.
2. In Interego's Identity page, open your existing account. Sign into the hosted dashboard using the passkey or wallet that already opens the account holding your Hallowmarch progress. Check its displayed account before continuing.
3. Choose to add this PC's local key. Verify again with an already registered passkey or wallet. A normal signed-in session alone cannot authorize adding a credential. If your passkey belongs to the relay's sign-in site, verification opens there; return to the original dashboard afterwards. No account bearer token is transferred to that popup or to the extension.
4. After verification, choose the dashboard's local-app linking button. Compare its code with Interego. The native app shows the exact existing account, pod and local key. Confirm that you are adding a login method to that account, then choose **Add PC key**.
5. The dashboard confirms the registered credential. Start Hallowmarch's normal Interego login and use the local app. The provider now resolves this key to the same existing owner, so Hallowmarch's progress binding remains unchanged. Each sign-in still needs approval in Interego.

Your old sign-in methods remain registered. The linking operation writes only the existing account's credential record; it does not copy, merge or replace accounts or game saves. Federation and the public bridge are unnecessary and remain off unless separately enabled.

If the local key is already registered to another account, linking refuses rather than silently changing which account it opens. Keep that key's backup, then use a separate local credential for the intended account. An uncertain save is reported as unconfirmed; check the dashboard before starting another link. Expired or cancelled requests need a new verification.

## Disconnect and recover

Remove the allowed extension IDs to disconnect browser access on this PC. Pending requests are cancelled. Removing a key needs explicit confirmation: retain its encrypted backup and another working sign-in method first. Losing the only credential and its backup can prevent access to that account. Received/shared notes and notes grants are managed separately.

Uninstall removes only this app's Chrome/Edge companion registration, while preserving the data folder. Reinstall and explicitly save the allowed extension IDs to register it again. Other processes acting as your Windows user are inside the local trust boundary.

## Verification boundary

Tests cover real Ed25519 proof verification, strict relay handoff/PKCE/state, native consent and encrypted recovery; a real Windows console companion uses DPAPI and interoperates with the encrypted local transport. An isolated integration imports Hallowmarch's unchanged login adapter and checks owner mismatch and callback replay refusal. These are not claims of a deployed website login or a live vendor account test.
