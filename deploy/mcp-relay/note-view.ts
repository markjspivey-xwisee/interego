/**
 * note-view — project a decrypted note/graph as a complete HyperMarkdown
 * document: the human-legible + agent-actionable view of a PRIVATE resource.
 *
 * Extracted from server.ts so it is unit-testable without booting the relay
 * (server.ts is self-starting). Called only AFTER /render's bearer +
 * recipient-set + decrypt checks pass, so it exposes nothing new — it renders
 * what the authorized owner already received as plaintext, but as HyperMarkdown
 * (the note's own text as rung-1 prose, the descriptor's affordances as
 * target-free :::control blocks, describedby/alternate links to the authority).
 */
import {
  controlsFromAffordances,
  extractAffordancesFromTurtle,
  renderHypermediaMarkdown,
} from '@interego/core';

export interface NoteViewInput {
  /** The note's dereferenceable HTTPS identity (this render URL). Fragment-free. */
  readonly viewUrl: string;
  /** The signed descriptor (authority) — already resolved to a public https URL. */
  readonly authority: string;
  /** The descriptor Turtle, for affordance extraction. */
  readonly descriptorTurtle: string;
  /** The decrypted note graph (Turtle/TriG). */
  readonly plaintextTurtle: string;
}

/** First literal value of any of the given predicates (triple- or single-quoted). */
function pickLiteral(turtle: string, preds: string): string {
  const p = `(?:${preds})`;
  const triple = new RegExp(`${p}\\s+"""([\\s\\S]*?)"""`).exec(turtle);
  if (triple) return triple[1]!.trim();
  const single = new RegExp(`${p}\\s+"((?:[^"\\\\]|\\\\.)*)"`).exec(turtle);
  return single ? single[1]!.replace(/\\"/g, '"').replace(/\\n/g, '\n').trim() : '';
}

export function noteToHyperMarkdown(input: NoteViewInput): string {
  const controls = controlsFromAffordances(
    extractAffordancesFromTurtle(input.descriptorTurtle, input.authority),
  );
  const title = pickLiteral(input.plaintextTurtle, 'dct:title|schema:name|rdfs:label|schema:headline') || 'Private note';
  const text = pickLiteral(input.plaintextTurtle, 'schema:text|schema:articleBody|dct:description|rdfs:comment');
  // Neutralize any leading ::: in the note text so it can't collide with the
  // renderer's reserved control-fence (owner content is trusted, but the fence
  // guard is strict; a leading space keeps it valid CommonMark and inert).
  const safeText = text.split('\n').map((l) => (/^:::/.test(l) ? ` ${l}` : l)).join('\n');
  const body = [
    `# ${title.replace(/\s+/g, ' ')}`,
    ``,
    ...(safeText ? [safeText, ``] : []),
    `_Private note — encrypted at rest; decrypted here for you, the authorized agent. Its controls and links are below; the note stays private._`,
  ].join('\n');
  return renderHypermediaMarkdown({
    id: input.viewUrl,
    type: ['ieh:AgentMemory', 'hmd:Document'],
    descriptorUrl: input.authority,
    state: 'private',
    links: [
      { label: 'Signed descriptor (authority)', href: input.authority, rel: 'describedby', type: 'text/turtle' },
      { label: 'Turtle (decrypted)', href: `${input.viewUrl}?format=turtle`, rel: 'alternate', type: 'text/turtle' },
    ],
    controls,
    body,
  });
}
