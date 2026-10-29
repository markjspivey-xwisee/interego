import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

describe('the published stdio configuration adapter', () => {
  it('runs the emitted adapter outside the workspace without private package resolution', async () => {
    const isolatedDir = await mkdtemp(join(tmpdir(), 'interego-stdio-package-'));
    try {
      // Only the shipping implementation is copied. A compiled re-export of the
      // private workspace package cannot resolve from this unrelated directory.
      await copyFile(new URL('../mcp-server/dist/deployment-config.js', import.meta.url),
        join(isolatedDir, 'deployment-config.mjs'));
      const probe = `
        import { resolveStdioConfig } from './deployment-config.mjs';
        process.stdout.write(JSON.stringify({
          defaults: resolveStdioConfig({}),
          remote: resolveStdioConfig({
            CG_BASE_URL: 'https://store.example/',
            CG_HOME_POD: 'https://pods.example/person/',
            CG_POD_NAME: 'person',
            CG_AGENT_ID: 'did:key:zPackagedAgent',
            CG_OWNER_WEBID: 'https://owner.example/#me',
            CG_IDENTITY_URL: 'https://identity.example',
            CG_KNOWN_PODS: 'https://peer.example/',
            CG_IPFS_PROVIDER: 'local-unpinned',
          }),
        }));
      `;
      const result = await execute(process.execPath, ['--input-type=module', '--eval', probe], {
        cwd: isolatedDir,
        // Do not inherit loaders or workspace-specific resolution hooks.
        env: { SystemRoot: process.env['SystemRoot'], PATH: process.env['PATH'] },
        encoding: 'utf8', timeout: 15_000, windowsHide: true,
      });
      expect(result.stderr).toBe('');
      const resolved = JSON.parse(result.stdout) as { defaults: unknown; remote: unknown };
      expect(resolved.defaults).toMatchObject({
        cssPort: 3456, podName: 'agent',
        baseUrl: 'http://localhost:3456/', homePod: 'http://localhost:3456/agent/',
        agentId: 'urn:agent:claude-code:local',
        identityUrl: 'https://identity.interego.xwisee.com',
        ipfsProvider: 'local-unpinned', ipfsApiKey: '', isLocal: true,
      });
      expect(resolved.remote).toMatchObject({
        baseUrl: 'https://store.example/', homePod: 'https://pods.example/person/',
        podName: 'person', agentId: 'did:key:zPackagedAgent',
        ownerWebId: 'https://owner.example/#me', identityUrl: 'https://identity.example',
        knownPodsRaw: 'https://peer.example/',
        ipfsProvider: 'local-unpinned', ipfsApiKey: '', isLocal: false,
      });
    } finally {
      if (dirname(resolve(isolatedDir)) === resolve(tmpdir())
        && basename(isolatedDir).startsWith('interego-stdio-package-')) {
        await rm(isolatedDir, { recursive: true, force: true });
      }
    }
  });

  it('does not require the private configuration workspace as a runtime dependency', async () => {
    const manifest = JSON.parse(await readFile(new URL('../mcp-server/package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const dependencies of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      expect(dependencies ?? {}).not.toHaveProperty('@interego/deployment-config');
    }
  });
});
