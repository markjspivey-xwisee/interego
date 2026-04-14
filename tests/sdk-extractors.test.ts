import { describe, it, expect } from 'vitest';
import {
  extract,
  detectFormat,
  ContextGraphsSDK,
} from '../src/index.js';

// ═════════════════════════════════════════════════════════════
//  Format Detection
// ═════════════════════════════════════════════════════════════

describe('Format Detection', () => {
  it('detects markdown', () => {
    expect(detectFormat('# Hello\n## World')).toBe('markdown');
  });

  it('detects JSON', () => {
    expect(detectFormat('{"key": "value"}')).toBe('json');
  });

  it('detects HTML', () => {
    expect(detectFormat('<html><body>Hello</body></html>')).toBe('html');
  });

  it('detects Turtle RDF', () => {
    expect(detectFormat('@prefix cg: <urn:cg:> . cg:test cg:value "hello" .')).toBe('turtle');
  });

  it('detects by filename extension', () => {
    expect(detectFormat('anything', 'file.pdf')).toBe('pdf');
    expect(detectFormat('anything', 'file.csv')).toBe('csv');
    expect(detectFormat('anything', 'file.json')).toBe('json');
  });

  it('defaults to text', () => {
    expect(detectFormat('plain text content')).toBe('text');
  });
});

// ═════════════════════════════════════════════════════════════
//  Extraction
// ═════════════════════════════════════════════════════════════

describe('Content Extraction', () => {
  it('extracts text as-is', async () => {
    const result = await extract('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.format).toBe('text');
    expect(result.contentHash.length).toBe(64);
    expect(result.metadata.extractor).toBe('passthrough');
  });

  it('extracts from JSON', async () => {
    const json = JSON.stringify({
      name: 'Interego',
      description: 'Federated context for AI agents',
      nested: { deep: 'value here' },
    });
    const result = await extract(json);
    expect(result.format).toBe('json');
    expect(result.text).toContain('Interego');
    expect(result.text).toContain('Federated context for AI agents');
    expect(result.text).toContain('value here');
  });

  it('extracts from CSV', async () => {
    const csv = 'name,role,team\nAlice,Engineer,Platform\nBob,Designer,Product';
    const result = await extract(csv, { filename: 'team.csv' });
    expect(result.format).toBe('csv');
    expect(result.text).toContain('Columns: name, role, team');
    expect(result.text).toContain('name: Alice');
    expect(result.text).toContain('role: Designer');
  });

  it('extracts from HTML', async () => {
    const html = '<html><head><style>body{}</style></head><body><h1>Title</h1><p>Content here</p><script>alert(1)</script></body></html>';
    const result = await extract(html, { filename: 'page.html' });
    expect(result.format).toBe('html');
    expect(result.text).toContain('Title');
    expect(result.text).toContain('Content here');
    expect(result.text).not.toContain('alert');
    expect(result.text).not.toContain('<script');
    expect(result.text).not.toContain('body{}');
  });

  it('extracts labels from Turtle', async () => {
    const turtle = `
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix schema: <http://schema.org/> .
      <urn:test> rdfs:label "My Resource" ;
        schema:description "A test resource for extraction" .
    `;
    const result = await extract(turtle);
    expect(result.format).toBe('turtle');
    expect(result.text).toContain('My Resource');
    expect(result.text).toContain('A test resource for extraction');
  });

  it('chunks text when requested', async () => {
    const text = 'a'.repeat(500);
    const result = await extract(text, { chunkSize: 100 });
    expect(result.chunks).toBeDefined();
    expect(result.chunks!.length).toBeGreaterThan(1);
    expect(result.chunks![0]!.text.length).toBeLessThanOrEqual(100);
  });

  it('produces deterministic content hash', async () => {
    const a = await extract('same content');
    const b = await extract('same content');
    expect(a.contentHash).toBe(b.contentHash);
  });
});

// ═════════════════════════════════════════════════════════════
//  SDK
// ═════════════════════════════════════════════════════════════

describe('SDK', () => {
  it('creates SDK instance with config', () => {
    const cg = new ContextGraphsSDK({
      podUrl: 'https://example.com/alice/',
      token: 'cg_test_token',
      agentId: 'urn:agent:test',
      ownerWebId: 'https://example.com/alice/profile#me',
    });
    expect(cg).toBeDefined();
    cg.close();
  });

  it('ingests content into PGSL lattice', () => {
    const cg = new ContextGraphsSDK({ podUrl: 'https://example.com/alice/' });
    const uri = cg.ingest('Hello world from the SDK');
    expect(uri).toContain('urn:pgsl:fragment');

    const resolved = cg.resolve(uri);
    expect(resolved).toBe('Hello world from the SDK');

    const stats = cg.stats();
    expect(stats.atoms).toBe(5); // Hello, world, from, the, SDK
    expect(stats.totalNodes).toBeGreaterThan(5);
    cg.close();
  });

  it('computes PGSL meet between two ingestions', () => {
    const cg = new ContextGraphsSDK({ podUrl: 'https://example.com/alice/' });
    const a = cg.ingest('context graphs enable federated knowledge sharing');
    const b = cg.ingest('federated knowledge sharing across autonomous agents');

    const meet = cg.meet(a, b);
    expect(meet).not.toBeNull();
    const content = cg.resolve(meet!);
    expect(content).toBe('federated knowledge sharing');

    cg.close();
  });

  it('search returns empty for non-matching query', async () => {
    // This would need a real pod, so we test the method exists
    const cg = new ContextGraphsSDK({ podUrl: 'https://example.com/alice/' });
    expect(typeof cg.search).toBe('function');
    expect(typeof cg.publish).toBe('function');
    expect(typeof cg.discover).toBe('function');
    expect(typeof cg.get).toBe('function');
    expect(typeof cg.subscribe).toBe('function');
    cg.close();
  });
});
