/**
 * The gate's entry point, as its own file.
 *
 * ★ SEPARATE FROM `gate.ts` SO THE LOGIC STAYS IMPORTABLE. A module that calls `runGate()` at load
 * cannot be imported by a test without running the gate, which is the same defect `main.ts` had
 * before it took a `Boot`. The policy and the decision live next door and are unit-testable; this
 * is the two lines that make them a program.
 */
import { runGate } from './gate.js';

runGate();
