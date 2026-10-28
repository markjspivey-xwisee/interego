// Declarations for seed-pinned-upper.mjs, so a test can import it: TS7016 in a test that imports
// an untyped .mjs fails the typecheck globalSetup, which takes down the whole suite.

/** One source as evidence/upper/manifest.json pins it (only the fields this script reads). */
export interface UpperPin {
  readonly key: string;
  readonly url: string;
  readonly sha256: string;
  readonly [field: string]: unknown;
}

/** The fetch this script calls, narrowed to what it uses, so a test can stand in for the network. */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Persistent-URL sources that are fetched from a commit-addressed copy instead, by manifest key. */
export declare const MIRRORS: Readonly<Record<string, { readonly url: string; readonly mirror: string }>>;

/** The User-Agent refresh-upper.ts sends, sent here too. */
export declare const USER_AGENT: string;

export declare function sha256(bytes: Uint8Array): string;

/** The manifest's pinned sources; throws when a key cannot name a file or is pinned twice. */
export declare function readPins(root: string): UpperPin[];

/** key → the Accept header refresh-upper.ts sends for it. */
export declare function readAccepts(root: string): Map<string, string>;

export declare function download(url: string, options?: {
  fetchImpl?: FetchLike; accept?: string; attempts?: number; timeoutMs?: number; backoffMs?: number;
}): Promise<Buffer>;

/** Writes `bytes` to `target` only when their SHA-256 is `pin.sha256`; throws, writing nothing, otherwise. */
export declare function writeVerified(target: string, bytes: Uint8Array, pin: { readonly key: string; readonly sha256?: string }): void;

/** Default mode: the mirrored sources into <root>/.cache/upper. Rejects on any failure. */
export declare function seedMirrors(root: string, options?: {
  fetchImpl?: FetchLike; log?: (line: string) => void; backoffMs?: number;
}): Promise<void>;

export interface SeedReport {
  /** Keys already in the directory with the pinned bytes. Nothing was fetched for them. */
  cached: string[];
  /** Keys fetched, verified and written, with where the bytes came from. */
  seeded: { key: string; url: string; bytes: number }[];
  /** Keys not in the directory after this run, with why. Each was also logged as a warning. */
  skipped: { key: string; reason: string }[];
  /** File names removed from the directory: not a pinned source, an interrupted write, or not the pin. */
  removed: string[];
  /** True only when every pinned key is cached or seeded. */
  complete: boolean;
  /** The skipped keys. */
  missing: string[];
}

/** --all mode: every pinned source into `out`, best effort. */
export declare function seedAll(root: string, out: string, options?: {
  fetchImpl?: FetchLike; log?: (line: string) => void; backoffMs?: number; timeoutMs?: number; attempts?: number;
}): Promise<SeedReport>;
