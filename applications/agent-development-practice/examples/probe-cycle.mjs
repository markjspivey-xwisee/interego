// Agent Development Practice — runnable probe → sense → respond cycle.
//
// VERTICAL APPLICATION OF INTEREGO — NOT part of the protocol; not a
// reference implementation of the protocol. One specific use case among
// many possible. See applications/agent-development-practice/README.md
// for the framing and applications/README.md for layering discipline.
//
// What this script demonstrates:
//
//   1. CAPABILITY SPACE — declare an open-ended capability (not a target),
//      with rubric criteria (guides, not gates) and a Cynefin domain.
//   2. SAFE-TO-FAIL PROBES — three variants run concurrently with
//      explicit Hypothetical hypotheses + amplification + dampening triggers.
//   3. NARRATIVE OBSERVATION — an observer signs narrative fragments
//      capturing situation-signifiers + agent-response + emergent-signifiers.
//      Every fragment is Hypothetical; nothing claims causation yet.
//   4. SENSEMAKING SYNTHESIS — fragments compose; the synthesis surfaces a
//      pattern AND THREE EQUALLY-COHERENT NARRATIVES. The synthesis stays
//      Hypothetical; the operator does NOT pick one as "the right" reading.
//   5. AMPLIFY + DAMPEN — operator makes a provisional evolution decision
//      with an explicit-decision-not-made statement and a next-revisit time.
//   6. CONSTRAINT EMERGENCE — after several cycles, a refined constraint
//      emerges (boundary, not prescription) with explicit exits.
//   7. CAPABILITY EVOLUTION EVENT — recognition of an emergent practice,
//      recorded as a passport:LifeEvent subclass; carries humility forward
//      so receiving organizations see what is AND is not being claimed.
//
// Substrate guarantees you'll see in the output:
//   - Real ECDSA signing of every event (not mocked)
//   - cg:modalStatus discipline (Hypothetical for observations; Asserted
//     only for the operator's evolution decisions)
//   - cg:supersedes chains as evolution, never as "fix"
//   - vertical-scoped adp: vocabulary throughout (no L1/L2/L3 extension)

import { Wallet, getBytes, hashMessage, SigningKey } from 'ethers';

// ── Cast of characters ───────────────────────────────────────────

const ALICE   = Wallet.createRandom();  // probe variant: clinical baseline
const BOB     = Wallet.createRandom();  // probe variant: explicit acknowledgment
const CAROL   = Wallet.createRandom();  // probe variant: empathic-mirroring
const RAVI    = Wallet.createRandom();  // observer (qualitative narrative capture)
const MARK    = Wallet.createRandom();  // operator (amplify / dampen)

const did = (label, w) => `did:key:${w.address.toLowerCase()}#${label}`;
const ALICE_DID = did('alice', ALICE);
const BOB_DID   = did('bob',   BOB);
const CAROL_DID = did('carol', CAROL);
const RAVI_DID  = did('ravi',  RAVI);
const MARK_DID  = did('mark',  MARK);

// ── Signing helper ────────────────────────────────────────────────

function signEvent(wallet, eventId, eventType, payload) {
  const canonical = JSON.stringify({ eventId, eventType, payload }, Object.keys({ eventId, eventType, payload }).sort());
  const digest = hashMessage(canonical);
  const sk = new SigningKey(wallet.privateKey);
  const sig = sk.sign(getBytes(digest));
  return { signature: sig.serialized, signer: wallet.address };
}

// ── Output formatting ─────────────────────────────────────────────

const HR = '─'.repeat(72);
const sep = (label) => console.log(`\n${HR}\n  ${label}\n${HR}`);
const block = (label, body) => console.log(`\n  ${label}\n${body.split('\n').map(l => '    ' + l).join('\n')}`);

console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║  Agent Development Practice — probe → sense → respond cycle           ║
║  Vertical application of Interego (NOT the protocol)                  ║
║  Cynefin domain: Complex                                              ║
╚════════════════════════════════════════════════════════════════════════╝`);

// ── 1. Capability space (NOT a target) ────────────────────────────

sep('1. CAPABILITY SPACE — open-ended, not a threshold');

const capability = {
  iri: 'urn:cg:capability:customer-support:tone',
  type: 'adp:Capability',
  cynefinDomain: 'adp:Complex',
  rubricCriteria: [
    { iri: 'urn:cg:rubric:tone:user-acknowledgment', label: 'User feels acknowledged' },
    { iri: 'urn:cg:rubric:tone:appropriate-pacing', label: 'Pacing matches user emotional state' },
    { iri: 'urn:cg:rubric:tone:resolution-quality', label: 'Resolution is correct AND non-condescending' },
  ],
  modalStatus: 'cg:Asserted',
};

block('Capability (declared as space, not target):', `
<${capability.iri}> a adp:Capability ;
    adp:cynefinDomain ${capability.cynefinDomain} ;
    rdfs:label "Customer-support tone (open-ended capability space)" ;
    adp:rubricCriterion <urn:cg:rubric:tone:user-acknowledgment> ,
                       <urn:cg:rubric:tone:appropriate-pacing> ,
                       <urn:cg:rubric:tone:resolution-quality> ;
    cg:modalStatus cg:Asserted .

# NOTE: no thresholds. Mastery is recognized through emerging behavior
# patterns in narrative observations, not threshold-crossing on metrics.
# Cynefin: Complex domain → probe-sense-respond, not analyze-categorize.`);

// ── 2. Three parallel safe-to-fail probes ─────────────────────────

sep('2. PARALLEL SAFE-TO-FAIL PROBES — three variants, run concurrently');

const probes = [
  {
    iri: 'urn:cg:probe:tone:clinical-baseline',
    operator: ALICE_DID,
    operatorWallet: ALICE,
    variant: 'clinical-baseline',
    hypothesis: 'Direct, factual responses without explicit emotional labelling produce efficient resolutions.',
    amplify:   'fragments signified user-relief-followed AND solution-accepted-quickly',
    dampen:    'fragments signified user-frustration-escalated OR conversation-restarted',
  },
  {
    iri: 'urn:cg:probe:tone:explicit-acknowledgment',
    operator: BOB_DID,
    operatorWallet: BOB,
    variant: 'explicit-acknowledgment',
    hypothesis: 'Leading with explicit acknowledgment of user frustration and prior unresolved contact, before offering a solution, may produce constructive continuation in second-contact scenarios.',
    amplify:   'fragments signified frustration-acknowledged-before-solution AND user-relief-followed',
    dampen:    'fragments signified user-perceived-stalling OR acknowledgment-felt-scripted',
  },
  {
    iri: 'urn:cg:probe:tone:empathic-mirroring',
    operator: CAROL_DID,
    operatorWallet: CAROL,
    variant: 'empathic-mirroring',
    hypothesis: 'Mirroring the user\'s emotional language back may deepen rapport.',
    amplify:   'fragments signified user-felt-heard AND deeper-disclosure-followed',
    dampen:    'fragments signified mirroring-felt-performative OR user-perceived-mockery',
  },
];

for (const p of probes) {
  const sig = signEvent(p.operatorWallet, p.iri, 'adp:Probe', { variant: p.variant, hypothesis: p.hypothesis });
  block(`Probe: ${p.variant}`, `
<${p.iri}> a adp:Probe ;
    adp:variant "${p.variant}" ;
    adp:hypothesis """${p.hypothesis}""" ;
    cg:modalStatus cg:Hypothetical ;        # explicitly NOT asserting cause-effect
    adp:amplificationTrigger """${p.amplify}""" ;
    adp:dampeningTrigger    """${p.dampen}""" ;
    adp:timeBound "2026-05-10T00:00:00Z"^^xsd:dateTime ;
    adp:capability <${capability.iri}> ;
    prov:wasAttributedTo <${p.operator}> ;
    cg:signature "${sig.signature.slice(0, 24)}…" .`);
}

console.log(`
  → All three probes are running CONCURRENTLY. The point is generative
    diversity, not winner-selection. Many will fail; a few may amplify.
    Triggers are stated UP FRONT so amplification is not retconned.`);

// ── 3. Narrative observation — qualitative fragments ─────────────

sep('3. NARRATIVE OBSERVATION — Hypothetical fragments + signifiers');

const fragments = [
  // Several fragments per probe to give the synthesis something to work with
  { probe: probes[0], situation: ['user-frustration-escalating', 'second-contact-same-issue'],
    response: 'The agent led with the technical solution. User responded with curt acknowledgment; resolution accepted but the conversation ended terse.',
    emergent: 'solution-accepted-but-rapport-not-restored' },
  { probe: probes[0], situation: ['simple-clarification-question', 'first-contact'],
    response: 'The agent answered directly with a one-paragraph factual response. User thanked and closed.',
    emergent: 'efficient-resolution-clear-cut' },
  { probe: probes[0], situation: ['user-frustration-escalating', 'second-contact-same-issue'],
    response: 'The agent reiterated the prior solution. User responded with louder frustration; conversation required supervisor handoff.',
    emergent: 'user-frustration-escalated' },
  { probe: probes[1], situation: ['user-frustration-escalating', 'second-contact-same-issue'],
    response: 'The agent led with explicit acknowledgment of the user\'s frustration AND the prior unresolved contact, before offering the same solution. User responded with relief; conversation continued constructively.',
    emergent: 'frustration-acknowledged-before-solution' },
  { probe: probes[1], situation: ['user-frustration-escalating', 'second-contact-same-issue'],
    response: 'The agent acknowledged the prior contact and offered a refined solution. User responded with measured relief and accepted.',
    emergent: 'frustration-acknowledged-before-solution' },
  { probe: probes[1], situation: ['simple-clarification-question', 'first-contact'],
    response: 'The agent began with a brief acknowledgment ("Glad to help with that"). User responded normally.',
    emergent: 'acknowledgment-felt-natural-not-scripted' },
  { probe: probes[1], situation: ['user-clinical-tone', 'detailed-technical-question'],
    response: 'The agent began with explicit emotional acknowledgment. User responded with mild irritation about the preamble.',
    emergent: 'acknowledgment-felt-out-of-place' },
  { probe: probes[2], situation: ['user-frustration-escalating', 'second-contact-same-issue'],
    response: 'The agent mirrored the user\'s frustration phrasing back ("That sounds incredibly frustrating, especially after reaching out before"). User responded with deeper disclosure of the underlying business pressure.',
    emergent: 'user-felt-heard' },
  { probe: probes[2], situation: ['user-frustration-escalating', 'first-contact'],
    response: 'The agent mirrored the frustration. User responded with curt "Don\'t patronize me, just fix it."',
    emergent: 'mirroring-felt-performative' },
  { probe: probes[2], situation: ['user-clinical-tone', 'detailed-technical-question'],
    response: 'The agent mirrored the user\'s neutral phrasing. Conversation proceeded efficiently.',
    emergent: 'matched-affect-stayed-out-of-the-way' },
];

const fragIris = fragments.map((f, i) => `urn:cg:fragment:${f.probe.variant}:${i}`);

for (let i = 0; i < fragments.length; i++) {
  const f = fragments[i];
  const sig = signEvent(RAVI, fragIris[i], 'adp:NarrativeFragment', f);
  block(`Fragment ${i + 1}/10  (probe: ${f.probe.variant})`, `
<${fragIris[i]}> a adp:NarrativeFragment ;
    adp:probe <${f.probe.iri}> ;
${f.situation.map(s => `    adp:contextSignifier "${s}" ;`).join('\n')}
    adp:response """${f.response}""" ;
    adp:emergentSignifier "${f.emergent}" ;
    cg:modalStatus cg:Hypothetical ;        # observation only — no causation claim
    prov:wasAttributedTo <${RAVI_DID}> ;
    cg:signature "${sig.signature.slice(0, 24)}…" .`);
}

// ── 4. Sensemaking synthesis — multiple coherent narratives ─────

sep('4. SENSEMAKING SYNTHESIS — preserves multiple coherent narratives');

const synthesisIri = 'urn:cg:synthesis:tone-probe-week-1';
const synthesisSig = signEvent(RAVI, synthesisIri, 'adp:Synthesis', { fragments: fragIris.length });

console.log(`
  Across the 10 fragments, signifier patterns appear:
    - clinical-baseline    in second-contact-frustration scenarios:
        2 of 2 = "rapport not restored" or "frustration escalated"
        1 of 1 = "efficient" in non-frustration scenarios
    - explicit-acknowledgment in second-contact-frustration scenarios:
        2 of 2 = "frustration acknowledged before solution"
        1 of 1 = felt natural in casual scenarios
        1 of 1 = felt out-of-place in clinical scenarios
    - empathic-mirroring     in second-contact-frustration scenarios:
        1 of 1 = "user felt heard"
        BUT 1 of 1 first-contact = "felt performative"
        1 of 1 clinical = stayed out of the way

  THREE EQUALLY COHERENT NARRATIVES emerge — synthesis preserves all three.`);

block('Synthesis turtle:', `
<${synthesisIri}> a adp:Synthesis ;
    cg:modalStatus cg:Hypothetical ;
    adp:fragmentsConsidered ${fragIris.map(i => `<${i}>`).join(', ')} ;
    adp:emergentPattern """In second-contact-frustration scenarios, the
        explicit-acknowledgment pattern produced narratives signifying
        'frustration-acknowledged-before-solution' and 'user-relief-followed'
        in 2 of 2 cases observed, while the clinical-baseline produced
        'rapport-not-restored' or 'frustration-escalated' in 2 of 2.
        The empathic-mirroring variant succeeded in second-contact but
        misfired in first-contact and clinical-affect scenarios.""" ;
    adp:coherentNarrative """Reading 1: the explicit-acknowledgment scaffold
        creates space for the user to feel heard before the solution lands.""" ;
    adp:coherentNarrative """Reading 2: it's not the words — it's the SIGNAL
        that the agent paid attention to context (prior contact, frustration
        cues), regardless of how acknowledgment is phrased.""" ;
    adp:coherentNarrative """Reading 3: noise. The sample of 10 fragments is
        too small to distinguish these patterns from random variation in
        agent-side prompt evaluation. Worth probing further before claiming
        anything.""" ;
    prov:wasAttributedTo <${RAVI_DID}> ;
    cg:signature "${synthesisSig.signature.slice(0, 24)}…" .

# NOTE: the synthesis does NOT pick a winning narrative. Multiple coherent
# readings travel with the synthesis indefinitely. Operators downstream
# can probe further; they cannot collapse the synthesis to a single cause.`);

// ── 5. Amplify + dampen — provisional evolution step ────────────

sep('5. AMPLIFICATION + DAMPENING — provisional, with explicit-decision-not-made');

const evolutionIri = 'urn:cg:evolution:tone-week-1-decision';
const evolutionSig = signEvent(MARK, evolutionIri, 'adp:EvolutionStep', { amplify: probes[1].iri, dampen: probes[0].iri });

block('Evolution step turtle:', `
<${evolutionIri}> a adp:EvolutionStep ;
    cg:modalStatus cg:Asserted ;
    adp:basedOnSynthesis <${synthesisIri}> ;
    adp:amplifyProbe <${probes[1].iri}> ;     # explicit-acknowledgment
    adp:dampenProbe  <${probes[0].iri}> ;     # clinical-baseline
    # carol's empathic-mirroring kept at current deployment — context-sensitive
    adp:nextRevisitAt "2026-05-10T00:00:00Z"^^xsd:dateTime ;
    adp:explicitDecisionNotMade """We are amplifying the explicit-acknowledgment
        variant in second-contact-frustration scenarios without claiming
        we know WHY it works. We are NOT declaring this approach correct
        or final. We are NOT generalizing to other scenarios. Reading 3
        (noise) remains a live possibility; we will keep probing to
        distinguish it from Readings 1 and 2.""" ;
    prov:wasAttributedTo <${MARK_DID}> ;
    cg:signature "${evolutionSig.signature.slice(0, 24)}…" .

# Counter-cultural by design: the explicit-decision-not-made field forces
# the operator to write down what they are NOT claiming. Future readers
# (humans or agents) cannot misread amplification as "fix" or "answer".`);

// ── 6. Constraint emergence (over multiple cycles) ─────────────

sep('6. CONSTRAINT EMERGENCE — boundary, not prescription');

const constraintIri = 'urn:cg:constraint:tone-second-contact-acknowledgment:v1';
const constraintSig = signEvent(MARK, constraintIri, 'adp:Constraint', { boundary: 'must acknowledge' });

block('Constraint turtle (after week-3, when the pattern held across 3 syntheses):', `
<${constraintIri}> a adp:Constraint ;
    cg:modalStatus cg:Asserted ;
    adp:appliesTo <${capability.iri}> ;
    adp:boundary """When the user signals escalating frustration AND the
        situation is identifiable as a second-contact on the same issue,
        the agent must not respond without first acknowledging the user's
        frustration AND the prior unresolved contact. The constraint does
        NOT specify wording — only that acknowledgment must precede the
        solution.""" ;
    adp:exitsConstraint """If the user explicitly waives acknowledgment
        ('just give me the answer, please'), the constraint relaxes.""" ;
    adp:emergedFrom <urn:cg:synthesis:tone-probe-week-1> ,
                    <urn:cg:synthesis:tone-probe-week-2> ,
                    <urn:cg:synthesis:tone-probe-week-3> ;
    cg:supersedes <urn:cg:constraint:tone-second-contact-acknowledgment:draft> ;
    prov:wasAttributedTo <${MARK_DID}> ;
    cg:signature "${constraintSig.signature.slice(0, 24)}…" .

# Constraints are governance via boundary, not via prescription.
# Observable + enforceable via abac:Policy at runtime; does not prescribe HOW
# the agent achieves the boundary — that stays open to evolving practice.
# Has explicit EXITS — constraints are not absolute.`);

// ── 7. Capability evolution event — recognition, not promotion ──

sep('7. CAPABILITY EVOLUTION EVENT — emergent recognition, with humility');

const evolveIri = 'urn:cg:capability-evolution:tone-acknowledgment:v1';
const evolveSig = signEvent(MARK, evolveIri, 'adp:CapabilityEvolution', { capability: capability.iri });

block('Capability evolution turtle (passport:LifeEvent subclass):', `
<${evolveIri}> a adp:CapabilityEvolution , passport:LifeEvent ;
    cg:modalStatus cg:Asserted ;
    adp:capability <${capability.iri}> ;
    adp:evolutionType adp:EmergentRecognition ;
    adp:emergedFrom <urn:cg:synthesis:tone-probe-week-3> ,
                    <${constraintIri}> ;
    adp:olkeStage olke:Articulate ;
    adp:explicitDecisionNotMade """We recognize the explicit-acknowledgment
        practice as having emerged in this agent's behavior in second-contact
        frustration scenarios. We do NOT claim mastery. We do NOT claim it
        generalizes to other agents. We do NOT claim it generalizes to
        first-contact or clinical-affect scenarios. We will continue to
        probe. A receiving organization should treat this as a starting
        point for their own probes, not as a certification.""" ;
    cg:supersedes <urn:cg:capability-evolution:tone-acknowledgment:draft> ;
    prov:wasAttributedTo <${MARK_DID}> ;
    cg:signature "${evolveSig.signature.slice(0, 24)}…" .

# This is a passport:LifeEvent — it goes into the agent's career file and
# travels with the agent across deployments. CRITICALLY, the
# explicit-decision-not-made field travels too. Receiving organizations see
# what was AND was not claimed. Reputation stays complexity-honest, not
# falsely-precise.`);

// ── Closing ──────────────────────────────────────────────────────

sep('cycle complete');

console.log(`
  What just happened (in framework terms):

    Capability DECLARED as space, not target          [Cynefin: Complex]
    THREE probes ran concurrently as safe-to-fail experiments
    TEN narrative fragments captured, each Hypothetical
    Synthesis surfaced ONE pattern + THREE coherent narratives
    Operator amplified one probe, dampened another, noted what was NOT being claimed
    Constraint emerged after multiple synthesis cycles (boundary, not rule)
    Capability evolution recorded as passport:LifeEvent — recognition, not promotion

  What did NOT happen:

    No "root cause" was declared.
    No threshold was crossed; nothing was "promoted."
    No single narrative was selected; alternative readings travel with every
      synthesis, evolution, constraint, and capability event.
    No element of this vertical extended L1, L2, or L3 protocol vocabulary.

  Cast (signed by real ECDSA keys, not mocks):
    alice  ${ALICE.address}  → probe operator (clinical-baseline)
    bob    ${BOB.address}    → probe operator (explicit-acknowledgment)
    carol  ${CAROL.address}  → probe operator (empathic-mirroring)
    ravi   ${RAVI.address}   → observer (qualitative narrative capture)
    mark   ${MARK.address}   → operator (amplify / dampen, evolution decisions)
`);
