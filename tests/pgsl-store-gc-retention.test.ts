import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertRebuildHeadroom, dropExpiredPreviousTables, previousTablesToDropAfterHours } from '../tools/pgsl-store-gc.js';
import type { LiveSet } from '../packages/pgsl-store/src/gc.js';
import { collectorVolumeHeadroom } from '../tools/pgsl-store-gc-volume.mjs';

const now = new Date('2026-10-17T18:30:00.000Z');
const complete = { keys: new Set(['one']), stats: { danglingRoots: [], unreadableNodes: 0 } } as unknown as Pick<LiveSet, 'keys' | 'stats'>;

describe('verified one-hour rollback retirement', () => {
  it('uses the exact millisecond cutoff and preserves unrelated, malformed and recent copies', () => {
    const names = ['pgsl_kv', 'pgsl_kv_live', 'pgsl_kv_old_20261017_173000000',
      'pgsl_kv_old_20261017_172959999', 'pgsl_kv_old_20261017_173000001',
      'pgsl_kv_old_20261017', 'other_old_20261016_000000000', 'pgsl_kv_old_20261017_253000000',
      'pgsl_kv_old_20261317_000000000', 'pgsl_kv_old_20261016_000000000_extra'];
    expect(previousTablesToDropAfterHours(names, 'pgsl_kv', now, 1)).toEqual([
      'pgsl_kv_old_20261017_172959999', 'pgsl_kv_old_20261017_173000000',
    ]);
    for (const hours of [0, -1, 0.5, NaN]) expect(() => previousTablesToDropAfterHours(names, 'pgsl_kv', now, hours)).toThrow();
  });

  it('keeps a date-only legacy copy until the entire named day plus retention has elapsed', () => {
    const names = ['pgsl_kv_old_20261016'];
    expect(previousTablesToDropAfterHours(names, 'pgsl_kv', new Date('2026-10-17T00:59:59.999Z'), 1)).toEqual([]);
    expect(previousTablesToDropAfterHours(names, 'pgsl_kv', new Date('2026-10-17T01:00:00Z'), 1)).toEqual(names);
  });

  it('makes zero catalog or DROP queries if current roots are missing, unreadable or empty', async () => {
    const queries: string[] = [];
    const client = { async query(sql: string) { queries.push(sql); return { rows: [] }; } };
    for (const live of [
      { ...complete, keys: new Set<string>() },
      { ...complete, stats: { ...complete.stats, danglingRoots: ['missing'] } },
      { ...complete, stats: { ...complete.stats, unreadableNodes: 1 } },
    ]) await expect(dropExpiredPreviousTables(client as never, 'pgsl_kv', live, { hours: 1 }, now)).rejects.toThrow('refusing backup cleanup');
    expect(queries).toEqual([]);
  });

  it('drops only exact generated names in public after a complete closure check', async () => {
    const queries: string[] = [];
    const client = { async query(sql: string) {
      queries.push(sql);
      return { rows: sql.startsWith('SELECT') ? ['pgsl_kv_old_20261017_173000000', 'pgsl_kv_old_20261017_180000000',
        'pgsl_kv', 'security_tombstones', 'other_old_20261016', 'pgsl_kv_old_20261017_000000000;DROP TABLE pgsl_kv'].map(relname => ({ relname })) : [] };
    } };
    expect(await dropExpiredPreviousTables(client as never, 'pgsl_kv', complete, { hours: 1 }, now)).toEqual(['pgsl_kv_old_20261017_173000000']);
    expect(queries[0]).toContain("n.nspname = 'public'");
    expect(queries.slice(1)).toEqual(['DROP TABLE public.pgsl_kv_old_20261017_173000000']);
  });
});

describe('copy headroom', () => {
  const sample = { capacityBytes: 10_000_000_000, usedBytes: 6_000_000_000, sampledAt: now.getTime(), tableBytes: 1_000_000_000 };
  it('requires two source sizes plus reserve and accepts exactly sufficient free space', () => {
    expect(() => assertRebuildHeadroom(sample, now.getTime())).not.toThrow();
    const edge = { ...sample, usedBytes: sample.capacityBytes - sample.tableBytes * 2 - 1_073_741_824 };
    expect(() => assertRebuildHeadroom(edge, now.getTime())).not.toThrow();
    expect(() => assertRebuildHeadroom({ ...edge, usedBytes: edge.usedBytes + 1 }, now.getTime())).toThrow('need');
  });
  it('fails closed on stale, future, unknown, inconsistent and unsafe byte counts', () => {
    for (const change of [{ sampledAt: sample.sampledAt - 600_001 }, { sampledAt: sample.sampledAt + 1 },
      { capacityBytes: NaN }, { usedBytes: -1 }, { usedBytes: sample.capacityBytes + 1 }, { tableBytes: 0 },
      { tableBytes: Number.MAX_SAFE_INTEGER }, { usedBytes: 0.5 }]) {
      expect(() => assertRebuildHeadroom({ ...sample, ...change }, now.getTime())).toThrow('refusing rebuild');
    }
  });
});

function platformVolumes() {
  return {
    environment: { config: { services: { postgres: { volumeMounts: { exact: { mountPath: '/data' } } } } } },
    project: { volumes: { edges: [
      { node: { id: 'exact', volumeInstances: { edges: [{ node: { serviceId: 'postgres', mountPath: '/data', sizeMB: 100_000, currentSizeMB: 5000 } }] } } },
      { node: { id: 'unmounted', volumeInstances: { edges: [{ node: { serviceId: 'postgres', mountPath: '/data', sizeMB: 10_000_000, currentSizeMB: 0 } }] } } },
    ] } },
  };
}

describe('environment-bound Railway volume measurements', () => {
  it('uses only the exact mounted volume and conservatively converts platform MB', () => {
    const data = platformVolumes();
    expect(collectorVolumeHeadroom(data, 'postgres', now.getTime())).toEqual({
      capacityBytes: 100_000_000_000, usedBytes: 5_242_880_000, sampledAt: now.getTime(),
    });
    const stringConfig = { ...data, environment: { config: JSON.stringify(data.environment.config) } };
    expect(collectorVolumeHeadroom(stringConfig, 'postgres', now.getTime())).toEqual(collectorVolumeHeadroom(data, 'postgres', now.getTime()));
  });
  it('refuses missing mounts, wrong services/paths, ambiguous instances and invalid usage', () => {
    for (const change of ['missing', 'service', 'path', 'ambiguous', 'unknown', 'overfull']) {
      const data = platformVolumes(), instances = data.project.volumes.edges[0]!.node.volumeInstances.edges;
      if (change === 'missing') data.environment.config.services.postgres.volumeMounts = {} as never;
      if (change === 'service') instances[0]!.node.serviceId = 'someone-else';
      if (change === 'path') instances[0]!.node.mountPath = '/elsewhere';
      if (change === 'ambiguous') instances.push(structuredClone(instances[0]!));
      if (change === 'unknown') instances[0]!.node.currentSizeMB = NaN;
      if (change === 'overfull') instances[0]!.node.currentSizeMB = 200_000;
      expect(() => collectorVolumeHeadroom(data, 'postgres')).toThrow('refusing collector copy');
    }
  });
});

it('manual recovery preserves one-hour rollback retirement and guards without a competing schedule', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pgsl-store-gc.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).not.toMatch(/^\s+schedule:/m);
  expect(workflow).not.toMatch(/^\s+-\s+cron:/m);
  expect(workflow).toContain('hourly|weekly) node tools/pgsl-store-gc-remote.mjs --drop-previous-older-than-hours 1 --rebuild-above 0.5 --min-rows 2000000');
  expect(workflow).toContain('dry-run) node tools/pgsl-store-gc-remote.mjs 2>&1');
  expect(workflow).toContain('cancel-in-progress: false');
  expect(workflow).toContain('[ "${{ github.event_name }}" = "schedule" ] && [ "$(date -u +%H)" != "06" ]');
});
