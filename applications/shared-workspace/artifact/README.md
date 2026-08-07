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

## `invoke_affordance` — observed live, 2026-08-07

Ten of the eleven tools this page declares had been exercised by a live driver in
`../tools/`. The eleventh, `invoke_affordance`, had not: the "ask a member" control only appears
when a member has published a capability document on their own pod, and **nothing in this
repository had ever written one**, so the call had never happened against the live relay. The
page was therefore published carrying a request shape nobody had seen a response to.

`../tools/observe-invoke-affordance-live.ts` now makes it happen — a fresh convener, the
deployed wsp-bridge's own wallet as the member, a real workspace, and a signed capability
document on the member's pod at the qualified IRI this page reads. The request below is the one
`askMember` sends, field for field.

```jsonc
// request
{
  "descriptor_url": "http://css.railway.internal:3456/u-eth-9c43ece1fd8f/context-graphs/1786081482999.ttl",
  "action_iri": "https://relay.interego.xwisee.com/ns/iep/action/wsp/respond-as-member",
  "payload": { "workspace": "https://relay.interego.xwisee.com/ns/u-eth-64d282184089/observe-msiirktx" }
}

// response — 200, 6.2 s
{
  "status": 200,
  "statusText": "",
  "contentType": "application/ld+json; charset=utf-8",
  "body": "{…the target's own JSON, as a STRING…}",
  "affordance": {
    "action": "https://relay.interego.xwisee.com/ns/iep/action/wsp/respond-as-member",
    "target": "https://wsp-bridge-production.up.railway.app/wsp/respond_as_member",
    "method": "POST"
  }
}
```

**The shape matches what this page sends and reads, so nothing here was changed.** `askMember`
reads `res.status` (present, `200`), parses `res.body` as JSON (it parses), and hands the result
to `renderAgentOutcome`, which found `outcome`, `agent`, `read` and `message` where it looks for
them. The one field the page ignores is `affordance` — the relay echoing the action it resolved.

★ **And the member refused, for a reason worth writing down.** `outcome: "refused"`,
`reason: "unreadable-workspace"` — because `rolesTurtle` in `@interego/workspace-client` emits a
role table that declares no `wsp:RoleProfile`, and the bridge's `dereferenceRoleProfile`
requires that type before it will compute a ceiling. So for a workspace created **by this page**
the control can currently only ever render a refusal. Two further disagreements sit behind that
one, found by the same run: the page's role table names local capability IRIs
(`<rolesIri>#Post`) while the bridge asks about `wsp-roles-default#append` — which `respond.ts`
documents as deliberate — and `acceptGrant` writes member documents under the qualified name
while `respondAsMember` composes the legacy one. None of that is a defect in the CALL, which is
what this section is evidence about; all of it is governance the two halves disagree on, and it
is left for a decision rather than patched around.

## Publishing it

Publish with the `mcp` capability and pass these eleven tool names as the `capabilities`
manifest. The page cannot ask for a tool at runtime:

    dereference, discover_context, get_current_head, get_descriptor, get_pod_status,
    invoke_affordance, notify_agent, publish_context, read_inbox, resolve_webfinger, verify_agent

The same list is `REQUIRED_TOOLS` in the generated block, is rendered into the lobby's
"Publishing this page" card, and is what the connector probe reports against — one definition,
so the three cannot drift.
