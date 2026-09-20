import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Answer, Question } from '../src/jev-client.js';
import { choiceAnswer, FakeJevClient } from '../src/jev-client.js';

/** A small repository on disk: two sources, one sensitive module, three tests, one doc. */
export function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'jev-harness-'));
  const files: Record<string, string> = {
    'src/rollup.ts': '/** Block and course satisfaction rollup for cmi5. */\nexport function rollupCourse(): number { return 4; }\n',
    'src/course.ts': '/** Course structure parser. */\nimport { rollupCourse } from \'./rollup.js\';\nexport const course = rollupCourse();\n',
    'src/auth/gate.ts': '/** Bearer auth gate. */\nexport const gate = true;\n',
    'tests/rollup.test.ts': '// rollup emits satisfied once per block\nimport { rollupCourse } from \'../src/rollup.js\';\nexport const t = rollupCourse;\n',
    'tests/course-flow.test.ts': '// end to end course flow\nimport { course } from \'../src/course.js\';\nexport const c = course;\n',
    'tests/conformance-claims-are-grounded.test.ts': '// CONFORMANCE.md rows point at code that exists\nexport const ok = true;\n',
    'tests/rollup-edge-cases.test.ts': '// rollup with an empty block; imports nothing\nexport const edge = true;\n',
    'CONFORMANCE.md': '# Conformance\n\n| Capability | Where |\n| rollup | src/rollup.ts |\n',
    'README.md': '# Fixture repo\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

interface StateWithIds { files?: Array<{ id: string; path: string }>; tests?: Array<{ id: string; path: string }> }

/** Look up the option id for a path in the state the fake model received. */
export function idOf(state: unknown, path: string): string {
  const s = state as StateWithIds;
  const hit = [...(s.files ?? []), ...(s.tests ?? [])].find((f) => f.path === path || f.path.endsWith(`/${path}`));
  if (!hit) throw new Error(`fixture state has no file ${path}`);
  return hit.id;
}

/** A fake Jev that answers every Choice with the option whose path matches `prefer(questionId)`. */
export function preferringJev(prefer: (questionId: string, state: unknown) => string | undefined, nouls: Record<string, number> = {}): FakeJevClient {
  return new FakeJevClient((state, questions) => {
    const out: Partial<Record<string, Answer>> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'noul' && nouls[id] !== undefined) out[id] = { type: 'noul', noul: nouls[id]! };
      if (q.type === 'choice') {
        const want = prefer(id, state);
        if (want && Object.prototype.hasOwnProperty.call(q.criteria, want)) out[id] = choiceAnswer(Object.keys(q.criteria), want, 0.9);
      }
    }
    return out;
  });
}

export function scripted(answers: Record<string, Answer>): FakeJevClient {
  return new FakeJevClient(() => answers);
}

export type { Question };
