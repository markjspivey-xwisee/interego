/**
 * The bridge's mark on a result it graded itself, so a credential can tell engine-graded
 * evidence from a statement the learner wrote into their own record.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Every statement the Foxxi LRS stores carries the same authority, whether the SCORM engine
 * graded it or the learner posted it through their own signed xAPI write; the extensions that
 * say `training` or name an observer are whatever the writer put there. So nothing in a
 * statement's shape says who decided the score. A credential the tenant signs must not rest
 * on the learner's word alone, and on 2026-09-24 the only way to know a result was the
 * engine's was to have been the engine. This tag is that knowledge, carried on the statement:
 * an HMAC over the fields that make the result what it is, keyed by a secret only the bridge
 * holds. A statement the learner writes can copy the extension's name but not compute it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The extension the tag travels in, on `context.extensions`. */
export const GRADED_TAG_EXT = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#gradedTag';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** The fields a grade is about: who, which verb, which activity, the result, and when. */
export function gradedFields(statement: Record<string, unknown>): string {
  const actor = obj(statement['actor']);
  const account = obj(actor?.['account']);
  const who = str(actor?.['mbox']) || str(actor?.['openid']) || `${str(account?.['homePage'])}|${str(account?.['name'])}`;
  const result = obj(statement['result']);
  const score = obj(result?.['score']);
  return [str(statement['id']), who, str(obj(statement['verb'])?.['id']), str(obj(statement['object'])?.['id']), typeof score?.['scaled'] === 'number' ? String(score['scaled']) : '', typeof result?.['success'] === 'boolean' ? String(result['success']) : '', str(statement['timestamp'])].join('\n');
}

/** The tag for a statement the bridge graded, under the bridge's key. */
export function gradedTag(statement: Record<string, unknown>, key: string): string {
  return createHmac('sha256', key).update(gradedFields(statement)).digest('hex');
}

/** The statement with the bridge's tag on it; the statement must already carry its id and timestamp. */
export function withGradedTag(statement: Record<string, unknown>, key: string): Record<string, unknown> {
  const context = obj(statement['context']) ?? {};
  const extensions = obj(context['extensions']) ?? {};
  return { ...statement, context: { ...context, extensions: { ...extensions, [GRADED_TAG_EXT]: gradedTag(statement, key) } } };
}

/** Whether the statement carries the tag the bridge would compute for it: it was graded here, and its result is as graded. */
export function isGradedBy(statement: Record<string, unknown>, key: string): boolean {
  const carried = str(obj(obj(statement['context'])?.['extensions'])?.[GRADED_TAG_EXT]);
  if (!carried) return false;
  const expected = gradedTag(statement, key);
  if (carried.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(carried, 'utf8'), Buffer.from(expected, 'utf8'));
}
