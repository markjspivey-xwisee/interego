/** Optional diagnostics for complete parity runs; never changes a reasoning verdict. */
import { appendFileSync } from 'node:fs';
export function progressEnabled(): boolean { return !!process.env.I2IDLX_PROGRESS_FILE; }
export function progress(stage: string, event: string, detail: Readonly<Record<string, unknown>> = {}): void {
  const file = process.env.I2IDLX_PROGRESS_FILE;
  if (!file) return;
  const cpu = process.cpuUsage(), memory = process.memoryUsage();
  const line = JSON.stringify({
    at: new Date().toISOString(), stage, event, pid: process.pid,
    uptimeSeconds: Math.round(process.uptime() * 10) / 10,
    cpuUserSeconds: Math.round(cpu.user / 100000) / 10,
    cpuSystemSeconds: Math.round(cpu.system / 100000) / 10,
    rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, ...detail,
  }) + '\n';
  appendFileSync(file, line);
  process.stdout.write('PROGRESS ' + line);
}
export async function progressStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  progress(stage, 'start');
  try {
    const result = await operation();
    progress(stage, 'end', { seconds: (Date.now() - started) / 1000 });
    return result;
  } catch (error) {
    progress(stage, 'error', { seconds: (Date.now() - started) / 1000, error: String(error) });
    throw error;
  }
}
