/**
 * Production-grade xAPI LRS client with version negotiation.
 *
 * Real-world LRSes vary in xAPI version support:
 *   - Yet Analytics Lrsql: xAPI 2.0.0 (and 1.0.3 for backward compat)
 *   - SCORM Cloud:         xAPI 1.0.3 ONLY (does NOT support 2.0)
 *   - Watershed:           xAPI 1.0.3 (some 2.0 support depending on version)
 *   - SCORM Cloud-style legacy LRSes: 1.0.3
 *
 * The lrs-adapter MUST do version negotiation against /about and target
 * the highest version both sides support, falling back to 1.0.3 for
 * legacy LRSes. Statements projected as the 1.0.3-conformant subset
 * work against both.
 *
 * Production guarantees:
 *   - Real HTTP, real Basic auth
 *   - Per-call timeout
 *   - Version detection via /about endpoint
 *   - Per-statement and batch operations
 *   - Statement filter parameters supported (verb, agent, activity, since)
 *   - Voiding semantics: GET on voided statementId returns 404 per spec;
 *     voidedStatementId= retrieves voided statements
 */

export type XapiVersion = '2.0.0' | '1.0.3';

export interface LrsAuth {
  /** Basic auth username (xAPI activity-provider key). */
  readonly username: string;
  /** Basic auth password (xAPI activity-provider secret). */
  readonly password: string;
}

export interface LrsClientConfig {
  /** Base URL of the LRS xAPI endpoint (e.g., https://cloud.scorm.com/lrs/<APP_ID>/sandbox). */
  readonly endpoint: string;
  readonly auth: LrsAuth;
  /** Preferred xAPI version. Negotiated at first call; falls back if LRS doesn't support. */
  readonly preferredVersion?: XapiVersion;
  /** Per-request timeout (ms). Defaults to 15000. */
  readonly timeoutMs?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type XapiStatement = Record<string, any>;

export interface AboutResponse {
  readonly version: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly extensions?: Record<string, any>;
}

export class LrsClient {
  private readonly endpoint: string;
  private readonly authHeader: string;
  private readonly preferredVersion: XapiVersion;
  private readonly timeoutMs: number;
  private negotiatedVersion: XapiVersion | null = null;

  constructor(config: LrsClientConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.authHeader = 'Basic ' + Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64');
    this.preferredVersion = config.preferredVersion ?? '2.0.0';
    this.timeoutMs = config.timeoutMs ?? 15000;
  }

  /**
   * Detect what xAPI version the LRS supports. Cached after first call.
   * Returns the highest mutually-supported version.
   */
  async negotiateVersion(): Promise<XapiVersion> {
    if (this.negotiatedVersion) return this.negotiatedVersion;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      // Try preferred first; fall back if rejected
      const r = await fetch(`${this.endpoint}/about`, {
        headers: {
          'Authorization': this.authHeader,
          'X-Experience-API-Version': this.preferredVersion,
        },
        signal: ac.signal,
      });
      if (r.ok) {
        const body = await r.json() as AboutResponse;
        if (body.version?.includes(this.preferredVersion)) {
          this.negotiatedVersion = this.preferredVersion;
          return this.preferredVersion;
        }
        if (body.version?.includes('1.0.3')) {
          this.negotiatedVersion = '1.0.3';
          return '1.0.3';
        }
        if (body.version?.includes('2.0.0')) {
          this.negotiatedVersion = '2.0.0';
          return '2.0.0';
        }
      }
    } catch { /* fall through */ } finally { clearTimeout(t); }

    // Preferred failed: probe 1.0.3 directly
    const ac2 = new AbortController();
    const t2 = setTimeout(() => ac2.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.endpoint}/about`, {
        headers: { 'Authorization': this.authHeader, 'X-Experience-API-Version': '1.0.3' },
        signal: ac2.signal,
      });
      if (r.ok) {
        const body = await r.json() as AboutResponse;
        if (body.version?.includes('1.0.3')) {
          this.negotiatedVersion = '1.0.3';
          return '1.0.3';
        }
      }
    } catch { /* */ } finally { clearTimeout(t2); }

    throw new Error(`LRS at ${this.endpoint} does not support xAPI 2.0.0 or 1.0.3 (or is unreachable / unauthorized)`);
  }

  private async commonHeaders(): Promise<Record<string, string>> {
    const version = await this.negotiateVersion();
    return {
      'Authorization': this.authHeader,
      'X-Experience-API-Version': version,
      'Content-Type': 'application/json',
    };
  }

  /**
   * POST a single Statement. Returns the statement ID assigned by the LRS.
   */
  async postStatement(stmt: XapiStatement): Promise<string> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.endpoint}/statements`, {
        method: 'POST', headers: await this.commonHeaders(), signal: ac.signal,
        body: JSON.stringify(stmt),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`LRS rejected statement (${r.status}): ${body}`);
      }
      const ids = await r.json() as string[];
      const id = ids[0] ?? stmt['id'] as string;
      if (!id) throw new Error('LRS returned empty statement id list');
      return id;
    } finally { clearTimeout(t); }
  }

  /**
   * POST a batch of Statements. Returns IDs in order.
   */
  async postStatementBatch(statements: readonly XapiStatement[]): Promise<readonly string[]> {
    if (statements.length === 0) return [];
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.endpoint}/statements`, {
        method: 'POST', headers: await this.commonHeaders(), signal: ac.signal,
        body: JSON.stringify(statements),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`LRS rejected statement batch (${r.status}): ${body}`);
      }
      return await r.json() as string[];
    } finally { clearTimeout(t); }
  }

  /**
   * GET a single Statement by ID. Returns null if not found (404 per spec).
   * Throws on other errors.
   */
  async getStatement(statementId: string): Promise<XapiStatement | null> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.endpoint}/statements?statementId=${encodeURIComponent(statementId)}`, {
        method: 'GET', headers: await this.commonHeaders(), signal: ac.signal,
      });
      if (r.status === 404) return null;
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`LRS getStatement failed (${r.status}): ${body}`);
      }
      return await r.json() as XapiStatement;
    } finally { clearTimeout(t); }
  }

  /**
   * GET a voided Statement by ID. Per xAPI 4.2.1, voided statements
   * return 404 on plain GET; this method retrieves them via the
   * dedicated voidedStatementId= parameter.
   */
  async getVoidedStatement(statementId: string): Promise<XapiStatement | null> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.endpoint}/statements?voidedStatementId=${encodeURIComponent(statementId)}`, {
        method: 'GET', headers: await this.commonHeaders(), signal: ac.signal,
      });
      if (r.status === 404) return null;
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`LRS getVoidedStatement failed (${r.status}): ${body}`);
      }
      return await r.json() as XapiStatement;
    } finally { clearTimeout(t); }
  }

  /**
   * GET Statements with filter. Returns a StatementResult with statements
   * + optional more URL for pagination.
   */
  async queryStatements(filter: {
    verb?: string;
    activity?: string;
    agent?: XapiStatement;  // serialized actor object
    since?: string;  // ISO timestamp
    until?: string;
    limit?: number;
  } = {}): Promise<{ statements: readonly XapiStatement[]; more?: string }> {
    const params = new URLSearchParams();
    if (filter.verb) params.set('verb', filter.verb);
    if (filter.activity) params.set('activity', filter.activity);
    if (filter.agent) params.set('agent', JSON.stringify(filter.agent));
    if (filter.since) params.set('since', filter.since);
    if (filter.until) params.set('until', filter.until);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const url = params.toString() ? `${this.endpoint}/statements?${params}` : `${this.endpoint}/statements`;
      const r = await fetch(url, {
        method: 'GET', headers: await this.commonHeaders(), signal: ac.signal,
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`LRS queryStatements failed (${r.status}): ${body}`);
      }
      return await r.json() as { statements: readonly XapiStatement[]; more?: string };
    } finally { clearTimeout(t); }
  }

  /**
   * Currently negotiated version. null until first call to a method that
   * triggers negotiation. Useful for diagnostics.
   */
  getNegotiatedVersion(): XapiVersion | null {
    return this.negotiatedVersion;
  }
}
