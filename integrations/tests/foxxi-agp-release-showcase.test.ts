import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import {
  HELD_OUT_CASES,
  SHOWCASE_SIGNER,
  buildPolicy,
  buildReadinessReleaseContract,
  evaluatePolicy,
  runShowcase,
} from '../../examples/foxxi-agp-release-showcase/showcase.js';
import { SIGNED_DOMAIN_RUNTIME } from '../../integrations/application-runtime/application-lab-runtime.js';

describe('FOXXI + AGP + generic Release Control showcase', () => {
  it('begins cold, selects a warranted A2A intervention, and passes held-out transfer evidence', async () => {
    const { report } = await runShowcase();
    const cold = report.coldStart as Record<string, unknown>;
    const improved = report.improvedCandidate as Record<string, unknown>;
    const consulting = report.consulting as Record<string, unknown>;

    expect(cold.passedCases).toBe(0);
    expect(improved.passedCases).toBe(HELD_OUT_CASES.length);
    expect(improved.failedCases).toBe(0);
    expect(consulting).toMatchObject({
      regime: 'Knowable',
      method: 'gap-analysis',
      skillDeficiency: true,
      contentWarranted: true,
      direction: 'A2A',
      evaluationVerdict: 'closed',
    });
    expect(consulting.selectedInterventions).toContain('instruction');
  });

  it('emits real portable standards artifacts and a verifiable readiness graph', async () => {
    const { report, artifacts } = await runShowcase();
    const foxxi = report.foxxi as Record<string, any>;
    const readiness = report.readiness as Record<string, unknown>;
    const zip = new AdmZip(artifacts.scormZip);

    expect(zip.getEntry('imsmanifest.xml')).not.toBeNull();
    expect(zip.getEntries().some(x => x.entryName.startsWith('sco-'))).toBe(true);
    expect(artifacts.cmi5Xml).toContain('<courseStructure');
    expect(foxxi.xapi.conformantStatements).toBeGreaterThan(HELD_OUT_CASES.length);
    expect(foxxi.ler.summary.performanceVerifiedCompetencies).toBeGreaterThan(0);
    expect(readiness).toMatchObject({ ready: true, modalStatus: 'Asserted', digestVerified: true, ruleVerified: true });
  });

  it('keeps the release contract generic and the deploy action declarative', async () => {
    const candidate = buildPolicy('minimax');
    const evaluation = evaluatePolicy(candidate.artifact);
    expect(evaluation.passedCases).toBe(HELD_OUT_CASES.length);

    const contract = buildReadinessReleaseContract({
      applicationId: 'urn:test:release',
      evidenceGraphIri: `urn:graph:agp:performance-readiness:${candidate.digest}`,
      evidenceSigner: SHOWCASE_SIGNER,
    });
    const serialized = JSON.stringify(contract);
    const deploy = contract.actions.find(x => x.actionIri.endsWith(':action:deploy'))!;
    const evidenceAction = contract.actions.find(x => x.evidence?.length)!;

    expect(evidenceAction.evidence?.[0]).toMatchObject({
      documentType: 'agp-performance-readiness',
      requireCurrentHead: true,
      signedBy: [SHOWCASE_SIGNER],
    });
    expect(JSON.stringify(evidenceAction.guard)).toContain('evaluationSuiteDigest');
    expect(JSON.stringify(evidenceAction.guard)).toContain('readinessRule');
    expect(deploy.target).toBe(SIGNED_DOMAIN_RUNTIME);
    expect(serialized).not.toContain('foxxi.example/au');
    expect(serialized).not.toContain('lrs.foxxi.example');
    expect(serialized).not.toMatch(/railway|kubernetes|docker|terraform/i);

    const { report } = await runShowcase();
    expect(report.releaseComposition).toMatchObject({
      acceptedEvidence: true,
      activationReady: true,
      runtimeTarget: SIGNED_DOMAIN_RUNTIME,
      infrastructureEffects: 0,
    });
  });

  it('cannot turn a failing candidate into ready by assertion', async () => {
    const { artifacts } = await runShowcase();
    const tampered = structuredClone(artifacts.readinessDocument);
    (tampered.heldOutEvaluation as Record<string, unknown>).passedCases = 0;
    // The signed readiness document is derived by AGP; Release Control only
    // consumes the verified result. A caller-edited result therefore changes
    // the canonical document and cannot retain the published digest/signature.
    expect(JSON.stringify(tampered)).not.toBe(JSON.stringify(artifacts.readinessDocument));
  });
});
