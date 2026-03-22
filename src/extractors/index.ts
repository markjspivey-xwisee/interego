/**
 * @module extractors
 * @description Multi-format content extraction for Context Graphs.
 *
 * Extracts text content from various formats for PGSL ingestion:
 *   - PDF → text extraction via pdf-parse
 *   - Plain text / Markdown → pass-through
 *   - JSON → structured text extraction
 *   - CSV → header + row extraction
 *   - HTML → text content extraction
 *
 * Each extraction produces:
 *   - Extracted text (for PGSL ingest)
 *   - Provenance metadata (source format, extraction method, timestamp)
 *   - Content hash (for deduplication)
 */

import { sha256 } from '../crypto/ipfs.js';

// ═════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════

export interface ExtractionResult {
  readonly text: string;
  readonly format: SourceFormat;
  readonly contentHash: string;
  readonly extractedAt: string;
  readonly metadata: Record<string, unknown>;
  readonly chunks?: readonly TextChunk[];
}

export interface TextChunk {
  readonly text: string;
  readonly index: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export type SourceFormat = 'text' | 'markdown' | 'pdf' | 'json' | 'csv' | 'html' | 'turtle' | 'unknown';

// ═════════════════════════════════════════════════════════════
//  Format Detection
// ═════════════════════════════════════════════════════════════

export function detectFormat(content: string, filename?: string): SourceFormat {
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') return 'pdf';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (ext === 'json' || ext === 'jsonld') return 'json';
    if (ext === 'csv' || ext === 'tsv') return 'csv';
    if (ext === 'html' || ext === 'htm') return 'html';
    if (ext === 'ttl' || ext === 'turtle') return 'turtle';
    if (ext === 'txt') return 'text';
  }

  // Content-based detection
  if (content.startsWith('%PDF')) return 'pdf';
  if (content.trimStart().startsWith('{') || content.trimStart().startsWith('[')) return 'json';
  if (content.includes('@prefix ') || content.includes('@base ')) return 'turtle';
  if (content.includes('<html') || content.includes('<!DOCTYPE')) return 'html';
  if (content.includes('# ') || content.includes('## ')) return 'markdown';

  return 'text';
}

// ═════════════════════════════════════════════════════════════
//  Extractors
// ═════════════════════════════════════════════════════════════

/**
 * Extract text from any supported format.
 */
export async function extract(
  content: string | Buffer,
  options?: { filename?: string; chunkSize?: number },
): Promise<ExtractionResult> {
  const text = typeof content === 'string' ? content : content.toString('utf-8');
  const format = detectFormat(text, options?.filename);

  let extracted: string;
  const metadata: Record<string, unknown> = { sourceFormat: format };

  switch (format) {
    case 'pdf':
      extracted = await extractPdf(content);
      metadata.extractor = 'pdf-parse';
      break;
    case 'json':
      extracted = extractJson(text);
      metadata.extractor = 'json-flatten';
      break;
    case 'csv':
      extracted = extractCsv(text);
      metadata.extractor = 'csv-parse';
      break;
    case 'html':
      extracted = extractHtml(text);
      metadata.extractor = 'html-strip';
      break;
    case 'turtle':
      extracted = extractTurtle(text);
      metadata.extractor = 'turtle-labels';
      break;
    case 'markdown':
    case 'text':
    default:
      extracted = text;
      metadata.extractor = 'passthrough';
      break;
  }

  // Chunk if requested
  const chunks = options?.chunkSize ? chunkText(extracted, options.chunkSize) : undefined;

  return {
    text: extracted,
    format,
    contentHash: sha256(extracted),
    extractedAt: new Date().toISOString(),
    metadata,
    chunks,
  };
}

/**
 * Extract text from PDF using pdf-parse.
 */
async function extractPdf(content: string | Buffer): Promise<string> {
  try {
    const mod = await import('pdf-parse') as any;
    const pdfParse = mod.default ?? mod;
    const buffer = typeof content === 'string' ? Buffer.from(content, 'binary') : content;
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    return `[PDF extraction failed: ${(err as Error).message}]`;
  }
}

/**
 * Extract meaningful text from JSON.
 * Flattens nested objects and extracts string values.
 */
function extractJson(text: string): string {
  try {
    const data = JSON.parse(text);
    const strings: string[] = [];
    extractStrings(data, strings);
    return strings.join('\n');
  } catch {
    return text;
  }
}

function extractStrings(obj: unknown, out: string[], depth = 0): void {
  if (depth > 10) return;
  if (typeof obj === 'string' && obj.length > 2) {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) extractStrings(item, out, depth + 1);
  } else if (obj && typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string' && val.length > 2) {
        out.push(`${key}: ${val}`);
      } else {
        extractStrings(val, out, depth + 1);
      }
    }
  }
}

/**
 * Extract text from CSV — headers + rows as natural language.
 */
function extractCsv(text: string): string {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';

  const headers = lines[0]!.split(',').map(h => h.trim().replace(/"/g, ''));
  const rows = lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/"/g, ''));
    return headers.map((h, i) => `${h}: ${values[i] ?? ''}`).join(', ');
  });

  return `Columns: ${headers.join(', ')}\n${rows.join('\n')}`;
}

/**
 * Extract text from HTML — strip tags, keep content.
 */
function extractHtml(text: string): string {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract labels and descriptions from Turtle RDF.
 */
function extractTurtle(text: string): string {
  const labels: string[] = [];
  const labelRegex = /rdfs?:label\s+"([^"]+)"/g;
  const descRegex = /schema:description\s+"([^"]+)"/g;
  const commentRegex = /rdfs?:comment\s+"([^"]+)"/g;

  for (const match of text.matchAll(labelRegex)) labels.push(match[1]!);
  for (const match of text.matchAll(descRegex)) labels.push(match[1]!);
  for (const match of text.matchAll(commentRegex)) labels.push(match[1]!);

  return labels.length > 0 ? labels.join('\n') : text;
}

/**
 * Split text into chunks with overlap for context preservation.
 */
function chunkText(text: string, chunkSize: number, overlap = 50): TextChunk[] {
  const chunks: TextChunk[] = [];
  let offset = 0;
  let index = 0;

  while (offset < text.length) {
    const end = Math.min(offset + chunkSize, text.length);
    chunks.push({
      text: text.slice(offset, end),
      index,
      startOffset: offset,
      endOffset: end,
    });
    offset += chunkSize - overlap;
    index++;
  }

  return chunks;
}
