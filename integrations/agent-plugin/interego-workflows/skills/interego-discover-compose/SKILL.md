---
name: interego-discover-compose
description: Discover live Interego or Foxxi capabilities and compose services for a concrete task through their advertised affordances. Use when the required service or operation is unknown, or when a task spans multiple Interego capabilities.
---

Use the connected Interego tools; hosts may prefix their names. Keep domain ontologies, input shapes, and service contracts live rather than assuming this package is their authority.

1. State the task's required inputs, desired output, and available authority. Start from a resource or service descriptor already supplied by the user or a verified discovery result. Otherwise use bounded discovery on the authenticated pod or a known service pod. Use federation discovery only when the needed capability is actually unknown across peers.
2. Read the descriptor with `get_descriptor` or `dereference`. Follow its advertised affordance, action IRI, target, method, input shape, required authentication, and output contract. Fetch linked shapes or guidance before constructing an unfamiliar request. Do not fabricate an endpoint from an action name or reuse an old cached contract without checking it.
3. Build the smallest sequence of available operations that produces the requested output. Reuse a domain bridge only when already connected and permitted. The generic Interego `act` can follow a descriptor's action, so another server is not automatically necessary.
4. Invoke read-only discovery and validation first. Then execute the task's authorized mutations with the advertised payload. If an operation requires a signed request, use `sign_request` for the session's own identity and pass its returned envelope unchanged. A signed response is evidence of integrity and attribution, not correctness of the domain claim.
5. Check the returned output against the contract and the user's objective. Reread any persisted artifact through its returned durable reference. For failure, retain the actual error and refresh the contract before a justified retry; avoid repeated speculative calls.
6. Save the working composition, exact service references, and validation result when the task calls for reusable work. Use `remember` for a simple note. Keep the live contracts linked, not copied into a new parallel specification.

Use the existing `render_hmd` viewer when a human needs to inspect or act on a signed HyperMarkdown artifact. Use `get_descriptor` for pure agent data. For ordinary memories use `remember`; reserve AMEP exchange envelopes for governed, contestable multi-party claims that require that protocol.
