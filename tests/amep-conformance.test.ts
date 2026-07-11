import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The conformance runner is intentionally executable ESM rather than a built
// workspace package, so independent implementations can copy and run it.
// @ts-ignore — validator.mjs deliberately ships without a TS declaration file.
import {
  actionContract,
  computeRepresentationTag,
  computeSemanticCid,
  parseAym,
  validateDocument,
  validateProblem,
} from '../tools/amep-conformance/validator.mjs';

const PROFILE_ROOT = resolve('docs/profiles/affordant-memory/0.1');
const FIXTURES = resolve(PROFILE_ROOT, 'conformance/fixtures');
const CONTEXT = JSON.parse(readFileSync(resolve(PROFILE_ROOT, 'context.jsonld'), 'utf8'));

function fixture(path: string) {
  const full = resolve(FIXTURES, path);
  return parseAym(readFileSync(full, 'utf8'), full);
}

function sourceShapes(report: Record<string, unknown>): string[] {
  return ((report['sh:result'] as Array<Record<string, string>>) ?? [])
    .map(result => result['sh:sourceShape']);
}

describe('Affordant Memory Exchange Profile 0.1', () => {
  it('accepts the six protocol acts and contextual reuse fixtures', async () => {
    const cases = [
      'valid/ask-human.aym.yaml',
      'valid/assert-agent.aym.yaml',
      'valid/challenge-agent.aym.yaml',
      'valid/accept-human.aym.yaml',
      'valid/fork-agent.aym.yaml',
      'valid/compose-human.aym.yaml',
      'valid/contextual-use-agent.aym.yaml',
    ];
    for (const path of cases) {
      const report = await validateDocument(fixture(path), CONTEXT);
      expect(report['sh:conforms'], path).toBe(true);
    }
  });

  it('keeps the candidate and committed forms on the same semantic CID', async () => {
    const candidate = fixture('valid/assert-agent.aym.yaml');
    const committed = fixture('valid/accept-human.aym.yaml');
    expect(candidate.memory.semanticCid).toBe(committed.memory.semanticCid);
    expect(await computeSemanticCid(candidate, CONTEXT)).toBe(candidate.memory.semanticCid);
    expect(await computeSemanticCid(committed, CONTEXT)).toBe(committed.memory.semanticCid);
    expect(candidate.memory.governanceStatus).toBe('amep:Candidate');
    expect(committed.memory.governanceStatus).toBe('amep:Committed');
  });

  it('changes the representation tag, but not semantic CID, for governance-only changes', async () => {
    const before = fixture('valid/assert-agent.aym.yaml');
    const after = structuredClone(before);
    after.memory.governanceStatus = 'amep:Committed';
    expect(await computeSemanticCid(after, CONTEXT)).toBe(await computeSemanticCid(before, CONTEXT));
    expect(computeRepresentationTag(after)).not.toBe(computeRepresentationTag(before));
  });

  it('preserves a reused holon CID while minting a new contextual-use CID', async () => {
    const source = fixture('valid/assert-agent.aym.yaml');
    const contextual = fixture('valid/contextual-use-agent.aym.yaml');
    expect(contextual.memory.reusedSemanticCid).toBe(source.memory.semanticCid);
    expect(contextual.memory.semantic.reuses.semanticCid).toBe(source.memory.semanticCid);
    expect(contextual.memory.semanticCid).not.toBe(source.memory.semanticCid);
  });

  it('advertises identical action contracts to human and software-agent projections', () => {
    const agent = fixture('valid/assert-agent.aym.yaml');
    const human = fixture('valid/assert-human-projection.aym.yaml');
    expect(actionContract(agent)).toEqual(actionContract(human));
  });

  it('rejects last-write-wins and receipt-driven auto-commit', async () => {
    const missingHead = await validateDocument(fixture('invalid/assert-missing-expected-head.aym.yaml'), CONTEXT);
    const autoCommit = await validateDocument(fixture('invalid/assert-auto-commit.aym.yaml'), CONTEXT);
    expect(sourceShapes(missingHead)).toContain('amep:ExpectedHeadShape');
    expect(sourceShapes(autoCommit)).toContain('amep:LifecycleTransitionShape');
  });

  it('rejects non-deterministic compose operand order', async () => {
    const report = await validateDocument(fixture('invalid/compose-unsorted.aym.yaml'), CONTEXT);
    expect(sourceShapes(report)).toContain('amep:DeterministicComposeShape');
  });

  it('rejects a contextual use that rewrites the reused CID', async () => {
    const report = await validateDocument(fixture('invalid/contextual-use-rewrites-cid.aym.yaml'), CONTEXT);
    expect(sourceShapes(report)).toContain('amep:ContextualUseShape');
  });

  it('emits a SHACL-shaped report for a semantic CID mismatch', async () => {
    const report = await validateDocument(fixture('invalid/semantic-cid-mismatch.aym.yaml'), CONTEXT);
    expect(report['@type']).toBe('sh:ValidationReport');
    expect(report['sh:conforms']).toBe(false);
    expect(sourceShapes(report)).toContain('amep:SemanticCidShape');
  });

  it('rejects duplicate YAML keys before JSON-LD processing', () => {
    expect(() => parseAym("'@id': urn:test:one\n'@id': urn:test:two\n", 'duplicate.yaml'))
      .toThrow(/duplicated mapping key/i);
  });

  it('keeps forbidden Problem Details free of state and policy leakage', () => {
    const problem = JSON.parse(readFileSync(resolve(PROFILE_ROOT, 'examples/forbidden.problem.json'), 'utf8'));
    expect(validateProblem(problem, {
      status: 403,
      required: ['type', 'title', 'status', 'detail', 'instance'],
      forbidden: ['currentHead', 'expectedHead', 'head', 'memory', 'policy', 'policyReason', 'affordances', 'target'],
    })).toEqual([]);
  });
});

