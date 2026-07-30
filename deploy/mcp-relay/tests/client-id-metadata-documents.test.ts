#!/usr/bin/env tsx
/**
 * Client ID Metadata Documents — the 2026-07-28 replacement for Dynamic Client
 * Registration.
 *
 * A client identifies itself by an https URL that dereferences to its own metadata, so
 * there is no registration round trip. The revision DEPRECATES DCR in favour of it and
 * orders client preference pre-registration > CIMD > DCR.
 *
 * ★ THIS FEATURE IS TWO SINKS AT ONCE, which is why every check below is a test rather
 * than a comment:
 *
 *   1. an SSRF sink — the server fetches a URL the CALLER chose. Unguarded, the
 *      authorization endpoint becomes a proxy into link-local (IMDS), loopback and
 *      private ranges.
 *   2. an IMPERSONATION sink — the fetched document asserts an OAuth client identity.
 *      Without the self-reference check, anyone able to host a document could claim to
 *      BE a different, trusted client.
 *
 * The security properties are asserted directly, not inferred from the happy path
 * working. A CIMD implementation that resolves valid documents correctly and skips any
 * one of these is worse than no CIMD at all.
 */

import { InteregoOAuthProvider } from '../oauth-provider.js';

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
};

const CID = 'https://client.example.invalid/mcp-client.json';

const VALID_DOC = {
  client_id: CID,
  client_name: 'Example MCP Client',
  redirect_uris: ['https://client.example.invalid/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
};

/** A fetch double that records what was requested and serves a canned document. */
function stubFetch(body: unknown, opts: { ok?: boolean; status?: number; throwFor?: RegExp } = {}) {
  const seen: string[] = [];
  const fn = async (url: string) => {
    seen.push(url);
    // Models the SSRF guard's refusal: guardedInvokeFetch THROWS on a screened host.
    if (opts.throwFor?.test(url)) throw new Error(`invoke: loopback host not allowed: ${url}`);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: async () => text,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? String(text.length) : null) },
    };
  };
  return { fn, seen };
}

function makeProvider(fetchStub?: ReturnType<typeof stubFetch>) {
  return new InteregoOAuthProvider({
    identityUrl: 'https://identity.invalid',
    initialClients: new Map(),
    ...(fetchStub ? { cimdFetch: fetchStub.fn } : {}),
    log: () => {},
  });
}

console.log('\nClient ID Metadata Documents');

async function run() {
  // ── The happy path ───────────────────────────────────────────────────────
  {
    const stub = stubFetch(VALID_DOC);
    const c = await makeProvider(stub).clientsStore.getClient(CID);
    ok(c?.client_id === CID, 'a valid document resolves to a client', String(c?.client_id));
    ok(c?.redirect_uris?.[0] === VALID_DOC.redirect_uris[0], '…carrying its redirect_uris', JSON.stringify(c?.redirect_uris));
    ok(stub.seen[0] === CID, '…fetched from exactly the client_id URL', stub.seen.join(','));
  }

  // ── Impersonation: the self-reference check ──────────────────────────────
  {
    // A document hosted at CID that claims to be a DIFFERENT, more trusted client.
    const stub = stubFetch({ ...VALID_DOC, client_id: 'https://trusted.example.invalid/client.json' });
    const c = await makeProvider(stub).clientsStore.getClient(CID);
    ok(c === undefined,
      'a document whose client_id is not its own URL is REFUSED (impersonation)', JSON.stringify(c));
  }

  // ── SSRF: the guard's refusal must not become an accepted client ─────────
  {
    const stub = stubFetch(VALID_DOC, { throwFor: /.*/ });
    const c = await makeProvider(stub).clientsStore.getClient(CID);
    ok(c === undefined, 'a fetch the SSRF guard refuses yields NO client', JSON.stringify(c));
  }
  {
    // No guard injected at all: CIMD must be OFF, never fall back to a bare fetch.
    const c = await makeProvider().clientsStore.getClient(CID);
    ok(c === undefined,
      'with no guarded fetch configured, CIMD is disabled rather than unguarded', JSON.stringify(c));
  }

  // ── Only https, and no fragment ──────────────────────────────────────────
  for (const [label, id] of [
    ['http (spoofable on the network path)', 'http://client.example.invalid/c.json'],
    ['a fragment (never sent to the server, so two ids would dereference alike)', 'https://client.example.invalid/c.json#a'],
  ] as const) {
    const stub = stubFetch(VALID_DOC);
    const c = await makeProvider(stub).clientsStore.getClient(id);
    ok(c === undefined && stub.seen.length === 0, `a client_id with ${label} is not treated as CIMD`, String(c));
  }

  // ── A CIMD client is PUBLIC, whatever the document says ──────────────────
  {
    const stub = stubFetch({ ...VALID_DOC, token_endpoint_auth_method: 'client_secret_basic', client_secret: 'hunter2' });
    const c = await makeProvider(stub).clientsStore.getClient(CID);
    ok(c?.token_endpoint_auth_method === 'none',
      'a document claiming a confidential auth method is forced to `none` (it proves URL control, not a secret)',
      String(c?.token_endpoint_auth_method));
    ok((c as { client_secret?: string } | undefined)?.client_secret === undefined,
      '…and no client_secret is carried over', String((c as { client_secret?: string } | undefined)?.client_secret));
  }

  // ── redirect_uris must exist and be acceptable ───────────────────────────
  {
    const stub = stubFetch({ ...VALID_DOC, redirect_uris: [] });
    ok(await makeProvider(stub).clientsStore.getClient(CID) === undefined,
      'a document with no redirect_uris is refused (the code has nowhere safe to go)');
  }
  {
    const stub = stubFetch({ ...VALID_DOC, redirect_uris: ['http://evil.example.invalid/cb'] });
    ok(await makeProvider(stub).clientsStore.getClient(CID) === undefined,
      'a non-loopback http redirect_uri is refused');
  }
  {
    const stub = stubFetch({ ...VALID_DOC, redirect_uris: ['http://127.0.0.1:7777/cb'] });
    const c = await makeProvider(stub).clientsStore.getClient(CID);
    ok(c !== undefined, 'a LOOPBACK http redirect_uri is allowed (OAuth 2.1 native-app flow)', String(c?.client_id));
  }

  // ── Malformed / oversized documents ──────────────────────────────────────
  {
    const stub = stubFetch('this is not json');
    ok(await makeProvider(stub).clientsStore.getClient(CID) === undefined, 'an unparseable document is refused');
  }
  {
    const stub = stubFetch(VALID_DOC, { ok: false, status: 404 });
    ok(await makeProvider(stub).clientsStore.getClient(CID) === undefined, 'a non-OK response is refused');
  }
  {
    // 64 KiB cap: a caller-supplied URL must not be able to stream unbounded bytes.
    const stub = stubFetch({ ...VALID_DOC, padding: 'x'.repeat(70 * 1024) });
    ok(await makeProvider(stub).clientsStore.getClient(CID) === undefined, 'an oversized document is refused');
  }

  // ── Precedence: a registered client is never shadowed by a document ──────
  {
    const stub = stubFetch({ ...VALID_DOC, client_name: 'Impostor' });
    const registered = {
      client_id: CID, client_name: 'The Real Registration',
      redirect_uris: ['https://client.example.invalid/registered-cb'],
      grant_types: ['authorization_code'], response_types: ['code'],
      token_endpoint_auth_method: 'none' as const,
    };
    const p = new InteregoOAuthProvider({
      identityUrl: 'https://identity.invalid',
      initialClients: new Map([[CID, registered]]),
      cimdFetch: stub.fn,
      log: () => {},
    });
    const c = await p.clientsStore.getClient(CID);
    ok(c?.client_name === 'The Real Registration',
      'a PRE-REGISTERED client wins over a document at the same URL (spec preference order)',
      String(c?.client_name));
    ok(stub.seen.length === 0, '…and the document is never even fetched', stub.seen.join(','));
  }

  // ── Caching ──────────────────────────────────────────────────────────────
  {
    const stub = stubFetch(VALID_DOC);
    const p = makeProvider(stub);
    await p.clientsStore.getClient(CID);
    await p.clientsStore.getClient(CID);
    ok(stub.seen.length === 1, 'a resolved document is cached, not re-fetched per request', `${stub.seen.length} fetches`);
  }
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch(err => {
  console.error(`\nharness error: ${(err as Error).stack}`);
  process.exit(1);
});
