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
`function graphRegion(...)` below it would shadow the module and win, which is exactly the
drift this arrangement exists to prevent.

## Why generated rather than imported

The file must stay one document: "publish this unedited and it becomes your page, on your pod,
under your own connector grant" is the whole proposition, and a page with an `import` is not
that. The alternative to generating is a copy, and a copy is how every drift defect in this
vertical happened — a Turtle reader hardened in one place while the other place kept the bug.

## What is generated and what is still hand-written

Generated (the module is the only copy): the Turtle walker and its comment/literal mask, every
reader, the TriG region locator, the role-profile parser, the member-document naming scheme and
its inverse, the pod resolvers, the supersession chain walk, entry composition and escaping,
the precondition honesty rule, and the eleven-tool manifest.

Still hand-written in the page, and therefore still duplicated: the thin I/O wrappers
(`tool`, `resolveServer`, `currentHead`, `descriptor`, `manifest`, `resolveMemberDoc`,
`publishAndConfirm`, `fetchProfileTurtle`), the roster fold inside `loadRoster`, and `post`.
These are interleaved with the page's own DOM and panels; the module has equivalents
(`WorkspaceClient`, `foldRoster`, `postEntry`) that the desktop shell uses. Collapsing the page
onto them is the next increment, not this one.

## Publishing it

Publish with the `mcp` capability and pass these eleven tool names as the `capabilities`
manifest. The page cannot ask for a tool at runtime:

    dereference, discover_context, get_current_head, get_descriptor, get_pod_status,
    invoke_affordance, notify_agent, publish_context, read_inbox, resolve_webfinger, verify_agent

The same list is `REQUIRED_TOOLS` in the generated block, is rendered into the lobby's
"Publishing this page" card, and is what the connector probe reports against — one definition,
so the three cannot drift.
