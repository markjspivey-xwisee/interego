// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

/** The repository root the gate measures by default. */
export declare const ROOT: string;

/** A package under `packages/` that belongs to a vertical, and so is neither scanned nor importable by the base. */
export interface VerticalOwned { readonly dir: string; readonly vertical: string; readonly why: string }
export declare const VERTICAL_OWNED: readonly VerticalOwned[];

/** One vertical's vocabulary. */
export interface VerticalTokens { readonly vertical: string; readonly pattern: RegExp }
export declare const VERTICAL_TOKENS: readonly VerticalTokens[];

/** Vertical vocabulary allowed in base code: an exact count of an exact text in one file, and why. */
export interface AllowedCodeToken { readonly file: string; readonly text: string; readonly count: number; readonly why: string }
export declare const ALLOWED_CODE_TOKENS: readonly AllowedCodeToken[];

/** Vertical mentions in comments, pinned per base root. */
export declare const COMMENT_PINS: Readonly<Record<string, number>>;

/** A vertical named in a file, with the exact matched text. */
export interface TokenHit { readonly vertical: string; readonly text: string; readonly index: number; readonly line: number }
export interface Specifier { readonly specifier: string; readonly line: number }

/** What one source file's code and comments say about verticals, and every module it names. */
export declare function scanSource(text: string, fileName?: string): {
  code: TokenHit[];
  comments: TokenHit[];
  specifiers: Specifier[];
};

/** Absolute paths of the base's production source files, per root. */
export declare function baseRoots(root?: string): Record<string, string[]>;

/** Package names published from `applications/`, `integrations/`, `examples/` and the vertical-owned packages. */
export declare function forbiddenPackages(root?: string): Set<string>;

/** Why a specifier imported from `file` is a dependency on a vertical, or undefined when it is not. */
export declare function forbiddenReason(specifier: string, file: string, root?: string, packages?: Set<string>): string | undefined;

export interface CodeHit { readonly file: string; readonly line: number; readonly text: string; readonly vertical: string }
export interface DependencyHit { readonly file: string; readonly line: number; readonly specifier: string; readonly why: string }
export interface Measurement {
  roots: Record<string, number>;
  dependencies: DependencyHit[];
  code: CodeHit[];
  comments: Record<string, { count: number; examples: string[] }>;
}

/** Measure the base under `root`. */
export declare function measure(root?: string): Measurement;

/** The failures a measurement has under the three rules; empty when the boundary holds. */
export declare function judge(
  m: Measurement,
  allowed?: readonly Pick<AllowedCodeToken, 'file' | 'text' | 'count'>[],
  pins?: Readonly<Record<string, number>>,
): string[];
