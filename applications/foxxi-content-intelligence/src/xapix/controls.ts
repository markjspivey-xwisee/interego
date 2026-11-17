/**
 * The document `xapix:controls` links to: what can be done now with a statement that follows a
 * template (../../xapix/README.md, section 5).
 *
 * A control is never embedded in a statement, which is stored once and read for years. What may
 * follow a kind of statement is a fact about the kind, so it is stated on the template, as
 * `xapix:offers`. This document is those offers with each affordance described as the deployment
 * serves it today: its target, its method and what it expects. A reader follows a link from here
 * and never assembles an address from an activity id or a naming convention.
 *
 * The document is of a template, not of a statement. It holds nothing a statement says, so
 * reading it tells nobody anything about anyone, and it can be served without a signature.
 *
 * An offer is a possibility, not a permission: the affordance's own access rules decide.
 */
import { xapix } from './namespace.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];

/** An affordance as the deployment serves it. `describe` returns none for an IRI it does not serve. */
export interface AffordanceCard {
  readonly title?: string;
  readonly description?: string;
  readonly method?: string;
  readonly target?: string;
  readonly mediaType?: string;
  readonly inputs?: ReadonlyArray<Record<string, unknown>>;
}

/** The affordance IRIs a template offers, in the order it states them. A target that is not `{ "@id": <IRI> }` is skipped: the lint finds it. */
export function offersOf(template: Json): string[] {
  return list(template[xapix('offers')]).flatMap(t => isObject(t) && typeof t['@id'] === 'string' ? [t['@id']] : []);
}

export const CONTROLS_NOTE = 'An offer is a possibility, not a permission: each affordance applies its own access rules. Follow `target` as given; no address here is assembled from a statement.';

/**
 * The controls document for some templates. `unresolved` names an offered affordance this
 * deployment does not serve: the offer stands in the profile, and nothing here can be followed for it.
 */
export function controlsDocument(input: { readonly id: string; readonly templates: readonly Json[]; readonly describe: (iri: string) => AffordanceCard | undefined }): Json {
  const controls: Json[] = [];
  const unresolved: Json[] = [];
  for (const template of input.templates) {
    for (const affordance of offersOf(template)) {
      const card = input.describe(affordance);
      if (!card) { unresolved.push({ offeredBy: template.id, affordance }); continue; }
      controls.push({ offeredBy: template.id, affordance, ...card });
    }
  }
  return {
    id: input.id,
    type: 'xapi-x controls',
    conformsTo: xapix('controls'),
    templates: input.templates.map(t => t.id),
    controls,
    ...(unresolved.length ? { unresolved } : {}),
    note: CONTROLS_NOTE,
  };
}

/** The address of the controls document for these templates, under a profile server's base. One IRI, as `xapix:controls` wants. */
export function controlsUrl(base: string, templates: readonly string[]): string {
  return `${base}/controls?${templates.map(t => `template=${encodeURIComponent(t)}`).join('&')}`;
}
