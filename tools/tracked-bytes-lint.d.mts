// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

/** Extensions .gitattributes marks `binary`; bytes there mean nothing to these checks. */
export declare const BINARY: RegExp;
/** Extensions .gitattributes pins to CRLF on purpose (cmd.exe). */
export declare const CRLF_BY_DESIGN: RegExp;
/** Dotfiles that read as an "extension" and are not a file type. */
export declare const DOTFILE_PSEUDO_EXTENSIONS: ReadonlySet<string>;

/** Every tracked path, from `git ls-files` — an untracked scratch file is not the tree. */
export declare function trackedFiles(repo?: string): string[];

/** One pass over the tracked tree, reporting every offender by class. */
export declare function scanTrackedBytes(repo?: string): {
  /** Every tracked path considered. A short list here makes every check vacuous. */
  files: string[];
  /** Tracked text files holding a CR while the index is LF. */
  cr: string[];
  /** `path (0xNN at byte N)` for each file holding a C0 byte that is not TAB/LF/CR. */
  controlBytes: string[];
  /** Tracked text files beginning EF BB BF. */
  bom: string[];
  /** `*.ext (N tracked file(s))` for each tracked text extension .gitattributes omits. */
  undeclaredExtensions: string[];
  /** The .gitattributes text, so a caller can assert about its content directly. */
  attributes: string;
  /** Extensions declared in .gitattributes; an empty set means the parse broke. */
  declared: ReadonlySet<string>;
};
