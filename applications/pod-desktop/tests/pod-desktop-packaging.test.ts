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

// Evaluate only the shipped hook's small NSIS instruction set against a Map.
// Windows packaging still compiles the real NSIS script; these fixtures never open HKCU.
function uninstallRegistrationFixture(updated: boolean, registry: Map<string, string>) {
  const data = 'C:\\Fixture\\Roaming'; const manifest = data + '\\Interego\\identity-browser\\com.interego.identity.json';
  const active = [true]; const reads: string[] = []; const removed: string[] = []; let value = '';
  for (const source of readFileSync(config.nsis.include, 'utf8').split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith(';') || line === '!macro customUnInstall' || line === '!macroend') continue;
    const enabled = active.every(Boolean);
    if (line === '${IfNot} ${isUpdated}') { active.push(enabled && !updated); continue; }
    const condition = /^\$\{If\} \$0 == "([^"]+)"$/.exec(line);
    if (condition) { active.push(enabled && value.toLowerCase() === condition[1]!.replace('$APPDATA', data).toLowerCase()); continue; }
    if (line === '${EndIf}') {
      if (active.length === 1) throw new Error('Unexpected end of uninstall condition');
      active.pop(); continue;
    }
    const read = /^ReadRegStr \$0 HKCU "([^"]+)" ""$/.exec(line);
    if (read) { if (enabled) { reads.push(read[1]!); value = registry.get(read[1]!) ?? ''; } continue; }
    const remove = /^DeleteRegValue HKCU "([^"]+)" ""$/.exec(line);
    if (remove) { if (enabled) { removed.push(remove[1]!); registry.delete(remove[1]!); } continue; }
    throw new Error('Unsupported native uninstall hook instruction');
  }
  if (active.length !== 1) throw new Error('Unclosed uninstall condition');
  return { registry, reads, removed, manifest };
}

describe('the local pod Windows installer boundary', () => {
  it('the shipped upgrade hook leaves both browser registrations untouched', () => {
    const google = 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.interego.identity';
    const edge = 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.interego.identity';
    const owned = 'C:\\Fixture\\Roaming\\Interego\\identity-browser\\com.interego.identity.json';
    const registry = new Map([[google, owned], [edge, owned]]); const before = [...registry.entries()];
    const result = uninstallRegistrationFixture(true, registry);
    expect([...result.registry.entries()]).toEqual(before); expect(result.reads).toEqual([]); expect(result.removed).toEqual([]);
  });

  it('the shipped real-uninstall hook removes only matching default values, leaving foreign registrations and data alone', () => {
    const google = 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.interego.identity';
    const edge = 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.interego.identity';
    const owned = 'C:\\Fixture\\Roaming\\Interego\\identity-browser\\com.interego.identity.json';
    for (const ownedKey of [google, edge]) {
      const foreignKey = ownedKey === google ? edge : google;
      const registry = new Map([[ownedKey, owned], [foreignKey, 'C:\\OtherApp\\manifest.json'], ['unrelated', 'retained']]);
      const result = uninstallRegistrationFixture(false, registry);
      expect(result.removed).toEqual([ownedKey]);
      expect([...registry.entries()]).toEqual([[foreignKey, 'C:\\OtherApp\\manifest.json'], ['unrelated', 'retained']]);
      expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
    }
  });

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
    expect(config.electronFuses).toMatchObject({
      runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
    });
    expect(config.electronFuses.onlyLoadAppFromAsar).not.toBe(true);
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
      '@interego/core', '@interego/deployment-config', '@interego/local-node', '@interego/pod-federation', '@interego/solid', '@modelcontextprotocol/server',
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
