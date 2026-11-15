/**
 * What this process holds in memory, and what its container is charged for.
 *
 * ★ WHY. The deployed bridge sits near 3 GB from the moment it starts, on a host that bills for
 * memory held, while the same code started with no pod behind it needs about 210 MB. Nothing the
 * bridge reported could say where the rest is. These numbers tell three causes apart:
 *   - live data: heapUsed near heapTotal, and both large;
 *   - a heap the collector was allowed to grow and has not given back (--max-old-space-size):
 *     heapTotal far above heapUsed;
 *   - memory that is not this process's at all: the container's `file` (page cache of files
 *     read) or `shmem` (a tmpfs written to) far above the process's own rss.
 *
 * Read on request, from the process and from the container's control group when there is one
 * (cgroup v2). No sampling, no history: the host keeps that.
 */
import { readFileSync } from 'node:fs';

export interface ContainerMemory {
  /** Everything the container is charged for (memory.current). */
  currentBytes: number;
  /** Anonymous memory: the processes' own heaps and stacks. */
  anonBytes?: number;
  /** Page cache: files read or written, kept by the kernel and reclaimable. */
  fileBytes?: number;
  /** Shared memory, a tmpfs included: counted, and not reclaimable while its files exist. */
  shmemBytes?: number;
}

export interface ProcessMemory {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  /** Absent where the process is not in a cgroup v2 container, or it cannot be read. */
  container?: ContainerMemory;
}

type ReadText = (path: string) => string;

/** A count of bytes written as plain digits, or undefined: an empty or signed value is not zero. */
const bytes = (text: string | undefined): number | undefined => {
  const digits = text?.trim() ?? '';
  if (digits === '' || [...digits].some(c => c < '0' || c > '9')) return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : undefined;
};

/** The container's memory, from cgroup v2's files under `root`, or undefined when they are not there. */
export function containerMemory(read: ReadText = p => readFileSync(p, 'utf8'), root = '/sys/fs/cgroup'): ContainerMemory | undefined {
  let current: number | undefined;
  try { current = bytes(read(`${root}/memory.current`)); } catch { return undefined; }
  if (current === undefined) return undefined;
  const out: ContainerMemory = { currentBytes: current };
  try {
    const stat = new Map<string, number>();
    for (const line of read(`${root}/memory.stat`).split('\n')) {
      const [key, value] = line.trim().split(' ');
      const n = bytes(value);
      if (key && n !== undefined) stat.set(key, n);
    }
    const anon = stat.get('anon'), file = stat.get('file'), shmem = stat.get('shmem');
    if (anon !== undefined) out.anonBytes = anon;
    if (file !== undefined) out.fileBytes = file;
    if (shmem !== undefined) out.shmemBytes = shmem;
  } catch { /* the total alone is still worth reporting */ }
  return out;
}

/** What the process holds now, and its container when it has one. */
export function processMemory(usage: NodeJS.MemoryUsage = process.memoryUsage(), container: ContainerMemory | undefined = containerMemory()): ProcessMemory {
  return {
    rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external, arrayBuffersBytes: usage.arrayBuffers,
    ...(container ? { container } : {}),
  };
}

/** The memory figures as Prometheus gauges, each with its HELP and TYPE lines. */
export function memoryMetricLines(m: ProcessMemory): string[] {
  const gauges: Array<[string, string, number | undefined]> = [
    ['foxxi_bridge_memory_rss_bytes', 'Resident memory of the bridge process', m.rssBytes],
    ['foxxi_bridge_memory_heap_used_bytes', 'JavaScript heap in use', m.heapUsedBytes],
    ['foxxi_bridge_memory_heap_total_bytes', 'JavaScript heap reserved, used or not', m.heapTotalBytes],
    ['foxxi_bridge_memory_external_bytes', 'Memory of objects bound to JavaScript but held outside its heap', m.externalBytes],
    ['foxxi_bridge_memory_array_buffers_bytes', 'Memory of ArrayBuffers and Buffers, part of external', m.arrayBuffersBytes],
    ['foxxi_bridge_container_memory_bytes', 'Everything the container is charged for (cgroup memory.current)', m.container?.currentBytes],
    ['foxxi_bridge_container_memory_anon_bytes', 'Container anonymous memory: process heaps and stacks', m.container?.anonBytes],
    ['foxxi_bridge_container_memory_file_bytes', 'Container page cache: files read or written, reclaimable', m.container?.fileBytes],
    ['foxxi_bridge_container_memory_shmem_bytes', 'Container shared memory, a tmpfs included', m.container?.shmemBytes],
  ];
  const lines: string[] = [];
  for (const [name, help, value] of gauges) {
    if (value === undefined) continue;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`, '');
  }
  return lines;
}
