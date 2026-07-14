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

/** The subject IRI of the first typed statement (`<iri> a …` / `urn:… a …`) —
 *  the payload graph's own identity, used to source-tag its controls. */
function primarySubject(turtle: string): string | undefined {
  const m = /(?:^|\n)\s*<([^>]+)>\s+a\s+/.exec(turtle) ?? /(?:^|\n)\s*((?:urn|did|https?):[^\s;]+)\s+a\s+/.exec(turtle);
  return m ? m[1] : undefined;
}

export function noteToHyperMarkdown(input: NoteViewInput): string {
  // DESCRIPTOR-level controls (canDecrypt / renderView) — source = the signed
  // descriptor (the transport authority).
  const descriptorControls = controlsFromAffordances(
    extractAffordancesFromTurtle(input.descriptorTurtle, input.authority),
    undefined,
    input.authority,
  );
  // PAYLOAD-level controls declared IN the signed graph (e.g. ask / acknowledge /
  // propose-correction, with their SHACL input shapes) — source = the payload
  // graph itself. Previously dropped: the projection only read the descriptor,
  // so a client had to reconstruct these after verifying the signed graph.
  const payloadSource = primarySubject(input.plaintextTurtle) ?? 'urn:interego:signed-payload';
  const payloadControls = controlsFromAffordances(
    extractAffordancesFromTurtle(input.plaintextTurtle, payloadSource),
    undefined,
    payloadSource,
  );
  // Merge; on an action collision the signed PAYLOAD control wins (authored,
  // verified content outranks a transport-descriptor affordance).
  const byAction = new Map<string, (typeof descriptorControls)[number]>();
  for (const c of [...descriptorControls, ...payloadControls]) byAction.set(c.action, c);
  const controls = [...byAction.values()];
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
