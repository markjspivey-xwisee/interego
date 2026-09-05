/** Optional, operator-installed resource interpreters. No domain is installed by default. */
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
export interface ResourceContext {
  readonly reads: ResourceReads;
  readonly principal: string;
  readonly identityUrl: string;
  readonly now: string;
}
export interface ResourceWriteContext extends ResourceContext {
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
  return Object.freeze({ reads: context.reads, principal: context.principal, identityUrl: context.identityUrl, now: context.now });
}

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
export async function loadResourceCompositions(configuration = ''): Promise<ResourceCompositions> {
  if (!configuration) return new ResourceCompositions();
  const paths: unknown = JSON.parse(configuration);
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
    throw new Error('INTEREGO_RESOURCE_COMPOSITIONS must be a JSON array of local module paths');
  }
  const modules: ResourceComposition[] = [];
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
