// Unit tests for the AMEP same-origin session bridge — the security-critical
// gate that decides when the relay auto-forwards a caller's OAuth bearer to
// POST /amep/acts and stamps act.actor. Run: tsx _amep-session-bridge-test.ts
import { applicationActionMcpRequest, amepSameOriginUrl, withAmepSession, principalIri, isIriLike } from './amep-session-bridge.js';
import type { FetchFn } from '@interego/core';

const BASE = 'https://relay.interego.xwisee.com';
let ok = 0, bad = 0;
const check = (n: string, p: boolean, d = '') => { p ? ok++ : bad++; console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };

// ── amepSameOriginUrl: the same-origin gate ──────────────────
check('same-origin /amep/acts → matched', !!amepSameOriginUrl(`${BASE}/amep/acts`, BASE));
check('same-origin /amep/exchanges/x → matched (read path)', !!amepSameOriginUrl(`${BASE}/amep/exchanges/x`, BASE));
check('EXTERNAL host → null (no forward off-origin)', amepSameOriginUrl('https://evil.example.com/amep/acts', BASE) === null);
check('same host, DIFFERENT port → null', amepSameOriginUrl('https://relay.interego.xwisee.com:8443/amep/acts', BASE) === null);
check('same host, http (scheme) → null', amepSameOriginUrl('http://relay.interego.xwisee.com/amep/acts', BASE) === null);
check('non-/amep path → null', amepSameOriginUrl(`${BASE}/mcp`, BASE) === null);
check('lookalike /amep-evil/ → null', amepSameOriginUrl(`${BASE}/amep-evil/acts`, BASE) === null);
check('path traversal /amep/../x → null (URL-normalized off /amep)', amepSameOriginUrl(`${BASE}/amep/../x`, BASE) === null);
check('userinfo@host still same origin (harmless, fetch ignores it)', !!amepSameOriginUrl(`https://evil@relay.interego.xwisee.com/amep/acts`, BASE));
check('unset base → null (fail closed)', amepSameOriginUrl(`${BASE}/amep/acts`, '') === null);
check('malformed url → null', amepSameOriginUrl('::::not a url', BASE) === null);
check('external host with base as path segment → null (no prefix bypass)', amepSameOriginUrl('https://relay.interego.xwisee.com.evil.com/amep/acts', BASE) === null);

// ── Application action MCP loopback: URL + body gate ───────────────
const MCP = `${BASE}/mcp`;
const APP_RPC = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_application_action', arguments: {} } });
const RPC_INIT = { method: 'POST', body: APP_RPC };
check('same-origin exact Application Lab tools/call → matched', !!applicationActionMcpRequest(MCP, BASE, RPC_INIT));
check('external MCP lookalike → null', applicationActionMcpRequest('https://evil.example.com/mcp', BASE, RPC_INIT) === null);
check('same-origin REST shortcut → null', applicationActionMcpRequest(`${BASE}/tool/execute_application_action`, BASE, RPC_INIT) === null);
check('MCP query string → null', applicationActionMcpRequest(`${MCP}?tool=execute_application_action`, BASE, RPC_INIT) === null);
check('GET MCP → null', applicationActionMcpRequest(MCP, BASE, { method: 'GET', body: APP_RPC }) === null);
check('another nested tool → null', applicationActionMcpRequest(MCP, BASE, { method: 'POST', body: APP_RPC.replace('execute_application_action', 'publish_context') }) === null);
check('another JSON-RPC method → null', applicationActionMcpRequest(MCP, BASE, { method: 'POST', body: APP_RPC.replace('tools/call', 'tools/list') }) === null);
check('malformed JSON-RPC body → null', applicationActionMcpRequest(MCP, BASE, { method: 'POST', body: '{' }) === null);

// ── principalIri: the AMEP actor IRI (never the bare userId slug) ──
check('isIriLike: did:/https: true, bare slug false', isIriLike('did:web:x') && isIriLike('https://x/c#me') && !isIriLike('u-pk-a') && !isIriLike(undefined));
check('principalIri: agent DID (IRI) preferred', principalIri('did:web:h:agents:chatgpt-u-pk-a', 'https://h/u-pk-a/card#me', 'u-pk-a') === 'did:web:h:agents:chatgpt-u-pk-a');
check('principalIri: bare agent → WebID (IRI) fallback', principalIri('chatgpt-u-pk-a', 'https://h/u-pk-a/card#me', 'u-pk-a') === 'https://h/u-pk-a/card#me');
check('principalIri: never returns a bare slug when an IRI exists', /^[a-z][a-z0-9+.-]*:/i.test(principalIri('chatgpt-u-pk-a', 'https://h/card#me', 'u-pk-a')));

// ── withAmepSession: credential injection + actor stamp ──────
// Recording fake solidFetch: captures (url, init) and returns a minimal response.
function recorder() {
  const calls: Array<{ url: string; init: any }> = [];
  const fn: FetchFn = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201, statusText: 'OK', headers: { get: () => null }, text: async () => '', json: async () => ({}) }; };
  return { fn, calls };
}
const DEPS = (solidFetch: FetchFn) => ({ solidFetch, publicBaseUrl: BASE });
const authHdr = (init: any) => Object.entries(init?.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
const acceptHdr = (init: any) => Object.entries(init?.headers ?? {}).find(([k]) => k.toLowerCase() === 'accept')?.[1];

// 1. same-origin POST /amep/acts, no explicit auth → Authorization auto-attached + redirect manual
{
  const rec = recorder();
  const { fetch } = withAmepSession(`${BASE}/amep/acts`, { act: {} }, { sessionBearer: 'TОКEN', principalId: 'u-pk-x' }, DEPS(rec.fn));
  await fetch(`${BASE}/amep/acts`, { method: 'POST', body: '{}' });
  check('POST /amep/acts → bearer auto-attached', authHdr(rec.calls[0]?.init) === 'Bearer TОКEN');
  check('POST /amep/acts → redirect:manual set', rec.calls[0]?.init?.redirect === 'manual');
}
// 2. same-origin GET (descriptor/head read) → NO bearer
{
  const rec = recorder();
  const { fetch } = withAmepSession(`${BASE}/amep/exchanges/x`, {}, { sessionBearer: 'TOK', principalId: 'u-pk-x' }, DEPS(rec.fn));
  await fetch(`${BASE}/amep/exchanges/x`, { method: 'GET' });
  check('GET /amep read → NO bearer attached', authHdr(rec.calls[0]?.init) === undefined);
}
// 3. EXTERNAL POST → NO bearer (never leaks off-origin)
{
  const rec = recorder();
  const { fetch } = withAmepSession('https://evil.example.com/amep/acts', {}, { sessionBearer: 'TOK', principalId: 'u-pk-x' }, DEPS(rec.fn));
  await fetch('https://evil.example.com/amep/acts', { method: 'POST', body: '{}' });
  check('EXTERNAL POST → NO bearer (no off-origin leak)', authHdr(rec.calls[0]?.init) === undefined);
}
// 4. explicit auth supplied → wrapper is bypassed (plain solidFetch), no auto-attach
{
  const rec = recorder();
  const { fetch } = withAmepSession(`${BASE}/amep/acts`, {}, { sessionBearer: 'TOK', principalId: 'u-pk-x', explicitAuth: 'Bearer USERSET' }, DEPS(rec.fn));
  await fetch(`${BASE}/amep/acts`, { method: 'POST', body: '{}' });
  check('explicit auth present → no auto-attach (caller controls it)', authHdr(rec.calls[0]?.init) === undefined);
}
// 5. actor stamp: same-origin + actor absent → stamped to principal
{
  const { payload } = withAmepSession(`${BASE}/amep/acts`, { act: { actType: 'amep:Compose' } }, { sessionBearer: 'T', principalId: 'u-pk-alice' }, DEPS(recorder().fn));
  check('actor absent → stamped to principal id', (payload as any)?.act?.actor === 'u-pk-alice');
}
// 6. actor binding: caller set a DIFFERENT actor → OVERRIDDEN to principal
//    (always-you; you can never be attributed as someone else, no 403 to reason about)
{
  const { payload } = withAmepSession(`${BASE}/amep/acts`, { act: { actor: 'did:key:someoneElse' } }, { sessionBearer: 'T', principalId: 'u-pk-alice' }, DEPS(recorder().fn));
  check('explicit different actor → OVERRIDDEN to principal (always-you, no impersonation)', (payload as any)?.act?.actor === 'u-pk-alice');
}
// 7. actor stamp: EXTERNAL target → NOT stamped
{
  const { payload } = withAmepSession('https://evil.example.com/amep/acts', { act: {} }, { sessionBearer: 'T', principalId: 'u-pk-alice' }, DEPS(recorder().fn));
  check('external target → actor NOT stamped', (payload as any)?.act?.actor === undefined);
}
// 8. no principal (operator/legacy path) → no stamp, no forward wrapper
{
  const rec = recorder();
  const { fetch, payload } = withAmepSession(`${BASE}/amep/acts`, { act: {} }, {}, DEPS(rec.fn));
  await fetch(`${BASE}/amep/acts`, { method: 'POST', body: '{}' });
  check('no session → no bearer, no stamp', authHdr(rec.calls[0]?.init) === undefined && (payload as any)?.act?.actor === undefined);
}
// 9. YAML string payload → parsed + stamped (AMEP content-type is affordance+yaml)
{
  const { payload } = withAmepSession(`${BASE}/amep/acts`, 'act:\n  actType: amep:Compose\n', { sessionBearer: 'T', principalId: 'u-pk-bob' }, DEPS(recorder().fn));
  check('yaml-string payload → parsed + actor stamped', (payload as any)?.act?.actor === 'u-pk-bob');
}

// ── Application Lab executor session bridge ──────────────────────────────
// 10. Exact same-origin executor tools/call → bearer attached + redirect disabled.
{
  const rec = recorder();
  const { fetch } = withAmepSession(MCP, {}, { sessionBearer: 'LABTOK' }, DEPS(rec.fn));
  await fetch(MCP, RPC_INIT);
  check('Application action MCP call → bearer auto-attached', authHdr(rec.calls[0]?.init) === 'Bearer LABTOK');
  check('Application action MCP call → Streamable HTTP Accept', acceptHdr(rec.calls[0]?.init) === 'application/json, text/event-stream');
  check('Application action MCP call → redirect:manual set', rec.calls[0]?.init?.redirect === 'manual');
}
// 11. GET, another nested tool, REST shortcut, and external MCP never receive it.
{
  const rec = recorder();
  const { fetch } = withAmepSession(MCP, {}, { sessionBearer: 'LABTOK' }, DEPS(rec.fn));
  await fetch(MCP, { method: 'GET' });
  await fetch(MCP, { method: 'POST', body: APP_RPC.replace('execute_application_action', 'publish_context') });
  await fetch(`${BASE}/tool/execute_application_action`, RPC_INIT);
  await fetch('https://evil.example.com/mcp', RPC_INIT);
  check('Application bridge refuses GET/other-tool/REST/off-origin', rec.calls.every((c) => authHdr(c.init) === undefined && acceptHdr(c.init) === undefined));
}
// 12. Explicit authorization suppresses session forwarding.
{
  const rec = recorder();
  const { fetch } = withAmepSession(MCP, {}, { sessionBearer: 'LABTOK', explicitAuth: 'Bearer CALLER' }, DEPS(rec.fn));
  await fetch(MCP, RPC_INIT);
  check('Application action explicit auth → no auto-forward', authHdr(rec.calls[0]?.init) === undefined);
}

console.log(`\n${ok}/${ok + bad} session-bridge checks passed`);
process.exit(bad === 0 ? 0 : 1);
