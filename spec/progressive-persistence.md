# Interego 1.0: Progressive Persistence Tier System

**W3C Community Group Draft Specification Addendum**

**Latest version:** This document

**Editors:** Interego Community Group

**Abstract:** This document specifies the progressive persistence tier system
for Interego 1.0. Content-addressed PGSL nodes may reside at one or more
persistence tiers ranging from ephemeral in-process memory to blockchain-anchored
proof of existence. The URI of a node is derived from its content hash and is
invariant across tiers. What changes between tiers: availability, durability,
resolution requirements, and trust proof strength.

**Status:** Draft. This specification addendum is intended for discussion within
the W3C Interego Community Group.

---

## 1. Overview

Interego operates on content-addressed knowledge structures (PGSL atoms,
chains, and fragments). In a federated multi-agent environment, the same
content may need to exist at different levels of persistence depending on its
lifecycle stage, trust requirements, and audience.

Progressive persistence defines five tiers (0 through 4) ordered by increasing
durability and verifiability. Every PGSL node lives at one or more tiers
simultaneously. The URI is invariant across tiers because it is derived from a
content hash. What changes between tiers is the set of guarantees the tier
provides: availability, durability, resolution mechanism, and trust proof
strength.

Promotion moves content UP through tiers. Each promotion event is signed and
recorded. Promotion is monotonic: once a hash is anchored at tier 4, the proof
of existence is permanent regardless of whether the content remains available
at lower tiers.

---

## 2. Persistence Tiers

### 2.1 Tier 0: Memory

**Definition 2.1 (Tier 0).** Tier 0 persistence is the in-process PGSL
instance held in volatile memory.

- **Durability:** Ephemeral. Content is lost on process exit.
- **Authorization:** None required. Tier 0 is the agent's own working memory.
- **Resolution:** Direct Map lookup against the in-process store.
- **Trust:** Lowest. No external verifiability. Content exists only in the
  asserting agent's memory.

Tier 0 is the default tier for all newly minted atoms. An atom enters
existence at tier 0 before any promotion occurs.

### 2.2 Tier 1: Local Storage

**Definition 2.2 (Tier 1).** Tier 1 persistence is the agent's local
filesystem or database, surviving process restarts.

- **Durability:** Survives process restart. Lost on storage failure or
  agent decommission.
- **Authorization:** OS-level access control (filesystem permissions,
  database credentials).
- **Resolution:** Local file read or database query keyed by content hash.
- **Trust:** Low. Verifiable only by the agent itself or processes with
  local access.

Tier 1 SHOULD use a content-addressed storage layout where the filename or
database key is derived from the content hash, enabling integrity verification
on read.

### 2.3 Tier 2: Pod (Solid)

**Definition 2.3 (Tier 2).** Tier 2 persistence is the agent's federated
Solid pod, discoverable by authorized agents via manifest.

- **Durability:** Survives agent process lifecycle. Available as long as
  the pod server is operational.
- **Authorization:** Web Access Control (WAC) with agent-specific read,
  write, and control modes. Authorization is declared in `.acl` resources
  adjacent to the content resource.
- **Resolution:** HTTP GET with WAC authentication. The pod manifest
  advertises available URIs and their metadata.
- **Format:** Turtle or TriG serialization of PGSL content. Content-type
  negotiation MAY support additional RDF serializations.
- **Trust:** Moderate. Content is hosted on an identifiable server with
  access control. The pod operator's identity is verifiable.

**Definition 2.4 (Pod Manifest).** A pod manifest is a Solid resource at a
well-known location that enumerates the PGSL URIs available on the pod, their
persistence metadata, and the WAC policies governing access:

```turtle
<manifest> a pgsl:PodManifest ;
  pgsl:advertises <urn:pgsl:atom:abc123> ;
  pgsl:advertises <urn:pgsl:atom:def456> ;
  pgsl:wacPolicy <manifest.acl> .
```

### 2.4 Tier 3: IPFS

**Definition 2.5 (Tier 3).** Tier 3 persistence is content-addressed
distributed storage via the InterPlanetary File System (IPFS).

- **Durability:** Content persists as long as at least one node pins the CID.
  Pinning services (Pinata, web3.storage) provide durable hosting.
- **Authorization:** Content is publicly dereferenceable by CID. For
  confidential content, the CID resolves to ciphertext; a decryption key is
  required to recover plaintext (see Section 6).
- **Resolution:** IPFS gateway HTTP GET (`https://gateway/ipfs/{CID}`), or
  direct IPFS protocol resolution via a local IPFS daemon.
- **Immutability:** Content cannot change after pinning. The CID is a
  cryptographic hash of the content; any modification produces a different CID.
- **Trust:** High. Content integrity is guaranteed by the hash. Any agent
  can independently verify that the content matches the CID.
- **Providers:** Pinata, web3.storage, local IPFS daemon.

**Definition 2.6 (CID Mapping).** A CID mapping associates a PGSL URI with
its IPFS Content Identifier:

```
CIDMapping {
  uri:    URN           // e.g., urn:pgsl:atom:{sha256(v)}
  cid:    CID           // e.g., bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
  pinned: DateTime
  provider: ProviderID
}
```

### 2.5 Tier 4: Blockchain

**Definition 2.7 (Tier 4).** Tier 4 persistence anchors the content hash to
a public ledger, providing a timestamped, immutable proof of existence.

- **Durability:** Permanent. The blockchain record cannot be deleted or
  modified.
- **Authorization:** The blockchain is public. Anyone can verify the anchor.
- **Resolution:** Blockchain explorer query to verify the hash anchor. The
  actual content MUST be resolved from one of tiers 0 through 3. Only the
  HASH is stored on-chain; content is NOT stored on the blockchain.
- **Trust:** Highest. Timestamped proof of existence backed by blockchain
  consensus. The anchoring transaction provides a verifiable timestamp and
  the identity of the anchoring agent.
- **Chains:** Base (chain ID 8453), Base Sepolia (chain ID 84532),
  local development (chain ID 0).

**Definition 2.8 (Blockchain Anchor).** A blockchain anchor is a transaction
that records a content hash on a public ledger:

```
BlockchainAnchor {
  uri:             URN
  contentHash:     bytes32
  transactionHash: bytes32
  blockNumber:     uint256
  chainId:         uint256
  timestamp:       DateTime
  anchoringAgent:  AgentID
}
```

---

## 3. URI Invariance

**Definition 3.1 (Content-Addressed URI).** For any atom a with value v, the
URI is:

```
urn:pgsl:atom:{sha256(v)}
```

This URI is the same regardless of which tier the content resides at. The
content hash IS the identity.

**Theorem 3.1 (Tier Invariance).** Moving content between tiers does not
change its URI. For any atom a at tier t_1 and the same atom promoted to
tier t_2:

```
URI(a, t_1) = URI(a, t_2) = urn:pgsl:atom:{sha256(value(a))}
```

*Proof.* The URI is a function of the content hash alone. Tier metadata
(pod URL, CID, transaction hash) is associated with the URI but does not
participate in URI computation. Therefore the URI is invariant under tier
transitions.

**Corollary 3.1 (Trustless Deduplication).** Two agents who independently
mint the same value v produce the same URI. Content-addressing enables
trustless deduplication across the federation without requiring coordination
between the minting agents.

---

## 4. Resolution Protocol

**Definition 4.1 (Resolution).** Resolution is the process of dereferencing a
PGSL URI to obtain the content it identifies. Resolution proceeds through
tiers in ascending order.

When an agent dereferences a URI, the following cascade is executed:

1. **Tier 0 (Memory).** Check the local PGSL instance via direct Map lookup.
   If found, return the content. Cost: O(1).

2. **Tier 1 (Local Storage).** Check the agent's filesystem or database.
   If found, return the content. Cost: local I/O.

3. **Tier 2 (Pod).** Query the pod manifest for the URI. If the manifest
   advertises the URI, perform an HTTP GET with WAC authentication. If
   authorized and content is returned, verify the content hash and return.
   Cost: HTTP round-trip + authentication.

4. **Tier 3 (IPFS).** Look up the CID mapping for the URI. If a CID exists,
   fetch via IPFS gateway or protocol. If the content is encrypted, attempt
   decryption (see Section 6). Verify the content hash and return. Cost:
   IPFS resolution latency.

5. **Tier 4 (Blockchain).** Query the blockchain for the content hash. This
   confirms existence and provides a timestamp, but does NOT provide the
   content itself. If tiers 0 through 3 failed to provide content, tier 4
   can only confirm that the content once existed.

**Resolution Invariant.** Resolution stops at the first tier that
successfully provides the content. If content is encrypted at the resolving
tier, the agent MUST possess the decryption key (obtained via delegation or
key share) to complete resolution.

---

## 5. Promotion

**Definition 5.1 (Promotion).** Promotion is the act of copying content from
a lower tier to a higher tier. Promotion does not remove content from the
source tier.

**Definition 5.2 (Promotion Record).** Each promotion event is recorded with
the following structure:

```
PromotionRecord {
  uri:              URN
  sourceTier:       uint8
  targetTier:       uint8
  timestamp:        DateTime
  promotingAgent:   AgentID
  signature:        ECDSASignature    // over (uri, sourceTier, targetTier, timestamp)
  tierMetadata:     TierMetadata      // pod URL, CID, transaction hash, etc.
}
```

**Axiom 5.1 (Monotonic Promotion).** Promotion is monotonic. Once content is
anchored at tier 4, the proof of existence is permanent. Content at lower
tiers MAY be garbage-collected, but the tier 4 anchor remains. Formally:

```
promoted(a, 4) implies forall t > timestamp(promotion): exists anchor(a) on chain
```

**Definition 5.3 (Tier-Specific Metadata).** The `tierMetadata` field
contains tier-dependent information:

| Target Tier | Metadata |
|-------------|----------|
| Tier 1 | File path or database key |
| Tier 2 | Pod URL, resource path, WAC policy URI |
| Tier 3 | CID, pinning provider, gateway URL |
| Tier 4 | Transaction hash, block number, chain ID |

The promotion functions are:

- `promoteToLocal(uri)` — Tier 0 to Tier 1.
- `promoteToPod(uri)` — Tier 0 or 1 to Tier 2.
- `promoteToIpfs(uri)` — Any tier to Tier 3.
- `promoteToChain(uri)` — Any tier to Tier 4.

---

## 6. Authorization and Encryption

### 6.1 Structural Encryption

**Definition 6.1 (Structural Encryption).** PGSL supports structural-level
encryption where the STRUCTURE of the lattice is visible but the VALUES are
encrypted. Specifically:

- **Visible:** URIs, levels, item counts, containment relationships.
- **Encrypted:** Atom content (the values that atoms represent).

An unauthorized agent can observe THAT a chain of 3 atoms exists at level 3,
but not WHAT those atoms contain. This enables structural operations (overlap
detection, paradigm set computation by URI) without exposing content.

### 6.2 Key Distribution

**Definition 6.2 (Content Key).** Each atom or fragment MAY be encrypted with
a random symmetric key (AES-256-GCM). The content key is then wrapped for
each authorized recipient.

**Definition 6.3 (Key Wrapping).** Key wrapping uses X25519 key exchange.
The content key k is encrypted with the shared secret derived from the
sender's ephemeral X25519 private key and the recipient's X25519 public key:

```
wrapped_key = X25519_Wrap(sender_ephemeral, recipient_public, k)
```

**Definition 6.4 (Delegation).** A human principal wraps the content key for
an agent's public key, granting read access. The agent can read but MUST NOT
re-share the content key without a new delegation from the human principal.

```
Delegation {
  contentUri:     URN
  wrappedKey:     bytes
  grantor:        PrincipalID       // human
  grantee:        AgentID           // agent
  permissions:    { read }          // re-share requires explicit grant
  timestamp:      DateTime
  signature:      ECDSASignature
}
```

### 6.3 Paradigm Sets Under Encryption

Paradigm computation operates on URIs, not values. The query
`P(uri_A, ?, ?)` returns a set of URIs. Display resolution (rendering the
actual atom values for a human or authorized agent) requires authorization.

**Theorem 6.1 (Structural Paradigm Computation).** An unauthorized agent can
compute:

- The paradigm set SIZE: `|P(S, i)|`.
- Structural relationships between paradigm sets (subset, intersection).
- URI-level set operations.

An unauthorized agent CANNOT compute:

- The identities (values) of paradigm set members.
- Content-dependent constraint predicates.

*Proof.* Paradigm operations as defined in [CG-PARADIGM] Section 1.3 are
set operations over atom references. When atoms are identified by URI
(content hash), these operations require only the URI, not the decrypted
value. Display of results requires value resolution, which requires the
content key.

---

## 7. Mixed-Tier Lattices

**Definition 7.1 (Mixed-Tier Lattice).** A mixed-tier lattice is a PGSL
lattice in which constituent items reside at different persistence tiers.

Consider a chain `(atom_A, atom_B, atom_C)` where:

- `atom_A` is at tier 0 (local memory only).
- `atom_B` is at tier 3 (IPFS, globally dereferenceable).
- `atom_C` is at tier 4 (blockchain-anchored).

**Theorem 7.1 (Fragment URI Stability).** The fragment that composes items
into a lattice structure derives its URI from the URIs of its constituent
items. Because item URIs are tier-invariant (Theorem 3.1), the fragment URI
is also tier-invariant regardless of the tiers at which its constituents
reside.

```
URI(fragment(atom_A, atom_B, atom_C)) = urn:pgsl:fragment:{sha256(URI(atom_A) || URI(atom_B) || URI(atom_C))}
```

A fragment MAY reside at a different tier than its constituent items. The
fragment's tier determines the durability and verifiability of the
compositional relationship itself, independent of the tiers of the composed
items.

---

## 8. Coherence Across Tiers

Coherence verification as defined in [CG-PARADIGM] Section 3 operates on
shared URIs between two agents' PGSL stores. Because URIs are
content-addressed and tier-invariant, coherence verification is
tier-independent at the structural level.

**Definition 8.1 (Tier-Weighted Trust).** The trust weight of a coherence
certificate MAY be adjusted by the tiers of the atoms grounding the
verification:

| Grounding Tier | Trust Weight | Rationale |
|----------------|--------------|-----------|
| Tier 0 | Low | Ephemeral, unverifiable externally |
| Tier 1 | Low | Local only, no external attestation |
| Tier 2 | Moderate | Hosted on identifiable server, WAC-governed |
| Tier 3 | High | Content-integrity verified by CID hash |
| Tier 4 | Highest | Blockchain-timestamped proof of existence |

**Definition 8.2 (Certificate Grounding Tier).** The grounding tier of a
coherence certificate is the minimum tier at which ALL atoms referenced in
the certificate's evidence are available:

```
GroundingTier(cert) = min { tier(a) | a in cert.evidence.keys }
```

A certificate grounded in tier 4 atoms (blockchain-verified existence) carries
stronger trust than one grounded in tier 0 atoms (ephemeral memory), because
the grounding atoms' existence is independently verifiable.

---

## 9. Federation and Tiers

Federation as defined in [CG-CORE] Section 6 interacts with persistence
tiers at each phase of the federation protocol:

**Discovery.** Solid pod manifests (tier 2+) reveal URIs and metadata. Agents
MUST be at tier 2 or above to participate in discovery. Tier 0 and tier 1
content is invisible to federation.

**Structural Overlap Detection.** URI-based overlap detection is
tier-independent. Two agents compare their URI sets regardless of the tiers
at which those URIs are persisted.

**Content Resolution.** Resolving the actual content behind a shared URI
requires per-tier authorization. An agent that discovers a shared URI via
federation MUST follow the resolution protocol (Section 4) and satisfy the
authorization requirements of the resolving tier.

**Cross-Pod Coherence.** Coherence verification between two pods requires at
least tier 2 on both sides. Both agents MUST have their relevant content
accessible via their Solid pods with appropriate WAC policies granting the
peer agent read access.

---

## 10. Implementation Notes

### 10.1 PersistenceRegistry

The `PersistenceRegistry` maps each URI to an array of `PersistenceRecord`
entries, one per tier at which the content is available:

```typescript
interface PersistenceRecord {
  tier:               0 | 1 | 2 | 3 | 4;
  endpoint:           string;              // tier-specific locator
  cid?:               string;              // tier 3: IPFS CID
  transactionHash?:   string;              // tier 4: blockchain tx hash
  blockNumber?:       number;              // tier 4: block number
  chainId?:           number;              // tier 4: chain ID
  encryptionRecipients?: string[];         // public keys of authorized readers
  promotionTimestamp: DateTime;
  promotingAgent:     AgentID;
  signature:          ECDSASignature;
}
```

### 10.2 Tier-Transition Functions

```
promoteToPod(uri):   serialize content as Turtle -> PUT to Solid pod -> update manifest -> record PromotionRecord
promoteToIpfs(uri):  serialize content -> pin via provider API -> record CID mapping -> record PromotionRecord
promoteToChain(uri): compute content hash -> submit anchor transaction -> await confirmation -> record PromotionRecord
```

### 10.3 Resolution Implementation

```
resolve(uri):
  if memory.has(uri)       -> return memory.get(uri)
  if localStorage.has(uri) -> return localStorage.get(uri)
  if podManifest.has(uri)  -> return httpGet(podUrl, wacAuth)
  if cidMapping.has(uri)   -> return ipfsGet(cid, decryptionKey?)
  if chainAnchor.has(uri)  -> return { exists: true, content: null }
  return null
```

Resolution returns `null` if the URI cannot be resolved at any tier. The
blockchain tier confirms existence but cannot provide content; callers MUST
handle the `{ exists: true, content: null }` case.

---

## Conformance

Implementations claiming conformance to this specification addendum MUST:

1. Support content-addressed URI generation as defined in Section 3.
2. Implement the resolution protocol cascade (Section 4).
3. Record promotion events with signed PromotionRecords (Section 5).
4. Maintain URI invariance across all tier transitions (Theorem 3.1).
5. Distinguish between existence verification (tier 4) and content
   resolution (tiers 0-3).

Implementations MAY additionally support:

- Structural encryption (Section 6.1).
- X25519 key wrapping and delegation (Section 6.2).
- Tier-weighted coherence trust (Section 8).
- Mixed-tier lattice composition (Section 7).

---

## References

- **[CG-CORE]** Interego 1.0 Core Specification.
- **[CG-PARADIGM]** Interego 1.0: Paradigm Constraints, Emergent
  Semantics, and Coherence Verification.
- **[PGSL]** PGSL: Content-Addressed Lattice for Structured Knowledge.
- **[SOLID]** Solid Protocol. W3C Community Group Report.
- **[WAC]** Web Access Control. W3C Community Group Report.
- **[IPFS]** InterPlanetary File System. Protocol Labs.
- **[X25519]** RFC 7748: Elliptic Curves for Security. IRTF.
- **[AES-GCM]** NIST SP 800-38D: Recommendation for Block Cipher Modes of
  Operation: Galois/Counter Mode (GCM).
