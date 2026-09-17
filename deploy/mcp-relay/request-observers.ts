/** Optional deployment-installed observation composition. The relay supplies only
 * authenticated identity, routing selectors and outcome flags; never payloads,
 * credentials, tool contents or an invented host conversation identifier. */
export interface RequestObservationContext {
  readonly principal: string;
  readonly tool: string;
  readonly selector?: { reference: string; action?: string };
  readonly now: () => string;
  readonly follow: (descriptor: string, action: string, payload: Record<string, unknown>) => Promise<string>;
}
export interface RequestObservation {
  finish(failed: boolean, finishedAt: string): Promise<Record<string, unknown>>;
}
export interface RequestObserver {
  readonly id: string;
  begin(context: RequestObservationContext): Promise<RequestObservation | undefined>;
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('observation deadline exceeded')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export class RequestObservers {
  constructor(private readonly modules: readonly RequestObserver[] = [], private readonly timeoutMs = 10_000) {}
  async run<T>(context: RequestObservationContext | undefined, work: () => Promise<T>): Promise<T> {
    if (!context || !this.modules.length) return work();
    const tickets: Array<{ id: string; ticket: RequestObservation }> = [];
    const receipts: Record<string, unknown>[] = [];
    for (const module of this.modules) {
      try { const ticket = await bounded(module.begin(context), this.timeoutMs); if (ticket) tickets.push({ id: module.id, ticket }); }
      catch { receipts.push({ observer: module.id, status: 'unavailable', stage: 'consent' }); }
    }
    let result: T;
    let thrown: unknown; let didThrow = false; let failed = false;
    try { result = await work(); failed = !!result && typeof result === 'object' && (result as Record<string, unknown>).isError === true; }
    catch (error) { thrown = error; didThrow = true; failed = true; }
    const finishedAt = context.now();
    for (const { id, ticket } of tickets) {
      try { receipts.push({ observer: id, ...await bounded(ticket.finish(failed, finishedAt), this.timeoutMs) }); }
      catch { receipts.push({ observer: id, status: 'unconfirmed', stage: 'delivery' }); }
    }
    if (didThrow) throw thrown;
    // MCP metadata does not change the tool's structuredContent or declared schema.
    if (receipts.length && result! && typeof result === 'object' && !Array.isArray(result)) {
      const object = result as Record<string, unknown>;
      return { ...object, _meta: { ...(object._meta as Record<string, unknown> | undefined), 'https://relay.interego.xwisee.com/request-observations': receipts } } as T;
    }
    return result!;
  }
}
export async function loadRequestObservers(configuration = ''): Promise<RequestObservers> {
  if (!configuration) return new RequestObservers();
  const paths: unknown = JSON.parse(configuration);
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new Error('INTEREGO_REQUEST_OBSERVERS must be a JSON array of local module paths');
  const modules: RequestObserver[] = [];
  for (const path of paths as string[]) {
    const url = new URL(path, import.meta.url);
    if (url.protocol !== 'file:' || url.host) throw new Error('request observers must be local deployment modules');
    const module = (await import(url.href)).default as RequestObserver;
    if (!module || typeof module.id !== 'string' || typeof module.begin !== 'function') throw new Error('invalid request observer module');
    modules.push(module);
  }
  return new RequestObservers(modules);
}
