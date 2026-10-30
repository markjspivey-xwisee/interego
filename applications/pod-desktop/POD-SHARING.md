# Connect with another Interego pod

This consumer preview supports selected, encrypted snapshots between local pods and the hosted federation adapter. Pod sharing starts off on every app launch. Hosted Interego remains available separately.

## Connect with your brother

1. Both people set up their own local Interego pod. In **Connections**, save a permanent HTTPS address in the web setup section. Each local computer needs its own address and gateway route. The temporary address is not used for permanent peer connections.
2. Choose **Check and enable web access** above to verify the saved route, reviewing any web-assistant pairings it will resume. Then in **Connect with your people**, choose a display name, read the explanation, and choose **Enable pod sharing**. Sharing has its own permission and does not start web access for you. Your computer and Interego must stay running for delivery.
3. One person chooses **Invite someone** and sends the copied invitation privately to the other. Invitations expire after 15 minutes and can be used once.
4. The other person enables sharing, pastes the invitation and chooses **Review invitation**. Compare the code shown on both computers over a channel you trust. A chosen display name is not proof of someone's identity.
5. The inviter confirms the matching code and accepts the connection. The other person chooses **Refresh sharing** to finish. Connecting does not share any notes automatically.
6. Choose the connected pod, load the list of saved notes, check one to ten notes, and confirm **Send selected snapshots**. Read received snapshots in the same panel. The original notes remain in the sender's local pod.

The same invitation flow works with the hosted adapter's **Pod sharing** page. Hosted management requires its own explicit sharing authorization; an assistant's notes permission does not authorize managing people or sharing. The hosted adapter must be deployed before that page is available. This PR does not deploy the hosted service.

## What you control

**Pause pod sharing** stops peer traffic and cancels pending work. **Stop Interego**, stopping web access and quitting also pause federation. Saved connections and received copies remain, and later app launches require you to enable sharing again. Web assistant access is a separate control: pausing only pod sharing can leave approved web assistants available.

**Disconnect pod** blocks new transfers involving that connection. A recipient may retain anything already delivered. Received snapshots are private local copies, not remotely retractable files. **Remove local copy** removes one received snapshot from this computer. **Clear sent history** clears display history while keeping connections and replay protection. **Reset pod sharing** explicitly removes the separate sharing identity, connections and received snapshots; your own notes and web-assistant pairings remain.

Sharing sends selected representations encrypted for the intended peer, using separate sharing keys. It never sends your pod's master key or storage credential. Canonical resource identities, media types and the original representation are retained. The tunnel provider sees routing information and encrypted peer payloads; peer names and public profiles are not secret. Web-assistant note access has its own privacy boundary described in [agent connections](AGENT-CONNECTIONS.md).

This preview supports snapshots and manual delivery while both pods are online. It does not provide live shared editing, automatic synchronization, offline queues or automatic retries of uncertain deliveries. If delivery cannot be confirmed, ask the recipient to check before sending again. Received copies and sent history each have a 64-item limit; remove copies or clear sent history to free space. Sharing credentials and received copies are excluded from the notes backup.

## Browser extension and website login

The Interego browser wallet can connect to a local installation through its permanent HTTPS bridge. In the extension choose **Local pod**, copy the installed extension ID, save that exact ID under **Use your browser extension** in Interego, and enable web access. Complete OAuth and compare the native approval code. The extension can read notes and, if separately approved, save reviewed captures. It retains hosted connections as another choice.

This notes connection does not provide a website login identity. In particular, hosted Hallowmarch currently verifies its configured hosted identity provider, owner record and trusted pod location. This Windows preview holds a notes key and a separate peer-sharing identity; neither is an assertion accepted by that login flow. Local-held identity and local game storage require a separate approved identity-provider adapter, a site-scoped challenge-signing flow with native consent, and reachable advertised pod capabilities that the game explicitly accepts. This PR preserves existing hosted login, account ownership and save rules.

## Implementation boundary

This is a Layer 3 adapter over the local storage runtime. It mounts only signed peer routes on the optional HTTPS bridge; the authoritative Solid storage remains credential-gated on loopback. MCP OAuth, extension-origin allowances and federation permissions are distinct. New adapters preserve the original graph identities instead of rewriting them to tunnel URLs.

Peer requests and replies bind signatures to the sender, recipient endpoint, operation, nonce, timestamp and request nonce. Durable peer/replay/snapshot state is committed before an acknowledgment. Desktop persistence uses Windows-protected storage. Public requests cannot change owner settings, fetch arbitrary local URLs or expose the storage gateway. Public HTTPS destinations use DNS validation and address pinning; local/intranet destinations and redirects are rejected. The hosted owner state uses encrypted pod storage with conditional writes. The current hosted preview needs a single active instance or request affinity for process-local enable state; it is disabled on a fresh instance.
