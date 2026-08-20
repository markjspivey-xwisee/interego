/**
 * @module action-authority
 * @description Resolving `/ns/iep/action/<vertical>/<verb>` to the manifest that defines it.
 *
 * This is the relay acting as the NAMING AUTHORITY for action identifiers: an action id is a
 * dereferenceable URL — a term, not a word — and this route is what makes that true. It
 * 302-redirects to the manifest where the action is defined.
 *
 * ★★ EXTRACTED BECAUSE THE RULE WAS ONLY TESTABLE THROUGH AN HTTP SERVER, AND SO WAS NOT TESTED.
 *
 * Measured against the live relay before this module existed:
 *
 *   GET /ns/iep/action/constructor/publish_context
 *     -> 302 Location: .../action/constructor/function%20Object()%20%7B%20[native%20code]%20%7D
 *
 * and likewise for `__proto__`, `toString`, `valueOf` and `hasOwnProperty`. The roster was a plain
 * object literal and the lookup a bare index, so every member of `Object.prototype` answered as a
 * registered vertical. The route's contract is "unknown vertical -> 404"; it was returning 302 for
 * five names nobody registered, under a comment asserting the map was fixed.
 *
 * A test that restated the rule locally would have passed against that code. This module is the
 * rule, and `tests/action-authority.test.ts` imports it.
 */

/** A path segment we are willing to put in a redirect: no dots, no slashes, no encoded escapes. */
const SEGMENT = /^[a-z0-9][a-z0-9_-]*$/i;

export interface ActionResolution {
  readonly ok: boolean;
  /** Absolute URL to redirect to, when ok. */
  readonly target?: string;
  /** Why the resolution was refused — for the 404 body and for tests to bind to. */
  readonly reason?: 'unknown-vertical' | 'bad-vertical' | 'bad-verb' | 'bad-target';
}

/**
 * Resolve one action id against a vertical roster.
 *
 * ★ THE OWN-KEY CHECK BELOW IS THE LOAD-BEARING GUARD, and the mutation results say so rather
 * than the intuition. Measured on this file:
 *
 *   - remove the own-key check          -> 6 assertions fail. This is the one that matters.
 *   - make the roster a plain literal   -> all 41 pass. Unobservable.
 *   - drop the `__proto__` merge skip   -> all 41 pass. Unobservable.
 *   - drop BOTH of the last two         -> all 41 still pass.
 *
 * The last result is the interesting one and it is not a hole in the test. With both merge guards
 * gone, `roster.__proto__ = {...}` sets the ROSTER's prototype (not `Object.prototype`), and the
 * own-key check then refuses the injected key anyway. So the null prototype and the `__proto__`
 * skip are genuine defence in depth against a future refactor that drops this check — they are
 * kept deliberately and they are NOT independently observable. Saying that here is the point:
 * a comment implying three guards each stop something is the kind of claim that survives long
 * after the thing it describes has changed.
 */
export function resolveActionTarget(
  roster: Record<string, string>,
  vertical: string,
  verb: string,
): ActionResolution {
  if (!SEGMENT.test(vertical)) return { ok: false, reason: 'bad-vertical' };
  if (!SEGMENT.test(verb)) return { ok: false, reason: 'bad-verb' };
  if (!Object.prototype.hasOwnProperty.call(roster, vertical)) {
    return { ok: false, reason: 'unknown-vertical' };
  }
  const raw = roster[vertical];
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'bad-target' };
  // Only an absolute http(s) target may be redirected to. The roster is operator-controlled, but a
  // value that is not a URL is how the prototype-member answers escaped as a `Location` at all.
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return { ok: false, reason: 'bad-target' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'bad-target' };
  }
  // Back-compat: a bare host (no path) keeps its historical /affordances target.
  const target = /^https?:\/\/[^/]+\/?$/.test(raw)
    ? `${raw.replace(/\/$/, '')}/affordances`
    : raw;
  return { ok: true, target };
}

/**
 * Build the roster from defaults plus an operator-supplied JSON override.
 *
 * Null-prototype, and `__proto__` is skipped explicitly: this object is merged from parsed JSON,
 * which is the textbook prototype-pollution vector when the target is a plain object.
 */
export function buildActionRoster(
  defaults: Readonly<Record<string, string>>,
  overrideJson: string | undefined,
): Record<string, string> {
  const roster: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(defaults)) roster[k] = v;
  try {
    const parsed: unknown = JSON.parse(overrideJson ?? '{}');
    if (parsed !== null && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (k === '__proto__' || typeof v !== 'string') continue;
        roster[k] = v;
      }
    }
  } catch { /* malformed override: keep the defaults rather than fail the boot */ }
  return roster;
}
