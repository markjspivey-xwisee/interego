#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actionContract,
  parseAym,
  validateProblem,
  validateSource,
} from './validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const profileRoot = resolve(repoRoot, 'docs/profiles/affordant-memory/0.1');
const manifestPath = resolve(profileRoot, 'conformance/manifest.json');
const contextPath = resolve(profileRoot, 'context.jsonld');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function shapes(report) {
  return new Set((report['sh:result'] ?? []).map(item => item['sh:sourceShape']));
}

const manifest = readJson(manifestPath);
const context = readJson(contextPath);
let passed = 0;
let failed = 0;

console.log('AMEP 0.1 Conformance Runner');
console.log('============================');

for (const testCase of manifest.cases) {
  const path = resolve(profileRoot, 'conformance', testCase.file);
  const source = readFileSync(path, 'utf8');
  const report = await validateSource(source, context, { filename: path });
  const conforms = report['sh:conforms'];
  const actualShapes = shapes(report);
  const expectedShapesPresent = (testCase.expects ?? []).every(shape => actualShapes.has(shape));
  const ok = conforms === testCase.conforms && expectedShapesPresent;
  if (ok) {
    passed++;
    console.log(`  ✓ ${testCase.file} — conforms=${conforms}`);
  } else {
    failed++;
    console.log(`  ✗ ${testCase.file}`);
    console.log(`      expected conforms=${testCase.conforms}, got ${conforms}`);
    if (!expectedShapesPresent) console.log(`      expected shapes: ${(testCase.expects ?? []).join(', ')}`);
    for (const violation of report['sh:result'] ?? []) {
      console.log(`      [${violation['sh:sourceShape']}] ${violation['sh:resultMessage']}`);
    }
  }
}

for (const problemCase of manifest.problems ?? []) {
  const path = resolve(profileRoot, problemCase.file);
  const failures = validateProblem(readJson(path), problemCase);
  if (failures.length === 0) {
    passed++;
    console.log(`  ✓ ${problemCase.file} — HTTP ${problemCase.status}`);
  } else {
    failed++;
    console.log(`  ✗ ${problemCase.file}`);
    for (const failure of failures) console.log(`      ${failure}`);
  }
}

for (const equivalence of manifest.actionContractEquivalence ?? []) {
  const leftPath = resolve(profileRoot, 'conformance', equivalence.left);
  const rightPath = resolve(profileRoot, 'conformance', equivalence.right);
  const left = actionContract(parseAym(readFileSync(leftPath, 'utf8'), leftPath));
  const right = actionContract(parseAym(readFileSync(rightPath, 'utf8'), rightPath));
  if (JSON.stringify(left) === JSON.stringify(right)) {
    passed++;
    console.log(`  ✓ ${equivalence.left} ≡ ${equivalence.right} — identical action contract`);
  } else {
    failed++;
    console.log(`  ✗ ${equivalence.left} ≠ ${equivalence.right} — human/agent semantics drifted`);
  }
}

console.log('============================');
console.log(`${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);

