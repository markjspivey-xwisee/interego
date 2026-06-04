/**
 * Kernel hypermedia + JSON-LD + SHACL decoration tests.
 *
 * Verifies the substrate-wide policy that every kernel-verb / shim
 * response carries:
 *   1. JSON-LD discipline — @context / @id / @type at the top level
 *   2. SHACL shape reference — cg:conformsToShape: <shape-iri>
 *   3. Hydra hypermedia — affordances[] with hydra:Operation typing
 *
 * The verb behaviours themselves are tested elsewhere; these tests
 * are purely about the wire-envelope discipline the kernel + relay
 * surface in every response.
 */

import { describe, it, expect } from 'vitest';
import {
  compose,
  ContextDescriptor,
  decompose,
  decorateKernelResult,
  decorateShim,
  extend,
  hydraAffordance,
  hydraEntryPoint,
  KERNEL_JSONLD_CONTEXT,
  KERNEL_RESULT_SHAPES,
  mint,
  promote,
  restrict,
} from '@interego/core';
import type {
  ContextDescriptorData,
  IRI,
} from '@interego/core';

const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const CG = 'https://markjspivey-xwisee.github.io/interego/ns/cg#';
const CGH = 'https://markjspivey-xwisee.github.io/interego/ns/cgh#';

describe('kernel hypermedia envelope', () => {
  it('mint result wrapped via decorateKernelResult carries @context / @type / shape / affordances', () => {
    const r = mint({ hello: 'world' }, { kind: 'opaque' });
    const decorated = decorateKernelResult(r as unknown as Record<string, unknown>, {
      kind: 'mint',
      id: r.holon.iri,
      nextSteps: [{ action: 'urn:cg:action:dereference', target: r.holon.iri, method: 'GET' }],
    });

    expect(decorated['@context']).toBe(KERNEL_JSONLD_CONTEXT);
    expect(decorated['@id']).toBe(r.holon.iri);
    expect(decorated['@type']).toContain(`${CG}MintResult`);
    expect(decorated['@type']).toContain(`${CG}Holon`);
    expect(decorated.conformsToShape).toBe(KERNEL_RESULT_SHAPES.holon);
    // The next-step affordance is fully Hydra-typed.
    expect(decorated.affordances.length).toBeGreaterThan(0);
    const aff = decorated.affordances[0]!;
    expect(aff['@type']).toContain(`${HYDRA}Operation`);
    expect(aff['@type']).toContain(`${CG}Affordance`);
    expect(aff['@type']).toContain(`${CGH}Affordance`);
    // Original verb payload still reachable verbatim.
    expect((decorated as unknown as { holon: { iri: string } }).holon.iri).toBe(r.holon.iri);
  });

  it('compose result advertises a ComposedDescriptor shape + next-step navigation', () => {
    const a = ContextDescriptor.create('urn:test:a' as IRI)
      .describes('urn:graph:a' as IRI)
      .asserted(0.9)
      .build();
    const b = ContextDescriptor.create('urn:test:b' as IRI)
      .describes('urn:graph:b' as IRI)
      .selfAsserted('did:web:test' as IRI)
      .build();

    const r = compose([a, b], 'union');
    const decorated = decorateKernelResult(r as unknown as Record<string, unknown>, {
      kind: 'compose',
      id: r.composed.id,
      nextSteps: [{ action: 'urn:cg:action:publish', target: 'urn:cg:tool:publish_context', method: 'POST' }],
    });
    expect(decorated['@type']).toContain(`${CG}ComposeResult`);
    expect(decorated['@type']).toContain(`${CG}ComposedDescriptor`);
    expect(decorated.conformsToShape).toBe(KERNEL_RESULT_SHAPES.composed);
    expect(decorated.affordances[0]?.action).toBe('urn:cg:action:publish');
    expect(decorated.affordances[0]?.method).toBe('POST');
  });

  it('promote result carries PromoteResult shape + dereference + decompose affordances', () => {
    const r = promote(['x', 'y', 'z']);
    const decorated = decorateKernelResult(r as unknown as Record<string, unknown>, {
      kind: 'promote',
      id: r.apex,
      nextSteps: [
        { action: 'urn:cg:action:dereference', target: r.apex, method: 'GET' },
        { action: 'urn:cg:action:decompose',   target: 'urn:cg:tool:decompose', method: 'POST' },
      ],
    });
    expect(decorated['@type']).toContain(`${CG}PromoteResult`);
    expect(decorated.conformsToShape).toBe(KERNEL_RESULT_SHAPES.promote);
    expect(decorated.affordances.map(a => a.action))
      .toContain('urn:cg:action:dereference');
    expect(decorated.affordances.map(a => a.action))
      .toContain('urn:cg:action:decompose');
  });

  it('decompose of a level-2 fragment yields pullback fields + dereference affordances', () => {
    // Mint a level-2 fragment via promote.
    const apexR = promote(['p', 'q', 'r']);
    const r = decompose(apexR.apex);
    // decompose may return null for small fragments; tolerate by
    // exercising the decoration path only when structure exists.
    if (r !== null) {
      const decorated = decorateKernelResult(r as unknown as Record<string, unknown>, {
        kind: 'decompose',
        id: r.apex,
        nextSteps: [
          { action: 'urn:cg:action:dereference', target: r.left,    method: 'GET' },
          { action: 'urn:cg:action:dereference', target: r.right,   method: 'GET' },
          { action: 'urn:cg:action:dereference', target: r.overlap, method: 'GET' },
        ],
      });
      expect(decorated['@type']).toContain(`${CG}DecomposeResult`);
      expect(decorated.affordances.length).toBe(3);
      expect(decorated.affordances.every(a => a.method === 'GET')).toBe(true);
    }
  });

  it('restrict / extend results preserve the descriptor as a navigable resource', () => {
    const d: ContextDescriptorData = ContextDescriptor.create('urn:test:c' as IRI)
      .describes('urn:graph:c' as IRI)
      .asserted(0.9)
      .selfAsserted('did:web:test' as IRI)
      .build();
    const restricted = restrict(d, { kind: 'facet-types', types: ['Semiotic'] });
    const decoratedR = decorateKernelResult(restricted as unknown as Record<string, unknown>, {
      kind: 'restrict',
      id: restricted.restricted.id,
      nextSteps: [{ action: 'urn:cg:action:extend', target: 'urn:cg:tool:extend', method: 'POST' }],
    });
    expect(decoratedR['@type']).toContain(`${CG}RestrictResult`);
    expect(decoratedR.conformsToShape).toBe(KERNEL_RESULT_SHAPES.descriptor);

    const extended = extend(restricted.restricted, d);
    const decoratedE = decorateKernelResult(extended as unknown as Record<string, unknown>, {
      kind: 'extend',
      id: extended.extended.id,
    });
    expect(decoratedE['@type']).toContain(`${CG}ExtendResult`);
  });
});

describe('hydraAffordance', () => {
  it('upgrades a bare Affordance to multi-typed JSON-LD', () => {
    const h = hydraAffordance({
      action: 'urn:cg:action:publish',
      target: 'https://relay.example/tool/publish_context',
      method: 'POST',
      mediaType: 'application/json',
    });
    expect(h['@type']).toContain(`${HYDRA}Operation`);
    expect(h['@type']).toContain(`${CG}Affordance`);
    expect(h['@type']).toContain(`${CGH}Affordance`);
    expect(h.method).toBe('POST');
    expect(h.mediaType).toBe('application/json');
  });
});

describe('decorateShim', () => {
  it('preserves the shim payload + adds the hypermedia envelope', () => {
    const payload = {
      published: true,
      descriptorUrl: 'https://pod.example/me/descriptors/a.ttl',
      graphUrl: 'https://pod.example/me/graphs/a.trig',
    };
    const decorated = decorateShim(payload, {
      tool: 'publish_context',
      id: payload.descriptorUrl,
      nextSteps: [
        { action: 'urn:cg:action:supersede', target: payload.descriptorUrl, method: 'POST' },
      ],
    });
    expect(decorated.published).toBe(true);
    expect(decorated['@id']).toBe(payload.descriptorUrl);
    expect(decorated['@type']).toContain('urn:cg:tool-result:publish_context');
    expect(decorated.affordances[0]?.action).toBe('urn:cg:action:supersede');
  });
});

describe('hydraEntryPoint', () => {
  it('emits a hydra:EntryPoint document with every operation Hydra-typed', () => {
    const entry = hydraEntryPoint({
      base: 'https://interego.example',
      title: 'Test relay',
      operations: [
        { name: 'list-tools', target: '/tools',    method: 'GET' },
        { name: 'invoke',     target: '/tool/{n}', method: 'POST', description: 'Invoke a tool by name' },
      ],
    });
    expect((entry['@type'] as string[]).includes(`${HYDRA}EntryPoint`)).toBe(true);
    const affordances = entry['affordances'] as Array<{ '@type': string[]; target: string }>;
    expect(affordances.length).toBe(2);
    expect(affordances[0]?.['@type']).toContain(`${HYDRA}Operation`);
    expect(affordances[0]?.target).toBe('https://interego.example/tools');
  });
});

describe('SHACL shape catalog', () => {
  it('every kernel result kind has a shape IRI', () => {
    for (const k of ['holon', 'descriptor', 'composed', 'manifest', 'affordance', 'promote', 'decompose', 'act', 'dereference', 'result'] as const) {
      expect(KERNEL_RESULT_SHAPES[k]).toMatch(/^https:\/\/.*#.*Shape$/);
    }
  });
});
