/**
 * The two credential fixtures Foxxi's own code produces: an Open Badges 3.0 course-completion
 * credential (buildCourseCompletionVc) and the CLR 2.0 credential that bundles it (assembleClr),
 * from fixed inputs, so the same code always yields the same document. The fixtures beside this file
 * were written by tools/read-credential-fixtures.ts from these functions; the test that reads them
 * builds the documents again and requires them to be those fixtures, so the RDF reading checked in
 * with each is the reading of what the code produces now.
 */
import type { VerifiableCredentialJson } from '../../../../_shared/vc-jwt/data-integrity-jcs.js';
import { buildCourseCompletionVc, deriveTenantIssuer } from '../../../src/credentials.js';
import { assembleClr, type ClrEnvelope } from '../../../src/clr.js';

const SEED = 'foxxi-credential-fixture';
const LEARNER = 'did:web:learner.example';

export async function foxxiCourseCompletion(): Promise<VerifiableCredentialJson> {
  const issuer = await deriveTenantIssuer(SEED);
  return buildCourseCompletionVc({
    subject: {
      learnerDid: LEARNER,
      courseId: 'refunds-101',
      courseTitle: 'Refunds 101',
      alignedSkills: [{ targetCode: 'refund-disputes', targetName: 'Resolve a disputed refund', targetFramework: 'Example Support Skills', targetFrameworkUrl: 'https://skills.example/framework' }],
      derivedFromExperiences: ['https://bridge.example/xapi/statements?statementId=1b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a'],
      validFrom: '2026-10-01T12:00:00Z',
    },
    tenantProfileDid: 'did:web:tenant.example',
    tenantProfileName: 'Example Tenant',
    issuerSeed: SEED,
  }, issuer.did, 'https://pod.example/learner/foxxi-wallet/refunds-101');
}

export async function foxxiClr(): Promise<ClrEnvelope> {
  const credential = await foxxiCourseCompletion();
  return assembleClr(
    [{ credential, verified: false, verifierReason: 'a fixture: the credential is unsigned', sourceDescriptor: 'https://pod.example/learner/foxxi-wallet/refunds-101' }],
    { learnerPodUrl: 'https://pod.example/learner/', learnerDid: LEARNER, issuerSeed: SEED },
    '2026-10-02T12:00:00Z',
  );
}
