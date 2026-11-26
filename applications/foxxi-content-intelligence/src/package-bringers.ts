/**
 * Who brought each hosted package, so whoever brought one can take it down.
 *
 * ★ WHY. Anyone who signs may bring a package to be hosted (src/open-hosting.ts), and only an
 * admin could take one down. Someone who brought a package by mistake, or brought a test, had no
 * way to remove what was theirs: that file's own header listed "a takedown by whoever brought the
 * package" as not there. Found the ordinary way, on 2026-11-26, by an agent that had brought three
 * test packages and could not remove them.
 *
 * ★ THE RULE, AND WHY IT IS THIS NARROW. A package is kept under the sha-256 of its bytes, so two
 * people who bring the same bytes bring the same package, and an operator's upload and a signer's
 * can be one package too. Taking it down removes it for all of them. So a signer may take a
 * package down only when the record shows it is theirs alone:
 *   - every signer the record names is that signer;
 *   - no operator kept it (an operator's package is the operator's to remove);
 *   - it was not already hosted when the record first heard of it (`heldBefore`). A package kept
 *     before this record existed has no known origin, and bringing its bytes again does not make
 *     them yours. Without this, anyone could bring the bytes of an operator's package and then take
 *     it down.
 * Anything else is left to an admin (foxxi.remove_hosted_package) or the operator's take-down list.
 *
 * ★ WHERE IT IS KEPT. Written to the pod beside the other durable registries, so the rule survives
 * a restart; this module is the record and its rules, and does no I/O.
 */

export interface PackageOrigin {
  /** The signers who brought these bytes through the open route. */
  signers: string[];
  /** An operator kept these bytes with the admin upload. */
  operator?: true;
  /** The package was already hosted when this record first heard of it. */
  heldBefore?: true;
  firstRecordedAt: string;
}

const SHA = /^[0-9a-f]{64}$/;

function validOrigin(v: unknown): v is PackageOrigin {
  const o = v as Partial<PackageOrigin> | null;
  return !!o && Array.isArray(o.signers) && o.signers.length <= 1000
    && o.signers.every(s => typeof s === 'string' && s.length > 0 && s.length <= 2048)
    && (o.operator === undefined || o.operator === true)
    && (o.heldBefore === undefined || o.heldBefore === true)
    && typeof o.firstRecordedAt === 'string' && Number.isFinite(Date.parse(o.firstRecordedAt));
}

export type TakeDownDecision =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

export class PackageBringers {
  private readonly bySha = new Map<string, PackageOrigin>();
  /** Packages forgotten here that the durable copy may still hold (see `load`). */
  private readonly forgotten = new Set<string>();
  dirty = false;
  constructor(private readonly max = 100_000) {}

  private note(sha: string, alreadyHosted: boolean, now: number): PackageOrigin | undefined {
    if (!SHA.test(sha)) return undefined;
    let o = this.bySha.get(sha);
    if (!o) {
      if (this.bySha.size >= this.max) return undefined;
      o = { signers: [], ...(alreadyHosted ? { heldBefore: true as const } : {}), firstRecordedAt: new Date(now).toISOString() };
      this.bySha.set(sha, o);
      this.forgotten.delete(sha);
      this.dirty = true;
    }
    return o;
  }

  /**
   * A signer brought these bytes. `alreadyHosted` is whether the package was hosted before this
   * bring, asked of the store before the bytes were kept.
   */
  signerBrought(sha: string, signer: string, alreadyHosted: boolean, now: number): void {
    const o = this.note(sha, alreadyHosted, now);
    if (!o || o.signers.includes(signer)) return;
    o.signers.push(signer);
    this.dirty = true;
  }

  /** An operator kept these bytes. */
  operatorKept(sha: string, now: number): void {
    const o = this.note(sha, false, now);
    if (!o || o.operator) return;
    o.operator = true;
    this.dirty = true;
  }

  originOf(sha: string): PackageOrigin | undefined {
    const o = this.bySha.get(sha);
    return o ? { ...o, signers: [...o.signers] } : undefined;
  }

  /** Whether this signer may take the package down. See the rule at the top of this file. */
  mayTakeDown(sha: string, signer: string): TakeDownDecision {
    const o = this.bySha.get(sha);
    if (!o || !o.signers.includes(signer)) return { ok: false, status: 404, error: 'no package you brought is recorded under that sha-256' };
    if (o.operator) return { ok: false, status: 403, error: 'an operator of this bridge also keeps that package, so it is the operator\'s to take down' };
    if (o.heldBefore) return { ok: false, status: 403, error: 'that package was already hosted here before you brought it, so it is not yours alone to take down; ask an admin' };
    if (o.signers.some(s => s !== signer)) return { ok: false, status: 403, error: 'someone else brought the same package, so it is not yours alone to take down; ask an admin' };
    return { ok: true };
  }

  /** The package is gone: forget where it came from, so the same bytes brought again start anew. */
  forget(sha: string): void {
    if (!this.bySha.delete(sha)) return;
    this.forgotten.add(sha);
    this.dirty = true;
  }

  /** The packages a signer may take down. */
  takeDownable(signer: string): string[] {
    return [...this.bySha.keys()].filter(sha => this.mayTakeDown(sha, signer).ok);
  }

  toJSON(): Record<string, PackageOrigin> { return Object.fromEntries(this.bySha); }

  /**
   * Take in a durable copy, merging with what this process holds. For a package both have, every
   * restriction either one knows of is kept: the signers are united, and `operator` and
   * `heldBefore` hold if either says so. A merge can therefore only narrow who may take a package
   * down. One forgotten here stays forgotten.
   */
  load(json: unknown): number {
    if (!json || typeof json !== 'object') return 0;
    let n = 0;
    for (const [sha, v] of Object.entries(json as Record<string, unknown>)) {
      if (!SHA.test(sha) || !validOrigin(v) || this.forgotten.has(sha)) continue;
      const mine = this.bySha.get(sha);
      if (!mine) {
        if (this.bySha.size >= this.max) break;
        this.bySha.set(sha, { signers: [...new Set(v.signers)], ...(v.operator ? { operator: true as const } : {}), ...(v.heldBefore ? { heldBefore: true as const } : {}), firstRecordedAt: v.firstRecordedAt });
        n++;
        continue;
      }
      for (const s of v.signers) if (!mine.signers.includes(s)) mine.signers.push(s);
      if (v.operator) mine.operator = true;
      if (v.heldBefore) mine.heldBefore = true;
      if (Date.parse(v.firstRecordedAt) < Date.parse(mine.firstRecordedAt)) mine.firstRecordedAt = v.firstRecordedAt;
    }
    return n;
  }
  pendingForgotten(): string[] { return [...this.forgotten]; }
  /** The durable copy holds a body made when `covered` was taken (see OwnAgentAssignments.committed). */
  committed(covered: readonly string[]): void {
    for (const sha of covered) if (!this.bySha.has(sha)) this.forgotten.delete(sha);
  }
}
