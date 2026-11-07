import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = resolve(appRoot, '../..');
export const stageRoot = resolve(appRoot, '.staging/app');
export const releaseRoot = resolve(appRoot, 'release');

export function within(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !/^[A-Za-z]:/u.test(path) && !path.startsWith('/'));
}

export function assertStagePath(path) {
  if (resolve(path) !== stageRoot || dirname(stageRoot) !== resolve(appRoot, '.staging') || !within(appRoot, stageRoot)) {
    throw new Error('Refusing to replace a directory outside the dedicated pod-desktop staging area.');
  }
}
