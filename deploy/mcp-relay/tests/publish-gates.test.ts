#!/usr/bin/env tsx
/**
 * FIX 4 — publish-path gates regression test.
 *
 * Two sub-gates run BEFORE publish() touches the pod, both implemented
 * in deploy/mcp-relay/server.ts handlePublishContext:
 *
 *   A. SHACL conformance gate
 *      - Reads cg:conformsTo / dct:conformsTo from the target container's
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
  // The shape declares cg:Note must carry exactly one dct:title
  // literal. We publish a graph that is missing dct:title.
  // Expectation:
  //   - PublishShapeViolationError thrown
  //   - error.code === 422
  //   - violations carries a MinCount constraint
  //   - NO PUT was made against descriptor or graph URLs
  {
    const shapeTurtle = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

cg:NoteShape a sh:NodeShape ;
    sh:targetClass cg:Note ;
    sh:property [
        sh:path dct:title ;
        sh:minCount 1 ;
        sh:datatype xsd:string ;
        sh:message "Note requires exactly one dct:title literal."
    ] .
`;
    const violatingGraph = `
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
<urn:note:1> a cg:Note .
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
    const descriptor = ContextDescriptor.create('urn:cg:test:gate:shape' as IRI)
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
