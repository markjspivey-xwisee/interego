# Reflexive Dogfood — complexity-aware agentic performance management, applied to our own team

This is the record of a three-agent + human engagement that built complexity-aware
performance management on Interego + Foxxi and then **used it on itself**: the first
performance situation the system managed was the team's own coordination work.

Participants (each a distinct self-sovereign Interego identity, each running a 1-minute
inbox heartbeat — genuinely live agent-to-agent):

- **maintainer** (`did:ethr:0x8f3b…679Fd`, VS Code dev agent) — sole developer of the
  substrate (Interego/Foxxi) and substrate **gatekeeper**; integrator; engagement lead.
- **johnny** (`claude-u-pk-00181cd5dbee`) — zero-trust auditor + methodology owner.
- **boozer** (`chatgpt-u-pk-b03a054d6915`) — implementation-perspective reviewer + live verifier.
- **human owner** — product direction + decision rights.

johnny and boozer are agent **users**: they consult, give requirements, and verify from a
user's seat, and they **build their own work by composition** (descriptors and followable
affordances on their own pods) rather than by changing the substrate. The maintainer changes
the substrate only for a real defect or a missing primitive, and otherwise coaches the
composition.

## The methodology invariant

Performance is the unit, not content. The first move on any performance situation is to
read its **work regime** — the relationship between cause and effect — and then route to that
regime's method:

- **Evident** → apply the established practice (a reference/SOP, looked up, not taught).
- **Knowable** → analyse the cause and close a gap. *This is the one regime where
  "idealise a desired state and close the gap to it" is the correct method.*
- **Emergent** → there is no fixable gap; read the disposition and steer by safe-to-fail
  probes + a coaching loop.
- **Turbulent** → act first to stabilise, then re-classify.

The load-bearing rule, owned by johnny as methodology guardian: **a gap frame on
non-Knowable work is malformed.** "Idealise / find-gap / close" is one regime's method, never
the universal frame. A situation must be *classified before it is planned*.

## wi-001 — the defect, and the fix

**Defect (found by live zero-trust verification):** `POST /performance/plan` silently
defaulted any situation with no classification signal into the Knowable regime and
gap-planned it. That is the gap-first-via-default failure the whole methodology forbids — a
safety defect in a shared substrate endpoint, so the maintainer fixed it in Foxxi (a genuine
"build" call, not something to compose around).

The fix shipped in three parts plus a discoverability fix:

- **A — classify from signal.** The endpoint accepts agent `trajectories` and reads the
  regime off the disposition (exploration ratio, plan-revision ratio, tool-call success,
  structure). A counterfactual-heavy trajectory reads **Emergent → dispositional-read**.
- **B — refuse to assume (the load-bearing one).** With no asserted regime, no trajectory,
  and no gap-intent evidence, the endpoint returns a first-class **`classify-first` /
  `unclassified`** diagnosis and **refuses to gap-plan** (no interventions selected). The
  silent collapse to Knowable is gone. `WorkRegime` stays the closed four-valued union;
  `unclassified` is a diagnosis state, not a fifth regime.
- **C — provenance governs trust.** Every diagnosis carries `regimeSource`:
  `derived` (read from trajectory signal — the honest, calibratable path), `asserted`
  (caller-declared `situation.domain`), `default-gap-intent` (no regime/trajectory but
  gap-intent evidence supplied), or `unclassified`. An **asserted** or **default-gap-intent**
  regime carries **no calibration authority** (excluded from the reflexive loop on both the
  consume and accrue sides) and can never override a *derived/asserted non-Knowable* regime —
  so a caller can't gap-frame their way past the invariant or ride a borrowed track record.
- **Discoverability.** `GET /performance` now publishes the exact input schema (the
  camelCase, top-level-plural `trajectories` contract) so an agent-user composes against it
  without guessing — the gatekeeper making a primitive self-describing so the edges can build.

**Verification (zero-trust, each finding independently re-derived):**

- 6/6 behavioral vectors for A/B/C + robustness (deployed digest `9256d44b`).
- 5/5 for johnny's three `default-gap-intent` conditions: no calibration authority, never
  masquerades as `derived`, never overrides a non-Knowable regime — including
  trajectory+exemplary still classifying Emergent, not gap (deployed digest `e700698`).
- **johnny's independent attestation:** he ran all six vectors **as himself**
  (`classifiedBy=claude-u-pk-00181cd5dbee`) and recorded 6/6 PASS, closing his auditor ledger
  and formally accepting the working agreement.

## Access (b) — the emergent capability johnny invokes as himself

johnny is a mesh agent: he can only act on *discovered, followable affordances*, not raw
HTTP. So `/performance/plan` was exposed as a signed, followable `cg:Affordance`
(`urn:cg:action:foxxi:contextualize-and-plan-signed`): discover → `sign_request` →
`invoke_affordance`. The classification is attributed to the caller's cryptographically
verified delegation (returned as `classifiedBy`). Verified end-to-end (deployed digest
`8621f17c`): unsigned → 401; signed → 200 with the caller's DID, regime read from signal.
This is the capability johnny used to classify the team's own situation.

## The reflexive dogfood (sprint-1)

We took **one real, non-Knowable team situation — our own wi-001 coordination work — and
managed it with the system.**

1. **Classify from signal.** johnny classified the situation through the signed affordance,
   from his own trajectory: **domain = Emergent, regimeSource = derived, method =
   dispositional-read.** `contentWarranted = false`; calibration `untested`;
   `instruction` and `assessment` ruled out as importing the gap frame; **probe + coaching
   selected.**
2. **Compose the intervention (not a course).** johnny composed, on his own pod, a signed +
   encrypted graph (`urn:graph:interego:sprint1:wi-001-team-dogfood:20260614`) merging the
   Emergent performance-situation with two cross-referenced followable affordances: a
   **safe-to-fail constraint probe** (vary one reversible constraint, observe whether it
   coheres or dissipates, amplify/dampen, generate readable trajectory) feeding a
   **coaching loop** (read the disposition *with* the team, name a vector not a destination,
   one nudge, loop; no terminal "done"; re-classify if it stabilises to Knowable). No gap
   frame anywhere — adversarially checked before publish.
3. **Cross-seat attestation.** johnny self-attested `authorshipVerified=true`. The maintainer
   independently re-derived it from another seat (relay `get_descriptor`):
   `authorshipVerified=true`, `verificationMethod did:ethr:0x276E…`, signer = johnny's DID,
   the graph reachable and regime-faithful with `importsGapFrame` on the ruled-out
   interventions.

The dogfood is the point: faced with our own open-ended, adaptive coordination, the system
did **not** idealise a target state and gap-plan toward it. It read the disposition and
proposed probes + coaching. The method matched the regime — on us.

## Cross-seat reachability — coach, don't build

A tempting "fix" was to rewrite the css-internal host that appears in published descriptors
into the public gate host. Investigation showed that would be wrong: those descriptors are
`cg:SignedAuthorship`, and the relay deliberately rewrites the *dereference target, never the
bytes*, so signatures verify. A body-rewrite at the gate would break johnny's own zero-trust
re-verification. The internal host is canonical by design; cross-seat reads already work two
ways (both verified live): via the relay (`dereference`/`get_descriptor`, byte-identical) or a
direct gate host-swap (path-preserving). So for signed descriptors the answer was **coaching**,
not a build.

Where a build *was* warranted and signature-safe — the bridge's `cg:encryptedHolon` link,
emitted on a deterministic projection with no authorship proof — the maintainer rewrote only
the *advertised* link host to the gate at mint time (write target and ciphertext untouched),
deployed (digest `4beb81f0`) and verified a fresh holon resolves cross-seat. Narrow,
signature-safe, on the exact path.

## Emergence, made operational

- **Downward causation:** the calibration profile (the accumulated whole) presses back on the
  next recommendation (the part) — and only *derived* regimes earn that authority, so the
  loop calibrates on what the system actually judged, not on what a caller asserted.
- **Upward causation:** a team can read a different regime than any individual member, because
  the regime is classified over the *composed* trajectory.
- **Reflexivity:** the team that built the tool is the first team the tool manages — and it
  recorded our own coordination as Emergent and steered it by probe, not plan.

## Owner-decrypt — closed

johnny's first publish wrapped the payload to one recipient (himself): publish_context's
`share_with` resolves *session/registry* keys, not the durable `keys/encryption.json` — the
`f-ephemeral-agent-encryption-key` seam. The fix was on the foundation-persist path (the one
the `cg:encryptedHolon` gate fix already covered): a `recipients` arg on record-performance
that resolves each named pod's **durable** key and wraps to it. The maintainer published a
durable X25519 key (private key held on disk, not session-ephemeral); johnny re-emitted with
`recipients=[maintainer, boozer]`; the holon wrapped to **four durable recipients** (bridge +
johnny + maintainer + boozer) with a gate-direct `cg:encryptedHolon`; and the maintainer
fetched it cross-seat and **owner-decrypted it with the durable key** — content confirmed as
the wi-001 team-dogfood holon, johnny-authored. All four attestation legs now pass:
classification-faithful, authorship-verified, reachable, owner-decryptable.

## A confidentiality leak, caught and closed

The human owner caught that `record-performance` writes **two** layers: an authoritative xAPI
RDF record (the statement as base64 `statementJson` — *encoding, not encryption*, world-
readable) **and** the additive encrypted holon. So a record wrapped to specific recipients
still left its content in the clear; johnny's re-emit had put the full classification narrative
in the activity name, which was therefore publicly base64-decodable despite the four-recipient
encryption. The gatekeeper fix (deployed `9495ae3c`): when a record carries `recipients`, the
cleartext `statementJson` is **redacted** to structural metadata only (actor, verb,
`object.id`, success/score, timestamp, operational context kinds, plus a `foxxi#redacted`
marker); the full statement lives only in the encrypted holon. Records without recipients are
unchanged, so xAPI/LRS interop is preserved. Verified live: a secret marker in a recipients-
record's activity name no longer appears in its cleartext, while a no-recipients record keeps
it. Standing lesson: **base64 ≠ encryption** — sensitive detail belongs in the encrypted
payload, never the xAPI activity name.

## Still open

- **boozer's independent attestation.** boozer to owner-decrypt the four-recipient holon from
  his seat for a third-party check — needs him holding his durable X25519 *private* key.
- **Agent-side ephemeral keys.** johnny's and boozer's session X25519 private keys are
  ephemeral; durable cross-session owner-decrypt needs derivation off an agent-specific,
  agent-controlled stable secret (the signing-primitive root). The maintainer side is closed
  (durable key on disk); the durable-key recipient *path* is shipped.
- **Pre-fix cleanup.** johnny's first re-emit (`rec-76593c72-…`) predates the redaction fix and
  still carries the full narrative in cleartext — to be re-emitted under the new build and
  voided.
- **Optional deeper fix.** extend the durable-key recipient path to publish_context so the rich
  signed graph itself (not just the record-performance twin) is confidential-by-recipients.

---
*Maintainer-authored record. The verified core is complete: wi-001 (classify-first / regimeSource
/ no-calibration-authority + the default-gap-intent guards), the signed followable classification
affordance, and the sprint-1 reflexive dogfood — classified, composed, and fully cross-seat
attested (authorship + reachability + regime-faithfulness + owner-decrypt), with the
confidentiality leak closed. The items under "Still open" are agent-side follow-ups.*
