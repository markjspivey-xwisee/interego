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
 *
 * ONE ERROR IS NOT A 500: `SubjectPodRefusedError` (src/subject-pod-url.ts). It is a decision, not
 * a fault: the request named a general guest whose records this bridge will not place (another
 * identity's guest, which would land on the shared tenant pod). It is thrown from the one pod
 * resolver, which some forty call sites reach, and every route that funnels its failures here
 * answered it 500. It is answered 403 with its reason code and nothing else. It arises only where
 * the dashboard's general guest is switched on; with the switch off this function is as it was.
 */
import { SubjectPodRefusedError } from './subject-pod-url.js';

export interface MinimalErrorResponse {
  status(code: number): { json(body: unknown): void };
}

export function sendServerError(res: MinimalErrorResponse, err: unknown, context: string): void {
  if (err instanceof SubjectPodRefusedError) {
    res.status(403).json({ ok: false, error: 'subject_pod_refused', reason: err.reason });
    return;
  }
  try {
    // eslint-disable-next-line no-console
    console.error(`[foxxi:500] ${context}:`, err instanceof Error ? (err.stack ?? err.message) : err);
  } catch { /* logging must never throw into the error path */ }
  res.status(500).json({ ok: false, error: 'internal error' });
}
