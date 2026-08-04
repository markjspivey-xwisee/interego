-------------------------- MODULE ModalLattice --------------------------
(***************************************************************************)
(* TLA+ specification of the modal lattice and supersession semantics      *)
(* underlying Interego's `iep:SemioticFacet` reasoning. (`cg:` was the      *)
(* pre-rename prefix; `iep:` is current.)                                  *)
(*                                                                         *)
(* ★ WHAT HAS AND HAS NOT BEEN RUN OVER THIS FILE — read this first.       *)
(*                                                                         *)
(* NO TLA+ TOOL HAS EVER PARSED IT. Not SANY, not TLC, not TLAPS. The      *)
(* status block at the bottom used to say the theorems were "TYPE CHECKED  *)
(* by TLA+ syntax"; that was false, and two defects survived behind it —   *)
(* a transitive closure with no witness constraint, which made THEOREM     *)
(* SupersessionPartialOrder assert something this module's own definitions *)
(* refute, and a LET-recursive operator with no RECURSIVE declaration, so  *)
(* the module would not have parsed at all. Both are corrected above BY    *)
(* INSPECTION, and the corrections are themselves unparsed.                *)
(*                                                                         *)
(* What IS machine-checked, on every `npx vitest run`, is the MATHEMATICS. *)
(* `tests/modal-lattice-spec.test.ts` evaluates every theorem named below  *)
(* exhaustively: the lattice laws against `ModalAlgebra` in                *)
(* @interego/core — the implementation this spec exists to constrain —     *)
(* and the supersession properties over bounded Descriptors. That test     *)
(* also FAILS IF A THEOREM IS ADDED HERE WITH NOTHING EXECUTING IT, so     *)
(* this file can no longer grow a claim that nothing checks. It is not a   *)
(* substitute for TLC; it is the part of TLC's job that can be done        *)
(* without one, made unskippable.                                          *)
(*                                                                         *)
(* This is a PROOF OUTLINE — the structure of the formal model is          *)
(* complete; the mechanized proofs (TLAPS / TLC model-checking config)     *)
(* are a follow-up. The intent of shipping this file now is two-fold:      *)
(*                                                                         *)
(*   1. Establish the formal vocabulary so future proofs can be written    *)
(*      against a stable substrate.                                        *)
(*   2. Make the safety properties explicit so any implementation can      *)
(*      cross-reference its own behavior against them.                     *)
(*                                                                         *)
(* What's modeled:                                                         *)
(*   - Modal values: Asserted, Hypothetical, Counterfactual                *)
(*   - The modal lattice + its operations (meet, join, not, implies)       *)
(*   - cg:supersedes as a partial order on descriptors                     *)
(*   - The "deny-overrides-permit" composition rule                        *)
(*                                                                         *)
(* Properties asserted (proofs deferred):                                  *)
(*   - meet, join are commutative, associative, idempotent (CRDT laws)     *)
(*   - meet distributes over join (lattice laws)                           *)
(*   - cg:supersedes is irreflexive + transitive + acyclic                 *)
(*   - composing N policies via meet is independent of order               *)
(*   - a Counterfactual-mode policy that matches always overrides Asserted *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets, Sequences

(***************************************************************************)
(* Modal values, ordered by "truth strength":                              *)
(*   Counterfactual < Hypothetical < Asserted                              *)
(* This is the lattice height — meet picks the lower, join picks the higher*)
(***************************************************************************)

CONSTANTS
    Counterfactual,    \* falsity, groundTruth=false
    Hypothetical,      \* undetermined
    Asserted           \* truth, groundTruth=true

ModalValues == {Counterfactual, Hypothetical, Asserted}

Rank(m) ==
    IF m = Counterfactual THEN 0
    ELSE IF m = Hypothetical THEN 1
    ELSE 2

(***************************************************************************)
(* Lattice operations                                                      *)
(***************************************************************************)

Meet(a, b) ==
    IF Rank(a) <= Rank(b) THEN a ELSE b

Join(a, b) ==
    IF Rank(a) >= Rank(b) THEN a ELSE b

Not(m) ==
    IF m = Asserted THEN Counterfactual
    ELSE IF m = Counterfactual THEN Asserted
    ELSE Hypothetical

(***************************************************************************)
(* Lattice laws (to prove via TLAPS)                                       *)
(***************************************************************************)

MeetCommutative ==
    \A a, b \in ModalValues : Meet(a, b) = Meet(b, a)

MeetAssociative ==
    \A a, b, c \in ModalValues : Meet(Meet(a, b), c) = Meet(a, Meet(b, c))

MeetIdempotent ==
    \A a \in ModalValues : Meet(a, a) = a

JoinCommutative ==
    \A a, b \in ModalValues : Join(a, b) = Join(b, a)

JoinAssociative ==
    \A a, b, c \in ModalValues : Join(Join(a, b), c) = Join(a, Join(b, c))

JoinIdempotent ==
    \A a \in ModalValues : Join(a, a) = a

\* Meet/Join distribute over each other (full lattice laws).
MeetDistributesOverJoin ==
    \A a, b, c \in ModalValues :
        Meet(a, Join(b, c)) = Join(Meet(a, b), Meet(a, c))

JoinDistributesOverMeet ==
    \A a, b, c \in ModalValues :
        Join(a, Meet(b, c)) = Meet(Join(a, b), Join(a, c))

\* Double negation. Note: Not(Hypothetical) = Hypothetical, so this is
\* intuitionistic, not classical. Double negation only equals identity for
\* Asserted and Counterfactual.
DoubleNegationOnTwoValued ==
    \A a \in {Asserted, Counterfactual} : Not(Not(a)) = a

(***************************************************************************)
(* CRDT property: composing N modal values via Meet is independent of      *)
(* order. Together with associativity + idempotence + commutativity, this  *)
(* is what makes the modal lattice a Conflict-free Replicated Data Type    *)
(* by construction (referenced in spec/CRDT-OFFLINE-MERGE.md).             *)
(***************************************************************************)

ModalCRDT ==
    /\ MeetCommutative
    /\ MeetAssociative
    /\ MeetIdempotent

(***************************************************************************)
(* cg:supersedes — partial order on descriptors                            *)
(***************************************************************************)

CONSTANTS
    Descriptors        \* abstract finite set of descriptor IRIs

VARIABLES
    supersedes         \* relation : Descriptors \X Descriptors
                       \* a -> b means a supersedes b

\* Supersession is irreflexive (a doesn't supersede itself) +
\* transitive (a > b, b > c implies a > c) + acyclic (no cycles
\* through transitive closure).

SupersedesIrreflexive ==
    \A d \in Descriptors : <<d, d>> \notin supersedes

\* Transitive closure (computed as a fixed point).
\*
\* ★ THIS DEFINITION WAS WRONG, AND WRONG IN THE DIRECTION THAT MAKES A THEOREM FALSE.
\* It read:
\*
\*     { <<a, c>> : a \in Descriptors, c \in Descriptors, b \in Descriptors }
\*
\* — a set constructor over three bound variables with NO constraint relating any of them
\* to R. `b` was bound and never used, which is the tell: the witness was declared and the
\* condition it was meant to witness was never written. So Step = R \cup (Descriptors \X
\* Descriptors), the fixed point is the COMPLETE relation, and SupersedesAcyclic below —
\* "no d with <<d,d>> \in TC(supersedes)" — is false for every non-empty Descriptors,
\* including in the initial state, where supersedes = {}. THEOREM SupersessionPartialOrder
\* therefore asserted something the module's own definitions refute.
\*
\* Nothing caught it because nothing has ever run over this file. See the status block at
\* the bottom for what is and is not checked, and tests/modal-lattice-spec.test.ts, which
\* evaluates BOTH forms exhaustively over bounded Descriptors and pins that the old one
\* proves the theorem false while this one proves it true.
RECURSIVE TC(_)
TC(R) ==
    LET Step ==
        R \cup
        { <<a, c>> \in Descriptors \X Descriptors :
            \E b \in Descriptors : <<a, b>> \in R /\ <<b, c>> \in R }
    IN IF Step = R THEN R ELSE TC(Step)

SupersedesAcyclic ==
    \A d \in Descriptors : <<d, d>> \notin TC(supersedes)

SupersedesTransitive ==
    \A a, b, c \in Descriptors :
        /\ <<a, b>> \in supersedes
        /\ <<b, c>> \in supersedes
        => <<a, c>> \in TC(supersedes)

(***************************************************************************)
(* Effective modal: given a set of descriptors related by supersedes,      *)
(* the effective current modal is the modal of the "tip" descriptor —      *)
(* the one that no other in-set descriptor supersedes.                     *)
(***************************************************************************)

VARIABLES
    descriptorModal    \* function : Descriptors -> ModalValues

CurrentTips(set) ==
    { d \in set : ~\E d2 \in set : <<d2, d>> \in supersedes }

(***************************************************************************)
(* Property: the modal-meet of all tips is well-defined and independent of *)
(* the iteration order over the set. Follows from ModalCRDT.               *)
(***************************************************************************)

EffectiveModal(set) ==
    LET tips == CurrentTips(set)
    IN IF tips = {} THEN Hypothetical
       ELSE LET mods == { descriptorModal[d] : d \in tips }
            IN \* fold via Meet — well-defined by ModalCRDT
               CHOOSE m \in ModalValues :
                 \A d \in tips : Meet(m, descriptorModal[d]) = m

(***************************************************************************)
(* Deny-overrides-permit: a pivotal property for ABAC composition.         *)
(* If any policy in a set is in Deny mode (modeled as Counterfactual)      *)
(* AND its predicate matches, the composed verdict is Counterfactual.     *)
(***************************************************************************)

\* ★ `Fold` IS DECLARED RECURSIVE. It was not: the definition below called itself from
\* inside a bare LET, which TLA+ does not accept — a recursive operator must be announced
\* with RECURSIVE before its definition, in a LET exactly as at module level. So this
\* module could not be PARSED, let alone checked, which is why the status block at the
\* bottom no longer claims it was "type checked by TLA+ syntax".
DenyOverridesPermit ==
    \A modals \in SUBSET ModalValues :
        Counterfactual \in modals
        => LET RECURSIVE Fold(_)
               Fold(s) == IF s = {} THEN Asserted
                          ELSE LET m == CHOOSE x \in s : TRUE
                               IN Meet(m, Fold(s \ {m}))
           IN Fold(modals) = Counterfactual

(***************************************************************************)
(* Initial state                                                           *)
(***************************************************************************)

Init ==
    /\ supersedes = {}
    /\ descriptorModal \in [Descriptors -> ModalValues]

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

TypeOK ==
    /\ supersedes \subseteq (Descriptors \X Descriptors)
    /\ descriptorModal \in [Descriptors -> ModalValues]

SafetyInvariants ==
    /\ TypeOK
    /\ SupersedesIrreflexive
    /\ SupersedesAcyclic

(***************************************************************************)
(* Theorems (proofs deferred — TLAPS or TLC model-check config follows)    *)
(***************************************************************************)

THEOREM ModalLatticeIsCRDT == ModalCRDT

THEOREM ModalLatticeLaws ==
    /\ MeetCommutative /\ MeetAssociative /\ MeetIdempotent
    /\ JoinCommutative /\ JoinAssociative /\ JoinIdempotent
    /\ MeetDistributesOverJoin /\ JoinDistributesOverMeet

THEOREM SupersessionPartialOrder ==
    /\ SupersedesIrreflexive
    /\ SupersedesAcyclic

THEOREM DenyAlwaysWins == DenyOverridesPermit

(***************************************************************************)
(* Status: PROOF OUTLINE, NEVER PARSED.                                    *)
(* - ★ NO theorem here is "type checked by TLA+ syntax". That sentence     *)
(*   stood in this slot and was false: no TLA+ tool has ever been run on   *)
(*   this file, and two defects lived behind the claim (see the header).   *)
(*   Do not restore it without a tool run to point at — the executable     *)
(*   check in tests/modal-lattice-spec.test.ts asserts this block does not *)
(*   claim a verification that did not happen.                             *)
(* - What IS checked, on every suite run: every theorem below is evaluated *)
(*   exhaustively in tests/modal-lattice-spec.test.ts — the lattice laws   *)
(*   against the real ModalAlgebra, the supersession laws over bounded     *)
(*   Descriptors. A theorem added here with no executable counterpart      *)
(*   fails that test.                                                      *)
(* - Mechanized proofs require TLAPS setup (out of scope for v1).          *)
(* - TLC can model-check ModalCRDT + SupersessionPartialOrder against      *)
(*   bounded Descriptors (e.g., |Descriptors| = 5) for sanity.             *)
(*                                                                         *)
(* To run TLC on this spec:                                                *)
(*   1. Install TLA+ Toolbox or `tla2tools.jar`.                           *)
(*   2. Create a ModelCheck config: CONSTANTS Descriptors = {d1, d2, d3,   *)
(*                                                          d4, d5},      *)
(*      INVARIANT SafetyInvariants /\ ModalCRDT.                           *)
(*   3. Run: `java -jar tla2tools.jar -workers auto -config <cfg>          *)
(*           ModalLattice.tla`.                                            *)
(*                                                                         *)
(* The intent of this file is to make Interego's correctness CLAIMS        *)
(* falsifiable: implementations that violate any theorem above are non-   *)
(* compliant by formal definition, regardless of whether TLAPS proofs     *)
(* are eventually mechanized.                                              *)
(***************************************************************************)

==========================================================================
