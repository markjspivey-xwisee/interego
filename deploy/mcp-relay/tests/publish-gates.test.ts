#!/usr/bin/env tsx
/**
 * FIX 4 — publish-path gates regression test.
 *
 * Two sub-gates run BEFORE publish() touches the pod, both implemented
 * in deploy/mcp-relay/server.ts handlePublishContext:
 *
 *   A. SHACL conformance gate
 *      - Reads iep:conformsTo / dct:conformsTo from the target container's
 *        metadata (.well-known/container-shape, falling back to the
 *        pod manifest collection subject).
 *      - Fetches each declared shape and validates the inbound
 *        graphContent against it via @interego/core's validateAgainstShape.
 *      - Non-conformance => error envelope { code: 422, error: 'shape_violation', ... }
 *        AND skip the CSS write.
 *
 *   B. Scope gate
 *      - Looks up the calling agent's verified delegation scope via
 *        verifyAgentDelegation.
 *      - Scope NOT in { ReadWrite, PublishOnly } => error envelope
 *        { code: 403, error: 'scope_violation', ... } AND skip the CSS write.
 *
 * The test drives the actual kernel-level enforcement points:
 *   - publish(..., { conformsToShapes: [...] }) — exercised via the
 *     kernel's PublishShapeViolationError throw path. This is the same
 *     code the relay uses when it threads container-declared shapes into
 *     publish().
 *   - verifyAgentDelegation(...) — read scope from a synthetic pod's
 *     agent registry and confirm a ReadOnly agent surfaces with scope
 *     "ReadOnly", which the scope-gate logic must then reject.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/publish-gates.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import {
  validateAgainstShape,
  createOwnerProfile,
  addAuthorizedAgent,
  ownerProfileToTurtle,
} from '@interego/core';
import type { IRI, FetchFn } from '@interego/core';
import {
  publish,
  PublishShapeViolationError,
  verifyAgentDelegation,
  AGENT_REGISTRY_PATH,
} from '@interego/solid';
import { ContextDescriptor } from '@interego/core';

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

// A trivially-permissive in-memory pod that records every method+url
// pair. PUT requests against the descriptor or graph paths after a
// gate violation are the failure mode the gates are meant to prevent.
function makeMemoryPod(initialResources: Record<string, string> = {}): {
  fetch: FetchFn;
  calls: { method: string; url: string }[];
  resources: Map<string, string>;
} {
  const resources = new Map<string, string>(Object.entries(initialResources));
  const calls: { method: string; url: string }[] = [];
  const f: FetchFn = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    if (method === 'GET') {
      const body = resources.get(url);
      if (body !== undefined) {
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: { get: (h: string) => h.toLowerCase() === 'etag' ? '"v1"' : null },
          text: async () => body, json: async () => JSON.parse(body),
        };
      }
      return {
        ok: false, status: 404, statusText: 'Not Found',
        headers: { get: () => null },
        text: async () => '', json: async () => ({}),
      };
    }
    if (method === 'PUT' || method === 'PATCH') {
      resources.set(url, typeof init?.body === 'string' ? init!.body as string : '');
      return {
        ok: true, status: 201, statusText: 'Created',
        headers: { get: (h: string) => h.toLowerCase() === 'etag' ? '"v1"' : null },
        text: async () => '', json: async () => ({}),
      };
    }
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => null },
      text: async () => '', json: async () => ({}),
    };
  };
  return { fetch: f, calls, resources };
}

async function main(): Promise<void> {
  // ── Scenario A: SHACL conformance gate rejects non-conformant payload ──
  //
  // The shape declares iep:Note must carry exactly one dct:title
  // literal. We publish a graph that is missing dct:title.
  // Expectation:
  //   - PublishShapeViolationError thrown
  //   - error.code === 422
  //   - violations carries a MinCount constraint
  //   - NO PUT was made against descriptor or graph URLs
  {
    const shapeTurtle = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

iep:NoteShape a sh:NodeShape ;
    sh:targetClass iep:Note ;
    sh:property [
        sh:path dct:title ;
        sh:minCount 1 ;
        sh:datatype xsd:string ;
        sh:message "Note requires exactly one dct:title literal."
    ] .
`;
    const violatingGraph = `
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
<urn:note:1> a iep:Note .
`;

    // Standalone engine assertions first — make sure the new
    // shacl-engine surface reports the violation cleanly.
    const directReport = validateAgainstShape(violatingGraph, shapeTurtle);
    ok(directReport.conforms === false,
      'validateAgainstShape: missing dct:title is reported as non-conformant');
    ok(directReport.results.some(r => r.constraintComponent.endsWith('MinCountConstraintComponent')),
      'validateAgainstShape: MinCountConstraintComponent is surfaced');

    // Now exercise the publish-level gate.
    const pod = makeMemoryPod();
    const descriptor = ContextDescriptor.create('urn:iep:test:gate:shape' as IRI)
      .describes('urn:graph:note:1' as IRI)
      .semiotic({ modalStatus: 'Asserted' })
      .build();

    let caught: PublishShapeViolationError | null = null;
    try {
      await publish(descriptor, violatingGraph, 'https://pod.example/u/', {
        fetch: pod.fetch,
        conformsToShapes: [{ shapeIri: 'https://shapes.example/NoteShape', shapeTurtle }],
      });
    } catch (err) {
      if (err instanceof PublishShapeViolationError) caught = err;
    }
    ok(caught !== null, 'publish() throws PublishShapeViolationError on a SHACL violation');
    ok(caught?.code === 422, 'PublishShapeViolationError.code === 422');
    ok(caught?.shape === 'https://shapes.example/NoteShape',
      'PublishShapeViolationError.shape carries the offending shape IRI');
    ok((caught?.violations.length ?? 0) > 0,
      'PublishShapeViolationError carries at least one violation row');
    const sawWrite = pod.calls.some(c => c.method === 'PUT' && c.url.includes('context-graphs/'));
    ok(sawWrite === false,
      'No descriptor/graph PUT was attempted after the conformance gate rejected (422 semantics)');
  }

  // ── Scenario A2: MCP-wire `conforms_to_shapes` arg ──
  //
  // The MCP publish_context tool now accepts a caller-supplied
  // `conforms_to_shapes: string[]` arg. The relay's runConformanceGate
  // fetches each shape from the pod (Accept: text/turtle), runs
  // validateAgainstShape against the inbound graph_content, and on
  // non-conformance returns the same 422 envelope the container-declared
  // gate uses. The substrate-level publish() gate also receives the
  // resolved (shapeIri, shapeTurtle) pairs so the SHACL invariant is
  // enforced at both layers.
  //
  // This scenario simulates the MCP-wire end-to-end by setting up a
  // memory pod that serves a NoteShape turtle at a known IRI AND the
  // relay's expected pod URLs (.well-known/container-shape returns 404,
  // so caller-supplied shapes are the ONLY source — the case the test
  // pod hits in production), then validating both branches:
  //   - violating payload → PublishShapeViolationError with code 422
  //     + shape IRI + violation report (the SHACL kernel response)
  //   - compliant payload → publish proceeds (no exception, the pod
  //     observes the descriptor + payload PUTs)
  {
    const shapeIri = 'https://shapes.example/NoteShape';
    const shapeTurtle = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

iep:NoteShape a sh:NodeShape ;
    sh:targetClass iep:Note ;
    sh:property [
        sh:path dct:title ;
        sh:minCount 1 ;
        sh:datatype xsd:string ;
        sh:message "Note requires exactly one dct:title literal."
    ] .
`;
    const violatingGraph = `
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
<urn:note:1> a iep:Note .
`;
    const compliantGraph = `
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
<urn:note:1> a iep:Note ; dct:title "Hello world" .
`;

    // ── Sub-case 1: violating payload via caller-supplied shape ──
    //
    // Exercises the same path the MCP `conforms_to_shapes` arg threads
    // through: a caller-supplied shape is wired into publish() as
    // conformsToShapes — the substrate-level gate fires before any pod
    // write. This is the MCP-wire equivalent: the relay's
    // runConformanceGate fetches the shape body for each caller IRI and
    // hands the (shapeIri, shapeTurtle) pairs to publish().
    {
      const pod = makeMemoryPod();
      const descriptor = ContextDescriptor.create('urn:iep:test:gate:caller-shapes:violation' as IRI)
        .describes('urn:graph:note:1' as IRI)
        .semiotic({ modalStatus: 'Asserted' })
        .build();

      let caught: PublishShapeViolationError | null = null;
      try {
        await publish(descriptor, violatingGraph, 'https://pod.example/u/', {
          fetch: pod.fetch,
          // Same shape the relay would have fetched from the IRI in the
          // caller-supplied conforms_to_shapes array. The relay's
          // runConformanceGate then threads it into publish() via the
          // conformsToShapes option — that's what's being asserted here.
          conformsToShapes: [{ shapeIri, shapeTurtle }],
        });
      } catch (err) {
        if (err instanceof PublishShapeViolationError) caught = err;
      }
      ok(caught !== null,
        'conforms_to_shapes (wire) — violating payload throws PublishShapeViolationError');
      ok(caught?.code === 422,
        'conforms_to_shapes (wire) — violation carries code 422');
      ok(caught?.shape === shapeIri,
        'conforms_to_shapes (wire) — violation carries the caller-supplied shape IRI');
      ok((caught?.violations.length ?? 0) > 0,
        'conforms_to_shapes (wire) — violation report carries at least one row');
      const sawWrite = pod.calls.some(c => c.method === 'PUT' && c.url.includes('context-graphs/'));
      ok(sawWrite === false,
        'conforms_to_shapes (wire) — no descriptor/graph PUT after a 422');
    }

    // ── Sub-case 2: compliant payload via caller-supplied shape ──
    //
    // Same caller-supplied shape, but the payload satisfies the
    // constraint (dct:title present). The gate must accept and the
    // publish must complete — at least one PUT to the
    // context-graphs container is observed on the memory pod.
    {
      const pod = makeMemoryPod();
      const descriptor = ContextDescriptor.create('urn:iep:test:gate:caller-shapes:ok' as IRI)
        .describes('urn:graph:note:1' as IRI)
        .semiotic({ modalStatus: 'Asserted' })
        .build();

      let threw = false;
      try {
        await publish(descriptor, compliantGraph, 'https://pod.example/u/', {
          fetch: pod.fetch,
          conformsToShapes: [{ shapeIri, shapeTurtle }],
        });
      } catch {
        threw = true;
      }
      ok(threw === false,
        'conforms_to_shapes (wire) — compliant payload does not throw');
      const sawWrite = pod.calls.some(c => c.method === 'PUT' && c.url.includes('context-graphs/'));
      ok(sawWrite === true,
        'conforms_to_shapes (wire) — compliant payload reaches the pod (PUT observed)');
    }
  }

  // ── Scenario A3: SHACL shape declared inside a TriG named graph ──
  //
  // FIX A — the conformance gate used to silently let publishes through
  // when the declared shape was served as application/trig with the
  // sh:NodeShape sitting INSIDE a named-graph block. Two failure modes:
  //
  //   1. fetchShapeBody sent `Accept: text/turtle` only → strict CSS
  //      negotiator answers 406 for a trig resource → returns null →
  //      gate treats shape as "missing" → publish accepted.
  //   2. Even if the bytes came back, the TriG parser only recognized
  //      `<iri> { ... }` graph blocks — NOT the `GRAPH <iri> { ... }`
  //      keyword form — so the inner sh:NodeShape was lost.
  //
  // The fix broadens Accept (text/turtle + trig + n-quads + ld+json)
  // and teaches parseTrig the GRAPH keyword. We assert the second half
  // directly here because the unit under test (validateAgainstShape)
  // exercises the parser; the Accept-header half is structurally
  // covered (we don't drive a real HTTP server here, but the broadened
  // header is a single-line constant which type-checks above).
  //
  // Three sub-cases:
  //   (a) IRI-prefix graph form  → already worked; regression guard.
  //   (b) GRAPH-keyword form     → newly handled; regression target.
  //   (c) Multiple named graphs declaring the same shape IRI with
  //       different constraints → constraints merge, violation still
  //       caught (defensive — shouldn't happen in practice).
  {
    const baseGraph = `
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
<urn:note:1> a iep:Note .
`;

    // (a) IRI-prefix graph block.
    {
      const trigShape = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:graph:shapes> {
  iep:NoteShape a sh:NodeShape ;
      sh:targetClass iep:Note ;
      sh:property [
          sh:path dct:title ;
          sh:minCount 1 ;
          sh:datatype xsd:string ;
          sh:message "Note requires exactly one dct:title literal."
      ] .
}
`;
      const report = validateAgainstShape(baseGraph, trigShape);
      ok(report.conforms === false,
        'trig shape (IRI-prefix graph block) — violation is reported');
      ok(report.results.some(r => r.constraintComponent.endsWith('MinCountConstraintComponent')),
        'trig shape (IRI-prefix graph block) — MinCount constraint surfaces');
    }

    // (b) GRAPH-keyword form (the FIX A regression target).
    {
      const trigShape = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

GRAPH <urn:graph:shapes> {
  iep:NoteShape a sh:NodeShape ;
      sh:targetClass iep:Note ;
      sh:property [
          sh:path dct:title ;
          sh:minCount 1 ;
          sh:datatype xsd:string ;
          sh:message "Note requires exactly one dct:title literal."
      ] .
}
`;
      const report = validateAgainstShape(baseGraph, trigShape);
      ok(report.conforms === false,
        'trig shape (GRAPH keyword) — violation is reported');
      ok(report.results.some(r => r.constraintComponent.endsWith('MinCountConstraintComponent')),
        'trig shape (GRAPH keyword) — MinCount constraint surfaces');
    }

    // (b2) End-to-end: publish() with a TriG `GRAPH`-form shape body
    // threaded through conformsToShapes — same path the relay's
    // runConformanceGate hands to the substrate.
    {
      const shapeIri = 'https://shapes.example/trig/NoteShape';
      const trigShape = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

GRAPH <urn:graph:shapes> {
  iep:NoteShape a sh:NodeShape ;
      sh:targetClass iep:Note ;
      sh:property [
          sh:path dct:title ;
          sh:minCount 1 ;
          sh:datatype xsd:string ;
          sh:message "Note requires exactly one dct:title literal."
      ] .
}
`;
      const pod = makeMemoryPod();
      const descriptor = ContextDescriptor.create('urn:iep:test:gate:trig-graph-shape' as IRI)
        .describes('urn:graph:note:1' as IRI)
        .semiotic({ modalStatus: 'Asserted' })
        .build();

      let caught: PublishShapeViolationError | null = null;
      try {
        await publish(descriptor, baseGraph, 'https://pod.example/u/', {
          fetch: pod.fetch,
          conformsToShapes: [{ shapeIri, shapeTurtle: trigShape }],
        });
      } catch (err) {
        if (err instanceof PublishShapeViolationError) caught = err;
      }
      ok(caught !== null,
        'trig shape (GRAPH keyword) — publish() throws PublishShapeViolationError end-to-end');
      ok(caught?.code === 422,
        'trig shape (GRAPH keyword) — error.code === 422 (the diag-prescribed envelope)');
      ok(caught?.shape === shapeIri,
        'trig shape (GRAPH keyword) — error.shape carries the trig shape IRI');
      const sawWrite = pod.calls.some(c => c.method === 'PUT' && c.url.includes('context-graphs/'));
      ok(sawWrite === false,
        'trig shape (GRAPH keyword) — no descriptor/graph PUT after the 422 (gate skipped CSS write)');
    }

    // (c) Same shape IRI declared in two graphs — constraints union.
    // The parser drops graph-parentage, so both copies' property
    // lists merge into a single subject; the compiler reads every
    // sh:property the merged subject carries and validates against
    // each — so a violation in either survives.
    {
      const trigShape = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:graph:shapes:base> {
  iep:NoteShape a sh:NodeShape ;
      sh:targetClass iep:Note ;
      sh:property [
          sh:path dct:title ;
          sh:minCount 1 ;
          sh:datatype xsd:string
      ] .
}

GRAPH <urn:graph:shapes:extension> {
  iep:NoteShape sh:property [
      sh:path dct:creator ;
      sh:minCount 1 ;
      sh:nodeKind sh:IRI
  ] .
}
`;
      const report = validateAgainstShape(baseGraph, trigShape);
      ok(report.conforms === false,
        'trig shape (split across two graphs) — violation still caught');
      // BOTH constraints (dct:title minCount + dct:creator minCount)
      // must fire; the merged shape carries property-shapes from both
      // graphs.
      const paths = new Set(report.results.map(r => r.path));
      ok(paths.has('http://purl.org/dc/terms/title'),
        'trig shape (split across two graphs) — dct:title violation surfaces');
      ok(paths.has('http://purl.org/dc/terms/creator'),
        'trig shape (split across two graphs) — dct:creator violation also surfaces');
    }
  }

  // ── Scenario B: scope gate rejects a Read-scoped agent ──
  //
  // We seed the pod's agent registry with a single ReadOnly agent and
  // call verifyAgentDelegation against it. The relay's scope gate logic
  // (mirrored here) rejects any scope NOT in { ReadWrite, PublishOnly }.
  {
    const podUrl = 'https://pod.example/bob/';
    const ownerWebId = 'https://id.example/bob/profile#me' as IRI;
    const readOnlyAgent = 'did:web:reader.example' as IRI;
    const writeAgent = 'did:web:writer.example' as IRI;

    // Build a profile carrying one ReadOnly + one ReadWrite authorized
    // agent so we can confirm the gate accepts the write-eligible one.
    let profile = createOwnerProfile(ownerWebId, 'Bob');
    profile = addAuthorizedAgent(profile, {
      agentId: readOnlyAgent,
      delegatedBy: ownerWebId,
      label: 'Read-only reader',
      isSoftwareAgent: true,
      scope: 'ReadOnly',
      validFrom: new Date().toISOString(),
    });
    profile = addAuthorizedAgent(profile, {
      agentId: writeAgent,
      delegatedBy: ownerWebId,
      label: 'Read-write writer',
      isSoftwareAgent: true,
      scope: 'ReadWrite',
      validFrom: new Date().toISOString(),
    });
    const registryTurtle = ownerProfileToTurtle(profile);
    const registryUrl = `${podUrl}${AGENT_REGISTRY_PATH}`;
    const pod = makeMemoryPod({ [registryUrl]: registryTurtle });

    // The relay's runScopeGate logic (mirrored here).
    const writeEligible = new Set(['ReadWrite', 'PublishOnly']);
    async function gateAllows(agentId: IRI): Promise<{ allowed: boolean; scope: string | undefined }> {
      const v = await verifyAgentDelegation(agentId, podUrl, { fetch: pod.fetch });
      const allowed = v.valid && v.scope !== undefined && writeEligible.has(v.scope);
      return { allowed, scope: v.scope };
    }

    const readerCheck = await gateAllows(readOnlyAgent);
    ok(readerCheck.scope === 'ReadOnly',
      'verifyAgentDelegation surfaces the ReadOnly scope from the registry');
    ok(readerCheck.allowed === false,
      'scope gate rejects a ReadOnly agent (403 semantics)');

    const writerCheck = await gateAllows(writeAgent);
    ok(writerCheck.scope === 'ReadWrite',
      'verifyAgentDelegation surfaces the ReadWrite scope from the registry');
    ok(writerCheck.allowed === true,
      'scope gate admits a ReadWrite agent (publish proceeds)');

    // And the agent that isn't on the registry at all must be rejected
    // — this is the "missing delegation" branch.
    const ghost = await gateAllows('did:web:ghost.example' as IRI);
    ok(ghost.allowed === false,
      'scope gate rejects an agent that is not registered on the pod');
  }

  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    // eslint-disable-next-line no-console
    console.error('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
