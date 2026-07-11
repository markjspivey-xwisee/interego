# Interego profiles

Profiles are additive, versioned contracts that compose Interego's stable
Layer-1 vocabulary for a particular interoperability pattern. They do not add
terms to `iep:`, `ie:`, `ieh:`, or `pgsl:` and they do not change L1
conformance.

| Profile | Status | Purpose |
|---|---|---|
| [Affordant Memory Exchange 0.1](affordant-memory/0.1/) | Draft | One hypermedia contract for human↔agent and agent↔agent acts, receipts, branching memory, and deterministic replay using Affordant YAML-LD Markdown. |

Each profile directory is self-contained: vocabulary, JSON-LD context, SHACL
shapes, HTTP binding, examples, and conformance fixtures travel together. A
client claims a profile by using its versioned IRI in both the media-type
`profile` parameter and `dct:conformsTo` in the representation.

