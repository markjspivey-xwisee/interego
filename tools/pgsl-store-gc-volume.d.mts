export function collectorVolumeHeadroom(data: unknown, serviceId: string, sampledAt?: number): {
  capacityBytes: number; usedBytes: number; sampledAt: number;
};
