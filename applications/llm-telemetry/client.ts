import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeEvent, type TelemetryEvent } from './events.js';

export type McpCall = (tool: string, input: Record<string, unknown>) => Promise<any>;
export interface Outbox { read(): Promise<TelemetryEvent[]>; replace(events: TelemetryEvent[]): Promise<void> }
/** A private persistent outbox. Use one process per directory; runtime callers
 * share one TelemetryClient instance. The host owns its lifecycle and scheduling. */
export function fileOutbox(directory: string): Outbox {
  const filename = join(directory, 'pending.json');
  return {
    async read() { try { return JSON.parse(await readFile(filename, 'utf8')).map(normalizeEvent); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; } },
    async replace(events) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(events), { mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    },
  };
}
export function resultPayload(result: any): any {
  if (result?.isError) throw new Error('MCP request refused');
  let value = result?.structuredContent ?? result;
  if (result?.content && !result.structuredContent) {
    const content = result.content.find((c: any) => c.type === 'text');
    if (content) value = JSON.parse(content.text);
  }
  if (typeof value === 'string') value = JSON.parse(value);
  if (typeof value?.body === 'string') {
    if (value.status >= 400) throw new Error(`telemetry ingest returned ${value.status}; pending observations retained`);
    value = JSON.parse(value.body);
  }
  return value;
}
export class TelemetryClient {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: { source: string; session_id: string; call: McpCall; outbox: Outbox;
    descriptor_url?: string; action_iri?: string; onError?: (error: unknown) => void }) {}
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(fn); this.tail = next; return next;
  }
  async record(event: Omit<TelemetryEvent, 'source' | 'session_id' | 'source_event_id' | 'observed_at' | 'capture_mode'> & Partial<Pick<TelemetryEvent, 'source_event_id' | 'observed_at' | 'capture_mode'>>) {
    const full = normalizeEvent({ source: this.config.source, session_id: this.config.session_id,
      source_event_id: randomUUID(), observed_at: new Date().toISOString(), capture_mode: 'live', coverage: 'runtime-adapter', ...event });
    return this.serialized(async () => {
      const pending = await this.config.outbox.read();
      if (pending.length >= 10000) throw new Error('telemetry outbox capacity reached; drain it before recording more observations');
      await this.config.outbox.replace([...pending, full]); return full.source_event_id;
    });
  }
  async flush() {
    return this.serialized(async () => {
      let pending = await this.config.outbox.read(); let delivered = 0;
      while (pending.length) {
        const batch = pending.slice(0, 20);
        const receipt = resultPayload(await this.config.call('act', {
          descriptor_url: this.config.descriptor_url ?? 'https://foxxi-bridge.interego.xwisee.com/affordances',
          action_iri: this.config.action_iri ?? 'https://relay.interego.xwisee.com/ns/iep/action/llm-telemetry/ingest',
          sign_payload: true, payload: { events: batch },
        }));
        if (receipt?.ok !== true || receipt?.durable !== true || receipt?.statementIds?.length !== batch.length) throw new Error('durable delivery was not confirmed; retry the same pending observations');
        pending = pending.slice(batch.length); await this.config.outbox.replace(pending); delivered += batch.length;
      }
      return { delivered, pending: pending.length };
    });
  }
  /** Wrap actual work. No arguments, outputs or error text are inspected. An
   * explicit usage extractor may return measured quantities only. Capture/delivery
   * failures are reported via onError without changing the work's return/throw. */
  async observe<T>(family: 'model' | 'tool' | 'agent', metadata: Partial<TelemetryEvent>, work: () => Promise<T>,
    measuredUsage?: (result: T) => TelemetryEvent['usage']): Promise<T> {
    const operation = randomUUID(); const started = performance.now();
    const id = family === 'tool' ? { tool_use_id: operation } : family === 'model' ? { generation_id: operation } : { agent_id: operation };
    const notify = (error: unknown) => { try { this.config.onError?.(error); } catch { /* an observer must not change the work outcome */ } };
    const capture = async (event: any) => { try { await this.record(event); } catch (error) { notify(error); } };
    await capture({ ...metadata, ...id, kind: family === 'model' ? 'model-invoked' : `${family}-started` });
    let result: T;
    try { result = await work(); }
    catch (error) { await capture({ ...metadata, ...id, kind: `${family}-failed`, status: 'error', usage: { duration_ms: performance.now() - started } }); throw error; }
    let usage: TelemetryEvent['usage'];
    try { usage = measuredUsage?.(result); } catch (error) { notify(error); }
    await capture({ ...metadata, ...id, kind: family === 'agent' ? 'agent-stopped' : `${family}-completed`, status: 'ok', usage: { ...usage, duration_ms: performance.now() - started } });
    return result;
  }
}
