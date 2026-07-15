/**
 * mdvault error + diagnostic model.
 *
 * Two failure kinds, kept distinct because they are governed differently:
 *  - VaultInputError    — malformed/hostile INPUT (path, YAML, JSON, IRI). A HARD
 *                         refusal: nothing about the offending note/context lands.
 *  - VaultConformanceError — the note violates the ACTIVE profile's rules (e.g. the
 *                         rung ceiling / authority gate, or a self-@context). The note
 *                         is quarantined out of the active graph; its exact source bytes
 *                         still recover from their content-addressed atom.
 *
 * Non-fatal problems (Vault-LD §6 "flag, not drop": unmapped terms, dangling/ambiguous
 * wiki-links, context shadowing) are reported as `Diagnostic`s rather than thrown, so a
 * partially-conforming vault still projects what it legitimately can.
 */
export type DiagnosticSeverity = 'refuse' | 'flag';

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  /** stable kebab/dotted code, e.g. 'unmapped-term', 'wiki.dangling', 'context.shadow'. */
  readonly code: string;
  readonly message: string;
  /** note/context bundle path or subject IRI this concerns, when known. */
  readonly where?: string;
}

export class MdVaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MdVaultError';
    this.code = code;
  }
}

/** Hard refusal — malformed or hostile input. Nothing lands. */
export class VaultInputError extends MdVaultError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'VaultInputError';
  }
}

/** Conformance refusal — the note breaks the active profile (rung ceiling, authority
 *  gate, self-@context). Quarantined from the active graph; source still recoverable. */
export class VaultConformanceError extends MdVaultError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'VaultConformanceError';
  }
}
