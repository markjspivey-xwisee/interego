const hostedSite = 'https://interego.xwisee.com';
export const hostedPrivacyUrl = `${hostedSite}/privacy/`;
const versionPattern = /^\d{4}-\d{2}-\d{2}$/;

export interface TermsAcceptance {
  version: string;
  acceptedAt: string;
}

export interface HostedTermsPolicy {
  version: string;
  termsUrl: string;
  statement: string;
}

export function hostedTermsPolicy(version: string | undefined): HostedTermsPolicy | null {
  if (!version) return null;
  if (!versionPattern.test(version)) throw new Error('HOSTED_TERMS_VERSION must be a YYYY-MM-DD release version');
  const termsUrl = `${hostedSite}/terms/${version}/`;
  return {
    version,
    termsUrl,
    statement: `I am at least 18 and agree to the Hosted Interego Terms of Service at ${termsUrl}`,
  };
}

export function readTermsAcceptance(value: unknown): TermsAcceptance | undefined {
  if (!value || typeof value !== 'object') return;
  const { version, acceptedAt } = value as Partial<TermsAcceptance>;
  if (typeof version === 'string' && versionPattern.test(version) && typeof acceptedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(acceptedAt)) return { version, acceptedAt };
}
