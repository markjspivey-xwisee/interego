# The judgment kit

The parts of a calibrated decision that are the same whatever the decision is about, shared by
every vertical that asks a System One model or an agent to judge something and then finds out
whether it was right.

Two verticals grew the shape independently. [`jev-harness`](../../jev-harness/) built it for
code between 2026-09-19 and 2026-09-21: where a task's change belongs, which tests cover it,
whether a diff may merge without a person. [`foxxi-content-intelligence`](../../foxxi-content-intelligence/)
built it again for content on 2026-09-22 and 23: how well a claim is supported, which work
regime a task is in, and then a network of judges, autonomy by calibration, and content that
grades and revises itself. By the end the two were one machine with different nouns. The kit is
that machine; the verticals keep the nouns.

## The loop

| Step | What it is | Modal status | In the kit |
| --- | --- | --- | --- |
| Judgment | A typed answer with a probability per alternative, from a model or an agent, naming its judge | Hypothetical | `judgment()` in `loop.ts`; rendered by `renderDescriptorTrig()` and `hmdDocument()` in `index.ts` |
| Outcome | What a confirmation makes of it: hit or miss, the multiclass Brier of its distribution, who confirmed it and whether as a person or an agent | Asserted; supersedes the judgment | `outcome()`, `choiceBrier()` |
| Calibration | Per kind of question: hit rate and mean Brier over the outcomes, Asserted from a sample floor, people and agents counted apart | Asserted from the floor | `calibration()`, `calibrationCell()` |
| Attestation | The registry attestation a calibration earns: each Asserted kind's hit rate on its axis, honesty from the Brier, Self when the judge attests itself and Peer otherwise, grounded in the calibration it came from | Asserted | `attestation()`, `attestations.ts` |
| Reputation | The registry's snapshot per judge from every attestation about it under one policy | — | `reputations()`, `reputationOf()` |
| Best judge | Judges ranked for a kind by their rating on that kind's axis | — | `rankJudges()` |
| Cross-confirmation | Each judge's newest judgment of a subject scored against every other judge's, once each way; an agent's confirmation counts but only a person's retires a judgment | Asserted, `confirmedFrom` names the peer | `crossConfirmations()`, `awaitingAPerson()` |
| Autonomy | Whether a judge may act on a kind without a person: rating clears the floor, the latest attestation rests on enough outcomes, enough of them a person's | — | `autonomy()` |

`../tests/judgment-loop.test.ts` runs the whole loop in memory on a decision kind neither
vertical has, an incident's severity: an agent and a model judge, a person and each other
confirm, the calibration asserts, the attestation rates, the registry ranks, and the rule grants
or refuses autonomy in the order it fails.

## A new decision kind

A decision kind is a name, its alternatives, and the registry axis its hit rate is reported on.
Nothing else about the domain reaches the kit.

```ts
import { attestation, autonomy, calibration, judgment, outcome, rankJudges, reputations, type DecisionKind } from '../_shared/judgment-kit/loop.js';

const SEVERITY: DecisionKind = { kind: 'incident-severity', alternatives: ['sev1', 'sev2', 'sev3', 'sev4'], axis: 'accuracy' };

// The model's Choice answer becomes a judgment; the agent's own call becomes one the same way.
const j = judgment(SEVERITY, { id, subject: 'INC-1', answer: choice.answer, probabilities: choice.probabilities, judge: MODEL });

// The on-call engineer's word makes an outcome; another judge's makes one too, with `from`.
const o = outcome(j, 'sev2', { did: PERSON });

// Calibration per kind, the attestation it earns, the registry's view, the judge to believe, and the rule.
const cells = calibration(outcomes, [SEVERITY], 20);
const self = attestation(cells, [SEVERITY], { attestor: MODEL, subject: MODEL, descriptorUrl, fromExecution: calibrationUrl });
const ranked = rankJudges(reputations(allAttestations, POLICY_ID), SEVERITY);
const decision = autonomy({ kind: SEVERITY.kind, floor: 0.9, minSamples: 20, minHumanConfirmers: 5 }, SEVERITY, snapshot, self);
```

What stays in the vertical: the question (what state the model sees, what the criteria say, which
primitive), where the entities live and how they are published (`renderDescriptorTrig()` and
`hmdDocument()` render them as seven-facet descriptors with controls; the vertical chooses the
graph IRIs and the pod), and who may call. The kit never publishes and never reads a pod.

## What each vertical takes from it

- **jev-harness** renders its navigation, selection, verdict and calibration descriptors with
  `index.ts` and issues its Self attestation through `attestations.ts`. Its calibration cells and
  advice buckets are its own (`src/store.ts`), older than the kit and carrying the harness's
  hit@1 / hit@3 arithmetic.
- **Foxxi** scores its content judgments with `choiceBrier()` and `calibrationCell()`, renders
  them with `hmdDocument()`, and issues Self and Peer attestations through `attestations.ts`.
  Its `src/judges.ts`, `src/confirm-next.ts` and `src/autonomy.ts` are the domain-bound forms of
  `rankJudges()`, `crossConfirmations()` and `autonomy()`: the same rules over judgments that
  also carry slides, courses and evidence, and an autonomy policy that is a constitutional
  document rather than a rule in memory.
- **`jev-client.ts`** is the System One client both use: questions in, typed answers and
  probabilities out, with token estimates for the usage each judgment records.

## Files

| File | Holds |
| --- | --- |
| `index.ts` | Vocabularies, Turtle literals and IRI references, payload prefixes, document head and control triples, the seven-facet TriG descriptor, the HyperMarkdown projection, `rankHits()`, `brierScore()`, `choiceBrier()`, `calibrationCell()` |
| `attestations.ts` | The attestation shape, `reputationPolicy()`, `toAttestationInput()`, `reputationOf()` over `@interego/registry` |
| `loop.ts` | The loop above, domain-free |
| `jev-client.ts` | The TypeSafe System One client |
| `../tests/judgment-kit.test.ts` | The rendering and scoring contract |
| `../tests/judgment-loop.test.ts` | The loop on a decision kind neither vertical has |
