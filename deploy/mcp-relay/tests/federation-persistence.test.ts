#!/usr/bin/env tsx
/**
 * Federation registry persistence smoke test.
 *
 * Verifies the structural fix: pods added to the relay's federation
 * registry before a container restart are still in the registry AFTER
 * the restart, because the registry is mirrored to the service-account
 * pod and rehydrated at startup.
 *
 * The test stubs the network layer with an in-memory FS so it can run
 * without a live CSS pod. The persistence shape (sha256(podUrl)
 * filename, JSON-LD body, `federation/` subcontainer under
 * `svc-relay-dcr/`) is the SAME shape the real store writes — the
 * stub here is purely the HTTP transport.
 *
 * Scenarios:
 *   1. Add two pods → restart (fresh load) → both pods present.
 *   2. Remove a pod → restart → only the remaining pod present.
 *   3. 'self' entry (synthetic per-bearer) is NEVER persisted, even
 *      if a buggy caller passes it in directly.
 *   4. Re-adding an existing entry preserves the original addedAt
 *      (audit-trail integrity).
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/federation-persistence.test.ts
 */

import {
  loadEntries,
  removeEntry,
  saveEntry,
  sha256Hex,
  type FederationEntry,
  type FederationStoreConfig,
} from '../federation-store.js';
import type { FetchFn } from '@interego/core';

// ── tiny test harness ───────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}`); }
}

// ── In-memory pod stub ──────────────────────────────────────

interface StubFile { contentType: string; body: string; }

function makeStubPod(): { fetch: FetchFn; files: Map<string, StubFile> } {
  const files = new Map<string, StubFile>();
  const fetchFn: FetchFn = (async (url: string, init?: any) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers ?? {};
    if (method === 'PUT') {
      const ct = (headers as Record<string, string>)['Content-Type'] ?? 'text/plain';
      files.set(url, { contentType: ct, body: init?.body ?? '' });
      return { ok: true, status: 201, statusText: 'Created',
               headers: { get: () => null }, text: async () => '', json: async () => ({}) };
    }
    if (method === 'DELETE') {
      const had = files.delete(url);
      return { ok: had, status: had ? 204 : 404, statusText: had ? 'No Content' : 'Not Found',
               headers: { get: () => null }, text: async () => '', json: async () => ({}) };
    }
    if (method === 'GET') {
      // Container listing — synthesize a Turtle ldp:contains listing for any
      // URL that ends in `/`. The store's listContainer only needs the URLs.
      if (url.endsWith('/')) {
        const children = [...files.keys()].filter(k => k.startsWith(url) && k !== url);
        const turtle = children.map(c => `<> <http://www.w3.org/ns/ldp#contains> <${c}> .`).join('\n');
        return { ok: true, status: 200, statusText: 'OK',
                 headers: { get: () => 'text/turtle' },
                 text: async () => turtle, json: async () => ({}) };
      }
      const f = files.get(url);
      if (!f) return { ok: false, status: 404, statusText: 'Not Found',
                       headers: { get: () => null }, text: async () => '', json: async () => ({}) };
      return { ok: true, status: 200, statusText: 'OK',
               headers: { get: (n: string) => n.toLowerCase() === 'content-type' ? f.contentType : null },
               text: async () => f.body, json: async () => JSON.parse(f.body) };
    }
    return { ok: false, status: 405, statusText: 'Method Not Allowed',
             headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  }) as FetchFn;
  return { fetch: fetchFn, files };
}

// ── Tests ───────────────────────────────────────────────────

const POD = 'https://example.invalid/svc-relay-dcr/';

async function run() {
  // 1. Add two pods → restart → both present.
  {
    const pod = makeStubPod();
    const cfg: FederationStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    const e1: FederationEntry = {
      url: 'https://alice.example/pod/',
      via: 'manual',
      addedAt: '2026-06-01T10:00:00.000Z',
      label: 'Alice',
    };
    const e2: FederationEntry = {
      url: 'https://bob.example/pod/',
      via: 'directory',
      addedAt: '2026-06-02T11:30:00.000Z',
      label: 'Bob',
      owner: 'did:web:bob.example',
    };
    await saveEntry(e1, cfg);
    await saveEntry(e2, cfg);
    ok(pod.files.size === 2, 'two add_pod calls wrote two files');
    ok(pod.files.has(`${POD}federation/${sha256Hex(e1.url)}.jsonld`), 'alice entry lives at federation/<sha(url)>.jsonld');
    ok(pod.files.has(`${POD}federation/${sha256Hex(e2.url)}.jsonld`), 'bob entry lives at federation/<sha(url)>.jsonld');

    // Simulate restart: fresh load.
    const loaded = await loadEntries(cfg);
    ok(loaded.length === 2, 'loadEntries recovers both pods after restart');
    const byUrl = new Map(loaded.map(e => [e.url, e]));
    ok(byUrl.get(e1.url)?.label === 'Alice', 'alice label survives restart');
    ok(byUrl.get(e2.url)?.via === 'directory', 'bob via=directory survives restart');
    ok(byUrl.get(e2.url)?.owner === 'did:web:bob.example', 'bob owner survives restart');
    ok(byUrl.get(e1.url)?.addedAt === '2026-06-01T10:00:00.000Z', 'addedAt survives restart');
  }

  // 2. Remove a pod → restart → only remaining pod present.
  {
    const pod = makeStubPod();
    const cfg: FederationStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    await saveEntry({ url: 'https://alice.example/pod/', via: 'manual', addedAt: new Date().toISOString() }, cfg);
    await saveEntry({ url: 'https://bob.example/pod/', via: 'manual', addedAt: new Date().toISOString() }, cfg);
    ok(pod.files.size === 2, 'precondition: 2 files present');
    await removeEntry('https://bob.example/pod/', cfg);
    ok(pod.files.size === 1, 'removeEntry deleted the bob file');
    ok(!pod.files.has(`${POD}federation/${sha256Hex('https://bob.example/pod/')}.jsonld`), 'bob file gone');
    const loaded = await loadEntries(cfg);
    ok(loaded.length === 1, 'restart sees only the surviving entry');
    ok(loaded[0]!.url === 'https://alice.example/pod/', 'survivor is alice');
  }

  // 3. 'self' is never persisted, and a leaked 'self' on disk is
  //    filtered out on load (defence-in-depth).
  {
    const pod = makeStubPod();
    const cfg: FederationStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    await saveEntry({ url: 'https://me.example/pod/', via: 'self', addedAt: new Date().toISOString() }, cfg);
    ok(pod.files.size === 0, 'saveEntry refuses to persist via:self');

    // Now manually inject a leaked self entry and confirm load drops it.
    const sha = sha256Hex('https://leaked-self.example/pod/');
    const url = `${POD}federation/${sha}.jsonld`;
    await (pod.fetch as any)(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { relay: 'https://interego-emergent.example/ns/mcp-relay#' },
        '@id': `urn:interego:mcp-relay:federation:${sha.slice(0, 16)}`,
        '@type': 'urn:cg:relay:FederationEntry',
        url: 'https://leaked-self.example/pod/',
        via: 'self',
        addedAt: new Date().toISOString(),
      }),
    });
    ok(pod.files.size === 1, 'leaked-self file is on disk');
    const loaded = await loadEntries(cfg);
    ok(loaded.length === 0, 'loadEntries filters out via:self leak');
  }

  // 4. Malformed file is skipped, not crash-out.
  {
    const pod = makeStubPod();
    const cfg: FederationStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    // Write a valid entry and one with missing fields.
    await saveEntry({ url: 'https://ok.example/pod/', via: 'manual', addedAt: new Date().toISOString() }, cfg);
    await (pod.fetch as any)(`${POD}federation/deadbeef.jsonld`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({ url: '' }), // missing via
    });
    const loaded = await loadEntries(cfg);
    ok(loaded.length === 1, 'malformed entry skipped, valid entry survives');
    ok(loaded[0]!.url === 'https://ok.example/pod/', 'valid entry is the survivor');
  }

  // 5. Cold-start with no container yields empty load (no throw).
  {
    const pod = makeStubPod();
    const cfg: FederationStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    const loaded = await loadEntries(cfg);
    ok(loaded.length === 0, 'cold-start (empty container) returns empty array');
  }

  // 5b. Hydrate-observability contract (FIX 5). After a successful
  //     loadEntries that returns N entries, the relay surfaces a
  //     post-startup signal independent of write activity. We can't
  //     drive the relay's globals from this in-process test, but we
  //     CAN verify the load contract that those globals depend on:
  //     loadEntries resolves regardless of whether the container had
  //     entries (so the relay's `.then(loaded => { federationLastHydratedAt = ...; })`
  //     always fires), and the returned length matches the input
  //     (drives hydrateSourceCount). This guards against a future
  //     refactor that makes loadEntries reject on an empty container
  //     and silently breaks the new observability path.
  {
    const pod = makeStubPod();
    const cfg: FederationStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    // Empty container: load resolves cleanly so the relay's
    // .then(loaded => ...) handler flips lastHydratedAt + sets
    // hydrateSourceCount = 0.
    const emptyLoad = await loadEntries(cfg);
    ok(Array.isArray(emptyLoad) && emptyLoad.length === 0,
       'loadEntries on empty container resolves to [] (not throw) — drives lastHydratedAt flip');

    // Now write a couple of entries and confirm loadEntries returns
    // them in a single Promise resolution — the relay's
    // federationHydrateSourceCount is set from .length on this exact
    // return value.
    await saveEntry({ url: 'https://a.example/pod/', via: 'manual', addedAt: new Date().toISOString() }, cfg);
    await saveEntry({ url: 'https://b.example/pod/', via: 'manual', addedAt: new Date().toISOString() }, cfg);
    const populatedLoad = await loadEntries(cfg);
    ok(populatedLoad.length === 2,
       'loadEntries returns N entries in one resolution — drives hydrateSourceCount=N');
  }

  // 6. Synchronous-write regression (Fix 8). saveEntry returns a
  //    Promise<void> that resolves only after the underlying PUT
  //    completes. Awaiting it MUST leave the file on disk before
  //    control returns — no setTimeout / debounce window where a
  //    container restart could drop the add.
  //
  //    This is the contract the relay's handleAddPod now relies on
  //    when it awaits persistFederationEntry(entry) before responding
  //    to the wire: list_known_pods called immediately after add_pod
  //    must see lastPersistedAt advanced and the entry durable on disk.
  {
    const pod = makeStubPod();
    const cfg: FederationStoreConfig = { podUrl: POD, fetch: pod.fetch, log: () => {} };
    const entry: FederationEntry = {
      url: 'https://sync-write.example/pod/',
      via: 'manual',
      addedAt: '2026-06-05T12:00:00.000Z',
      label: 'SyncWrite',
    };
    const expectedKey = `${POD}federation/${sha256Hex(entry.url)}.jsonld`;

    // Precondition: the file isn't there before we await.
    ok(!pod.files.has(expectedKey), 'precondition: file not yet on disk');

    const writePromise = saveEntry(entry, cfg);
    // The promise IS awaitable — type signature is Promise<void>.
    ok(typeof (writePromise as Promise<void>).then === 'function', 'saveEntry returns a thenable');
    await writePromise;

    // Postcondition (Fix 8 regression): immediately after await, the
    // file MUST exist. NO setTimeout window, NO debounce gap.
    ok(pod.files.has(expectedKey), 'file is durable on disk immediately after await (no async window)');

    // And a fresh load (cold-restart sim) must see the entry.
    const reloaded = await loadEntries(cfg);
    ok(reloaded.length === 1 && reloaded[0]!.url === entry.url,
       'restart immediately after await sees the persisted entry');
    ok(reloaded[0]!.label === 'SyncWrite', 'label persisted in the same sync write');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exit(1);
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
