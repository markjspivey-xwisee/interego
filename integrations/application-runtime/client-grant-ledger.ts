/** Grant lifecycle shares the application's CAS chain with every authorized action. */
import { canonicalJson, type ApplicationAction, type ApplicationContract, type ApplicationState } from './application-lab-runtime.js';
import { clientKeyId, requireVerifiedClientAuthorization, type ClientSignature, type VerifiedClientAuthorization, type ClientSigningKey } from './client-authorization.js';
import { verifyClientSigningGrant, verifyDelegatedClientAuthorization, replayDelegatedClientSignature,
  requireVerifiedDelegatedClientAuthorization, type SignedClientSigningGrant, type ClientSigningGrant, type DelegatedClientSignature, type VerifiedDelegatedClientAuthorization } from './client-signing-grant.js';
import { verifyClientRegistration, type ClientRegistrationAttestation } from '../../deploy/mcp-relay/client-registration.js';

export interface ClientGrantPolicy {
  readonly schema: 'interego.application.client-grants/v1';
  readonly audience: string;
  readonly registrationVerifier: string;
}
export interface ClientGrantEntry {
  readonly envelope: SignedClientSigningGrant;
  readonly registration: ClientRegistrationAttestation;
  readonly enrolledAt: string;
  readonly revokedAt?: string;
}
export interface VerifiedClientGrantChange {
  readonly receipt: string;
  readonly ledger: readonly ClientGrantEntry[];
  readonly registration?: ClientRegistrationAttestation;
}
const changes = new WeakSet<object>();
const enrolledAdmissions = new WeakMap<object, string>();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid grant lifecycle data');
  return value as Record<string, unknown>;
};

export function validateClientGrantContract(contract: ApplicationContract): void {
  const policy = contract.clientSigningGrants;
  if (policy === undefined) {
    if (contract.actions.some(a => a.clientGrantOperation !== undefined || a.allowClientDelegation !== undefined)) throw new Error('client grants require an explicit versioned contract policy');
    return;
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).sort().join(',') !== 'audience,registrationVerifier,schema'
    || policy.schema !== 'interego.application.client-grants/v1'
    || typeof policy.audience !== 'string' || new URL(policy.audience).origin !== policy.audience || !policy.audience.startsWith('https://')
    || !/^did:ethr:0x[0-9a-f]{40}$/.test(policy.registrationVerifier)) throw new Error('invalid client-grant policy');
  for (const op of ['enroll', 'revoke']) {
    if (contract.actions.filter(a => a.clientGrantOperation === op).length !== 1) throw new Error('grant policy must declare one enrollment and one revocation action');
  }
  for (const action of contract.actions) {
    if (action.allowClientDelegation !== undefined && typeof action.allowClientDelegation !== 'boolean') throw new Error('allowClientDelegation must be boolean');
    if ((action.allowClientDelegation || action.clientGrantOperation) && action.clientSignature !== true) throw new Error('grant actions require client signatures');
    if (action.clientGrantOperation === undefined) continue;
    if (!['enroll', 'revoke'].includes(action.clientGrantOperation) || action.allowClientDelegation || action.effects?.length
      || (action.method ?? 'POST').toUpperCase() !== 'POST' || action.target !== 'urn:interego:runtime:signed-domain:v1') throw new Error('grant lifecycle cannot delegate itself or change application data');
    const names = action.clientGrantOperation === 'enroll' ? ['grant', 'possession'] : ['grantId'];
    if (canonicalJson(action.inputs?.map(x => x.name).sort()) !== canonicalJson(names.sort())
      || action.inputs?.some(x => x.type !== 'string' || x.required !== true)) throw new Error('grant lifecycle inputs must be exact required strings');
  }
}

export function clientGrantLedger(state: ApplicationState): readonly ClientGrantEntry[] {
  const ledger = state.clientSigningGrants ?? [];
  if (!Array.isArray(ledger) || ledger.length > 256) throw new Error('invalid or full client grant ledger');
  const ids = new Set<string>();
  for (const entry of ledger) {
    const id = entry?.envelope?.grant?.id;
    if (!id || ids.has(id) || typeof entry.enrolledAt !== 'string'
      || Object.keys(entry).some(k => !['envelope', 'registration', 'enrolledAt', 'revokedAt'].includes(k))) throw new Error('invalid client grant ledger entry');
    ids.add(id);
  }
  return ledger;
}

export function unsignedClientReceipt(receipt: Record<string, unknown>): string {
  const unsigned = { ...receipt };
  delete unsigned['clientAuthorization']; delete unsigned['clientDelegatedAuthorization']; delete unsigned['clientRegistration'];
  return canonicalJson(unsigned);
}

async function proposedLedger(input: {
  state: ApplicationState; contract: ApplicationContract; action: ApplicationAction;
  receipt: string; authorization: ClientSignature;
}) {
  const { state, contract, action, receipt, authorization } = input;
  const policy = contract.clientSigningGrants;
  if (!policy || !action.clientGrantOperation) throw new Error('grant lifecycle is not declared');
  const ledger = clone(clientGrantLedger(state));
  const r = record(JSON.parse(receipt)); const payload = record(r['payload']); const actor = String(r['actor']);
  if (action.clientGrantOperation === 'revoke') {
    const found = ledger.find(entry => entry.envelope.grant.id === payload['grantId']);
    if (!found || found.envelope.grant.actor !== actor || found.envelope.grant.issuer !== actor || found.revokedAt !== undefined) throw new Error('only the grant owner can revoke an active grant');
    return { ledger: ledger.map(entry => entry === found ? { ...entry, revokedAt: String(r['at']) } : entry) };
  }
  const grant = record(JSON.parse(String(payload['grant']))) as unknown as ClientSigningGrant;
  const possessionProof = JSON.parse(String(payload['possession'])) as ClientSignature;
  if (ledger.length >= 256 || ledger.some(entry => entry.envelope.grant.id === grant.id)) throw new Error('grant already enrolled or ledger full');
  if (!contract.actions.some(a => a.actionIri === grant.actionIri && a.allowClientDelegation === true)) throw new Error('grant target does not allow delegated client signing');
  const verified = await verifyClientSigningGrant({ grant, possessionProof, issuerProof: authorization, enrollmentReceipt: receipt }, {
    issuer: actor, actor, audience: policy.audience, issuerKeys: [authorization.key], now: () => Date.parse(String(r['at'])), enrollmentActionIri: action.actionIri,
  });
  return { ledger, verified };
}

export async function validateClientGrantProposal(input: {
  state: ApplicationState; contract: ApplicationContract; action: ApplicationAction; receipt: string; authorization: VerifiedClientAuthorization;
}): Promise<void> {
  const auth = requireVerifiedClientAuthorization(input.authorization, input.receipt);
  await proposedLedger({ ...input, authorization: auth.proof });
}

async function nextLedger(input: {
  state: ApplicationState; contract: ApplicationContract; action: ApplicationAction;
  receipt: string; authorization: ClientSignature; registration?: unknown;
}): Promise<readonly ClientGrantEntry[]> {
  const { ledger, verified } = await proposedLedger(input);
  if (!verified) {
    if (input.registration !== undefined) throw new Error('unexpected registration on revocation');
    return ledger;
  }
  const { grant } = verified.envelope;
  const registration = verifyClientRegistration(input.registration, input.receipt, grant.actor, verified.issuerKeyId, input.contract.clientSigningGrants!.registrationVerifier);
  if (Date.parse(registration.at) < Date.parse(grant.notBefore) || Date.parse(registration.at) >= Date.parse(grant.expiresAt)) throw new Error('grant expired before registration was attested');
  return [...ledger, { envelope: verified.envelope, registration: clone(registration), enrolledAt: registration.at }];
}

export async function prepareClientGrantChange(input: {
  state: ApplicationState; contract: ApplicationContract; action: ApplicationAction; receipt: string;
  authorization: VerifiedClientAuthorization;
  attest: (proof: unknown) => Promise<unknown>;
}): Promise<VerifiedClientGrantChange> {
  const auth = requireVerifiedClientAuthorization(input.authorization, input.receipt);
  await validateClientGrantProposal(input);
  const registration = input.action.clientGrantOperation === 'enroll' ? await input.attest(auth.proof) : undefined;
  const ledger = await nextLedger({ ...input, authorization: auth.proof, ...(registration ? { registration } : {}) });
  const result = freeze({ receipt: input.receipt, ledger, ...(registration ? { registration: registration as ClientRegistrationAttestation } : {}) });
  changes.add(result); return result;
}

export function requireClientGrantChange(value: VerifiedClientGrantChange | undefined, receipt: string) {
  if (!value || !changes.has(value) || value.receipt !== receipt) throw new Error('verified grant lifecycle change is required');
  return value;
}

export async function replayClientGrantLedger(input: {
  state: ApplicationState; successor: ApplicationState; contract: ApplicationContract; action: ApplicationAction;
  receipt: Record<string, unknown>; authorization?: ClientSignature;
}): Promise<void> {
  const expected = input.action.clientGrantOperation
    ? await nextLedger({ ...input, receipt: unsignedClientReceipt(input.receipt), authorization: input.authorization!, registration: input.receipt['clientRegistration'] })
    : clientGrantLedger(input.state);
  if (!input.action.clientGrantOperation && input.receipt['clientRegistration'] !== undefined) throw new Error('unexpected client registration attestation');
  if (canonicalJson(expected) !== canonicalJson(clientGrantLedger(input.successor))) throw new Error('grant ledger replay did not reproduce the successor');
}

function enrolledProof(raw: unknown, state: ApplicationState, contract: ApplicationContract, receipt: string) {
  const proof = clone(raw) as DelegatedClientSignature;
  const id = proof?.grant?.grant?.id;
  const entry = clientGrantLedger(state).find(v => v.envelope.grant.id === id);
  if (!entry || entry.revokedAt !== undefined || canonicalJson(proof.grant) !== canonicalJson(entry.envelope)) throw new Error('delegated grant is not the active enrolled grant');
  const r = record(JSON.parse(receipt));
  if (Date.parse(String(r['at'])) < Date.parse(entry.enrolledAt)) throw new Error('action predates grant enrollment');
  const policy = contract.clientSigningGrants;
  const action = contract.actions.find(a => a.actionIri === r['actionIri']);
  if (!policy || action?.allowClientDelegation !== true || !entry.envelope.enrollmentReceipt) throw new Error('contract does not allow this delegated proof');
  const enrollmentActionIri = String(record(JSON.parse(entry.envelope.enrollmentReceipt))['actionIri']);
  if (!contract.actions.some(a => a.actionIri === enrollmentActionIri && a.clientGrantOperation === 'enroll')) throw new Error('grant enrollment action is absent from current contract');
  if (entry.envelope.grant.contractDigest !== r['contractDigest'] || entry.envelope.grant.audience !== policy.audience) throw new Error('grant is outside the current policy');
  verifyClientRegistration(entry.registration, entry.envelope.enrollmentReceipt, entry.envelope.grant.actor,
    clientKeyId(entry.envelope.issuerProof.key), policy.registrationVerifier);
  return { proof, entry, policy, enrollmentActionIri };
}

export async function authorizeEnrolledClientGrant(raw: unknown, receipt: string, input: {
  state: ApplicationState; contract: ApplicationContract; actor: string; audience: string;
  keys: readonly ClientSigningKey[]; now: () => number;
}): Promise<VerifiedDelegatedClientAuthorization> {
  const { proof, entry, policy, enrollmentActionIri } = enrolledProof(raw, input.state, input.contract, receipt);
  if (policy.audience !== input.audience) throw new Error('grant audience is not this relay');
  const admitted = await verifyDelegatedClientAuthorization(proof, receipt, { actor: input.actor, issuer: input.actor,
    audience: input.audience, issuerKeys: input.keys, now: input.now, enrollmentActionIri,
    // The predecessor ledger is immutable. Publication MUST CAS this same state:
    // revocation and action contend on one head, including across relay processes.
    readStatus: async binding => binding.id === entry.envelope.grant.id && binding.actor === input.actor ? 'active' : 'unknown',
  });
  enrolledAdmissions.set(admitted, canonicalJson(clientGrantLedger(input.state)));
  return admitted;
}

export function requireEnrolledClientGrant(value: VerifiedDelegatedClientAuthorization, state: ApplicationState, receipt: string) {
  requireVerifiedDelegatedClientAuthorization(value, receipt);
  if (enrolledAdmissions.get(value) !== canonicalJson(clientGrantLedger(state))) throw new Error('delegated proof must be admitted against this enrolled predecessor');
  return value;
}

export async function replayEnrolledClientGrant(raw: unknown, receipt: string, state: ApplicationState, contract: ApplicationContract) {
  const { proof } = enrolledProof(raw, state, contract, receipt);
  return { ...await replayDelegatedClientSignature(proof, receipt), issuerScheme: proof.grant.issuerProof.key.scheme };
}
