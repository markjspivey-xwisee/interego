/**
 * The bridge reports what it holds in memory and what its container is charged for.
 *
 * ★ WHY. Deployed, the bridge sits near 3 GB from the moment it starts, on a host that bills for
 * memory held; started with no pod behind it, the same code needs about 210 MB. Nothing it reported
 * could tell live data from a heap left grown or from the container's file cache
 * (src/process-memory.ts). These are the numbers that tell them apart, at GET /metrics.
 */
import { describe, expect, it } from 'vitest';
import { containerMemory, memoryMetricLines, processMemory } from '../src/process-memory.js';
import { metricsJson, renderMetrics } from '../src/observability.js';

const files = (m: Record<string, string>) => (path: string): string => {
  const text = m[path];
  if (text === undefined) throw new Error(`ENOENT ${path}`);
  return text;
};

describe('the container, read from its control group', () => {
  it('reads the total and what it is made of', () => {
    expect(containerMemory(files({
      '/sys/fs/cgroup/memory.current': '3221225472\n',
      '/sys/fs/cgroup/memory.stat': 'anon 524288000\nfile 2621440000\nkernel 1000\nshmem 4096\n',
    }))).toEqual({ currentBytes: 3221225472, anonBytes: 524288000, fileBytes: 2621440000, shmemBytes: 4096 });
  });

  it('reports the total alone when what it is made of cannot be read', () => {
    expect(containerMemory(files({ '/sys/fs/cgroup/memory.current': '1024' }))).toEqual({ currentBytes: 1024 });
    expect(containerMemory(files({ '/sys/fs/cgroup/memory.current': '1024', '/sys/fs/cgroup/memory.stat': 'anon lots\nfile -3\n\nshmem 7' })))
      .toEqual({ currentBytes: 1024, shmemBytes: 7 });
  });

  it('reports nothing where there is no cgroup v2, or its total is not a count', () => {
    expect(containerMemory(files({}))).toBeUndefined();
    for (const current of ['max', '', '-1', '1.5']) expect(containerMemory(files({ '/sys/fs/cgroup/memory.current': current }))).toBeUndefined();
  });

  it('reads another root when given one', () => {
    expect(containerMemory(files({ '/cg/memory.current': '5' }), '/cg')).toEqual({ currentBytes: 5 });
  });
});

describe('the process', () => {
  const usage = { rss: 900, heapUsed: 300, heapTotal: 700, external: 50, arrayBuffers: 20 } as NodeJS.MemoryUsage;
  it('reports its own figures, and the container only when there is one', () => {
    expect(processMemory(usage, undefined)).toEqual({ rssBytes: 900, heapUsedBytes: 300, heapTotalBytes: 700, externalBytes: 50, arrayBuffersBytes: 20 });
    expect(processMemory(usage, { currentBytes: 1000 }).container).toEqual({ currentBytes: 1000 });
  });

  it('reads the running process when asked for nothing in particular', () => {
    const m = processMemory();
    expect(m.rssBytes).toBeGreaterThan(0);
    expect(m.heapUsedBytes).toBeLessThanOrEqual(m.heapTotalBytes);
  });

  it('renders a gauge for each figure it has, and none for one it does not', () => {
    const lines = memoryMetricLines(processMemory(usage, { currentBytes: 1000, fileBytes: 600 }));
    const values = Object.fromEntries(lines.filter(l => l && !l.startsWith('#')).map(l => l.split(' ')));
    expect(values).toEqual({
      foxxi_bridge_memory_rss_bytes: '900', foxxi_bridge_memory_heap_used_bytes: '300', foxxi_bridge_memory_heap_total_bytes: '700',
      foxxi_bridge_memory_external_bytes: '50', foxxi_bridge_memory_array_buffers_bytes: '20',
      foxxi_bridge_container_memory_bytes: '1000', foxxi_bridge_container_memory_file_bytes: '600',
    });
    // Each gauge is declared before its value, as the exposition format asks.
    for (const name of Object.keys(values)) expect(lines.indexOf(`# TYPE ${name} gauge`)).toBe(lines.indexOf(`${name} ${values[name]}`) - 1);
  });
});

describe('what the bridge serves', () => {
  it('carries the memory figures at /metrics, after what was there, ending in one newline', () => {
    const text = renderMetrics();
    expect(text).toMatch(/^foxxi_bridge_memory_rss_bytes \d+$/m);
    expect(text).toMatch(/^foxxi_bridge_memory_heap_used_bytes \d+$/m);
    expect(text.indexOf('foxxi_bridge_vcs_issued_total')).toBeLessThan(text.indexOf('foxxi_bridge_memory_rss_bytes'));
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('carries them at /metrics.json too', () => {
    expect(metricsJson().memory.rssBytes).toBeGreaterThan(0);
  });
});
