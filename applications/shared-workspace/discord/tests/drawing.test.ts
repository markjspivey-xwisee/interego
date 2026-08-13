/**
 * AN AGENT PRODUCING A FILE — WHICH NEEDED NO CAPABILITY AT ALL.
 *
 * Asked in a live channel for a picture, a delegate replied that image generation was not something
 * it could do and that somebody would have to wrap an image model and grant it write access. A
 * whole design followed that: connectors, per-tool grants, a published affordance holding its own
 * API key. All of it beside the point.
 *
 * ★ A FILE IS TEXT WITH A NAME, and writing text is the one thing a delegate needs no permission
 * for. MEASURED through the delegate's own isolated config — the relay as its only MCP server,
 * every built-in denied, no image tool present — the same child produced a 2,595-character donkey
 * with a viewBox and no script. The capability was never absent; the agent had not been told that
 * producing a file counts, and the channel had no way to attach one.
 *
 * So nothing here grants anything, and nothing here touches the record: what the agent writes lands
 * in `dct:description` like any other answer. This is a PROJECTION into Discord, the same
 * relationship `render.ts` has to an entry.
 */

import { describe, it, expect } from 'vitest';
import { contentTypeFor, findProduced, renderPng, safeFileName } from '../src/drawing.js';

const DONKEY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 320">'
  + '<ellipse cx="225" cy="195" rx="115" ry="58" fill="#888"/>'
  + '<ellipse cx="225" cy="237" rx="80" ry="18" fill="#aaa"/>'
  + '</svg>';

/** A fenced block, built rather than written, so no escape survives a tool that rewrites this file. */
const fence = (name: string, body: string): string => '```file:' + name + '\n' + body + '\n```';

describe('a file the agent produced, of any kind', () => {
  it('★ takes a fenced block tagged with a filename — the general case', () => {
    // Markdown, CSV, JSON, Turtle, code — anything a model can write.
    const d = findProduced('Here is the summary.\n\n' + fence('findings.md', '# Findings\n\nRoof: patch.'));
    expect(d.kind).toBe('file');
    if (d.kind !== 'file') throw new Error('narrowed above');
    expect(d.name).toBe('findings.md');
    expect(d.contentType).toBe('text/markdown');
    expect(d.rasterise).toBe(false);
    expect(d.text).toContain('# Findings');
    // ★ THE PROSE IS KEPT. An agent that attaches a table and explains it in a sentence has said
    // both, and dropping the sentence to show the file would be this bot editing an answer that is
    // already on somebody's permanent record.
    expect(d.rest).toBe('Here is the summary.');
  });

  it('types a file from its extension, and falls back to plain text', () => {
    expect(contentTypeFor('a.csv')).toBe('text/csv');
    expect(contentTypeFor('a.json')).toBe('application/json');
    expect(contentTypeFor('a.ttl')).toBe('text/turtle');
    expect(contentTypeFor('a.wat')).toBe('text/plain');
  });

  it('★ refuses or defuses a filename that is a path', () => {
    // The name is chosen by a model in answer to text other people wrote, and it becomes a
    // filename on somebody's machine the moment they click it.
    expect(safeFileName('a/b.md')).toBe('ab.md');
    expect(safeFileName('../../etc/passwd')).toBe('etcpasswd');
    expect(safeFileName('.hidden')).toBe('hidden');
    expect(safeFileName('')).toBeNull();
    expect(safeFileName('x'.repeat(200))).toBeNull();
    expect(safeFileName('a>b.md')).toBeNull();
    expect(safeFileName('a:b.md')).toBeNull();
    // A space is ordinary in a filename and is allowed — the first version of the rule was a
    // character RANGE that refused it, which is a different rule from the one meant.
    expect(safeFileName('my notes.md')).toBe('my notes.md');
  });

  it('refuses an empty file rather than attaching nothing', () => {
    expect(findProduced(fence('empty.md', '   ')).kind).toBe('refused');
  });

  it('an svg named as a file is still rendered as a picture', () => {
    const d = findProduced(fence('chart.svg', '<svg viewBox="0 0 1 1"><rect/></svg>'));
    expect(d.kind).toBe('file');
    if (d.kind !== 'file') throw new Error('narrowed above');
    expect(d.rasterise).toBe(true);
    expect(d.name).toBe('chart.png');
  });
});

describe('a drawing, recognised on its own', () => {
  it('finds an svg and keeps the words around it', () => {
    const d = findProduced('Here you go.\n\n' + DONKEY + '\n\nIt is grey.');
    expect(d.kind).toBe('file');
    if (d.kind !== 'file') throw new Error('narrowed above');
    expect(d.text).toBe(DONKEY);
    expect(d.rasterise).toBe(true);
    expect(d.name).toBe('drawing.png');
    expect(d.rest).toContain('Here you go.');
    expect(d.rest).toContain('It is grey.');
    expect(d.rest).not.toContain('<svg');
  });

  it('strips a code fence a model wrapped it in', () => {
    const d = findProduced('```svg\n' + DONKEY + '\n```');
    expect(d.kind).toBe('file');
    if (d.kind !== 'file') throw new Error('narrowed above');
    expect(d.rest).toBe('');
  });

  it('an ordinary answer produces nothing', () => {
    expect(findProduced('I think we should re-tile in spring.').kind).toBe('none');
    expect(findProduced('').kind).toBe('none');
  });
});

/**
 * ★ THE INPUT IS MARKUP A MODEL WROTE, IN ANSWER TO TEXT OTHER PEOPLE TYPED.
 *
 * It is never eval'd, so this is not an injection surface in the usual sense — but it is untrusted
 * and it is about to be handed to a native renderer, and the original is kept on a pod where a
 * person may later open it in a browser that behaves differently.
 */
describe('what will not be rendered', () => {
  const refused = (svg: string): string => {
    const d = findProduced(svg);
    expect(d.kind, svg.slice(0, 60)).toBe('refused');
    return d.kind === 'refused' ? d.why : '';
  };

  it('★ refuses script, however it is spelled', () => {
    refused('<svg viewBox="0 0 1 1"><script>fetch("http://evil")</script></svg>');
    refused('<svg viewBox="0 0 1 1"><SCRIPT >x</SCRIPT></svg>');
  });

  it('★ refuses an event handler', () => {
    refused('<svg viewBox="0 0 1 1"><rect onload="x()" /></svg>');
    refused('<svg viewBox="0 0 1 1"><rect onclick="x()" /></svg>');
  });

  it('★ refuses a reference to something outside the document', () => {
    // A renderer that fetched these would make the bot issue an outbound request to an address the
    // MODEL chose, from inside the deployment — an SSRF arriving dressed as a picture.
    refused('<svg viewBox="0 0 1 1"><image href="https://evil/x.png"/></svg>');
    refused('<svg viewBox="0 0 1 1"><image xlink:href="http://evil/x.png"/></svg>');
    refused('<svg viewBox="0 0 1 1"><use href="//evil/x"/></svg>');
    refused('<svg viewBox="0 0 1 1"><rect fill="url(https://evil/x)"/></svg>');
  });

  it('refuses entity expansion and foreignObject', () => {
    refused('<svg viewBox="0 0 1 1"><!ENTITY x "y"></svg>');
    refused('<svg viewBox="0 0 1 1"><foreignObject><b>x</b></foreignObject></svg>');
  });

  it('refuses one too large to be worth rendering', () => {
    expect(refused('<svg viewBox="0 0 1 1">' + '<rect/>'.repeat(20_000) + '</svg>')).toContain('over the');
  });

  it('★ a local reference is fine — the rule is OUTSIDE, not references', () => {
    // Gradients and clip paths are how real SVG is written and they point at `#id` in the same
    // document. A rule refusing every `href` would refuse most legitimate drawings.
    expect(findProduced('<svg viewBox="0 0 1 1"><use href="#body"/><rect fill="url(#grad)"/></svg>').kind).toBe('file');
  });
});

describe('rendering a drawing to something a person can see', () => {
  it('★ produces a PNG, because Discord shows an SVG attachment as a file to download', async () => {
    const out = await renderPng(DONKEY);
    if (!out.ok) {
      // A deployment whose architecture has no prebuilt binary must still run the bot; the words
      // post either way. Reported rather than failed, so this suite is honest on such a machine.
      expect(out.why).toBeTruthy();
      return;
    }
    expect(out.png.byteLength).toBeGreaterThan(100);
    // PNG magic: 0x89 P N G
    expect(Array.from(out.png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('a renderer failure is an answer, not a throw', async () => {
    const out = await renderPng('<svg');
    if (out.ok) { expect(out.png.byteLength).toBeGreaterThan(0); return; }
    expect(out.why).toBeTruthy();
  });
});
