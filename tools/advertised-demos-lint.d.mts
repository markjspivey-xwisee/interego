// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

/** The repository root the tool works from. */
export declare const ROOT: string;
/** The example whose advertised scripts CI compiles. */
export declare const DEMO_DIR: string;
/** The tsconfig that lists them. */
export declare const ADVERTISED_TSCONFIG: string;

/** Every `tsx examples/multi-agent/<script>.ts` instruction in the tracked Markdown. */
export declare function advertisedDemos(root?: string): Set<string>;
/** The script the example's own `npm start` runs, if it runs one with tsx. */
export declare function startScript(root?: string): string | undefined;
/** What CI compiles. */
export declare function compiledDemos(root?: string): string[];
/** Every mismatch; empty when CI compiles exactly the advertised scripts plus `npm start`. */
export declare function judge(root?: string): string[];
