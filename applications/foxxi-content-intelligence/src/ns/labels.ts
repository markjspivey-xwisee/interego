/**
 * ns/labels.ts — natural-language labels for terms whose names are identifiers.
 *
 * A standard's element names (`completionThreshold`, `adlcp:scormType`, `slideId`) are the
 * notation a machine matches on; a person reads words. Every Foxxi document publishes both — the
 * words as `rdfs:label`/`skos:prefLabel` (@en), the identifier as `skos:notation` — and this is
 * the one place the words are made, so two documents cannot spell the same acronym two ways.
 */

const ACRONYMS: Readonly<Record<string, string>> = {
  id: 'ID', iri: 'IRI', iris: 'IRIs', uri: 'URI', url: 'URL', uuid: 'UUID', lms: 'LMS', sco: 'SCO', au: 'AU',
  ai: 'AI', xapi: 'xAPI', scorm: 'SCORM', cmi: 'CMI', adl: 'ADL', ims: 'IMS', lrs: 'LRS', did: 'DID', ui: 'UI',
  json: 'JSON', html: 'HTML', sha1sum: 'SHA-1 sum', sha2: 'SHA-2', ifi: 'IFI', idref: 'IDREF', mbox: 'mbox',
  openid: 'OpenID', ref: 'ref', xml: 'XML', usd: 'USD',
};

/** The usual written forms of the acronyms above. */
const WRITTEN_FORMS = new Set(Object.values(ACRONYMS));

/** Is `raw` an identifier (camelCase / snake_case / dotted) rather than words? */
const isIdentifier = (raw: string): boolean => /^[A-Za-z][A-Za-z0-9]*(?:[._:][A-Za-z0-9]+)*$/.test(raw)
  && (/[a-z][A-Z]/.test(raw) || /[A-Z]{2,}[a-z]/.test(raw) || /[._:]/.test(raw));

/** Words for an identifier: `useCurrentAttemptObjectiveInfo` → "use current attempt objective info".
 *  Anything that is already words is returned unchanged. */
export function naturalLabel(raw: string, kind: 'class' | 'property' | 'concept'): string {
  // A label already written in its usual form ("OpenID") is words, not an identifier to split.
  if (!isIdentifier(raw) || WRITTEN_FORMS.has(raw)) return raw;
  const words = raw.replace(/^[a-z]+:/, '')                       // drop an XML prefix (adlcp:…)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:]+/).filter(Boolean)
    .map(w => ACRONYMS[w.toLowerCase()] ?? (kind === 'class' ? w[0]!.toUpperCase() + w.slice(1) : w.toLowerCase()));
  return words.join(' ');
}
