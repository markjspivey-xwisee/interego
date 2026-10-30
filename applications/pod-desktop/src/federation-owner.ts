import type { FederationResource, FederationStatus } from '@interego/pod-federation';

interface SelectedShare {
  readonly generation: () => number;
  readonly closing: () => boolean;
  readonly resources: (ids: readonly string[]) => Promise<readonly FederationResource[]>;
  readonly share: (peerId: string, resources: readonly FederationResource[]) => Promise<FederationStatus>;
}

/** A reviewed selection cannot cross Pause/Forget/quit into a later sharing session. */
export async function shareSelectedNotes(options: SelectedShare, peerId: string, ids: readonly string[]): Promise<FederationStatus> {
  const generation = options.generation();
  const resources = await options.resources(ids);
  if (options.closing() || options.generation() !== generation) throw new Error('Sharing was paused while preparing these notes. Review your selection before sending again.');
  return options.share(peerId, resources);
}
