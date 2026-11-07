/** Snapshot selection is constrained to the signed-in owner's actual manifest. */
import type { ManifestEntry } from '@interego/core';
import type { FederationResource } from '@interego/pod-federation';
import type { HostedFederationOwner, HostedShareResource } from './pod-federation-http.js';

export function hostedFederationResources(options: {
  readonly entries: (owner: HostedFederationOwner) => Promise<readonly ManifestEntry[]>;
  readonly descriptor: (owner: HostedFederationOwner, id: string) => Promise<unknown>;
  readonly ownResource: (owner: HostedFederationOwner, url: string) => boolean;
  readonly title?: (owner: HostedFederationOwner, id: string) => Promise<string | undefined>;
}) {
  const inventory = async (owner: HostedFederationOwner) => (await options.entries(owner))
    .filter(entry => options.ownResource(owner, entry.descriptorUrl))
    .sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''));
  return {
    async list(owner: HostedFederationOwner): Promise<readonly HostedShareResource[]> {
      const entries = (await inventory(owner)).slice(0, 25), result: HostedShareResource[] = [];
      for (let offset = 0; offset < entries.length; offset += 4) {
        result.push(...await Promise.all(entries.slice(offset, offset + 4).map(async entry => {
          const title = await options.title?.(owner, entry.descriptorUrl).catch(() => undefined);
          return { id: entry.descriptorUrl, title: (title?.trim().slice(0, 160) || entry.describes[0] || entry.descriptorUrl)
            + (entry.validFrom ? ' · ' + entry.validFrom : '') };
        })));
      }
      return result;
    },
    async selected(owner: HostedFederationOwner, ids: readonly string[]): Promise<readonly FederationResource[]> {
      const entries = await inventory(owner);
      const chosen = ids.map(id => entries.find(entry => entry.descriptorUrl === id));
      if (!ids.length || ids.length > 16 || new Set(ids).size !== ids.length || chosen.some(entry => !entry)) {
        throw new Error('Choose resources currently listed in your own pod.');
      }
      const result: FederationResource[] = [];
      for (let i = 0; i < chosen.length; i++) {
        const entry = chosen[i]!;
        const value = await options.descriptor(owner, ids[i]);
        if (!value || typeof value !== 'object') throw new Error('The selected resource could not be opened.');
        const descriptor = value as { url?: unknown; turtle?: unknown; graph?: { url?: unknown; mediaType?: unknown; content?: unknown } };
        if (typeof descriptor.turtle !== 'string' || typeof descriptor.url !== 'string'
          || !options.ownResource(owner, descriptor.url) || !descriptor.graph
          || typeof descriptor.graph.url !== 'string' || !options.ownResource(owner, descriptor.graph.url)
          || typeof descriptor.graph.mediaType !== 'string' || typeof descriptor.graph.content !== 'string') {
          throw new Error('Choose an openable descriptor and payload within your own hosted pod.');
        }
        // Original signed descriptor and original graph representation stay byte-identical
        // inside the encrypted snapshot. Access URLs are provenance, never rewritten IRIs.
        const content = JSON.stringify({ format: 'interego-descriptor-snapshot/v1',
          descriptorUrl: descriptor.url, descriptorTurtle: descriptor.turtle,
          graphUrl: descriptor.graph.url, graphMediaType: descriptor.graph.mediaType, graphContent: descriptor.graph.content });
        if (Buffer.byteLength(content) > 128 * 1024) throw new Error('This resource is larger than the preview sharing limit of 128 KiB.');
        result.push({ iri: entry.describes[0] ?? entry.descriptorUrl, mediaType: 'application/vnd.interego.descriptor-snapshot+json', content });
      }
      return result;
    },
  };
}
