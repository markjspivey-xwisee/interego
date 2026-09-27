/**
 * The bridge a portal talks to, as its entry point names itself. The entry point's own IRI is the
 * one URL the portal is configured with; everything else is found from it: an affordance by its
 * tool name, and a composition's IRI under the bridge's base.
 */

/** The bridge's base URL, from its entry point's IRI (`<base>/api/foxxi/v1`), or '' before it is known. */
export function bridgeBaseOf(entry: { '@id'?: string } | null | undefined): string {
  const id = entry?.['@id'];
  if (!id) return '';
  try {
    const url = new URL(id);
    return `${url.origin}${url.pathname.replace(/\/api\/foxxi\/v1\/?$/, '').replace(/\/+$/, '')}`;
  } catch { return ''; }
}
