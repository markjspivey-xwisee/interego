import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { BrowserExtensionStore } from '../src/browser-extensions.js';

const directories: string[] = [];
const protector = { protect: (value: string) => Buffer.from(value).toString('base64'), unprotect: (value: string) => Buffer.from(value, 'base64').toString() };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'interego-extension-origins-')); directories.push(directory);
  return { directory, store: new BrowserExtensionStore(directory, protector) };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-extension-origins-')) await rm(directory, { recursive: true, force: true });
});
describe('native browser extension origin preferences', () => {
  it('starts empty and persists only validated exact extension origins under the injected protector', async () => {
    const { directory, store } = await fixture(); expect(await store.list()).toEqual([]);
    const id = 'a'.repeat(32); await store.save([id]);
    expect(await new BrowserExtensionStore(directory, protector).origins()).toEqual([`chrome-extension://${id}`]);
    expect(await readFile(join(directory, 'browser-extensions.bin'), 'utf8')).not.toContain(id);
    expect(await store.save([])).toEqual([]); expect(await store.origins()).toEqual([]);
  });
  it.each([['*'], ['https://example.com'], ['a'.repeat(31)], ['q'.repeat(32)], ['a'.repeat(32), 'a'.repeat(32)], Array.from({ length: 5 }, (_, i) => String.fromCharCode(97 + i).repeat(32))])('rejects an overbroad or malformed origin allowance %j', async value => {
    const { store } = await fixture(); expect(() => store.save(value)).toThrow(/extension IDs/); expect(await store.list()).toEqual([]);
  });
  it('fails closed on corrupt settings and lets an explicit native save recover', async () => {
    const { directory, store } = await fixture(); await writeFile(join(directory, 'browser-extensions.bin'), 'damaged');
    await expect(store.origins()).rejects.toThrow('could not be opened'); await store.save([]); expect(await store.origins()).toEqual([]);
  });
});
