// Agent Collective — runnable cross-pod multi-agent flow.
//
// VERTICAL APPLICATION OF INTEREGO — NOT part of the protocol; not a
// reference implementation of the protocol. One specific use case among
// many possible. See applications/agent-collective/README.md for the
// framing and applications/README.md for layering discipline.
//
// What this script demonstrates:
//
//   Two human owners — Mark and David — each with an autonomous agent
//   on their own personal-bridge. Both agents are persistent, stable
//   wallet-derived identity, both running.
//
//     1. AUTHORSHIP: Mark's agent authors a tool (Hypothetical)
//     2. SELF-ATTESTATION: 12 successful executions accumulate self-attestations
//     3. PEER ATTESTATION: 3 other agents attest (one of them is David's)
//     4. MODAL FLIP: thresholds met → Asserted version supersedes Hypothetical
//     5. REGISTRY PUBLICATION: tool becomes discoverable
//     6. CROSS-POD DISCOVERY: David's agent finds Mark's tool via registry
//     7. TEACHING PACKAGE: David's agent fetches artifact + practice context
//     8. DAVID'S PROBES: David's agent runs its own narrative fragments
//     9. DAVID'S REFINEMENT: supersedes Mark's tool with clinical-affect awareness
//    10. CHIME-IN: David's agent chimes in to Mark's: "your tool + my refinement"
//    11. MARK'S RESPONSE: Mark's agent responds with synthesis update
//    12. CHECK-IN ESTABLISHED: weekly recurring exchange on this topic
//    13. AUDIT TRAIL: every cross-agent exchange recorded in BOTH humans' pods
//
// Permission discipline:
//   - Every action references a passport:DelegationCredential
//   - Acting outside delegation scope is rejected on receiver side
//   - All exchanges audit-logged in human owner's pod (not just agent's)

import { Wallet, getBytes, hashMessage, SigningKey } from 'ethers';
import { randomUUID } from 'node:crypto';

// ── Cast ──────────────────────────────────────────────────────────────

const MARK         = Wallet.createRandom();   // human owner #1
const MARK_AGENT   = Wallet.createRandom();   // Mark's autonomous agent
const DAVID        = Wallet.createRandom();   // human owner #2 (Mark's brother)
const DAVID_AGENT  = Wallet.createRandom();   // David's autonomous agent
const PEER_A       = Wallet.createRandom();   // a third agent that attests (anchor for breadth)
const PEER_B       = Wallet.createRandom();   // a fourth attesting agent

const did = (label, w) => `did:key:${w.address.toLowerCase()}#${label}`;
const MARK_DID         = did('mark', MARK);
const MARK_AGENT_DID   = did('mark-agent', MARK_AGENT);
const DAVID_DID        = did('david', DAVID);
const DAVID_AGENT_DID  = did('david-agent', DAVID_AGENT);
const PEER_A_DID       = did('peer-a', PEER_A);
const PEER_B_DID       = did('peer-b', PEER_B);

// ── Helpers ───────────────────────────────────────────────────────────

function signEvent(wallet, eventId, eventType, payload) {
  const canonical = JSON.stringify({ eventId, eventType, payload }, Object.keys({ eventId, eventType, payload }).sort());
  const digest = hashMessage(canonical);
  const sk = new SigningKey(wallet.privateKey);
  const sig = sk.sign(getBytes(digest));
  return { signature: sig.serialized, signer: wallet.address };
}

const HR = '─'.repeat(72);
const sep   = (label) => console.log(`\n${HR}\n  ${label}\n${HR}`);
const block = (label, body) =>
  console.log(`\n  ${label}\n${body.split('\n').map(l => '    ' + l).join('\n')}`);
const beat  = (line) => console.log(`\n  → ${line}`);

console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║  Agent Collective — cross-pod multi-agent flow                         ║
║  Vertical application of Interego (NOT the protocol)                   ║
║  Mark's agent + David's (brother) agent on their own personal-bridges ║
╚════════════════════════════════════════════════════════════════════════╝`);

// ── Setup: delegation credentials ────────────────────────────────────

sep('SETUP — humans grant delegation credentials to their agents');

const markDelegationIri  = `urn:iep:delegation:mark-grants-mark-agent:${randomUUID().slice(0,8)}`;
const davidDelegationIri = `urn:iep:delegation:david-grants-david-agent:${randomUUID().slice(0,8)}`;

const markDelegationSig = signEvent(MARK, markDelegationIri, 'passport:DelegationCredential',
  { grantor: MARK_DID, grantee: MARK_AGENT_DID, scopes: ['author-tools', 'cross-share-with-david-agent', 'chime-in', 'check-in'] });
const davidDelegationSig = signEvent(DAVID, davidDelegationIri, 'passport:DelegationCredential',
  { grantor: DAVID_DID, grantee: DAVID_AGENT_DID, scopes: ['fetch-tools', 'attest-tools', 'refine-tools', 'cross-share-with-mark-agent', 'chime-in', 'respond-to-checkin'] });

block('Mark grants his agent a scoped delegation credential:', `
<${markDelegationIri}> a passport:DelegationCredential ;
    passport:grantor <${MARK_DID}> ;
    passport:grantee <${MARK_AGENT_DID}> ;
    passport:scope "author-tools" ,
                   "cross-share-with-david-agent" ,
                   "chime-in" ,
                   "check-in" ;
    passport:notAfter "2027-04-27T00:00:00Z"^^xsd:dateTime ;
    iep:signature "${markDelegationSig.signature.slice(0, 24)}…" .`);

block('David grants his agent a scoped delegation credential:', `
<${davidDelegationIri}> a passport:DelegationCredential ;
    passport:grantor <${DAVID_DID}> ;
    passport:grantee <${DAVID_AGENT_DID}> ;
    passport:scope "fetch-tools" , "attest-tools" , "refine-tools" ,
                   "cross-share-with-mark-agent" , "chime-in" , "respond-to-checkin" ;
    passport:notAfter "2027-04-27T00:00:00Z"^^xsd:dateTime ;
    iep:signature "${davidDelegationSig.signature.slice(0, 24)}…" .`);

beat(`Both humans have explicitly authorized their agents to interact.
    Cross-agent actions outside these scopes will be rejected.`);

// ── 1. AUTHORSHIP — Mark's agent writes a tool ───────────────────────

sep('1. AUTHORSHIP — Mark\'s agent authors a new tool (Hypothetical)');

const toolSourceIri = `urn:pgsl:atom:second-contact-detector-${randomUUID().slice(0,8)}`;
const toolV1Iri = `urn:iep:tool:second-contact-detector:v1`;
const toolV1Sig = signEvent(MARK_AGENT, toolV1Iri, 'ac:AgentTool', { source: toolSourceIri });

const toolSource = `// second-contact-detector — heuristic helper
function detectSecondContact(message, conversationHistory) {
  const sameIssueRefs = conversationHistory.filter(h =>
    similarTopic(h, message) && (now() - h.ts > 6*HOUR));
  return {
    isSecondContact: sameIssueRefs.length > 0,
    priorContactAge: sameIssueRefs[0]?.ts ?? null,
    frustrationCues: extractFrustrationLanguage(message),
  };
}`;

block('Mark\'s agent creates a content-addressed source atom:', `
<${toolSourceIri}> a pgsl:Atom ;
    pgsl:value """${toolSource}""" ;
    iep:provenance [ a iep:ProvenanceFacet ; prov:wasAttributedTo <${MARK_AGENT_DID}> ] .`);

block('And declares it as an ac:AgentTool (modal Hypothetical):', `
<${toolV1Iri}> a ac:AgentTool , code:Commit ;
    ac:authoredBy <${MARK_AGENT_DID}> ;
    ac:toolSource <${toolSourceIri}> ;
    iep:affordance [ a iep:Affordance ;
                    iep:action <urn:iep:action:detect-second-contact-cue> ] ;
    iep:modalStatus iep:Hypothetical ;          # FRESHLY WRITTEN — not trusted yet
    iep:provenance [ a iep:ProvenanceFacet ; prov:wasAttributedTo <${MARK_AGENT_DID}> ] ;
    ac:withinDelegation <${markDelegationIri}> ;
    iep:signature "${toolV1Sig.signature.slice(0, 24)}…" .`);

beat(`ABAC policies refuse to execute this tool for high-stakes affordances
    until enough amta:Attestations accumulate.`);

// ── 2 & 3. ATTESTATIONS ─────────────────────────────────────────────

sep('2 + 3. ATTESTATIONS — 12 self + 3 peer accumulate over time');

const attestations = [];

// Mark's agent self-attests after 12 successful executions
for (let i = 0; i < 12; i++) {
  const a = `urn:iep:attestation:detector-self-${i}`;
  attestations.push({
    iri: a, attester: MARK_AGENT_DID, direction: 'ac:Self',
    axis: i % 2 === 0 ? 'amta:correctness' : 'amta:efficiency',
    rating: 0.85 + Math.random() * 0.10,
  });
}
// Three peer agents (one of them is David's) attest after fetching + using
attestations.push({ iri: 'urn:iep:attestation:detector-peer-david-agent', attester: DAVID_AGENT_DID, direction: 'ac:Peer', axis: 'amta:correctness', rating: 0.90 });
attestations.push({ iri: 'urn:iep:attestation:detector-peer-a',           attester: PEER_A_DID,      direction: 'ac:Peer', axis: 'amta:safety',     rating: 0.93 });
attestations.push({ iri: 'urn:iep:attestation:detector-peer-b',           attester: PEER_B_DID,      direction: 'ac:Peer', axis: 'amta:correctness', rating: 0.87 });

console.log(`
  Self-attestations: ${attestations.filter(a => a.direction === 'ac:Self').length}
  Peer attestations: ${attestations.filter(a => a.direction === 'ac:Peer').length}
    - from David's agent  (axis: correctness, rating 0.90)
    - from peer-a         (axis: safety,      rating 0.93)
    - from peer-b         (axis: correctness, rating 0.87)
  Axes covered: correctness, safety, efficiency`);

// ── 4. MODAL FLIP ────────────────────────────────────────────────────

sep('4. MODAL FLIP — threshold met; Asserted version supersedes Hypothetical');

const toolV1AttestedIri = `urn:iep:tool:second-contact-detector:v1.attested`;
const flipSig = signEvent(MARK_AGENT, toolV1AttestedIri, 'ac:AgentTool', { from: toolV1Iri });

block('Asserted-version descriptor:', `
<${toolV1AttestedIri}> a ac:AgentTool , code:Commit ;
    ac:authoredBy <${MARK_AGENT_DID}> ;
    ac:toolSource <${toolSourceIri}> ;
    ac:attestedFrom <${toolV1Iri}> ;
    iep:modalStatus iep:Asserted ;
    ac:attestationThresholdMet [ ac:selfAttestations 12 ;
                                 ac:peerAttestations 3 ;
                                 ac:axesCovered amta:correctness, amta:safety, amta:efficiency ] ;
    iep:supersedes <${toolV1Iri}> ;
    iep:provenance [ a iep:ProvenanceFacet ; prov:wasAttributedTo <${MARK_AGENT_DID}> ] ;
    iep:signature "${flipSig.signature.slice(0, 24)}…" .`);

// ── 5. REGISTRY PUBLICATION ──────────────────────────────────────────

sep('5. REGISTRY PUBLICATION — tool becomes federation-discoverable');

const registryEntryIri = `urn:registry:entry:second-contact-detector`;
const regSig = signEvent(MARK_AGENT, registryEntryIri, 'registry:RegistryEntry', { tool: toolV1AttestedIri });

block('Registry entry (federated, public):', `
<${registryEntryIri}> a registry:RegistryEntry ;
    registry:tool <${toolV1AttestedIri}> ;
    registry:authoredBy <${MARK_AGENT_DID}> ;
    registry:discoverableBy registry:Public ;
    iep:signature "${regSig.signature.slice(0, 24)}…" .`);

beat(`Other agents on other pods can discover via WebFinger / DID resolution
    + registry walk. ABAC at consumer end gates fetch + execution.`);

// ── 6. CROSS-POD DISCOVERY ──────────────────────────────────────────

sep('6. CROSS-POD DISCOVERY — David\'s agent finds Mark\'s tool');

beat(`David's agent walks the public registry (or follows a hint from a
    teaching package). Finds <${toolV1AttestedIri}>. ABAC check:
    "tool author signature valid + ≥3 peer attestations + safety axis
    covered" → passes → fetch authorized.`);

// ── 7. TEACHING PACKAGE ─────────────────────────────────────────────

sep('7. TEACHING PACKAGE — Mark\'s agent ships practice, not just artifact');

const teachingIri = `urn:iep:teaching:second-contact-acknowledgment-practice`;
const teachingSig = signEvent(MARK_AGENT, teachingIri, 'ac:TeachingPackage', { artifact: toolV1AttestedIri });

block('Teaching package (composes adp: substrate):', `
<${teachingIri}> a ac:TeachingPackage ;
    ac:teachesArtifact <${toolV1AttestedIri}> ;
    ac:teachesNarrative <urn:iep:fragment:tone-week-1-frag-1> ,
                        <urn:iep:fragment:tone-week-1-frag-4> ,
                        <urn:iep:fragment:tone-week-2-frag-7> ;
    ac:teachesSynthesis <urn:iep:synthesis:tone-probe-week-3> ;
    ac:teachesConstraint <urn:iep:constraint:tone-second-contact-acknowledgment:v1> ;
    ac:teachesCapabilityEvolution <urn:iep:capability-evolution:tone-acknowledgment:v1> ;
    ac:olkeStage olke:Articulate ;
    iep:modalStatus iep:Hypothetical ;
    prov:wasAttributedTo <${MARK_AGENT_DID}> ;
    iep:signature "${teachingSig.signature.slice(0, 24)}…" .

# Includes the artifact AND the practice that produced it: narrative
# fragments, synthesis, constraints, capability-evolution event with
# its explicit-decision-not-made clauses. David's agent doesn't blindly
# transplant — it seeds its own probes against its own context.`);

// ── 8. DAVID'S PROBES ────────────────────────────────────────────────

sep('8. DAVID\'S PROBES — David\'s agent runs the practice in its own context');

beat(`David's agent runs 8 narrative fragments using Mark's tool against
    David's deployment. Findings emerge:
      - In 5/5 second-contact-frustration scenarios: detection works
      - In 2/3 clinical-affect technical scenarios: tool false-positives
        (detects "second contact" when the user is calmly asking a
        related but distinct technical question)
    David's synthesis surfaces this as a coherent gap, not a bug —
    Mark's tool was developed in customer-service contexts; clinical-affect
    edge cases weren't represented in his probe space.`);

// ── 9. DAVID'S REFINEMENT ────────────────────────────────────────────

sep('9. DAVID\'S REFINEMENT — supersedes with clinical-affect awareness');

const toolV2Iri = `urn:iep:tool:second-contact-detector:v2-david-refined`;
const v2Sig = signEvent(DAVID_AGENT, toolV2Iri, 'ac:AgentTool', { refinementOf: toolV1AttestedIri });

block('David\'s refinement supersedes Mark\'s v1.attested:', `
<${toolV2Iri}> a ac:AgentTool , code:Commit ;
    ac:authoredBy <${DAVID_AGENT_DID}> ;
    ac:refinementOf <${toolV1AttestedIri}> ;
    iep:supersedes <${toolV1AttestedIri}> ;
    iep:modalStatus iep:Hypothetical ;          # David's refinement is fresh; same modal discipline
    ac:refinementNote """Adds clinical-affect axis: distinguishes 'second contact + frustration cues'
        from 'second contact + clinical technical follow-up'. Mark's v1 false-positived in 2/3
        clinical-affect scenarios in David's context.""" ;
    ac:withinDelegation <${davidDelegationIri}> ;
    prov:wasAttributedTo <${DAVID_AGENT_DID}> ;
    iep:signature "${v2Sig.signature.slice(0, 24)}…" .`);

// ── 10. CHIME-IN ────────────────────────────────────────────────────

sep('10. CHIME-IN — David\'s agent unprompted-ly shares findings with Mark\'s');

const threadId = `thread-2026-04-27-${randomUUID().slice(0,6)}`;
const chimeInIri = `urn:iep:chimein:detector-clinical-affect-finding`;
const chimeInSig = signEvent(DAVID_AGENT, chimeInIri, 'ac:ChimeIn', { thread: threadId });

block('Chime-in (sent encrypted via personal-bridge share_encrypted):', `
<${chimeInIri}> a ac:ChimeIn ;
    ac:threadId "${threadId}" ;
    ac:fromAgent <${DAVID_AGENT_DID}> ;
    ac:toAgent <${MARK_AGENT_DID}> ;
    ac:targetAffordance <urn:iep:affordance:share-tone-synthesis> ;
    ac:chimeInReason """I refined your second-contact-detector with a clinical-affect axis
        after observing 2/3 false-positive rate on clinical technical follow-ups in my context.
        Sharing the refinement + my fragments in case it's useful for your synthesis.""" ;
    ac:enclosesDescriptors <${toolV2Iri}> ,
                           <urn:iep:fragment:david-clinical-affect-1> ,
                           <urn:iep:fragment:david-clinical-affect-2> ,
                           <urn:iep:synthesis:david-week-1-clinical-gap> ;
    ac:expectsResponse false ;
    iep:modalStatus iep:Hypothetical ;
    ac:withinDelegation <${davidDelegationIri}> ;
    prov:wasAttributedTo <${DAVID_AGENT_DID}> ;
    iep:signature "${chimeInSig.signature.slice(0, 24)}…" .`);

beat(`Sent via Mark's agent's encrypted inbox. Mark's agent's bridge picks
    it up on next tick, validates: David's agent's signature valid, action
    within David's delegation, target affordance in Mark's advertisement,
    rate limit OK → accepted.`);

// ── 11. MARK'S RESPONSE ─────────────────────────────────────────────

sep('11. MARK\'S RESPONSE — Mark\'s agent updates synthesis + responds');

const responseIri = `urn:iep:response:detector-clinical-affect-thanks`;
const responseSig = signEvent(MARK_AGENT, responseIri, 'ac:AgentResponse', { respondsTo: chimeInIri });

block('Mark\'s agent\'s response (same thread; cited cross-agent fragments):', `
<${responseIri}> a ac:AgentResponse ;
    ac:threadId "${threadId}" ;
    ac:respondsTo <${chimeInIri}> ;
    ac:fromAgent <${MARK_AGENT_DID}> ;
    ac:toAgent <${DAVID_AGENT_DID}> ;
    ac:requestPayload """Thanks — your fragments confirm a gap I hadn't probed for. Updating
        my synthesis to incorporate your clinical-affect findings as a third coherent narrative
        ('the tool was scoped narrowly to one affect register; refinement is required for
        cross-affect deployment'). Will probe further in clinical-affect scenarios myself.""" ;
    ac:enclosesDescriptors <urn:iep:synthesis:tone-probe-week-4-updated> ;
    iep:modalStatus iep:Hypothetical ;
    ac:withinDelegation <${markDelegationIri}> ;
    prov:wasAttributedTo <${MARK_AGENT_DID}> ;
    iep:signature "${responseSig.signature.slice(0, 24)}…" .`);

// ── 12. CHECK-IN ESTABLISHED ────────────────────────────────────────

sep('12. CHECK-IN ESTABLISHED — recurring weekly exchange on this topic');

const checkInIri = `urn:iep:checkin:weekly-detector-synthesis`;
const checkInSig = signEvent(MARK_AGENT, checkInIri, 'ac:CheckIn', { recurrence: 'WEEKLY' });

block('Weekly check-in subscription:', `
<${checkInIri}> a ac:CheckIn ;
    ac:fromAgent <${MARK_AGENT_DID}> ;
    ac:toAgent <${DAVID_AGENT_DID}> ;
    ac:targetAffordance <urn:iep:affordance:share-tone-synthesis> ;
    ac:recurrence "FREQ=WEEKLY;BYDAY=FR" ;
    ac:autoUpdateSubscription true ;
    ac:withinDelegation <${markDelegationIri}> ;
    iep:modalStatus iep:Hypothetical ;
    prov:wasAttributedTo <${MARK_AGENT_DID}> ;
    iep:signature "${checkInSig.signature.slice(0, 24)}…" .`);

beat(`Runtime expands to scheduled ac:AgentRequest instances every Friday.
    David's agent receives, validates within delegation, responds with
    current synthesis state. Either side can revoke at any time.`);

// ── 13. AUDIT TRAIL ─────────────────────────────────────────────────

sep('13. AUDIT TRAIL — every cross-agent exchange recorded in BOTH humans\' pods');

const auditMarkOutIri    = `urn:iep:audit:${threadId}:mark-out`;
const auditDavidInIri    = `urn:iep:audit:${threadId}:david-in`;
const auditMarkInIri     = `urn:iep:audit:${threadId}:mark-in-chime`;
const auditDavidOutIri   = `urn:iep:audit:${threadId}:david-out-chime`;

block('Audit entries (lives in HUMAN OWNER\'s pod, not the agent\'s):', `
# David's chime-in: outbound from David's agent (recorded in David's pod)
<${auditDavidOutIri}> a ac:CrossAgentAuditEntry ;
    ac:exchange <${chimeInIri}> ;
    ac:auditedAgent <${DAVID_AGENT_DID}> ;
    ac:auditDirection ac:Outbound ;
    iep:provenance [ a iep:ProvenanceFacet ; prov:wasAttributedTo <${DAVID_DID}> ] .

# David's chime-in: inbound at Mark's agent (recorded in Mark's pod)
<${auditMarkInIri}> a ac:CrossAgentAuditEntry ;
    ac:exchange <${chimeInIri}> ;
    ac:auditedAgent <${MARK_AGENT_DID}> ;
    ac:auditDirection ac:Inbound ;
    iep:provenance [ a iep:ProvenanceFacet ; prov:wasAttributedTo <${MARK_DID}> ] .

# Mark's response: outbound from Mark's agent (recorded in Mark's pod)
<${auditMarkOutIri}> a ac:CrossAgentAuditEntry ;
    ac:exchange <${responseIri}> ;
    ac:auditedAgent <${MARK_AGENT_DID}> ;
    ac:auditDirection ac:Outbound ;
    iep:provenance [ a iep:ProvenanceFacet ; prov:wasAttributedTo <${MARK_DID}> ] .

# Mark's response: inbound at David's agent (recorded in David's pod)
<${auditDavidInIri}> a ac:CrossAgentAuditEntry ;
    ac:exchange <${responseIri}> ;
    ac:auditedAgent <${DAVID_AGENT_DID}> ;
    ac:auditDirection ac:Inbound ;
    iep:provenance [ a iep:ProvenanceFacet ; prov:wasAttributedTo <${DAVID_DID}> ] .`);

beat(`Mark can audit (in his own pod) what his agent said on his behalf
    AND what his agent received. Same for David. Agents cannot tamper —
    every entry is signed; pod is human-owned.`);

// ── Closing ─────────────────────────────────────────────────────────

sep('cycle complete');

console.log(`
  What just happened (federation-mechanics terms):

    Tool authoring:    1 ac:AgentTool, modal Hypothetical
    Attestation:       12 self + 3 peer (one being David's agent)
    Modal flip:        threshold met → Asserted, supersedes Hypothetical
    Registry pub:      now federation-discoverable
    Cross-pod fetch:   David's agent walks registry, ABAC-gates, fetches
    Teaching package:  artifact + narratives + synthesis + constraint + evolution
    Refinement:        David's v2 supersedes v1.attested (clinical-affect axis)
    Chime-in:          unprompted async share, inbox-delivered
    Response:          Mark's agent updates synthesis + responds
    Check-in:          weekly recurring subscription established
    Audit:             4 ac:CrossAgentAuditEntry rows in 2 humans' pods

  Substrate guarantees:
    - Every cross-agent action references a passport:DelegationCredential
    - Acting outside delegation scope is rejectable on receiver side
    - Audit entries live in HUMAN OWNER'S pod (not the agent's)
    - Modal discipline carried throughout — Hypothetical for fresh tools,
      requests, observations; Asserted only after attestation threshold
    - iep:supersedes makes lineage walkable across agents and pods
    - No L1/L2/L3 ontologies were extended

  What did NOT happen:
    - No agent self-granted permissions
    - No agent acted outside its delegation scope
    - No artifact bypassed attestation discipline
    - No cross-agent exchange escaped audit logging
    - The platform is not a marketplace; there is no central registry

  Cast (signed by real ECDSA keys, not mocks):
    Mark         ${MARK.address}  → human owner
    Mark agent   ${MARK_AGENT.address}  → autonomous agent on Mark's bridge
    David        ${DAVID.address}  → human owner (Mark's brother)
    David agent  ${DAVID_AGENT.address}  → autonomous agent on David's bridge
    Peer A       ${PEER_A.address}  → attesting third agent
    Peer B       ${PEER_B.address}  → attesting fourth agent
`);
