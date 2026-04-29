/**
 * Source-adapter framework for the organizational-working-memory vertical.
 *
 * Each external information source (web, drive, slack, github, ...) is
 * implemented as a small typed adapter that owns its source's quirks
 * — auth, pagination, content-type negotiation, ACL inheritance,
 * length truncation. The adapter speaks a uniform interface so the
 * main agent sees ONE pair of tools (navigate_source, update_source)
 * regardless of how many adapters are wired.
 *
 * The pattern: per-source isolation. The main agent's context is
 * never polluted by per-source tool descriptions or per-source
 * intermediate results. The bridge calls into the adapter; the
 * adapter returns a normalized payload; the main agent gets only
 * the normalized payload.
 */

export type NavigationVerb = 'ls' | 'cat' | 'grep' | 'recent';

export interface NavigateArgs {
  /** Verb-specific args. `cat` expects { uri }, `grep` expects
   *  { pattern, scope? }, `ls` expects { path? }, `recent` expects
   *  { window_minutes? }. */
  readonly [k: string]: unknown;
}

export interface SourceAdapter {
  /** Stable short key (e.g., "web", "drive"). */
  readonly key: string;
  /** Human-readable description (surfaces in list_sources output). */
  readonly description: string;
  /** Verbs this adapter actually supports — others are rejected at
   *  the bridge layer with a clear error before the call lands. */
  readonly supportedVerbs: ReadonlyArray<NavigationVerb>;
  /** Optional write actions. Empty if read-only. */
  readonly supportedActions: ReadonlyArray<string>;
  /** Read-side dispatch. */
  readonly navigate: (verb: NavigationVerb, args: NavigateArgs) => Promise<unknown>;
  /** Write-side dispatch (omit if read-only). */
  readonly update?: (action: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** Registry holding the loaded adapters keyed by `key`. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    if (this.adapters.has(adapter.key)) {
      throw new Error(`adapter "${adapter.key}" already registered`);
    }
    this.adapters.set(adapter.key, adapter);
  }

  get(key: string): SourceAdapter | undefined {
    return this.adapters.get(key);
  }

  list(): Array<{ key: string; description: string; supportedVerbs: readonly NavigationVerb[]; supportedActions: readonly string[]; writable: boolean }> {
    return Array.from(this.adapters.values()).map(a => ({
      key: a.key,
      description: a.description,
      supportedVerbs: a.supportedVerbs,
      supportedActions: a.supportedActions,
      writable: typeof a.update === 'function',
    }));
  }
}
