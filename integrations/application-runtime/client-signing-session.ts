/** An existing agent signer submits its own reviewed proof through its own MCP session. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './application-lab-runtime.js';
import { clientKeyId, clientSigningMessage, verifyClientAuthorization, type ClientSigningKey, type ClientSignature } from './client-authorization.js';

interface Control { readonly descriptorUrl: string; readonly action: string }
type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface ClientSigningScope {
  readonly actor: string;
  readonly applicationId: string;
  readonly actionIri: string;
  readonly contractDigest: string;
  readonly expiresAt: string;
  /** Runtime-owned review of the exact receipt and evidence; never a model-supplied flag. */
  readonly review: (receipt: Readonly<Record<string, unknown>>, digest: string) => Promise<boolean>;
}

function result(value: Record<string, unknown>): Record<string, unknown> {
  if (value['isError']) throw new Error('MCP operation refused');
  const body = value['structuredContent'] as Record<string, unknown> | undefined ?? value;
  if (typeof body['status'] === 'number' && body['status'] >= 400) throw new Error('MCP operation refused');
  const out = typeof body['body'] === 'string' && typeof body['status'] === 'number'
    ? JSON.parse(body['body']) as Record<string, unknown> : body;
  if (out['error']) throw new Error('MCP operation refused');
  return out;
}

/**
 * Scope is configured in the real key holder's runtime, not passed through a model
 * tool. Server-side account registration, current delegation and CAS still apply.
 * This neither provisions a key nor grants a hosted connector access to a signer.
 */
export function clientSigningSession(config: {
  call: Call;
  key: ClientSigningKey;
  sign: (message: string) => Promise<string>;
  scope: ClientSigningScope;
  now?: () => number;
}) {
  // Copy immutable authority before any async call. A caller cannot mutate it mid-review.
  const key = JSON.parse(JSON.stringify(config.key)) as ClientSigningKey;
  if (!['eip191', 'ed25519'].includes(key.scheme)) throw new Error('An existing runtime-held signing key is required');
  const keyId = clientKeyId(key);
  const { actor, applicationId, actionIri, contractDigest, expiresAt, review } = config.scope;
  const now = config.now ?? Date.now;
  const checkExpiry = () => {
    if (!Number.isFinite(Date.parse(expiresAt)) || now() >= Date.parse(expiresAt)) throw new Error('Signing scope expired');
  };
  return {
    async execute(preview: Control, submit: Control, payload: Record<string, unknown> = {}) {
      checkExpiry();
      if (preview.action !== actionIri || submit.action !== actionIri) throw new Error('Action is outside signing scope');
      const controls = { preview: { ...preview }, submit: { ...submit } };
      const inputs = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
      if ('client_proof' in inputs) throw new Error('The signer owns the proof field');
      const prepared = result(await config.call('invoke_affordance', {
        descriptor_url: controls.preview.descriptorUrl, action_iri: actionIri, payload: inputs,
      }));
      const request = prepared['signingRequest'] as { schema: string; message: string; expiresAt: string; keys: { keyId: string; key: ClientSigningKey }[] } | undefined;
      if (!request || request.schema !== 'interego.client-signing-request/v1') throw new Error('No client signing request was returned');
      const message = request.message;
      const receipt = JSON.parse(message) as Record<string, unknown>;
      if (message !== canonicalJson(receipt) || receipt['actor'] !== actor || receipt['applicationId'] !== applicationId
        || receipt['actionIri'] !== actionIri || receipt['contractDigest'] !== contractDigest
        || canonicalJson(receipt['payload']) !== canonicalJson(inputs)) throw new Error('Receipt is outside signing scope');
      if (!request.keys.some(entry => entry.keyId === keyId && clientKeyId(entry.key) === keyId)) throw new Error('The runtime key is not registered for this session');
      const expires = Date.parse(request.expiresAt);
      const at = Date.parse(String(receipt['at']));
      const fresh = () => {
        checkExpiry();
        if (!Number.isFinite(at) || !Number.isFinite(expires) || now() >= expires || at > now() + 30_000 || now() - at > 600_000) throw new Error('Signing receipt expired');
      };
      fresh();
      if (!await review(JSON.parse(message) as Record<string, unknown>, createHash('sha256').update(message).digest('hex'))) throw new Error('Receipt review refused');
      fresh();
      const proof: ClientSignature = { schema: 'interego.client-signature/v1', key, message,
        signature: await config.sign(clientSigningMessage(message, key)) };
      fresh();
      await verifyClientAuthorization(proof, message, [key]);
      // Exactly one submit. Unknown outcomes require read-only reconciliation,
      // never blind retry or falling back to a human/relay signature.
      return result(await config.call('invoke_affordance', {
        descriptor_url: controls.submit.descriptorUrl, action_iri: actionIri,
        payload: { ...inputs, client_proof: JSON.stringify(proof) },
      }));
    },
  };
}
