/**
 * The ledger: every call anyone makes in the demo, as it happens, pushed to the page over
 * server-sent events. A call is recorded pending before it goes out and settled when it comes
 * back, with its latency, what it left on a pod, and the request and response with anything
 * secret removed.
 */
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

export type Actor = 'you' | 'claude' | 'verifier' | 'jev' | 'bridge' | 'relay' | 'pod';

export interface LedgerLink {
  readonly label: string;
  readonly href: string;
}

export interface LedgerEntry {
  readonly id: string;
  readonly at: string;
  readonly actor: Actor;
  readonly service: string;
  readonly tool?: string;
  status: 'pending' | 'ok' | 'refused' | 'err';
  code?: string | number;
  ms?: number;
  summary?: string;
  links?: LedgerLink[];
  request?: unknown;
  response?: unknown;
}

const SECRET_KEY = /token|secret|private|password|verifier|apikey|api_key|authorization|cookie|seed|mnemonic/i;
const MAX_STRING = 6000;
const MAX_ITEMS = 60;

/** A copy safe to show: secret-looking keys removed, long strings and arrays cut. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '…';
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ITEMS).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ITEMS) out.push(`… ${value.length - MAX_ITEMS} more`);
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Hub {
  private readonly clients = new Set<Response>();
  readonly ledger: LedgerEntry[] = [];

  attach(res: Response): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    this.clients.add(res);
    const beat = setInterval(() => res.write(': beat\n\n'), 15_000);
    res.on('close', () => { clearInterval(beat); this.clients.delete(res); });
  }

  emit(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  toast(text: string): void { this.emit('toast', { text }); }

  private push(entry: LedgerEntry): void {
    const i = this.ledger.findIndex((e) => e.id === entry.id);
    if (i >= 0) this.ledger[i] = entry; else this.ledger.push(entry);
    if (this.ledger.length > 400) this.ledger.splice(0, this.ledger.length - 400);
    this.emit('ledger', entry);
  }

  /**
   * Record a call around `fn`: pending first, then settled with what `fn` says about it. A throw
   * settles the entry as an error and is rethrown.
   */
  async track<T>(
    meta: { actor: Actor; service: string; tool?: string; summary?: string; request?: unknown },
    fn: () => Promise<{ value: T; status?: 'ok' | 'refused' | 'err'; code?: string | number; summary?: string; links?: LedgerLink[]; response?: unknown }>,
  ): Promise<T> {
    const entry: LedgerEntry = { id: randomUUID(), at: new Date().toISOString(), actor: meta.actor, service: meta.service, status: 'pending', ...(meta.tool ? { tool: meta.tool } : {}), ...(meta.summary ? { summary: meta.summary } : {}), ...(meta.request !== undefined ? { request: redact(meta.request) } : {}) };
    this.push(entry);
    const started = Date.now();
    try {
      const r = await fn();
      entry.status = r.status ?? 'ok';
      entry.ms = Date.now() - started;
      if (r.code !== undefined) entry.code = r.code;
      if (r.summary) entry.summary = r.summary;
      if (r.links?.length) entry.links = r.links;
      if (r.response !== undefined) entry.response = redact(r.response);
      this.push(entry);
      return r.value;
    } catch (e) {
      entry.status = 'err';
      entry.ms = Date.now() - started;
      entry.summary = (e as Error).message;
      this.push(entry);
      throw e;
    }
  }
}
