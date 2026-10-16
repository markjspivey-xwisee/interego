/** Same-process transport for the signed xAPI adapter. This awaits the ordinary
 * authenticated LRS resource; a transport timeout is never evidence of rollback. */
import type { SelfXapiDependencies } from './self-xapi.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 180_000;

function checkedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error('FOXXI_SIGNED_XAPI_TIMEOUT_MS must be an integer from 30000 to 180000');
  }
  return value;
}

export function configuredSelfXapiTimeout(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FOXXI_SIGNED_XAPI_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) throw new Error('FOXXI_SIGNED_XAPI_TIMEOUT_MS must be an integer from 30000 to 180000');
  return checkedTimeout(Number(raw));
}

export function createSelfXapiRequest(options: {
  port: number;
  principal: string;
  secret: string;
  timeoutMs?: number;
  transport?: typeof globalThis.fetch;
}): SelfXapiDependencies['request'] {
  const timeoutMs = checkedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('invalid loopback LRS port');
  const transport = options.transport ?? globalThis.fetch;
  return async (method, query, body) => {
    const url = new URL(`http://127.0.0.1:${options.port}/xapi/statements`);
    url.search = query.toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Loopback LRS request timed out', 'TimeoutError')), timeoutMs);
    try {
      const response = await transport(url, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Experience-API-Version': '2.0.0',
          Authorization: `Basic ${Buffer.from(`${options.principal}:${options.secret}`).toString('base64')}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Keep the same deadline through the body, not just response headers.
      return { status: response.status, body: await response.json() as unknown };
    } finally { clearTimeout(timer); }
  };
}
