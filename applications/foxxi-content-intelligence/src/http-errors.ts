/**
 * Shared HTTP error responder (round-47). Echoing a raw `(err as Error).message`
 * to the caller leaks internal detail (CSS host names, pod URLs, file paths,
 * upstream/library error text) to unauthenticated and any-signed-wallet callers.
 *
 * Round-45 introduced this discipline but only for bridge/server.ts's own 500 sinks;
 * the src route modules (content-delivery, context-chat, lti13, performance-routes,
 * cmi5-lms) and the unauthenticated compliance-runner endpoints kept echoing raw
 * error text. server.ts imports FROM src (not the reverse), so the helper lives here in
 * src and BOTH layers import it: one choke point, no sink left to re-introduce the leak.
 *
 * Log the real error server-side for operators; return a generic, non-disclosing body.
 * A minimal structural Response type keeps this module free of a hard express import.
 */

export interface MinimalErrorResponse {
  status(code: number): { json(body: unknown): void };
}

export function sendServerError(res: MinimalErrorResponse, err: unknown, context: string): void {
  try {
    // eslint-disable-next-line no-console
    console.error(`[foxxi:500] ${context}:`, err instanceof Error ? (err.stack ?? err.message) : err);
  } catch { /* logging must never throw into the error path */ }
  res.status(500).json({ ok: false, error: 'internal error' });
}
