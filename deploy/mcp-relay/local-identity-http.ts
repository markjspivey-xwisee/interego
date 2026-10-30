/** Native-only handoff transport. Provider URLs always come from server configuration. */
import type { RequestHandler } from 'express';
import { LocalIdentityHandoffs, type LocalIdentityChallenge } from './local-identity-handoff.js';

export function localIdentityContextHandler(handoffs: LocalIdentityHandoffs): RequestHandler {
  return async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    if (req.headers.origin !== undefined || !req.is('application/json') || !req.body || Array.isArray(req.body)
      || Object.keys(req.body).length !== 1 || typeof req.body.handoffCode !== 'string') {
      res.status(400).json({ error: 'Open this sign-in request with the installed Interego app.' }); return;
    }
    const cancel = new AbortController();
    const closed = () => { if (!res.writableEnded) cancel.abort(); }; res.on('close', closed);
    try { const context = await handoffs.context(req.body.handoffCode, cancel.signal); if (!cancel.signal.aborted) res.json(context); }
    catch { if (!cancel.signal.aborted) res.status(400).json({ error: 'This local sign-in request expired. Start sign-in again.' }); }
    finally { res.off('close', closed); }
  };
}

export async function fetchLocalIdentityChallenge(identityOrigin: string, signal: AbortSignal): Promise<LocalIdentityChallenge> {
  // No caller-controlled destination, redirect or ambient bearer is accepted.
  const response = await fetch(new URL('/challenges', identityOrigin), { method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ purpose: 'did-sig' }) });
  if (!response.ok || !response.body) throw new Error('Identity challenge unavailable');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8192) throw new Error('Identity challenge too large'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as LocalIdentityChallenge;
}
