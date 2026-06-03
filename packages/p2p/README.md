# @interego/p2p

Nostr-style relay-mediated p2p federation transport. Dual ECDSA + Schnorr signing; in-memory / file-backed / WebSocket-mirror relays.

Particular composition over the `@interego/core` substrate — see
`docs/ARCHITECTURAL-FOUNDATIONS.md §12` for the substrate-vs-vertical
split that motivates this package boundary.
