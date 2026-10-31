# Interego Workspace archive and feature evaluation

**Layer 3 application status.** The older Interego Workspace desktop app is archived for now. The [new Interego app](../pod-desktop/README.md) is the active desktop direction. We will evaluate individual features from Workspace rather than continue developing a second desktop product in parallel.

The central purpose of the earlier work was **spaces where humans and agents can chat together, including conversations bridged to Discord**. Retaining that work means preserving the conversation, identity, permission and ownership behavior, as well as the interface.

## Archive scope

- Preserve the old app's source, installation, data and historical validation records. This decision does not uninstall the app, delete accounts, copy keys or migrate conversations.
- Keep shared libraries, tests, the Discord adapter and existing hosted compatibility intact. Archiving the old desktop product does not retire Interego's workspace capabilities or shut down any hosted service or deployed bot.
- Keep the existing build and regression checks. Feature adoption in the new app needs its own implementation and validation; a historical test is not proof that the new local runtime supports it.
- Keep hosted Interego available. Federation remains optional and off by default in the local app. Discord bridging, remote agent access and pod federation require separate explicit choices; choosing a local pod does not enable any of them.

## Features to evaluate for the new app

| Candidate | Behavior worth preserving | Evaluation needed |
|---|---|---|
| Human-and-agent chat spaces | Named participants, visible human/agent authorship, channels and explicit addressees | Consumer setup, local storage and supported local/hosted participants |
| Conversation ownership and membership | Per-participant records, invitations, acceptance, permission ceilings and revocation | Local service capabilities, encrypted access and behavior when participants are offline |
| Agent participation | Delegated identities, targeted requests, reviewed drafts, local model execution and stop controls | Scoped access, clear consent and the distinction between local storage and provider processing |
| Discord conversation bridging | Record linked participants' Discord messages and deliver workspace messages and agent answers back to their Discord thread | Explicit channel selection, attribution, loop/duplicate handling, revocation and local-pod connectivity |
| Shared artifacts | Canvas and other conversation-linked artifacts | Ownership, concurrent changes and recovery |

These are feature candidates, not a committed delivery schedule or a claim of current support in the local app.

## What the retained Discord code actually does

The adapter is more than account linking. Current source records Discord messages through the workspace client, watches workspace logs and posts new entries and agent answers back to Discord. Mentions, typed agent names and replies route through authorized agent requests. See [incoming messages and agent addressing](discord/src/main.ts), [workspace watching](discord/src/watch.ts) and [outgoing rendering](discord/src/render.ts).

This is a two-way conversation conduit with polling and delivery limits, not a complete synchronized copy of Discord. Message edits and deletes are not mirrored. Parts of the Discord README's historical limitations predate the retained agent-participation code. Local-pod compatibility and any reused feature's current end-to-end behavior require separate validation.

## Reuse boundary

Prefer the existing [workspace client](../../packages/workspace-client/), shared relay transport, membership, attribution and delegation code over copying a second implementation into the new app. Keep Discord-specific behavior in an optional adapter.

The local app's current scoped notes tools do not satisfy all the operations the workspace client requires. A local workspace integration must advertise and implement the necessary capabilities and preserve their authorization rules. It must not assume that changing the relay URL makes the old client compatible.

Workspace signing and encryption keys are distinct from the new local sign-in key. Account linking does not automatically move hosted history or provide decryption access. Any future import or connection flow must explain those choices and preserve existing access.
