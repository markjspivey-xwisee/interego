# `adp/shapes` — the path the `adpsh:` IRIs actually declare

`applications/agent-development-practice/ontology/adp-shapes.ttl:22` binds

    adpsh: <…/applications/agent-development-practice/adp/shapes#>

and the document declares itself as `<…/adp/shapes>` at line 24. It was only ever published at
`…/adp.ttl` and `…/adp.html`, so **every `adpsh:` shape IRI 404'd at its own declared
authority** — the same defect the sibling `agp/shapes` directory was created to fix, one
vertical over, found by an adversarial pass after that one was closed.

`shapes` here is a byte copy of `applications/agent-development-practice/ontology/adp-shapes.ttl`,
served at the declared path.

**The IRI was not changed to match the file, deliberately** — the same reasoning as
`agp/shapes`: an identifier is what other parties cite, and renaming it to fix a hosting
mistake breaks every existing reference to make a filename tidier. Move the bytes to the
identifier, never the reverse.

Extensionless on purpose: the IRI has no extension, and GitHub Pages serves the file at exactly
the requested path.

`tests/shape-namespaces-resolve.test.ts` now walks every tracked file rather than five source
directories, so the next vertical that declares a namespace it does not publish fails there
instead of waiting for an audit.
