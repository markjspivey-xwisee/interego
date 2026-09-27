/**
 * How much of a unit's trajectory the learner record keeps with it: at most this many steps, and
 * each of a step's texts (what was done, on what, its ids, its note) at most this long.
 *
 * On its own so that what writes a trajectory in a browser, the dashboard's Work page, holds the
 * limits workStepsFrom enforces rather than a copy of them. A copy said 500 where the record takes
 * 200, and the page offered to send what the bridge then refused. It names nothing but numbers, so
 * a browser can load it.
 */
export const WORK_STEP_LIMITS = { steps: 100, text: 200 } as const;
