import { execFile } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const REMOTE_REF = 'refs/heads/master';

export interface RepositorySource {
  read<T>(evaluate: (root: string) => T | Promise<T>): Promise<T>;
}

interface Snapshot {
  readonly root: string;
  readonly directory: string;
  readonly commit: string;
  readers: number;
}

export class RepositoryUnavailableError extends Error {
  constructor() {
    super('The repository could not be refreshed. Retry shortly.');
    this.name = 'RepositoryUnavailableError';
  }
}

/** The hosted bridge reads master as data, independently of its deployed runtime. */
export class GitRepositorySource implements RepositorySource {
  private readonly mirror: string;
  private initialized = false;
  private current: Snapshot | undefined;
  private refreshResult: Promise<Snapshot> | undefined;
  private checkAfter = 0;

  constructor(
    private readonly remote: string,
    private readonly checkIntervalMs = 60_000,
    private readonly cache = mkdtempSync(join(tmpdir(), 'jev-repository-')),
  ) {
    this.mirror = join(cache, 'git');
  }

  async read<T>(evaluate: (root: string) => T | Promise<T>): Promise<T> {
    if (!this.refreshResult || Date.now() >= this.checkAfter) {
      this.checkAfter = Infinity;
      this.refreshResult = this.refresh().then((snapshot) => {
        this.checkAfter = Date.now() + this.checkIntervalMs;
        return snapshot;
      }, (error: unknown) => {
        this.checkAfter = Date.now() + 10_000;
        process.stderr.write(`[jev-harness] repository refresh failed: ${(error as Error).message}\n`);
        throw new RepositoryUnavailableError();
      });
    }
    const snapshot = await this.refreshResult;
    snapshot.readers++;
    try {
      return await evaluate(snapshot.root);
    } finally {
      snapshot.readers--;
      if (snapshot !== this.current && snapshot.readers === 0) await this.discard(snapshot);
    }
  }

  private async refresh(): Promise<Snapshot> {
    if (!this.initialized) {
      await this.git(this.cache, ['init', '--bare', '--template=', this.mirror]);
      this.initialized = true;
    }
    await this.git(this.mirror, ['fetch', '--depth=1', '--no-tags', '--', this.remote, REMOTE_REF]);
    const commit = await this.git(this.mirror, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    if (this.current?.commit === commit) return this.current;

    // Keep previous readers on their original tree while newer judgments use the new revision.
    const directory = await mkdtemp(join(this.cache, 'revision-'));
    const root = join(directory, 'interego');
    const snapshot = { root, directory, commit, readers: 0 };
    try {
      await this.git(this.mirror, ['worktree', 'add', '--detach', '--', root, commit]);
    } catch (error) {
      await this.discard(snapshot);
      throw error;
    }
    const previous = this.current;
    this.current = snapshot;
    if (previous && previous.readers === 0) await this.discard(previous);
    return snapshot;
  }

  private async discard(snapshot: Snapshot): Promise<void> {
    await this.git(this.mirror, ['worktree', 'remove', '--force', '--', snapshot.root]).catch(() => undefined);
    await rmdir(snapshot.directory).catch((error: Error) => {
      process.stderr.write(`[jev-harness] could not remove old repository snapshot: ${error.message}\n`);
    });
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await exec('git', [
      '-c', `core.hooksPath=${join(this.cache, 'no-hooks')}`, '-c', 'core.symlinks=false',
      '-c', 'credential.helper=', '-c', 'http.followRedirects=false', ...args,
    ], { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
    return stdout.trim();
  }
}
