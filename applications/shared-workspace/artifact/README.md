# The published artifact

`channel.html` is the single self-contained file published at
<https://claude.ai/code/artifact/96913c2e-f6f6-4ebd-b89e-80481b548c1f>.

## Do not edit between the markers

Everything between

```
/* == BEGIN GENERATED - @interego/workspace-client ==...
/* == END GENERATED ==... */
```

is built from `packages/workspace-client/src` by `tools/build-workspace-artifact.mjs`. Edit the
package, then:

```sh
node tools/build-workspace-artifact.mjs          # rewrite the block in place
node tools/build-workspace-artifact.mjs --check  # exit 1 if it would change
```

`tests/workspace-artifact-no-drift.test.ts` runs `--check`, and additionally asserts that none
of the extracted symbols is declared **outside** the region — a re-pasted
`async function currentHead(...)` below it would shadow the module and win, which is exactly
the drift this arrangement exists to prevent. It also asserts that `window.claude` is reached
from exactly one line, and that nothing in the hand-written half calls `callTool` /
`listTools` / `watchTool` / `invalidate` on the host directly.

Both extra rules are load-bearing rather than decorative: injecting either mutant — a re-pasted
`currentHead` below the region, or a second route to the host — leaves the byte comparison
green and fails only these.

## Why generated rather than imported

The file must stay one document: "publish this unedited and it becomes your page, on your pod,
under your own connector grant" is the whole proposition, and a page with an `import` is not
that. The alternative to generating is a copy, and a copy is how every drift defect in this
vertical happened — a Turtle reader hardened in one place while the other place kept the bug.

## What is generated and what is still hand-written

Generated (the module is the only copy): the Turtle walker and its comment/literal mask, every
reader, the TriG region locator, the role-profile parser, the member-document naming scheme and
its inverse, the pod resolvers, the supersession chain walk, entry composition and escaping,
the precondition honesty rule, the eleven-tool manifest — and, since this increment, **all of
the I/O**. `tool`, `resolveServer`, `currentHead`, `descriptor`, `manifest`,
`resolveMemberDoc`, `fetchProfileTurtle`, `publishAndConfirm` and `readWorkspaceRecord` are
bindings onto one `WSPC.WorkspaceClient` over one `WSPC.ConnectorTransport`; the roster fold is
`WSPC.foldRoster`; the append is `WSPC.postEntry`; the live watch and the cache drop go through
the same transport as every other read; `entryShapeAnswer` and `toChainRow` are the module's.

Hand-written in the page, and NOT a second copy of anything:

- **The panels.** `errBox`, `writeLine`, `refusalPanel`, `say`, `kvPair`, `renderRoster`,
  `renderStream`, `renderLobby` and the rest. A shell draws; the module decides.
- **`errorCopy`.** It delegates to `WSPC.errorCopy` for the category and overrides only the
  sentences where being a *published page* changes the remedy — this file's tool manifest was
  fixed when it was published, so "re-publish this file" is the fix and "reload" is not, which
  would be wrong advice in the desktop shell. Because the categories come from the module, a
  code the module learns tomorrow arrives here already handled rather than falling into a
  `default` nobody extended.
- **`shortCid` / `shortRef`.** Both delegate to `WSPC.shortRef`, so the rule that tells a
  content CID apart from a descriptor URL lives in one place. What stays is the placeholder for
  "there was nothing to shorten", which differs per shell.
- **The five documents `createWorkspace` publishes**, `canvasTurtle`, `findSeat`, `loadSpaces`,
  `loadInvites`, `verifyGrantIri`, `acceptGrant`, `sendInvite`, `checkAffordance`,
  `askMember`. These exist exactly once, here. There is no module equivalent to drift from,
  and moving them would grow the module's surface for a single consumer.
- **`mcp()`.** The host object is the one thing a page must supply. It is handed to the
  transport once and never reached again.

## What the move changed in behaviour

Two differences that had already opened up between the two copies, both closed by deleting the
page's half:

1. The page never applied the module's `GRANT_READ_CAP`, so a workspace with more grants than
   the cap folded differently depending on which client you opened it in. The page now reads at
   most 25 and says so on the roster when it found more.
2. The page's own `resolveMemberDoc` treated a head the relay could not explain as evidence of
   absence, reporting `error: null` — which every caller reads as licence to print "granted, but
   no acceptance published on their pod yet", a positive statement about somebody else's pod
   from a read that established nothing. The module had the same hole and now carries the
   `unreadable` message forward as an error. Covered in `tests/workspace-client.test.ts`.

## Publishing it

Publish with the `mcp` capability and pass these eleven tool names as the `capabilities`
manifest. The page cannot ask for a tool at runtime:

    dereference, discover_context, get_current_head, get_descriptor, get_pod_status,
    invoke_affordance, notify_agent, publish_context, read_inbox, resolve_webfinger, verify_agent

The same list is `REQUIRED_TOOLS` in the generated block, is rendered into the lobby's
"Publishing this page" card, and is what the connector probe reports against — one definition,
so the three cannot drift.
