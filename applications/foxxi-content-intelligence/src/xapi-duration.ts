/**
 * Whether a value is a duration xAPI takes as `result.duration`: ISO 8601, xAPI §4.1.5.2.
 *
 * ★ IT IMPORTS NOTHING. The LRS checks every statement's duration with it (xapi-validate.ts), and
 * the dashboard checks a performer's own duration with it before a statement carries one. The
 * dashboard's image builds with its own dependencies alone, and its type check follows every
 * import, `import type` included. When the dashboard imported this from xapi-validate.ts, whose
 * model imports the substrate's ontology types, every dashboard image build failed: from #535,
 * and with it every automatic deploy after it (tests/the-dashboard-runs-in-a-browser.test.ts
 * now walks what the dashboard type-checks).
 */

/** ISO 8601 duration (xAPI §4.1.5.2 result.duration). At least one component. */
const DURATION_RE =
  /^P(?=[^T]|T.)(\d+(?:\.\d+)?Y)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?W)?(\d+(?:\.\d+)?D)?(T(?=.)(\d+(?:\.\d+)?H)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?S)?)?$/;
/** ISO 8601:2004 §4.4.3.2 — the week designator is exclusive. */
const WEEK_DURATION_RE = /^P\d+(?:\.\d+)?W$/;

/**
 * Whether `v` is a duration xAPI takes as `result.duration`. What a caller's own duration is checked
 * against before a statement carries it, on the bridge and in the dashboard alike.
 */
export function isXapiDuration(v: unknown): boolean {
  if (typeof v !== 'string' || v.length < 2 || !DURATION_RE.test(v)) return false;
  // The week designator cannot be combined with any other component.
  if (v.includes('W')) return WEEK_DURATION_RE.test(v);
  return true;
}
