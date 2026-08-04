// See railway-services.d.mts for why these declarations exist at all (TS7016 in
// globalSetup takes down the whole suite, not one file).

export interface PinRow {
  service: string;
  serviceId?: string | null;
  image?: string | null;
  status?: string | null;
  deployedAt?: string | null;
  pinnedCommitAt?: string | null;
  error?: string;
  missingFromRailway?: boolean;
  repo?: string;
  tag?: string;
  tagKind?: string;
  agreement?: string;
  builtHere?: boolean;
  expectedRepo?: string | null;
  numReplicas?: number | null;
  overlapSeconds?: number | null;
  drainingSeconds?: number | null;
  freshness?: string;
  behind?: number | null;
  deployAgreement?: string;
  limitOverride?: unknown;
  limitVerdict?: string;
  limitReason?: string;
}

/**
 * The git facts `annotateFreshness` folds over. Injected rather than read, so a double
 * can answer DIFFERENTLY per sha — a double that says the same thing every time cannot
 * tell a correct fold from one that hardcodes a verdict.
 */
export interface GitFacts {
  head: string;
  known: (sha: string) => boolean;
  isAncestorOfHead: (sha: string) => boolean;
  commitsSince: (sha: string) => number;
}

export type Gql = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export declare function railwayGql(token: string, endpoint?: string): Gql;
export declare function splitImage(ref: unknown): { repo: string; tag: string; kind: string };
export declare function annotate(row: PinRow): PinRow;
export declare function annotateFreshness(row: PinRow, git: GitFacts | null): PinRow;
export declare function deployAgreement(row: PinRow): string;
export declare function gitCommitAt(tag: string, root?: string): string | null;
export declare function gitFacts(cwd?: string): GitFacts | null;
export declare function hasDisagreement(rows: PinRow[]): boolean;
export declare function collectPins(
  gql: Gql,
  git?: GitFacts | null,
  commitAt?: (tag: string) => string | null,
): Promise<{
  project: string;
  projectId: string;
  environmentId: string;
  rows: PinRow[];
}>;
