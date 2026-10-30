import { describe, expect, it, vi } from 'vitest';
import { shareSelectedNotes } from '../src/federation-owner.js';
import type { FederationResource, FederationStatus } from '@interego/pod-federation';

describe('reviewed desktop sharing across owner lifecycle changes', () => {
  it.each(['pause-and-resume', 'forget', 'quit'])('does not send an earlier selected export after %s', async action => {
    let generation = 1; let closing = false; let complete!: (value: readonly FederationResource[]) => void;
    const exported = new Promise<readonly FederationResource[]>(done => { complete = done; });
    const share = vi.fn(async (): Promise<FederationStatus> => { throw new Error('Must not send.'); });
    const pending = shareSelectedNotes({ generation: () => generation, closing: () => closing, resources: async () => exported, share }, 'peer', ['selected-note']);
    const rejected = expect(pending).rejects.toThrow('Review your selection');
    if (action === 'quit') closing = true; else generation += action === 'pause-and-resume' ? 2 : 1;
    complete([{ iri: 'urn:graph:selected', mediaType: 'text/turtle', content: 'exact source' }]);
    await rejected; expect(share).not.toHaveBeenCalled();
  });
});
