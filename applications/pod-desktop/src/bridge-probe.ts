import { setTimeout as delay } from 'node:timers/promises';

export interface BridgeReadiness { readonly path: string; readonly expected: string; }
export class BridgeRouteError extends Error {
  constructor() { super('Your public address did not reach this Interego app. Check its hostname and the copied local target in your tunnel settings, then try again. Your saved pairings were kept.'); }
}

/** Check only a fresh public nonce; never send credentials or notes to a test URL. */
export async function verifyBridgeRoute(origin: string, proof: BridgeReadiness, signal: AbortSignal): Promise<void> {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin || proof.path !== '/.well-known/interego-bridge'
    || !/^[a-zA-Z0-9_-]{16,128}$/.test(proof.expected)) throw new BridgeRouteError();
  for (let attempt = 0; attempt < 8; attempt++) {
    signal.throwIfAborted();
    const request = new AbortController();
    const active = AbortSignal.any([signal, request.signal, AbortSignal.timeout(4_000)]);
    try {
      const response = await fetch(`${origin}${proof.path}`, { redirect: 'manual', signal: active,
        headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
      if (response.ok && response.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json') {
        const reader = response.body?.getReader();
        let body = ''; let size = 0;
        if (reader) {
          try {
            while (true) {
              const chunk = await reader.read(); if (chunk.done) break;
              size += chunk.value.length;
              if (size > 4096) throw new BridgeRouteError();
              body += Buffer.from(chunk.value).toString('utf8');
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
        const result = JSON.parse(body) as { challenge?: unknown };
        if (result.challenge === proof.expected) return;
      } else await response.body?.cancel();
    } catch { signal.throwIfAborted(); }
    finally { request.abort(); }
    if (attempt < 7) await delay(1_000, undefined, { signal });
  }
  throw new BridgeRouteError();
}
