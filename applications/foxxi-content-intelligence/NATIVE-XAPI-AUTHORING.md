# Native xAPI course authoring

`foxxi.xapi_author` authors a course directly into the format-neutral content engine. A course is
a composition of modules and lessons, each made from teaching fragments and checks. Its native
launch uses `foxxi.content_launch` and `foxxi.content_next`; these grade stored question verifiers
and write xAPI 2.0 statements directly. No SCORM manifest or SCORM sequencing engine is needed.

The same content can still be projected to cmi5 or SCORM. Existing `foxxi.scorm_author`, launch,
submit and SCORM exports remain available.

## Author and launch

Discover `foxxi.xapi_author` in the canonical affordance manifest. Sign the following payload
with the existing `sign_request` flow and post its envelope to the discovered target
(`/agent/xapi/author`):

```json
{
  "agent_id": "<your authenticated identity>",
  "timestamp": "<current timestamp>",
  "course": {
    "title": "Check a source before using it",
    "competency": "source-verification",
    "modules": [{
      "title": "Read and check",
      "lessons": [{
        "title": "Source fidelity",
        "fragments": [
          { "kind": "concept", "body": "Read the returned source before claiming it supports a fact." },
          { "kind": "assessment-item", "body": "Check your understanding.",
            "questions": [{ "question": "A title alone proves a source supports a fact.", "type": "true-false", "answer": false }] }
        ]
      }]
    }]
  }
}
```

Modules and lessons inherit the course competency unless they declare another. Fragment
competencies inherit the lesson unless declared. An explicit fragment competency set must include
the lesson competency; use a lesson override when it teaches another competency. Fragments use the existing fragment kinds,
Markdown, language, audience and typed question contracts. Assessment answers are transformed
into blinded verifiers before storage; public artifacts omit the verifiers and answer keys.
The teaching the author writes remains readable.

The successful response includes the root `@id`, author identity, artifact links and confirmed
pod persistence. It is returned only after the whole content bundle has been kept. Invalid
content returns 400; authentication failure returns the existing verifier's refusal; storage
failure returns 503. This operation may make a new content identity on each invocation when
graded questions receive fresh blinding, so it is not advertised as idempotent.

Launch by signing the existing `foxxi.content_launch` payload with `composition` set to the
returned `@id`. Its session and xAPI registration identify the attempt. Continue through
`foxxi.content_next` with signed `expected_step` set to the returned `step.step`. Keep that number
on a retry. A reported pending-write failure keeps the same statements and already-graded
answers. A lost acknowledgement after a successful write replays the latest receipt without
grading or writing again, including a guarded final step. Older step numbers are refused. These
receipts are in-process, bounded by the existing three-hour session expiry and capacity limit;
process restarts or eviction do not preserve them. Legacy calls without `expected_step` retain
their existing behavior and cannot safely retry a lost successful acknowledgement. A failed
answer remains failed. Unassessed reading is completion, not a
passing score or mastery claim. Existing learner-specific resolution, admissions and authority
checks apply unchanged.

## Readable artifacts

- `.../ns/foxxi/composition/<hash>?format=markdown`: HyperMarkdown with an authority-closed
  native launch control, resolved from the current signed affordance.
- `.../ns/foxxi/composition/<hash>/xapi.json`: `foxxi-native-xapi-course/v1`, an answer-safe
  descriptor of every reachable public fragment/composition, the xAPI tracking contract,
  hosted native launch and companion artifact links.
- `.../ns/foxxi/composition/<hash>/cmi5.xml`: existing cmi5 course structure referencing the
  hosted Assignable Unit. That standard has its own launch token, LaunchData and statement rules.
- `.../ns/foxxi/composition/<hash>/scorm.zip`: existing optional SCORM 2004 projection.

xAPI standardizes experience records rather than a course package/launch format. `xapi.json`
is explicitly this product's hosted descriptor; it is not a standardized xAPI ZIP, an offline
player, or a portable grading-key archive. Reading it never starts an attempt or records a
learner's experience. The external-LMS cmi5 AU's reported outcomes remain distinct from the
signed native engine's server-graded evidence.

## Validation scope

`tests/xapi-course.test.ts` exercises native hierarchy authoring, answer-safe export, actual
composition resolution/play, right and wrong answers, unassessed completion, interrupted record
recovery, guarded lost-acknowledgement replay, stale-step refusal, input budgets and source-level signed-route wiring. Run the repository's normal
typecheck/test gates before release. Passing local tests alone does not establish deployment,
an actual LRS receipt, cryptographic persistence or improved learner performance.
