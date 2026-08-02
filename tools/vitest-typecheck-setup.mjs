/**
 * vitest `globalSetup` — run the compiler before a single test does.
 *
 * ★ WHY IT HANGS OFF globalSetup AND NOT AN npm SCRIPT. The command people actually type is
 * `npx vitest run tests/`, and it goes nowhere near `package.json`'s `test` script. A gate
 * reachable only through `npm test` is a gate that is not there when it matters — and the
 * defect that prompted this (a required bail-out deleted from `readAcceptanceRecord`, all 237
 * tests green, `tsc` catching it instantly) was found by hand, not by any command in the repo.
 * globalSetup runs once per vitest invocation however vitest was invoked.
 *
 * Throwing here fails the whole run before collection, which is the point: a suite that
 * reports 2,555 passing tests over source that does not compile is reporting on JavaScript
 * nobody wrote.
 *
 * Costs ~6s per vitest invocation. That is the price of the guarantee and it is stated rather
 * than hidden; there is deliberately no environment variable to switch it off, because an
 * escape hatch on a gate is the gate.
 */
import { runTypecheckGate, typecheckGateReport } from './typecheck-gate.mjs';

export default function setup() {
  const result = runTypecheckGate();
  if (!result.ok) throw new Error(typecheckGateReport(result));
  // Printed on success too: a gate nobody can see running is one people assume is not.
  console.log(`✓ ${typecheckGateReport(result)}`);
}
