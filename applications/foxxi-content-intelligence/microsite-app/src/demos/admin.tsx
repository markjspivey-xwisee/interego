import React from 'react';
import { callBridge, DEMO_IDENTITIES } from '../bridge-client.js';
import type { DemoStep } from '../components/DemoCard.js';

const JOSHUA = DEMO_IDENTITIES.joshua;
const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/foxxi/';

export const adminSteps: DemoStep[] = [
  {
    title: 'Run a privacy-preserving coverage query',
    subtitle: 'foxxi.coverage_query · merkle-attested-opt-in mode',
    body: (
      <>
        How many concepts in your catalog are taught only in one course? Plain SQL would expose the
        underlying records. Foxxi's coverage query uses the substrate's aggregate-privacy primitives:
        in <code>merkle-attested-opt-in</code> mode the bridge returns a count + a Merkle root the
        auditor can re-verify, without any single per-record value leaking.
      </>
    ),
    actionLabel: 'Run merkle-attested-opt-in coverage query',
    run: () => callBridge({
      tool: 'foxxi.coverage_query',
      args: {
        tenant_pod_url: POD,
        coverage: [
          { concept: 'handicap', taughtIn: ['golf-explained'], mentionedIn: ['golf-fundamentals'] },
          { concept: 'pace-of-play', taughtIn: ['golf-explained'], mentionedIn: [] },
          { concept: 'course-par', taughtIn: ['lesson1', 'golf-explained'], mentionedIn: ['golf-fundamentals'] },
        ],
        privacy_mode: 'merkle-attested-opt-in',
      },
      identity: 'jordan',
    }),
    summarize: (r) => {
      const x = r as { mode?: string; bundle?: { count?: number } };
      return x ? `mode: ${x.mode} · count: ${x.bundle?.count ?? 'n/a'}` : 'no result';
    },
    explainer: (r) => {
      const x = r as { mode?: string; bundle?: { count?: number; merkleRoot?: string } };
      if (!x?.mode) return <em>Bridge returned an error.</em>;
      return (
        <>
          The bridge ran the aggregate-privacy v2 ladder: each contributor's record was committed to a
          Merkle leaf, the bridge published the root, returned the aggregate count
          (<strong>{x.bundle?.count}</strong>). An auditor receives the same Merkle root + per-leaf
          inclusion proofs, can re-compute the root, and confirms the count <em>without</em> seeing the
          underlying records. Try the other modes (<code>abac</code> plain count, <code>zk-distribution</code>
          DP-noised histogram) via the full dashboard.
        </>
      );
    },
  },

  {
    title: 'Issue a learner an Open Badges 3.0 credential',
    subtitle: 'foxxi.issue_completion_credential · eddsa-jcs-2022',
    body: (
      <>
        Joshua finished Golf Explained (passed at 0.87). You're the L&amp;D admin — Foxxi mints a W3C
        Verifiable Credential shaped as an Open Badges 3.0 <code>OpenBadgeCredential</code>, signs it
        with your tenant's deterministic Ed25519 issuer key using the W3C
        <code> eddsa-jcs-2022</code> Data Integrity cryptosuite, and publishes it to Joshua's pod.
        Joshua's wallet (his pod) now holds a verifiable, portable credential — any W3C VC verifier
        accepts it, with no Foxxi vendor dependency.
      </>
    ),
    actionLabel: 'Issue OB3 to Joshua',
    run: () => callBridge({
      tool: 'foxxi.issue_completion_credential',
      args: {
        learner_did: JOSHUA.webId,
        learner_pod_url: POD,
        course_id: 'golf-explained',
        course_title: 'Golf Explained',
        course_description: 'Introduction to the rules and etiquette of golf (SCORM Cloud sample course).',
        criterion_narrative: 'Completed all 14 slides + scored 0.87 on the Q&A above mastery 0.7.',
        aligned_skills: [
          { targetCode: 'handicap', targetName: 'Handicap calculation', targetFramework: 'usga-handicap-system' },
        ],
        evidence: [
          { type: 'fxa:CitedSlide', id: 'urn:foxxi:golf-explained:slide:etq-course', narrative: 'Etiquette slide — Golf Etiquette Overview' },
        ],
      },
      identity: 'jordan',
    }),
    summarize: (r) => {
      const x = r as { vc?: { type?: string[]; proof?: { cryptosuite?: string } } };
      return x?.vc ? `${x.vc.type?.join(', ')} · ${x.vc.proof?.cryptosuite}` : 'no result';
    },
    explainer: (r) => {
      const x = r as { issuerDid?: string; credentialId?: string; descriptorUrl?: string; vc?: { credentialSubject?: { achievement?: { name?: string } } } };
      if (!x?.credentialId) return <em>Bridge returned an error.</em>;
      return (
        <>
          The bridge built the OB3 VC, ran <code>verifyDataIntegrityProof</code> on itself before
          publishing (so a misconfigured issuer never leaves a broken credential), then PUT the wrapped
          descriptor to Joshua's pod at the URL below. Joshua's wallet picks it up next time he opens
          <em> export_clr</em>. Issuer DID: <code style={{ wordBreak: 'break-all' }}>{x.issuerDid?.slice(0, 60)}…</code>
          <br /><br />Try the learner-side flow — <em>step 3: Export my CLR</em> — to see this credential land in Joshua's wallet.
        </>
      );
    },
  },

  {
    title: 'Compose a one-query compliance audit trail',
    subtitle: 'foxxi.audit_compliance_trail · cmi5 → OB3 → CASE → ABAC → SOC 2',
    body: (
      <>
        Regulator asks: "show me everything that happened to Joshua's learning record this quarter,
        and which compliance controls each step references." Foxxi composes a single descriptor walk
        — every <code>iep:ContextDescriptor</code> with a Provenance facet or <code>dct:conformsTo</code> tag
        in the window comes back as an ordered chain. Each step's framework citations
        (SOC 2 / EU AI Act / NIST RMF / IEEE LERS) come from the descriptor's own
        <code>dct:conformsTo</code> — no separate compliance database, no audit-prep marathon.
      </>
    ),
    actionLabel: 'Walk Joshua’s audit trail',
    run: () => callBridge({
      tool: 'foxxi.audit_compliance_trail',
      args: { learner_did: JOSHUA.webId, learner_pod_url: POD },
      identity: 'jordan',
    }),
    summarize: (r) => {
      const x = r as { stepCount?: number; frameworksCited?: string[] };
      return x ? `${x.stepCount} steps · ${x.frameworksCited?.length} frameworks` : 'no result';
    },
    explainer: (r) => {
      const x = r as { stepCount?: number; frameworksCited?: string[]; steps?: Array<{ kind: string; validFrom?: string }> };
      if (!x?.stepCount) return <em>Bridge returned an error.</em>;
      const kindCounts: Record<string, number> = {};
      for (const s of x.steps ?? []) kindCounts[s.kind] = (kindCounts[s.kind] ?? 0) + 1;
      return (
        <>
          Walked the pod and assembled <strong>{x.stepCount} chained descriptors</strong> spanning
          {' '}<strong>{x.frameworksCited?.length} unique framework citations</strong>. Step-kind breakdown:
          {' '}{Object.entries(kindCounts).map(([k, n]) => `${k}×${n}`).join(', ')}. Each step is independently
          verifiable — the regulator can pick any descriptor, fetch its graph, re-verify its signature,
          re-check its policy. Every framework in <em>frameworksCited</em> is a real IRI that resolves to
          a standard spec (or to a vertical-side mapping ontology like <code>rcd:</code> / <code>fxa:</code>).
        </>
      );
    },
  },

  {
    title: 'Declare a cross-tenant competency alignment',
    subtitle: 'foxxi.declare_framework_alignment · 1EdTech CASE 1.0 CFAssociation',
    body: (
      <>
        Acme Training and PartnerCo use different internal competency names but mean the same thing for
        handicap. As Acme Training's L&amp;D admin, you declare an alignment: Foxxi's
        <code>handicap</code> ≡ PartnerCo's <code>ac-distribution-l2</code>. The declaration is
        published as a CASE 1.0 CFAssociation descriptor on your tenant pod; any PartnerCo agent that
        discovers it can now accept Acme Training-issued handicap credentials as satisfying their L2
        requirement. Zero re-credentialing.
      </>
    ),
    actionLabel: 'Declare Acme Training ≡ PartnerCo alignment',
    run: () => callBridge({
      tool: 'foxxi.declare_framework_alignment',
      args: {
        own_item_iri: 'urn:foxxi:comp:handicap',
        own_item_label: 'Handicap calculation',
        other_item_iri: 'urn:partnerco:comp:onboarding-l2',
        other_framework_iri: 'urn:partnerco:framework:onboarding',
        other_tenant_did: 'did:web:partnerco.example',
        relation: 'isEquivalentTo',
        rationale: 'Both standards require IBR control with handicap reference computation per industry onboarding standard §5.3.',
      },
      identity: 'jordan',
    }),
    summarize: (r) => {
      const x = r as { associationType?: string };
      return x?.associationType ? `relation: ${x.associationType}` : 'no result';
    },
    explainer: (r) => {
      const x = r as { identifier?: string; associationType?: string; originNode?: { uri: string }; destinationNode?: { uri: string; tenantDid?: string } };
      if (!x?.identifier) return <em>Bridge returned an error.</em>;
      return (
        <>
          The alignment is now a substrate-discoverable artifact. A PartnerCo agent calling
          <em> foxxi.resolve_aligned_competency</em> with their <code>ac-distribution-l2</code> requirement
          + this alignment in scope gets back <em>satisfied: true · via: aligned · 1 hop</em>. The
          CFAssociation IRI is <code>{x.identifier}</code>. The relation is <code>{x.associationType}</code>,
          which is bidirectional — works whether Acme Training or PartnerCo is the asking party.
        </>
      );
    },
  },

  {
    title: 'Export your competency framework as CASE 1.0',
    subtitle: 'foxxi.export_case_framework · 1EdTech CFDocument JSON-LD',
    body: (
      <>
        Hand your competency framework to any CASE-compliant tool (CaSS, CASE Network, downstream
        LMSes) without re-implementing Foxxi semantics. The bridge projects your tenant's
        <code>fxk:SkillFramework</code> + <code>fxk:Skill</code> items into a
        1EdTech <code>CFDocument</code> JSON-LD payload with the right <code>@context</code>, ready
        for upload.
      </>
    ),
    actionLabel: 'Export CASE 1.0 document',
    run: () => callBridge({
      tool: 'foxxi.export_case_framework',
      args: { framework_id: 'urn:foxxi:framework:acme:demo' },
      identity: 'jordan',
    }),
    summarize: (r) => {
      const x = r as { caseDoc?: { CFItems?: unknown[]; CFAssociations?: unknown[] } };
      return x?.caseDoc ? `${x.caseDoc.CFItems?.length} items · ${x.caseDoc.CFAssociations?.length} assocs` : 'no result';
    },
    explainer: (r) => {
      const x = r as { caseDoc?: { '@context'?: string; title?: string; CFItems?: unknown[]; CFRubrics?: unknown[] } };
      if (!x?.caseDoc) return <em>Bridge returned an error.</em>;
      return (
        <>
          Returned a CFDocument titled <em>{x.caseDoc.title}</em> with {x.caseDoc.CFItems?.length} CFItems
          {x.caseDoc.CFRubrics?.length ? ` and ${x.caseDoc.CFRubrics.length} CFRubrics` : ''}. The
          <code> @context</code> resolves to the official IMS Global CASE 1.0 JSON-LD context, so
          consumers don't need any Foxxi-specific code. Pair this with the alignment in step 4 — the
          CFAssociations array will start carrying every <em>isAlignedTo</em> / <em>isEquivalentTo</em>
          you declare.
        </>
      );
    },
  },
];
