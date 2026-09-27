/**
 * The forms a fragment can take, what each may ask, and the levels a fragment is pitched at: the
 * data every author works from, a person in the dashboard or an agent reading the affordances.
 *
 * ★ IT IMPORTS NOTHING. The engine (content-fragments.ts) builds and checks fragments from this
 * list, and the dashboard's author tools offer the same list in the browser, where the engine's own
 * modules cannot load (they hash with node:crypto). So there is one list, and the compiler holds
 * the engine to it: content-fragments.ts types every entry against the engine's own fragment kinds.
 */

/** Whether a kind carries questions, and which. */
export type QuestionPolicy = 'optional' | 'required' | 'ungraded-only';

/** Every form a fragment can take, and what each may ask. The bridge publishes it as it is. */
export const FRAGMENT_KIND_LIST = [
  { kind: 'concept', label: 'Concept', questions: 'optional', definition: 'A concept told: what it is, why it matters, how it relates.' },
  { kind: 'worked-example', label: 'Worked example', questions: 'optional', definition: 'A problem solved step by step, with the reasoning shown.' },
  { kind: 'video', label: 'Video', questions: 'optional', definition: 'A recorded demonstration, with its transcript in the body.' },
  { kind: 'simulation', label: 'Simulation', questions: 'optional', definition: 'An environment to try the skill in, with what to try.' },
  { kind: 'practice-task', label: 'Practice task', questions: 'optional', definition: 'A deliberate-practice repetition of a skill that already exists.' },
  { kind: 'assessment-item', label: 'Assessment item', questions: 'required', definition: 'Questions or a task that measure; they teach nothing new.' },
  { kind: 'job-aid', label: 'Job aid', questions: 'optional', definition: 'Support used in the flow of work, at the moment it is needed.' },
  { kind: 'reference', label: 'Reference', questions: 'optional', definition: 'Knowledge to look up rather than learn.' },
  { kind: 'context-descriptor', label: 'Context', questions: 'optional', definition: 'Doctrine or policy an agent takes into its working context.' },
  { kind: 'probe', label: 'Probe', questions: 'ungraded-only', definition: 'A safe-to-fail experiment: what is uncertain, what to try, when to stop, and what to watch. Nothing in it is graded, because in an emergent situation there is no right answer yet.' },
  { kind: 'reflection', label: 'Reflection', questions: 'ungraded-only', definition: 'Prompts to make sense of what happened, the material of coaching. Recorded, never graded.' },
] as const satisfies ReadonlyArray<{ kind: string; label: string; questions: QuestionPolicy; definition: string }>;

/** The levels a fragment is pitched at, lowest first. */
export const COGNITIVE_LEVELS = ['foundational', 'working', 'applied', 'advanced'] as const;
