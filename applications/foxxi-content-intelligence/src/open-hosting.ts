/**
 * Anyone who signs may bring a package to be hosted, not only an operator.
 *
 * ★ WHY. The bridge hosts a package for anyone to play (src/scorm-hosting.ts) and a wallet with no
 * account can launch one for itself, but only an admin could bring one (foxxi.upload_scorm_package),
 * so a person or an agent arriving with content had nothing to do with it. This is the same upload,
 * parsed and kept the same way, asked for with a signed request instead of a directory role.
 *
 * ★ WHAT OPENING IT COSTS, AND WHAT BOUNDS IT. A package is kept by its sha-256 on the tenant pod
 * and served to anyone, each document in a sandbox of its own with no same-origin access, so what
 * a stranger brings cannot read this bridge's origin. It can still fill the pod and it is still
 * served from this host, so the route is bounded here rather than trusted:
 *   - a smaller package than an operator may bring (FOXXI_OPEN_HOSTING_MAX_ZIP_MB, 25 by default);
 *   - a number of packages per signer per hour (FOXXI_OPEN_HOSTING_PER_SIGNER_HOURLY, 5 by default),
 *     counted in this process, on top of the route's own per-address limit;
 *   - one switch that closes it (FOXXI_OPEN_HOSTING=off), leaving the operator's upload as it was.
 * The upload's own receipt names the signer as the uploader, so what is kept can be traced to a key.
 *
 * What is brought can be taken down: an admin removes a package by its sha-256 with
 * foxxi.remove_hosted_package (HostedPackages.remove).
 *
 * Not here: a cumulative storage budget that survives a restart, and a takedown by whoever brought
 * the package.
 */

/** What the open hosting route is allowed to take, read once from the environment. */
export interface OpenHostingSettings {
  readonly enabled: boolean;
  /** The largest zip, in bytes, a signer may bring. */
  readonly maxZipBytes: number;
  /** How many packages one signer may bring in an hour. */
  readonly perSignerHourly: number;
}

const DEFAULT_MAX_ZIP_MB = 25;
const DEFAULT_PER_SIGNER_HOURLY = 5;
const HOUR_MS = 3_600_000;
/** Signers remembered at once; past it the oldest is forgotten, so the map cannot grow without bound. */
const MAX_SIGNERS_REMEMBERED = 10_000;

/** A whole number in a range, or a stop: a setting that is present but unusable must not be guessed at. */
function boundedSetting(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(raw)})`);
  return n;
}

/** The settings an environment asks for. Throws on a value it cannot honor, so the bridge stops at startup. */
export function openHostingSettings(env: Readonly<Record<string, string | undefined>>): OpenHostingSettings {
  const sw = env.FOXXI_OPEN_HOSTING?.trim().toLowerCase();
  if (sw !== undefined && sw !== '' && sw !== 'on' && sw !== 'off') throw new Error(`FOXXI_OPEN_HOSTING must be "on" or "off" (got ${JSON.stringify(env.FOXXI_OPEN_HOSTING)})`);
  return {
    enabled: sw !== 'off',
    // 37 MB is what fits the bridge's 50 MB request body once base64 and the envelope are counted.
    maxZipBytes: boundedSetting('FOXXI_OPEN_HOSTING_MAX_ZIP_MB', env.FOXXI_OPEN_HOSTING_MAX_ZIP_MB, DEFAULT_MAX_ZIP_MB, 1, 37) * 1024 * 1024,
    perSignerHourly: boundedSetting('FOXXI_OPEN_HOSTING_PER_SIGNER_HOURLY', env.FOXXI_OPEN_HOSTING_PER_SIGNER_HOURLY, DEFAULT_PER_SIGNER_HOURLY, 1, 1000),
  };
}

/** The base64 characters a zip of `bytes` bytes is at most: four for every three bytes, padded. */
export function base64CharsFor(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export type OpenHostingRequest =
  | { ok: true; zipBase64: string; hintedTitle?: string }
  | { ok: false; status: number; error: string };

/** Read what a signed payload asks to host, or say why it cannot be taken. */
export function openHostingRequest(payload: Readonly<Record<string, unknown>>, settings: OpenHostingSettings): OpenHostingRequest {
  const zip = payload.zip_base64;
  if (typeof zip !== 'string' || !zip) return { ok: false, status: 400, error: 'zip_base64 is required: the package, base64-encoded, inside the signed payload' };
  if (zip.length > base64CharsFor(settings.maxZipBytes)) {
    return { ok: false, status: 413, error: `the package is larger than a signer may bring here (${Math.floor(settings.maxZipBytes / (1024 * 1024))} MB)` };
  }
  const title = payload.hinted_title;
  if (title !== undefined && typeof title !== 'string') return { ok: false, status: 400, error: 'hinted_title, when given, is a string' };
  return { ok: true, zipBase64: zip, ...(typeof title === 'string' && title.trim() ? { hintedTitle: title.trim().slice(0, 200) } : {}) };
}

/**
 * How many packages each signer has brought in the last hour, in this process. `admit` counts the
 * request it admits; a refused one is not counted, and says how long until one would be admitted.
 */
export class SignerHourlyLimit {
  private readonly seen = new Map<string, number[]>();
  constructor(private readonly limit: number) {}

  admit(signer: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const key = signer.toLowerCase();
    const recent = (this.seen.get(key) ?? []).filter(t => now - t < HOUR_MS);
    if (recent.length >= this.limit) {
      this.seen.set(key, recent);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + HOUR_MS - now) / 1000)) };
    }
    recent.push(now);
    // Re-inserted, so the map's order is by last use and the first key is the one longest unused.
    this.seen.delete(key);
    this.seen.set(key, recent);
    if (this.seen.size > MAX_SIGNERS_REMEMBERED) this.seen.delete(this.seen.keys().next().value as string);
    return { ok: true };
  }
}
