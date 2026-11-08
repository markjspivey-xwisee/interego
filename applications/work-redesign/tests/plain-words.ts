/**
 * The plain-words guard every DOM test of the web UI shares: the protocol's and the plumbing's words
 * a person should never have to read on screen, and what "on screen" means. One copy, so a test in
 * another harness (signed in with Interego, say) holds the page to exactly the same list.
 */

/** Words of the protocol and the plumbing that a person should never have to read on screen. */
export const JARGON = /\b(pod|affordance|envelope|payload|ratif\w*|regime|Hypothetical|Asserted|Counterfactual|P(10|50|90)|Brier|IRI|descriptor|sha256|relay|bridge|countersign\w*|Refused)\b|HTTP \d{3}|WRD_[A-Z_]+|EIP-191|personal_sign|did:web:|urn:wrd:/i;
/** Matches the guard allows, each with why. Empty: nothing on screen needs one. */
export const ALLOWED: ReadonlyArray<readonly [RegExp, string]> = [];

/** Every match of JARGON in `text` outside ALLOWED, each with the words around it. */
export const jargonIn = (text: string): string[] => {
  let rest = text;
  for (const [re] of ALLOWED) rest = rest.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), ' ');
  const hits: string[] = [];
  const g = new RegExp(JARGON.source, 'gi');
  for (const m of rest.matchAll(g)) {
    const at = m.index ?? 0;
    hits.push(`"${m[0]}" in …${rest.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ')}…`);
  }
  return hits;
};

/**
 * What a person can see of #app: closed details' contents, hidden elements, pre blocks and text areas
 * left out. A field's value is never text (an input's value is not textContent), so an address in a
 * readonly input is not on screen as words.
 */
export const visibleText = (d: Document): string => {
  const root = d.getElementById('app')!.cloneNode(true) as HTMLElement;
  for (const det of [...root.querySelectorAll('details')]) if (!det.hasAttribute('open')) for (const c of [...det.children]) if (c.tagName !== 'SUMMARY') c.remove();
  for (const n of [...root.querySelectorAll('[hidden], pre, textarea')]) n.remove();
  return root.textContent ?? '';
};
