/** Optional, operator-installed resource interpreters. No domain is installed by default. */
import { mcpOutputSchema } from '@interego/core';
export interface ResourceDescriptor {
  readonly url: string;
  readonly cid?: string;
  readonly turtle?: string;
  readonly content?: string;
  readonly authorship?: {
    readonly authorshipVerified?: boolean;
    readonly contentBinding?: string;
    readonly descriptorBinding?: { readonly bound?: boolean };
    readonly effectiveTrustLevel?: string;
    readonly signedBy?: string;
    readonly verificationMethod?: string;
  } | null;
}
export interface ResourceEntry {
  readonly descriptorUrl: string;
  readonly cid?: string | null;
  readonly validFrom?: string | null;
  readonly supersedes?: readonly string[] | null;
  readonly describes?: readonly string[] | null;
}
export interface ResourceReads {
  discover(graphIri: string): Promise<readonly { podUrl: string; entry: ResourceEntry }[]>;
  currentHead(podUrl: string, graphIri: string): Promise<{
    readonly forked?: boolean;
    readonly head?: { readonly descriptorUrl?: string | null; readonly cid?: string | null } | null;
  }>;
  discoverGraph(podUrl: string, graphIri: string): Promise<readonly ResourceEntry[]>;
  descriptor(url: string): Promise<ResourceDescriptor>;
}
export interface ResourceSigningKey {
  readonly scheme: 'eip191' | 'ed25519' | 'webauthn';
  readonly address?: string;
  readonly publicKeyMultibase?: string;
  readonly publicKey?: string;
  readonly credentialId?: string;
  readonly origins?: readonly string[];
  readonly rpIds?: readonly string[];
}
export interface ResourceContext {
  readonly reads: ResourceReads;
  readonly principal: string;
  readonly identityUrl: string;
  readonly now: string;
  readonly relayUrl?: string;
  readonly clock?: () => number;
  /** Public verification material for the authenticated caller, never a signing oracle. */
  readonly signingKeys?: () => Promise<readonly ResourceSigningKey[]>;
  readonly interactionStatus?: (id: string) => Promise<Record<string, unknown>>;
}
export interface ResourceSignatureDraft {
  readonly reference: string;
  /** Immutable authority, evidence, actor and inputs; the module decides its semantics. */
  readonly binding: string;
  readonly request: { schema: string; message: string; keys: readonly { keyId: string; key: ResourceSigningKey }[]; expiresAt: string; clientGrants?: Record<string, unknown> };
}
export interface ResourceWriteContext extends ResourceContext {
  /** Attest current credential membership only after independently verifying the holder proof. */
  readonly attestClientRegistration?: (proof: unknown) => Promise<unknown>;
  readonly requestSignature?: (reference: string, action: string, payload: Record<string, unknown>, draft: ResourceSignatureDraft) => Promise<Record<string, unknown>>;
  readonly cancelInteraction?: (id: string) => Promise<Record<string, unknown>>;
  readonly renewInteraction?: (id: string) => Promise<Record<string, unknown>>;
  /** Mint a one-use browser launch scoped to this exact signing request. */
  readonly openInteraction?: (id: string) => Promise<Record<string, unknown>>;
  /** Session-bound, signed, synchronous CAS publication through the existing substrate gates. */
  readonly publish: (request: {
    podUrl: string; graphIri: string; graphContent: string; expectedHead: string; actor: string;
  }) => Promise<Record<string, unknown>>;
}
export interface ResourceView {
  readonly descriptorUrl: string;
  readonly title: string;
  readonly body: string;
  readonly hmd: string;
  readonly controls: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}
export interface ResourceComposition {
  /** Pure address recognition. It must perform no I/O and confer no document authority. */
  claims(reference: string): boolean;
  /** Exact operation classification. Unknown operations fail closed. */
  access(reference: string, action: string): 'read' | 'write' | undefined;
  render(reference: string, context: ResourceContext, descriptor?: ResourceDescriptor): Promise<ResourceView | undefined>;
  invoke(reference: string, action: string, payload: unknown, context: ResourceContext | ResourceWriteContext): Promise<Record<string, unknown>>;
  /** Re-resolves a draft for a human review. This never signs or publishes. */
  prepareSignature?(reference: string, action: string, payload: Record<string, unknown>, context: ResourceContext): Promise<ResourceSignatureDraft>;
  prepareClientGrant?(reference: string, action: string, payload: Record<string, unknown>, context: ResourceContext): Promise<{ action: string; payload: Record<string, unknown>; draft: ResourceSignatureDraft }>;
  validateSignature?(reference: string, action: string, payload: Record<string, unknown>, proof: unknown, context: ResourceContext): Promise<void>;
}

export class ResourceCompositions {
  constructor(private readonly modules: readonly ResourceComposition[] = []) {}

  private owner(reference: string): ResourceComposition | undefined {
    const matches = this.modules.filter(module => module.claims(reference));
    if (matches.length > 1) throw new Error('ambiguous resource composition');
    return matches[0];
  }

  claims(reference: string): boolean { return !!this.owner(reference); }

  access(reference: string, action: string): 'read' | 'write' | undefined {
    return this.owner(reference)?.access(reference, action);
  }

  async prepareSignature(reference: string, action: string, payload: Record<string, unknown>, context: ResourceContext): Promise<ResourceSignatureDraft> {
    const owner = this.owner(reference);
    if (!owner?.prepareSignature || owner.access(reference, action) !== 'write') throw new Error('resource does not support client signing');
    return owner.prepareSignature(reference, action, payload, readContext(context));
  }
  async prepareClientGrant(reference: string, action: string, payload: Record<string, unknown>, context: ResourceContext) {
    const owner = this.owner(reference);
    if (!owner?.prepareClientGrant || owner.access(reference, action) !== 'write') throw new Error('resource does not support scoped client grants');
    return owner.prepareClientGrant(reference, action, payload, readContext(context));
  }
  async validateSignature(reference: string, action: string, payload: Record<string, unknown>, proof: unknown, context: ResourceContext): Promise<void> {
    const owner = this.owner(reference);
    if (!owner?.validateSignature || owner.access(reference, action) !== 'write') throw new Error('resource signature validation is unavailable');
    return owner.validateSignature(reference, action, payload, proof, readContext(context));
  }

  async render(reference: string, context: ResourceContext, descriptor?: ResourceDescriptor): Promise<ResourceView | undefined> {
    // Copy only read capabilities even if the caller happens to hold a write context.
    const reads = readContext(context);
    const owner = this.owner(reference);
    if (owner) return owner.render(reference, reads, descriptor);
    const views = [];
    for (const module of this.modules) {
      const view = await module.render(reference, reads, descriptor);
      if (view) views.push(view);
    }
    if (views.length > 1) throw new Error('ambiguous resource representation');
    return views[0];
  }

  async invoke(reference: string, action: string, payload: unknown, context: ResourceWriteContext): Promise<Record<string, unknown> | undefined> {
    const owner = this.owner(reference);
    if (!owner) return undefined;
    const access = owner.access(reference, action);
    if (!access) throw new Error('operation is not declared on this resource');
    return owner.invoke(reference, action, payload, access === 'read' ? readContext(context) : context);
  }
}

function readContext(context: ResourceContext): ResourceContext {
  return Object.freeze({ reads: context.reads, principal: context.principal, identityUrl: context.identityUrl, now: context.now,
    ...(context.relayUrl ? { relayUrl: context.relayUrl } : {}), ...(context.clock ? { clock: context.clock } : {}),
    ...(context.signingKeys ? { signingKeys: context.signingKeys } : {}),
    ...(context.interactionStatus ? { interactionStatus: context.interactionStatus } : {}) });
}

export const INVOKE_AFFORDANCE_OUTPUT = mcpOutputSchema({
  type: 'object',
  description: 'Result of a iep:Affordance invocation — echo of the resolved affordance metadata plus the raw HTTP response from the target. Parse body based on contentType; 4xx is informative (e.g. forbidden / validation), 5xx is retried internally before surfacing.',
  properties: {
    status: { type: 'integer', description: 'HTTP status from the target' },
    statusText: { type: 'string' },
    contentType: { type: 'string', description: 'Content-Type header from the target (null when absent)' },
    body: { type: 'string', description: 'Response text, or base64 bytes when bodyEncoding is base64. Decode that encoding before interpreting contentType.' },
    bodyEncoding: { type: 'string', enum: ['base64'], description: 'Present for binary representations; absent for text.' },
    affordance: {
      type: 'object',
      description: 'Resolved affordance metadata from the descriptor',
      properties: {
        action: { type: 'string', description: 'iep:action IRI selected by the caller' },
        target: { type: 'string', description: 'hydra:target URL invoked' },
        method: { type: 'string', description: 'hydra:method (default POST when absent on the descriptor)' },
        mediaType: { type: 'string', description: 'dcat:mediaType when present' },
      },
      required: ['action', 'target', 'method'],
    },
  },
  required: ['status', 'statusText', 'contentType', 'body', 'affordance'],
});

/** Preserve the generic affordance follower's existing transport result schema. */
export function resourceActionResponse(reference: string, action: string, result: Record<string, unknown>, access: 'read' | 'write') {
  return {
    status: result['error'] ? 409 : 200,
    statusText: result['error'] ? 'Conflict' : 'OK',
    contentType: 'application/json', body: JSON.stringify(result),
    affordance: { action, target: reference, method: access === 'read' ? 'GET' : 'POST' },
  };
}

/** Match the kernel adapter's descriptor form, then its pre-resolved target form. */
export function resourceInvocation(args: Record<string, unknown>, allowTarget = false): { reference: string; action: string } | undefined {
  if (typeof args['descriptor_url'] === 'string' && args['descriptor_url']
    && typeof args['action_iri'] === 'string' && args['action_iri']) {
    return { reference: args['descriptor_url'], action: args['action_iri'] };
  }
  const action = args['action'] ?? args['action_iri'];
  if (allowTarget && typeof args['target'] === 'string' && args['target'] && typeof action === 'string' && action) {
    return { reference: args['target'], action };
  }
  return undefined;
}

/** Local modules are selected by deployment configuration, never by a fetched document. */
export async function loadResourceCompositions(configuration = '', builtins: readonly ResourceComposition[] = []): Promise<ResourceCompositions> {
  if (!configuration) return new ResourceCompositions(builtins);
  const paths: unknown = JSON.parse(configuration);
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
    throw new Error('INTEREGO_RESOURCE_COMPOSITIONS must be a JSON array of local module paths');
  }
  const modules: ResourceComposition[] = [...builtins];
  for (const path of paths as string[]) {
    const url = new URL(path, import.meta.url);
    if (url.protocol !== 'file:' || url.host) throw new Error('resource composition modules must be local files');
    const module = (await import(url.href)).default as ResourceComposition;
    if (!module || ['claims', 'access', 'render', 'invoke'].some(key => typeof (module as unknown as Record<string, unknown>)[key] !== 'function')) {
      throw new Error('invalid resource composition module');
    }
    modules.push(module);
  }
  return new ResourceCompositions(modules);
}
