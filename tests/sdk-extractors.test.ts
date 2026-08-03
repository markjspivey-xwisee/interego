import { describe, it, expect } from 'vitest';
import {
  detectFormat,
  extract,
} from '@interego/extractors';
import {
  ContextGraphsSDK,
} from '@interego/solid';

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
    expect(detectFormat('@prefix iep: <urn:iep:> . iep:test iep:value "hello" .')).toBe('turtle');
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

/**
 * A genuinely valid one-page PDF that draws `text` with the base-14 Helvetica font.
 *
 * Hand-assembled — five objects, a real xref table with real byte offsets, and a trailer —
 * because the point of the test below is to run the actual pdfjs parse. A stub or a
 * pre-canned "the answer" fixture would pass over the broken code path just as happily as
 * over the fixed one.
 */
function minimalPdf(text: string): Buffer {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]'
      + ' /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objs.push(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

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

  // ★★ THE FORMAT THAT HAD NO TEST WAS THE FORMAT THAT DID NOT WORK.
  //
  // Every other branch of extract()'s switch is asserted above. `pdf` was not, and `pdf`
  // was broken outright: `extractPdf` called the pdf-parse v1 API (`(await
  // import('pdf-parse')).default(buffer)`) against the v2 pinned in package.json, which has
  // no default export and whose namespace object is not callable. The TypeError was caught
  // and returned AS THE EXTRACTED TEXT, so `extract()` resolved successfully with
  // `format: 'pdf'`, a 64-char contentHash over the error sentence, and
  // `metadata.extractor: 'pdf-parse'` — nothing downstream could tell it apart from a real
  // document. It survived because `as any` switched the compiler off over the one call site
  // that mattered and nothing here ever ran it.
  //
  // Built rather than fixtured: a checked-in binary is a thing nobody reads or updates, and
  // the whole point is that this path executes the real pdfjs pipeline.
  it('★ extracts real text from a real PDF', async () => {
    const marker = 'INTEREGO PDF PROBE';
    const result = await extract(minimalPdf(marker), { filename: 'probe.pdf' });
    expect(result.format).toBe('pdf');
    expect(result.metadata.extractor).toBe('pdf-parse');
    expect(result.text).toContain(marker);
    // The specific regression: the failure sentence must never be the answer. Asserted
    // separately from the `toContain` above because a future breakage returns a STRING, and
    // a test that only checks the happy substring would still report a clean failure
    // message while the substring check is what actually fails.
    expect(result.text).not.toContain('PDF extraction failed');
  });

  it('reports a corrupt PDF as a failure rather than as content', async () => {
    // Detected as PDF by the %PDF magic, then rejected by the parser. The extractor's
    // contract for this case is the bracketed sentence — pinned so the previous behaviour
    // (EVERY pdf taking this path) cannot come back disguised as intentional.
    const result = await extract(Buffer.from('%PDF-1.4\nnot actually a pdf\n', 'binary'),
      { filename: 'broken.pdf' });
    expect(result.format).toBe('pdf');
    expect(result.text).toMatch(/^\[PDF extraction failed: .+\]$/);
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

  it('ingests content into PGSL lattice', async () => {
    // PGSL convenience methods moved off the SDK with the substrate
    // split (PGSL is now `@interego/pgsl`). Use the package directly.
    const { createPGSL, embedInPGSL, resolve: pgslResolve, latticeStats } = await import('@interego/pgsl');
    const pgsl = createPGSL({ wasAttributedTo: 'urn:agent:test', generatedAtTime: new Date().toISOString() });
    const uri = embedInPGSL(pgsl, 'Hello world from the SDK');
    expect(uri).toContain('/ns/pgsl/fragment');

    const resolved = pgslResolve(pgsl, uri);
    expect(resolved).toBe('Hello world from the SDK');

    const stats = latticeStats(pgsl);
    expect(stats.atoms).toBe(5); // Hello, world, from, the, SDK
    expect(stats.totalNodes).toBeGreaterThan(5);
  });

  it('computes PGSL meet between two ingestions', async () => {
    const { createPGSL, embedInPGSL, latticeMeet, resolve: pgslResolve } = await import('@interego/pgsl');
    const pgsl = createPGSL({ wasAttributedTo: 'urn:agent:test', generatedAtTime: new Date().toISOString() });
    const a = embedInPGSL(pgsl, 'context graphs enable federated knowledge sharing');
    const b = embedInPGSL(pgsl, 'federated knowledge sharing across autonomous agents');

    const meet = latticeMeet(pgsl, a, b);
    expect(meet).not.toBeNull();
    const content = pgslResolve(pgsl, meet!);
    expect(content).toBe('federated knowledge sharing');
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
