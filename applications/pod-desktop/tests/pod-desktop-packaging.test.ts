import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const app = join(root, 'applications/pod-desktop');
const appRequire = createRequire(import.meta.url);
const config = appRequire(join(app, 'electron-builder.config.cjs'));
const signaturePolicy = appRequire(join(app, 'tools/signature-policy.cjs'));
const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));

describe('the local pod Windows installer boundary', () => {
  it('installs for the current user without elevation and preserves pod data on uninstall', () => {
    expect(config.appId).toBe('dev.interego.pod');
    expect(config.productName).toBe('Interego');
    expect(config.nsis).toMatchObject({
      perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: false,
      deleteAppDataOnUninstall: false, runAfterFinish: true,
    });
    expect(config.win.target).toContainEqual({ target: 'nsis', arch: ['x64'] });
  });

  it('packages the exact installed Electron runtime and a dedicated filesystem staging tree', () => {
    expect(config.electronVersion).toBe(appRequire('electron/package.json').version);
    expect(config.asar).toBe(false);
    expect(resolve(config.directories.app)).toBe(resolve(app, '.staging/app'));
    expect(resolve(config.directories.app)).not.toBe(root);
    expect(config.files).toContain('node_modules/**/*');
    expect(config.files).not.toContain('**/*');
    expect(config.npmRebuild).toBe(false);
  });

  it('keeps the main process ESM while the isolated preload remains CommonJS', () => {
    expect(manifest.type).toBe('module');
    expect(manifest.main).toBe('dist/main.mjs');
    const build = readFileSync(join(app, 'tools/build.mjs'), 'utf8');
    expect(build).toContain("'dist/main.mjs'");
    expect(build).toContain("'dist/preload.cjs'");
    expect(build).toContain("packages: 'external'");
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@interego/core', '@interego/deployment-config', '@interego/local-node', '@interego/solid',
    ]);
    expect(manifest.dependencies).not.toHaveProperty('electron');
    expect(manifest.scripts).not.toHaveProperty('postinstall');
  });

  it('never publishes during packaging and inspects the produced signature instead of claiming signing', () => {
    expect(config.publish).toBeNull();
    const packaging = readFileSync(join(app, 'tools/package-win.mjs'), 'utf8');
    expect(packaging).toContain("'--publish', 'never'");
    expect(packaging).toContain('SHA256SUMS.txt');
    expect(packaging).toContain('inspect-signature.ps1');
    expect(packaging).toContain('signaturePolicy(signature.status, signingRequested)');
    expect(signaturePolicy('NotSigned', false)).toBe('unsigned-preview');
    expect(signaturePolicy('Valid', false)).toBe('signed');
    expect(signaturePolicy('Valid', true)).toBe('signed');
    for (const status of ['HashMismatch', 'NotTrusted', 'UnknownError', 'NotSupportedFileFormat', undefined]) {
      expect(() => signaturePolicy(status, false)).toThrow(/cannot be distributed/);
    }
    expect(() => signaturePolicy('NotSigned', true)).toThrow(/cannot be distributed/);
  });

  it('gates the downloadable artifact on its own real local-pod success marker', () => {
    const smoke = readFileSync(join(app, 'tools/smoke-packaged.mjs'), 'utf8');
    expect(smoke).toContain('INTEREGO_POD_SMOKE_OK');
    expect(smoke).toContain('INTEREGO_POD_SMOKE_DATA: fixture');
    expect(smoke).toContain('delete env.ELECTRON_RUN_AS_NODE');
    const workflow = readFileSync(join(root, '.github/workflows/pod-desktop-windows.yml'), 'utf8');
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('npm run smoke:packaged --workspace @interego/pod-desktop');
    expect(workflow).toContain('SHA256SUMS.txt');
    expect(workflow).toContain('contents: read');
  });
});
