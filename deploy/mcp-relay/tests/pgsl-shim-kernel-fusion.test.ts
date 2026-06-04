#!/usr/bin/env tsx
/**
 * pgsl_* shim ↔ kernel fusion smoke test.
 *
 * Verifies the FIX 1 invariant: the relay-local `pgslInstance` is gone,
 * every pgsl_* shim composes against the kernel-owned PGSL singleton,
 * and a URI minted through one path is dereferencable by every other.
 *
 * Specifically:
 *   1. Pre-fix shape: kernel.dereference of a URI created in a sibling
 *      PGSLInstance returns 'not-found'. (Sanity check that the
 *      substrate's content-addressing is per-instance for the lookup
 *      path even though the IRI is global.)
 *   2. Post-fix shape: a URI returned by `embedInPGSL(getKernelPGSL(),
 *      content)` is found by `kernel.dereference(uri)`, and the
 *      adapter's resolve shape matches the legacy `pgslResolve`.
 *   3. The pgsl_resolve shim's wire shape is unchanged: { uri,
 *      resolved, kind, provenance, level, ... } with the same field
 *      semantics as before.
 *   4. pgsl_lattice_status / pgsl_to_turtle / pgsl_meet read the same
 *      PGSL the kernel writes through.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/pgsl-shim-kernel-fusion.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import {
  createPGSL,
  embedInPGSL,
  getKernelPGSL,
  latticeMeet,
  latticeStats,
  pgslToTurtle,
  resolve as pgslResolve,
  resetKernelPGSL,
} from '@interego/pgsl';
import {
  dereference as kernelDereference,
  decompose as kernelDecompose,
} from '@interego/core';
import type { IRI } from '@interego/core';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    // eslint-disable-next-line no-console
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    failures.push(name);
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${name}`);
  }
}

async function main(): Promise<void> {
  resetKernelPGSL();

  // ── Scenario 1: pre-fix repro — sibling PGSL minted URIs are
  //   invisible to kernel.dereference (this is exactly the bug the
  //   removed `pgslInstance: PGSLInstance = createPGSL(...)` caused).
  {
    const sibling = createPGSL({
      wasAttributedTo: 'urn:agent:test:sibling' as IRI,
      generatedAtTime: new Date().toISOString(),
    });
    const siblingUri = embedInPGSL(sibling, 'alpha beta gamma delta');
    const deref = await kernelDereference(siblingUri);
    ok(deref.status === 'not-found',
      'sibling-PGSL URI is not-found via kernel.dereference (pre-fix bug repro)');
  }

  // ── Scenario 2: post-fix — embedding through the kernel-owned
  //   singleton makes the URI visible to kernel.dereference.
  let topUri: IRI;
  {
    const pgsl = getKernelPGSL({
      wasAttributedTo: 'urn:agent:test:shim' as IRI,
      generatedAtTime: new Date().toISOString(),
    });
    topUri = embedInPGSL(pgsl, 'alpha beta gamma delta');
    const deref = await kernelDereference(topUri);
    ok(deref.status === 'ok',
      'shim-minted URI is ok via kernel.dereference (post-fix invariant)');
    ok(Array.isArray(deref.affordances) && deref.affordances.length > 0,
      'kernel.dereference surfaces affordances on the shim-minted URI');
  }

  // ── Scenario 3: pgsl_resolve wire shape — reproduce the handler's
  //   body against the kernel-owned PGSL and check field semantics.
  {
    const deref = await kernelDereference(topUri);
    ok(deref.status === 'ok', 'pgsl_resolve: kernel.dereference resolves topUri');

    const pgsl = getKernelPGSL();
    const node = pgsl.nodes.get(topUri)!;
    ok(node != null, 'pgsl_resolve: node present in kernel-owned singleton');

    const resolved = pgslResolve(pgsl, topUri);
    const base: Record<string, unknown> = {
      uri: topUri,
      resolved,
      kind: node.kind,
      provenance: {
        wasAttributedTo: node.provenance.wasAttributedTo,
        generatedAtTime: node.provenance.generatedAtTime,
      },
    };
    if (node.kind === 'Atom') {
      base.level = 0;
      base.value = (node as { value: unknown }).value;
    } else {
      base.level = (node as { level: number }).level;
      base.itemCount = (node as { items: unknown[] }).items.length;
      const left = (node as { left?: IRI }).left;
      const right = (node as { right?: IRI }).right;
      if (left) base.left = left;
      if (right) base.right = right;
      const dec = kernelDecompose(topUri);
      if (dec) base.overlap = dec.overlap;
    }

    ok(typeof base.uri === 'string', 'pgsl_resolve shape: uri is string');
    ok('resolved' in base, 'pgsl_resolve shape: resolved present');
    ok(base.kind === 'Atom' || base.kind === 'Fragment',
      'pgsl_resolve shape: kind is Atom or Fragment');
    ok(typeof (base.provenance as { wasAttributedTo: string }).wasAttributedTo === 'string',
      'pgsl_resolve shape: provenance.wasAttributedTo is string');
    ok(typeof (base.provenance as { generatedAtTime: string }).generatedAtTime === 'string',
      'pgsl_resolve shape: provenance.generatedAtTime is string');
    ok(typeof base.level === 'number', 'pgsl_resolve shape: level is number');
  }

  // ── Scenario 4: pgsl_lattice_status / pgsl_to_turtle / pgsl_meet
  //   all observe the kernel's writes through the singleton.
  {
    const pgsl = getKernelPGSL();
    const stats = latticeStats(pgsl);
    ok(typeof stats === 'object' && stats !== null && 'totalNodes' in stats,
      'pgsl_lattice_status shape: stats object has totalNodes');
    ok((stats as { totalNodes: number }).totalNodes > 0,
      'pgsl_lattice_status: kernel-owned singleton has nodes after shim ingest');

    const ttl = pgslToTurtle(pgsl);
    ok(typeof ttl === 'string' && ttl.length > 0,
      'pgsl_to_turtle shape: turtle is non-empty string');
    ok(ttl.includes(topUri),
      'pgsl_to_turtle: turtle export includes the shim-minted apex URI');

    // Ingest a second content with overlap; meet should be non-null.
    const second = embedInPGSL(pgsl, 'gamma delta epsilon zeta');
    const meet = latticeMeet(pgsl, topUri, second);
    ok(meet !== null,
      'pgsl_meet: shared sub-fragment found between two shim ingests on the kernel singleton');
  }

  // ── Summary ───────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    // eslint-disable-next-line no-console
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(2);
});
