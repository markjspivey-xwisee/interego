# Signed resource surfaces

This optional composition opens an existing application through the shared
Interego HyperMarkdown viewer. It registers no MCP tools and requires no
application-specific ChatGPT plugin.

A signed `interego.resource-surface/v1` document supplies the application's
identities, its registry and contract, the engine and state graphs, the grid
presentation, and any evidence references. The reusable `finite-board/v1`
interpreter understands the declared finite-board rules; it does not contain a
particular game's graph IDs, action IRIs, players, dimensions or winning lines.
The reference relay image installs this interpreter explicitly. The default
neutral image still installs no application interpreter.

The signed surface's `authority.actionTarget` explicitly binds the interpreter
to the abstract runtime target advertised by the contract and registry.
Unsupported rule or input grammars fail closed.

## Open and act

1. Discover the surface in the ordinary pod manifest and resolve its current head.
2. Pass its signed descriptor to `render_hmd`.
3. Follow the returned controls with `act` or `invoke_affordance`, preserving the
   exact descriptor reference, action IRI and payload.

Opening verifies the surface, registry, contract, engine and current state. It
reconstructs the differential frontier from the signed registry and resolves
`verified-minimal-edit`; it does not publish. A grid cell only refers to an
advertised control. The shared viewer has no game rules and never changes cells
optimistically. Terminal positions have no executable cell controls.

An action reference binds the reviewed authority and inputs but is not a
credential. Execution re-fetches the signed resources, repeats planning, and
checks the complete selected tuple. Writes require an authenticated principal
and the existing signed publication/CAS gate. A stale predecessor returns 412.
A publication followed by a verification failure retains the publication
outcome and must not be retried as though no write occurred.

The Markdown representation remains available. Each action is also an
addressable HMD document with its own typed control and authority context;
links between those documents are discoverable without the grid renderer.

## Evidence

Optional evidence declarations select signed JSON documents or existing signed
application catalogs. They declare digest and signer requirements, equalities
between document paths, readable summaries and a recorded-state reference.
Those bindings are data, so neither the renderer nor evidence verifier needs to
know a particular release, evaluation system or policy.

Current artifact verification and related application history replay are
reported separately. A historical observation whose recorded state differs
from the displayed head is labeled historical. A derived display does not
claim to have its own authorship signature.

## Existing Differential Reuse game

`examples/resource-surfaces/differential-reuse.json` is a surface definition for
the existing public game and its signed policy-use evidence. Publishing that
definition adds a presentation/discovery resource only. It does not recreate,
reset, copy or supersede the game's engine, registry, contract or session.

The old personal `interego-differential-reuse` ChatGPT plugin and its named
opening/planning tools are not part of this execution path. After verifying the
surface on the deployed reference relay, that plugin can be removed without
removing the game or its history.

Offline regression tests cover alternate graph/action identities and board
configurations, invalid authority and evidence, terminal cells, stale writes,
and uncertain publication outcomes. Live verification of an existing game
should use only discovery, rendering and advertised read controls.
