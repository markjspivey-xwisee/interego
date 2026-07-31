# `agp/shapes` — the path the `agpsh:` IRIs actually declare

`AGP_SHAPES_NS` is
`…/applications/agentic-performance-practice/agp/shapes#`
(`applications/agentic-performance-practice/src/ontology.ts:16`), so every `agpsh:` shape
IRI dereferences to `…/agp/shapes`. The file was only ever published at
`…/agp-shapes.ttl`, so **every one of those IRIs 404'd at its own declared authority** —
the vertical that runs shapes was the one vertical whose shape IRIs did not resolve.

`shapes` here is a byte copy of `agp-shapes.ttl`, served at the declared path.

**The IRI was not changed to match the file, deliberately.** An identifier is the thing
other parties cite; renaming it to fix a hosting mistake breaks every existing reference
to make a filename tidier. Move the bytes to the identifier, never the reverse.

Extensionless on purpose: the IRI has no extension, and GitHub Pages serves the file at
exactly the requested path.
