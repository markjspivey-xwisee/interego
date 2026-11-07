# Workspaces: chat with people and agents

**Layer 3 optional application, preview.** Workspaces adds local conversations to the new Interego app. It reuses the Shared Workspace vocabulary and record writers while keeping the old [Interego Workspace desktop app archived](../shared-workspace/ARCHIVE.md). The local pod, notes, identity sign-in and hosted Interego remain available independently. Enabling Workspaces does not enable federation, public web access or Discord.

## Start a local conversation

1. Set up or restore your local space and start Interego.
2. Open **Workspaces** and choose **Enable Workspaces**. It is off until you choose this on first use.
3. Enter a name under **New workspace name** and choose **Create workspace**.
4. Write under **Your message** and choose **Send message**. Your messages appear as **You**. Open another conversation from **Your conversations** to switch spaces.
5. **Pause Workspaces** blocks conversation access and pauses its Discord bridge while keeping the saved conversations. Enable it again to resume local use. Discord still requires its separate Start choice.

Conversations open on a bounded page of recent messages. Use the history controls for earlier or newer messages, or **Latest** to return to the current end. Refresh preserves the history page you selected.

Conversation records are encrypted in this computer's pod, and reopening the same pod preserves them. This preview hosts each conversation in one owner's local pod. It does not recreate the old hosted application's per-participant, cross-pod log federation. It also does not import the old desktop's keys or conversations automatically.

**Back up notes does not back up workspace conversations.** The current notes backup contains notes and their content key, not the Workspace state. Identity backups also exclude chat. Workspace-specific portable backup/export is not included in this preview. Keep this installation's data folder and do not treat a notes restore as a chat migration.

## Invite an agent

An app connection and workspace membership are two separate approvals. Giving a connection a scope does not automatically seat it in a conversation.

1. Create the conversation first.
2. Open **Connections**, choose **Connect an app**, and select your local client.
3. Under **Optional workspace access**, choose read access or read-and-post access. Select only the workspaces this connection needs. A new workspace is not automatically added to an existing grant.
4. Save the connection and use its generated setup instructions in the selected client. Keep Interego open. Existing note permissions remain independent.
5. Return to the conversation, expand **People and agents**, select the scoped connection under **Invite a connected agent**, and choose **Invite agent**.
6. Ask that agent to discover Interego and accept its workspace invitation. Until it accepts, it can see the invitation's name and action, not the conversation history.
7. After acceptance, an agent with read-and-post permission can read and reply. Its messages show the connection's name and **Agent**; the caller cannot turn its message into a post by **You**.

Use **Remove** beside a participant to revoke that workspace's membership. **Disconnect** in Connections revokes the app's grant, including its selected workspace access. Removing access does not erase messages or information already received by the client. Messages an agent reads may be sent to its AI provider; storing them locally does not make the model run locally. This preview connects existing agents and does not automatically start a model or make an agent answer without its host running.

## Discover and follow the available actions

Workspace connections receive two generic MCP tools:

- **`interego_discover`** returns a JSON-LD representation with canonical resource identifiers, the workspaces visible to that connection, and their current action controls and input schemas.
- **`interego_act`** follows a returned control using its `action`, `target` and required `input`. Copy those fields from the current representation instead of constructing action names or target addresses.

The available controls depend on the current role, scope and membership. They cover listing and reading conversations, posting, accepting invitations and leaving. Owner controls also include enabling/pausing Workspaces, creating conversations, inviting participants and revoking membership. The desktop follows the same service controls, and an action is authorized again when it executes. Old or copied controls cannot bypass changed permissions.

A useful request to a connected agent is: “Discover my Interego workspaces, show me the invitations you can accept, and wait for me to choose one.” After joining, ask it to read the selected conversation and reply through its advertised post action.

Local resource identifiers use `urn:interego:local-workspaces:…`. These are canonical names resolved through this authenticated local capability transport. They are not public website addresses, and the app does not claim that an unauthenticated HTTP client can open them. The representation states its `interego_discover`/`interego_act` transport. The records reuse `wsp:` types and membership/message writers; their authorship describes the authenticated local connection, not a signature from the person's website identity key.

## Optional Discord bridge

Discord is a separate external connection. Leave it paused to keep using local chat without Discord. This preview bridges **one selected workspace and one Discord text channel or thread**.

1. Open **Optional Discord bridge** in Workspaces. Choose **Open Discord bot setup** if you need to create a bot in your Discord account.
2. Give that bot access to the chosen server/channel and permission to view and send messages. Enable its **Message Content** intent so the gateway can deliver conversation text. Use a dedicated channel containing the people you intend to share with.
3. Select the local workspace, paste the Discord channel link or its ID, and enter the bot token. Treat the token as a secret. Interego saves it using Windows protection and does not show it to agents or return it in status.
4. Under **People allowed to bridge**, enter one Discord user ID and display name per line, separated by `|`. Discord's Developer Mode exposes **Copy User ID**. These names are display labels; the gateway's actual Discord account ID controls who can post into the local conversation.
5. Read and check the sharing acknowledgement, then choose **Save Discord setup**. Saving does not start the connection or send messages.
6. Choose **Start Discord bridge** when ready. Starting it grants the selected Discord accounts local conversation membership for this bridge. Their messages appear with **Discord** attribution, separately from your PC identity and agent connections.
7. New authorized Discord messages are recorded locally. New local human and agent messages are sent into the selected Discord channel with their author label. Bot messages are ignored on the incoming path to prevent echoes.

Discord and the people who can access that Discord channel can read the messages sent there, including local messages from people or agents who did not individually authenticate with Discord. The allowed-people list limits **incoming authors**, not who can read the Discord channel. Do not enable a bridge on a conversation whose participants have not agreed to that sharing.

**Pause Discord bridge** closes the connection while keeping its protected configuration. Messages saved locally after its delivery checkpoint, including while paused, can be sent when you explicitly start it again. A fresh configuration starts from the current end of the conversation and does not send its earlier history. **Disconnect and forget bot token** pauses the bridge and removes this app's saved bot configuration; it does not delete messages already in Discord or revoke the token at Discord. Use Discord's own bot settings to revoke or rotate the vendor token if needed.

Every app launch starts Discord paused. Stopping Interego or pausing Workspaces stops the bridge. It makes outbound connections to Discord and needs neither public web access nor pod federation.

The bridge handles new text messages, not a complete synchronized Discord archive. Attachments, edits and deletions are not mirrored. Local source-message identifiers suppress repeated incoming records; outgoing delivery uses a saved sequence checkpoint and Discord nonces. Delivery can still be uncertain if a request reaches Discord before an interrupted checkpoint save. An error pauses delivery; check the channel before explicitly starting again. Reading a conversation locally does not prove a remote delivery succeeded.

## Hosted access and limits

**Use hosted Interego** remains available. Local Workspaces is an independent optional vertical; enabling it does not sign into, copy or migrate hosted workspaces. Federation continues off by default and must be chosen separately. Cross-pod live workspaces, a general hosted Workspace connection, a portable chat backup and automatic agent execution remain separate capabilities.

The local preview supports up to 30 conversations, 2,000 messages per conversation and 64 participants per conversation. Messages follow the advertised input bounds. A connection sees only the selected conversations where its current membership allows access. The local Windows user and processes running as that user remain inside the application's trust boundary.
