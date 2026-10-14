/** Cache only assets named by the generated page; smoke tests then block every other network request. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [pageArg, cacheArg] = process.argv.slice(2);
if (!pageArg || !cacheArg) throw new Error('Usage: cache-ui-assets.ts <generated-app.html> <cache-directory>');
const page = await readFile(resolve(pageArg), 'utf8'), cache = resolve(cacheArg);
await mkdir(join(cache, 'gstatic'), { recursive: true });
const receipt: { url: string; bytes: number; sha256: string }[] = [];
async function get(url: string): Promise<Uint8Array> {
  const host = new URL(url).hostname;
  if (!['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(host) || !url.startsWith('https://')) throw new Error('Unexpected page asset origin: ' + url);
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      receipt.push({ url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      return bytes;
    } catch (error) { last = error; }
  }
  throw new Error('Cannot cache page asset ' + url + ': ' + String(last));
}
const scripts = [...page.matchAll(/<script\b[^>]*\bsrc=["'](https:\/\/cdnjs\.cloudflare\.com\/[^"']+)["']/gu)].map(m => m[1]!);
if (!scripts.length) throw new Error('The generated page does not name its CDN scripts');
await Promise.all(scripts.map(async url => writeFile(join(cache, url.replace('https://', '').replaceAll('/', '_')), await get(url))));
const fontUrl = /<link\b[^>]*\bhref=["'](https:\/\/fonts\.googleapis\.com\/[^"']+)["']/u.exec(page)?.[1];
if (!fontUrl) throw new Error('The generated page does not name its font stylesheet');
const fontBytes = await get(fontUrl.replaceAll('&amp;', '&')), fonts = new TextDecoder('utf-8', { fatal: true }).decode(fontBytes);
await writeFile(join(cache, 'fonts.css'), fontBytes);
const fontFiles = [...new Set([...fonts.matchAll(/url\(["']?(https:\/\/fonts\.gstatic\.com\/[^"')]+)["']?\)/gu)].map(m => m[1]!))];
for (let start = 0; start < fontFiles.length; start += 4) await Promise.all(fontFiles.slice(start, start + 4).map(async url => writeFile(join(cache, 'gstatic', url.replace('https://fonts.gstatic.com/', '').replaceAll('/', '_')), await get(url))));
await writeFile(join(cache, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write('Cached ' + receipt.length + ' actual page assets; browser oracles use these bytes offline\n');
