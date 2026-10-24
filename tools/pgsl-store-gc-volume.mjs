/** Resolve only the database volume mounted in the token's exact environment.
 * Ambiguous instance lists are refused instead of borrowing another environment's space. */
export function collectorVolumeHeadroom(data, serviceId, sampledAt = Date.now()) {
  const config = typeof data?.environment?.config === 'string' ? JSON.parse(data.environment.config) : data?.environment?.config;
  const mounts = config?.services?.[serviceId]?.volumeMounts;
  const candidates = [];
  for (const { node: volume } of data?.project?.volumes?.edges ?? []) {
    if (!mounts?.[volume.id]) continue;
    for (const { node: instance } of volume.volumeInstances?.edges ?? []) {
      if (instance.serviceId === serviceId && instance.mountPath === mounts[volume.id].mountPath) candidates.push(instance);
    }
  }
  if (candidates.length !== 1) throw new Error('refusing collector copy: exact environment database volume is missing or ambiguous');
  const { sizeMB, currentSizeMB } = candidates[0];
  if (!Number.isFinite(sizeMB) || sizeMB <= 0 || !Number.isFinite(currentSizeMB) || currentSizeMB < 0 || currentSizeMB > sizeMB
    || !Number.isSafeInteger(sampledAt)) throw new Error('refusing collector copy: database volume usage is unavailable');
  // Capacity is rounded down in decimal MB and usage up in binary MB. This
  // deliberately understates free space under either common MB convention.
  return { capacityBytes: Math.floor(sizeMB * 1_000_000), usedBytes: Math.ceil(currentSizeMB * 1_048_576), sampledAt };
}
