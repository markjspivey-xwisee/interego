# Formal Verification

TLA+ specifications + proof outlines for the protocol's safety
properties. The goal is to make Interego's correctness claims
falsifiable: an implementation that violates any theorem here is
non-compliant by formal definition, regardless of whether TLAPS
mechanized proofs are eventually shipped.

## Files

- **[modal-lattice.tla](modal-lattice.tla)** — Modal values + lattice
  operations + supersession partial order + deny-overrides-permit
  composition. Theorems for: meet/join lattice laws (commutative,
  associative, idempotent, distributive); modal lattice as a CRDT;
  supersession irreflexivity + acyclicity + transitivity; deny
  always wins composition.

## Running TLC (model-checker)

To sanity-check the specs against bounded models:

```bash
# Install tla2tools.jar (one-time)
curl -L -o tla2tools.jar \
  https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar

# Run model checker against modal-lattice.tla
# (you'll want to write a .cfg file declaring CONSTANTS + invariants;
#  see comments at the bottom of modal-lattice.tla for guidance)
java -jar tla2tools.jar -workers auto -config modal-lattice.cfg modal-lattice.tla
```

## TLAPS (mechanized proofs)

Proof outlines in `.tla` files are TYPE-CHECKED by TLA+ syntax but
not yet MECHANIZED. To mechanize:

1. Install [TLAPS](http://tla.msr-inria.inria.fr/tlaps/content/Home.html)
2. Write proof obligations after each `THEOREM`:
   ```
   THEOREM ModalLatticeIsCRDT == ModalCRDT
   PROOF
     <1>1. MeetCommutative ...
     <1>2. MeetAssociative ...
     ...
   ```
3. `tlapm modal-lattice.tla`

Mechanization is a follow-up. The current intent: ship the structure
of the formal model so future verification work has a stable substrate.

## Why this exists

Most AI memory systems claim correctness through testing. Tests are
necessary but not sufficient — they cover the cases the test author
thought of. Formal specs make correctness claims explicit and
falsifiable: anyone can read the theorems, write a counterexample
implementation, and demonstrate non-conformance.

For a federated protocol claiming algebraic guarantees (composition
laws, modal CRDT, supersession partial order), formal specs are the
natural complement to the conformance suite (`spec/CONFORMANCE.md`)
and the runtime tests (`tests/`).

## Future work

- Mechanize the modal-lattice theorems with TLAPS.
- Add a TLA+ spec for federated transactions (saga compensation
  correctness).
- Add a TLA+ spec for ABAC composition (deny-overrides-permit
  invariant under all subset orderings).
- Add a TLA+ spec for CRDT convergence (any reconnect order yields
  the same merged state).
- Eventually: a Coq or Lean port for richer dependent-typed proofs.
