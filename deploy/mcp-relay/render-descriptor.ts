import { parseTrig, findSubjectsOfType, type FetchFn, type IRI, type ManifestEntry } from '@interego/core';
import { predictDescriptorUrl } from '@interego/solid';

const DESCRIPTOR = 'https://markjspivey-xwisee.github.io/interego/ns/iep#ContextDescriptor' as IRI;

export interface RenderDescriptorDeps {
  /** Verified caller's pod first, followed by pods already known to this relay. */
  pods: readonly string[];
  manifest(pod: string): Promise<readonly ManifestEntry[]>;
  /** The relay's screened fetch, including for explicit URL references. */
  fetch: FetchFn;
}

/** Resolve the descriptor itself. A graph dereference returns a payload, not a
 * descriptor location, and it does not resolve the descriptor URNs we mint. */
export async function resolveRenderDescriptor(reference: string, deps: RenderDescriptorDeps): Promise<{ url: string; turtle: string } | null> {
  const read = async (url: string) => {
    const response = await deps.fetch(url, { headers: { Accept: 'text/turtle' } });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`Descriptor GET failed: ${response.status}`);
    return { url, turtle: await response.text() };
  };
  if (/^https?:\/\//.test(reference)) return read(reference);
  if (!reference.startsWith('urn:')) return null;

  let failure: unknown;
  const pods = [...new Set(deps.pods.map(p => p.endsWith('/') ? p : `${p}/`))];
  for (const pod of pods) {
    try {
      const entries = await deps.manifest(pod);
      const graph = entries.find(e => e.describes.includes(reference));
      if (graph) {
        const result = await read(graph.descriptorUrl);
        if (result) return result;
      }
      // The same naming function as publish(), used only to narrow manifest
      // candidates. A matching filename is never treated as matching identity.
      const filename = new URL(predictDescriptorUrl(pod, reference)).pathname.split('/').pop();
      for (const entry of entries) {
        if (new URL(entry.descriptorUrl).pathname.split('/').pop() !== filename) continue;
        const result = await read(entry.descriptorUrl);
        if (!result) continue;
        const subjects = findSubjectsOfType(parseTrig(result.turtle), DESCRIPTOR);
        if (subjects.some(subject => subject.subject === reference)) return result;
      }
    } catch (error) { failure = error; }
  }
  // A failed index/descriptor read did not establish absence.
  if (failure) throw failure;
  return null;
}
