import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { followAffordance } from '@interego/core';
import { affordancesManifestTurtle } from '../../_shared/affordance-mcp/index.js';
import { AUTHORED_CATALOG, AUTHORED_NS, FRAMEWORK_IRI } from '../i2idlx/typescript/authored-concepts.js';
import { authoredGlossaryAffordances } from '../src/i2idlx-authored-affordances.js';
import { attachSemanticTaskRoutes } from '../src/i2idlx-semantic-tasks.js';

describe('authored read declarations match the actual HTTP follower contract', () => {
  it('follows all three advertised reads and shares their client budget before reading files', async () => {
    const temporaryRoot = await realpath(tmpdir()), directory = await mkdtemp(join(temporaryRoot, 'authored-read-contract-'));
    const target = resolve(directory), contained = relative(temporaryRoot, target);
    if (isAbsolute(contained) || contained === '..' || contained.startsWith('..') || !basename(target).startsWith('authored-read-contract-')) throw new Error('Refusing cleanup outside the created fixture directory.');
    const server = express();
    // Eight bounded fixture rows satisfy the proposal's related references; this is not a full-release fixture.
    const concepts = AUTHORED_CATALOG.concepts[0]!.related.map(id => ({ id, l: id, d: 'Contract fixture source entry.' }));
    const data = { meta: { release: 'contract-fixture', commit: '0'.repeat(40), ns: AUTHORED_NS,
      iri: { ontology: AUTHORED_NS.slice(0, -1) }, counts: { concepts: concepts.length } }, concepts, sources: [],
    semantic: { categories: [{ id: 'model' }], bridges: [] }, authoredCatalog: AUTHORED_CATALOG };
    let listener: ReturnType<typeof server.listen> | undefined;
    try {
      const appDataFile = join(directory, 'data.json');
      await writeFile(appDataFile, JSON.stringify(data));
      await writeFile(join(directory, 'i2idlx-shapes.ttl'), `<${AUTHORED_NS.slice(0, -1)}-shapes#I2IDLConceptRef> a <http://www.w3.org/ns/shacl#NodeShape> ; <http://www.w3.org/ns/shacl#pattern> "^https://id\\\\.i2idl\\\\.org/concepts/[a-z0-9][a-z0-9-]*$" .`);
      listener = server.listen(0, '127.0.0.1');
      await new Promise<void>(done => listener!.once('listening', done));
      const base = 'http://127.0.0.1:' + (listener.address() as AddressInfo).port;
      attachSemanticTaskRoutes(server, { baseUrl: base, appDataFile, distDirectory: directory });
      const descriptor = base + '/affordances';
      server.get('/affordances', (_req, res) => res.type('text/turtle').send(affordancesManifestTurtle(descriptor, authoredGlossaryAffordances, base)));
      const results = new Map<string, Awaited<ReturnType<typeof followAffordance>>>();
      for (const declaration of authoredGlossaryAffordances) {
        const result = await followAffordance(descriptor, declaration.action, {}, { expectedMethod: 'GET' });
        results.set(declaration.toolName, result);
        expect(declaration).toMatchObject({ method: 'GET', externallyRouted: true, inputs: [],
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } });
        expect(result.status).toBe(200); expect(result.contentType).toContain(declaration.mediaType!);
        expect(result.affordance).toMatchObject({ action: declaration.action, method: 'GET', mediaType: declaration.mediaType });
        expect(Object.keys(declaration.outputs!.properties!)).toEqual(['status', 'contentType', 'body', 'affordance']);
        for (const [field, property] of Object.entries(declaration.outputs!.properties!)) expect(typeof result[field as keyof typeof result]).toBe(property.type);
      }
      const catalogResult = results.get('foxxi.i2idlx_authored_catalog')!, rdf = results.get('foxxi.i2idlx_authored_rdf')!, shapes = results.get('foxxi.i2idlx_authored_shapes')!;
      const catalog = JSON.parse(catalogResult.body);
      expect(catalog).toMatchObject({ kind: 'authored-glossary-catalog', status: 'Hypothetical', upstream_adopted: false,
        counts: { canonical: 8, authored: 1, combined: 9 } });
      expect(catalog.rdf.href).toBe(rdf.affordance.target);
      expect(createHash('sha256').update(rdf.body).digest('hex')).toBe(catalog.rdf.sha256);
      for (const text of [rdf.body, shapes.body]) { expect(text).toContain(FRAMEWORK_IRI); expect(() => JSON.parse(text)).toThrow(); }
      // The three follower reads above and these 57 reads spend one shared
      // client budget, rather than granting 60 reads per representation.
      const targets = [...results.values()].map(result => result.affordance.target);
      for (let request = results.size; request < 60; request++) {
        const response = await fetch(targets[request % targets.length]!);
        expect(response.status).toBe(200);
        await response.text();
      }
      // An invoked handler would now fail its first file read with 503. Every
      // representation must instead refuse before loading or parsing anything.
      await rm(appDataFile);
      for (const target of targets) {
        const response = await fetch(target);
        expect(response.status).toBe(429);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(60);
        expect(response.headers.get('ratelimit')).toContain('i2idlx-authored-client');
        expect(await response.json()).toEqual({ error: 'too_many_requests' });
      }
    } finally {
      if (listener?.listening) await new Promise<void>((done, reject) => listener!.close(error => error ? reject(error) : done()));
      await rm(target, { recursive: true, force: true });
    }
  });
});
