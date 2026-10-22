# Practice Evidence: conversation practice with evidence a reviewer can stand behind

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** One specific use case among many possible. The Interego protocol does not depend on any of this; multiple alternative verticals could exist over the same substrate. Vocabulary in this document (`pev:` namespace) is vertical-scoped, non-normative, and lives in [`ontology/pev.ttl`](ontology/pev.ttl).
>
> Status: Working Draft. Layer: application-over-L3. No L1/L2/L3 ontologies are extended.

## What is verified, and what has never run

Verified, offline, by the five test modules in [`tests/`](tests/) and by the offline demo:

- The pure engines: scenario and rubric checks, the quote rule, the platform's arithmetic, calibration, the review queue, results suppression, xAPI statement building and checking, record graphs against the SHACL shapes, envelopes in both forms.
- The model seam against a fetch double that speaks the Anthropic Messages shape: request shape, timeouts, retries, and every failure mapped to a refusal that records nothing.
- Every act, in order, through the handlers on an in-memory pod that honours ETags and conditional writes, with generated wallets: every refusal the spec names is provoked and its status and code asserted, and every record is read back from the pod and checked against the platform signature.
- The bridge over HTTP and MCP, and the web UI: the shipped `/ui` page and `app.js` run in a jsdom window against a loopback bridge, and three signing modes (demo keys, a wallet, pasted signatures) carry a learner, an author, a reviewer and an admin through the lifecycle.
- The offline demo walks two bridges over HTTP the way a Path-A agent does and checks every step; a test runs it and re-checks what it reports.

Never run:

- **No live model.** No test or demo calls a real model; the scripted fixture is disclosed as `scripted` on every turn and judgment.
- **No live pod.** Every pod path, including the operator write credential (`PEV_POD_WRITE_SECRET`), is proven against the in-memory pod only.
- **No learning record store** receives a statement. Statements are returned, logged in an audit row, and shown with the request a person would send.
- **No browser wallet.** The wallet path is proven by an equivalence check: the page's own code signs through a `window.ethereum` that signs the way `personal_sign` does, with a real key. No real browser or wallet extension was driven.

## What it does

Five kinds of people use it, and an agent can sit in any seat its registry entry allows.

- **Author.** Writes a practice scenario: what the learner practises, their part, the situation, the person they practise with (who they are, what they want, what they know, how they react), that person's first line, when the conversation ends, a turn limit, and a rubric of criteria with ordered levels and a descriptor per level. The author must say how the scenario is used (feedback only, or a pass gate) and how knowable the work is. They can draft with this bridge's model or their own agent; the record says who drafted it. They save a draft, try it themselves (a test that never counts), and publish. Every content edit is a new version that supersedes the old one. Per scenario they see results and what reviewers changed and why.
- **Reviewer.** Ratifies a published rubric version (until then, results on it cannot leave as evidence). Works a ranked queue. States a level for every criterion, confirming the judge's or setting another with a reason. On audit-sample attempts, chooses levels before seeing the judge's. Re-reviews a contested review.
- **Learner.** Picks a scenario, says whether they are coached, and talks with the other person. Every reply shows which model produced it. They end the conversation (the other person may propose the end, never impose it), ask for judging and second opinions, and see per criterion: the level, their own words highlighted where a quote checked out, what did not check out and why, the judge's words labelled as not part of the score, and what the next level asks for, quoted from the rubric. They can contest a review, download their signed record, copy it to their own pod, and remove the transcript from the operator's pod.
- **Judge.** This bridge's model, or an independent judge agent working from a packet. It picks a level, quotes and a rationale per criterion. It never computes a score and never has the last word.
- **Admin.** Registers roles. Can withdraw a review for cause; the withdrawal is recorded and the learner sees why.

Everything is a signed record on a pod. With no model configured the bridge says so (503) and points at the packet route; it never fakes a model.

## How this differs

These are deliberate design choices of this vertical, stated as our own concepts.

- **The model never does arithmetic and never gets the last word.** A judge returns a level, quotes and a rationale per criterion. The platform checks every quote, character for character after a published normalisation, against the learner's own lines; computes any score from the rubric's weights and pass rule; and records a Hypothetical attempt bound to the rubric version hash, the transcript hash and the judge disclosure. A quote that does not check out leaves its criterion unverified, and an unverified criterion counts at its lowest level until a reviewer sets it.
- **Nothing leaves as evidence until a qualified person reviews it, on a rubric a person ratified.** A reviewer who is not the learner, not a judge of the attempt and not the platform states every level in a signed act. That review is an Asserted record that supersedes the Hypothetical one. Unverified criteria must be set by the reviewer. Statements are built only for a reviewed head on a ratified rubric; a decline is a 409 and leaves an audit row.
- **Classify first, and feedback only is a real choice.** The author declares how knowable the work is. A pass gate on work not read as evident or knowable needs a recorded reason. A feedback-only scenario computes, stores and projects no score at all.
- **The judge is calibrated per criterion, and the queue says where to look.** Every review is an outcome for the judge, per (judge × prompt × rubric version × criterion), measured as agreement with the reviewer (not accuracy) with a Brier score and a mean level distance. The queue ranks attempts by unverified quotes, disagreement between judgments, closeness to the pass mark, the judge's own uncertainty, thin calibration, learner control and the audit sample, and shows the factors with the priority.
- **Several judgments, with agreement shown.** An attempt can be judged up to five times; a repeat by the same judge and prompt measures test-retest consistency.
- **Practice evidence is not capability evidence.** Records and statements say "practice"; the statement verb is `completed`; no credential is issued from practice; the attempt number and whether the learner was coached are recorded.
- **Who controlled the other person and the judge is recorded.** When the learner's own agent wrote the other person's lines, or the learner chose the judge's model, the record says so and the queue raises the attempt.
- **The learner holds their record.** They can download every version's exact signed bytes, verifiable offline with the substrate's functions alone; copy every version to a pod they name; contest a review; and remove the transcript from the operator's pod while every hash and level stays.
- **Your own agent can do the inference.** Routes: this bridge's model (operator key), your own key for one request (used once, never stored), client-required packets that let your agent play the other person or an independent judge agent judge, and a scripted fixture for the offline demo and tests. Every turn and judgment discloses provider, the model the provider returned, key source, route and measured usage.
- **Authoring is evidence-first.** A rubric version is identified by its hash; editing creates a new version that supersedes the old one; levels are fixed per version and every attempt binds the version it practised.

## Signing as a learner (or in any role)

Every act that changes or reveals a person's record is signed by that person; the signer is the actor and nothing else names them. The web UI offers three ways:

- **Wallet.** A wallet that supports `personal_sign`. One prompt per signed act (session keys are not built; see Deviations). Read views reuse one signed read for up to nine minutes.
- **Paste.** The page shows the exact text to sign (`canonicalJson` of the payload) and takes the pasted signature.
- **Demo.** With `PEV_DEMO_ROLES=1` on a loopback bridge, or the demo's `--serve`, the bridge holds role keys and signs as the role picked. A permanent banner says so, and every record those keys sign says so.

Agents use either envelope form: `{payload, signature}` (EIP-191 over `canonicalJson(payload)`), or `{_signed_payload, _signature}` when `agent_id` names the signer's own key. A relay-mediated signature is refused: the relay signs with its own key.

## Run it

**The offline demo** (no network, no model, no environment variables):

```bash
npx tsx applications/practice-evidence/demo/run.ts                  # walk, print every step, write demos/output/pev-<time>.md
npx tsx applications/practice-evidence/demo/run.ts --serve          # ...then serve the web UI on 127.0.0.1:6110 in demo mode
npx tsx applications/practice-evidence/demo/run.ts --serve --port 6111
```

With `--serve`, open `http://127.0.0.1:6110/ui`. The other person, the judge and the drafter are the scripted fixture: it answers lines it has no script for with "Go on.", judges the demo rubrics from its script and gives other rubrics the lowest level, and says so on every record. There is no `--live` mode; the real path is the server below.

**The bridge:**

```bash
PEV_DEFAULT_POD_URL=https://your-pod.example/practice/ \
PEV_ADMIN_ADDRESSES=0xYourAdminAddress \
PEV_PLATFORM_KEY=0xPlatformKeyHex \
PEV_LLM_API_KEY=… PEV_LLM_MODEL=… \
  npx tsx applications/practice-evidence/bridge/server.ts
```

Then the web UI is at `/ui`, the affordance manifest at `/affordances`, MCP at `/mcp` and the ontology at `/ns/pev`.

| Variable | Meaning |
|---|---|
| `PORT` | default 6110 |
| `HOST` | default `127.0.0.1`; a bridge holding a signing key does not listen on every interface unless told to |
| `BRIDGE_DEPLOYMENT_URL` | the public base URL |
| `PEV_DEFAULT_POD_URL` | the operator pod |
| `PEV_SERVED_PODS` | comma-separated pods records may be written to; default the operator pod |
| `PEV_POD_WRITE_SECRET` | the operator pod's write credential, sent as a bearer only on writes under that pod's path; never logged |
| `PEV_PLATFORM_KEY` | the platform signing key; absent means an ephemeral key (see below) |
| `PEV_TRUSTED_PLATFORM_ADDRESSES` | earlier platform addresses whose records stay trusted |
| `PEV_ADMIN_ADDRESSES` | addresses that may change roles and withdraw reviews |
| `PEV_LLM_API_KEY` or `ANTHROPIC_API_KEY`, with `PEV_LLM_MODEL` | this bridge's own model route; a key without a model is no route, because this bridge never picks a model |
| `PEV_DEMO_ROLES` | `1` gives the bridge demo role keys; refused unless `HOST` is loopback |

- **The pod** must accept this bridge's writes, or the bridge needs `PEV_POD_WRITE_SECRET` for a gated pod. A refused write is reported as `pod-refused-write`, naming that setting.
- **Ephemeral key.** Without `PEV_PLATFORM_KEY` the bridge makes a key at startup and every record says `keyKind: ephemeral`. After a restart those records are untrusted until the old address is added to `PEV_TRUSTED_PLATFORM_ADDRESSES`; the startup lines print the exact setting, or use a fresh pod path.
- **Your own key for one request** (`llm_api_key` with `llm_model`) is used once, never stored or echoed. The web UI offers it as a toggle in the header.

## Affordances

| Tool | What it does |
|---|---|
| `pev.register_role` | An admin adds or removes reviewer, author, judge or agent for an address |
| `pev.author_scenario` | Save or publish a scenario version |
| `pev.draft_scenario_packet` | The drafting prompt for your own agent; writes nothing |
| `pev.draft_scenario` | Draft with this bridge's model or your key; writes nothing, returns a platform receipt |
| `pev.ratify_scenario` | A reviewer (a person, not an author of the version) ratifies a rubric version |
| `pev.list_scenarios` | Published scenarios with their full rubrics, or one scenario with its versions |
| `pev.start_attempt` | Start practising; the signer is the learner |
| `pev.say` | Say a line; this bridge's model answers as the other person |
| `pev.counterpart_packet` | The other person's prompt, for your own agent |
| `pev.record_turns` | Record your line and the line your agent wrote for the other person |
| `pev.end_conversation` | End the conversation; the transcript is fixed |
| `pev.judge_attempt` | This bridge's model (or your key) judges the attempt |
| `pev.judge_packet` | The judging prompt and output schema, for an independent judge agent |
| `pev.record_judgment` | A registered judge records its judgment, bound to the head it read |
| `pev.review_queue` | A reviewer's ranked queue, with the factors behind each priority |
| `pev.countersign_attempt` | A reviewer confirms every level the primary judgment chose |
| `pev.override_attempt` | A reviewer sets every level, with reasons where they differ |
| `pev.contest_review` | The learner asks a different reviewer to look again |
| `pev.retract_review` | An admin withdraws a review for cause |
| `pev.calibration` | Agreement with the reviewer per judge, prompt, rubric version and criterion |
| `pev.scenario_results` | Results per scenario, small counts suppressed |
| `pev.project_attempt` | An xAPI statement for a reviewed attempt on a ratified rubric |
| `pev.holder_copy` | Copy every version of an attempt to a pod the learner names |
| `pev.export_record` | Every version's exact signed bytes, verifiable offline |
| `pev.redact_attempt` | Remove the transcript from the operator pod; hashes and levels stay |
| `pev.get_attempt` | One attempt with what this caller may do next, or a list of attempts |
| `pev.sign_as_demo_role` | Demo only: the bridge signs as a demo role it holds |

## Records and lifecycle

Every record is a Context Descriptor on the operator pod whose graph carries typed `pev:` triples and the whole record body as canonical JSON, signed by the platform key with a content-bound authorship proof. An attempt is one supersede chain on one graph IRI:

```
start_attempt ─► in-conversation  (Hypothetical)
in-conversation ─(say | record_turns)─► in-conversation
in-conversation ─(endAfter | turn limit | end_conversation)─► ended   (transcript hash fixed)
ended ─(judge_attempt | record_judgment)─► judged                       (Hypothetical; platform result)
judged | contested | review-retracted ─(countersign_attempt)─► countersigned   (Asserted)
judged | contested | review-retracted ─(override_attempt)─► overridden         (Asserted)
countersigned | overridden ─(contest_review)─► contested                       (Hypothetical)
countersigned | overridden | contested ─(retract_review)─► review-retracted     (Retracted)
any state but redacted ─(redact_attempt)─► redacted                              (Retracted; earlier graphs deleted)
```

A scenario moves draft → published → ratified (Asserted, attested by the reviewer); a content change is a new, unratified version. Learners start published or ratified versions only.

## Inference and disclosure

`src/model.ts` holds the seam and reads no environment. The Anthropic Messages client sends only `model`, `max_tokens`, `system` and `messages`, with per-request and total timeouts; a 5xx or network failure is retried, nothing else is, and a timeout is reported, not retried. The model the provider returned is the one disclosed. Every failure is a refusal (400, 502 or 503) that records nothing and carries the disclosure of the call that was made.

## Calibration and standing

Calibration is computed on read from the reviewed attempts on the pod and is not published. It is agreement with the reviewer, who usually saw the judge's levels first; the blind subset is declared by the reviewer. Cells are keyed per judge, prompt template hash, rubric version hash and criterion, so a rubric edit (even a weight) starts new cells; a pooled view across versions with the same criterion text is offered for information only. Standing (a reputation-weighted agreement rating of at least 0.9, resting on at least 20 reviewed outcomes confirmed by at least five different people; software agents only) is reported and changes nothing in this version: every attempt still needs a qualified reviewer before it can leave as evidence.

## Results

Per scenario, for reviewers, authors and admins: counts by state, final levels from standing reviews, provisional levels from primary judgments (labelled), coached and attempt-number splits, and what reviewers changed and why. Counts below five are suppressed, and a second cell is suppressed where one would otherwise be recoverable. The page says what results are: what happened in practice, not what caused it.

## Projections and what they lose

`xapi` builds an xAPI 2.0 statement; `cmi5` builds the same with cmi5-allowed context only (a derived registration and session id, no cmi5-defined category, so practice cannot satisfy an assignable unit). Both carry the practice marker, the rubric and transcript hashes, the primary judge and the reviewer. A pass gate carries a score and `success`; feedback only carries levels and neither. Each statement lists what it loses (the quotes, the transcript, the reviewer's reasons, other judgments). SCORM is refused (501): a SCORM write is made by content in the browser, so it would carry a score without its provenance.

## What it does not do yet

- Send statements to a learning record store; LTI grade passback; SCORM; a cmi5 launch from an LMS.
- Packages for authoring tools.
- Voice, avatars, coaches, knowledge retrieval.
- Encrypted holder copies; writing pod access-control documents.
- Retention windows (automatic redaction after a period); a pod-wide feedback-only switch; review links for people without an account.
- Session keys for signing (one wallet prompt per act today).
- Badges or any credential; metering.

## Cost and growth

Every exchange rewrites the whole attempt body, so storage per attempt grows with the square of its length, and every act runs a manifest read, so the work per act grows with the pod. In one run of the offline demo on the build machine an exchange took about 50 to 70 ms on the in-memory pod; steps whose DNS look-up (made by the SSRF guard on every pod request) stalled took about 2 s longer. The demo report lists the per-turn figures of each run. A real pod adds its own round trips.

## Threat notes

- A learner can try to talk the judge into a level. Quote checking cannot catch a real quote used out of context; the reviewer is the control.
- Reviewers usually see the judge's levels first; blind order is declared by the reviewer, not enforced.
- When the learner's own agent wrote the other person's lines, the record says so and the queue raises the attempt.
- Records are plaintext. The bridge writes no access-control document and no public-read facet; whoever the operator pod lets read `pev/records/` can read transcripts, so restrict that container.
- The person-versus-agent rules rest entirely on the admin's registry.
- Writes are bounded by the served pods, the turn limit, five judgments and two contests per attempt.
- The Host-header guard protects a loopback bridge from DNS rebinding.
- The nonce ledger is per process: across a restart, what remains is the ten-minute freshness window and the compare-and-set on each chain.
- Relay-mediated signatures are refused.
- Redaction deletes graphs but leaves descriptors and manifest entries, which hold proofs and hashes, not text.

## Deviations

From the design decisions and the spec, deliberately:

1. **No grants in this version.** Standing is computed and shown; it changes nothing, and there is no grant record to revoke.
2. **Plaintext records**; the pod's own access control governs reads. Encrypted copies are out of scope.
3. **Replay protection is per process** (see Threat notes).
4. **Concurrency.** Every record has a unique slug, so a race between processes becomes a detectable fork (409 `chain-forked`, no repair path in this version), never a silent overwrite. The heads are read again right before every publish. Graph locks belong to each handler set, so two handler sets in one process behave like two processes.
5. **SCORM is 501.** `cmi5` is narrowed to xAPI with cmi5-allowed context.
6. **Nothing is posted to an LRS.**
7. **The rubric is public**, including to the learner.
8. **Ephemeral platform keys** make earlier records untrusted after a restart until trusted again.
9. **No server-side model fallback**, and no `thinking` or sampling parameters.
10. **Calibration is computed on read**, not published.
11. **Envelope form B** is accepted only when `agent_id` names the recovered signer.
12. **Holder copies** go only to pods that accept the bridge's unauthenticated writes, never to the operator pod or a pod this bridge serves (400 `target-pod-is-served`: copies there would add competing heads to the attempt's own chain). `pev.export_record` gives the learner the signed bytes in every case.
13. **Several judgments per attempt** (up to five); the first is primary.
14. **Explicit per-criterion review**: countersign and override both list every criterion.
15. **The verb is `completed`**, with `success` for a pass gate.
16. **Calibration cells are split by prompt template hash** as well as rubric version and criterion.
17. **Blind review is declared, not enforced.**
18. **Redaction** deletes earlier graphs only under the operator pod's path; anything else is listed in `graphsStillPresent`.
19. **Wallet signing is one prompt per act.**
20. **Served pods** bound where the platform key's records are written.
21. **Unratified rubrics** cannot be projected.
22. **Additions to the spec's interface:** refusal codes `payload-shape`, `pod-url-differs`, `target-missing`, `why-too-long`, `brief-too-long`, `source-text-too-long`, `byok-incomplete`, `group-by-unknown`, `target-pod-is-served`; output fields `currentTarget` on every attempt write, `primaryJudgeLevels` on reviews, the rubric on queue entries, `validFrom`/`validUntil` on a withdrawal, `provisionalLabel` on judgments, and `scenarioKey` in scenario views (the web UI needs it to edit a scenario). Each attempt act keeps its signature, so every act can be re-verified from the record. An untrusted attempt head answers `project_attempt` with 409 `record-not-trusted` and writes no skip audit. Eligibility checks the author-test rule first.
23. **The other person's reply has no length limit**; the 4000-character limit applies to the learner's lines and to lines recorded from a packet.
24. **Demo role keys** on the real server are registered against `PEV_DEFAULT_POD_URL` at startup.
25. **The offline demo has no live mode**: `runDemo({ live: true })` and `--live` say what to run instead. Its step table follows the spec's, with extra checks: 27b reads the skip audit back from the pod; 31a shows that the same reviewer is refused as an earlier reviewer (403) before any state check, and 31b that a different reviewer is refused because the attempt is already reviewed (409); 47b, 50b and the last step read the attempts.
26. **The scripted judge** gives criteria it has no script for the lowest level, with a rationale saying it is a fixture, so a scenario written in `--serve` mode can be judged offline.

## Owner questions

1. Should standing pool across rubric versions whose criterion text is identical? (Built: any rubric edit starts new cells; a pooled view exists for information.)
2. The verb: `completed` with `success` (built), or `passed`/`failed`?
3. `cmi5`: keep the document with cmi5-allowed context (built), or refuse it with 501 until an LMS launch path exists?
4. Unratified rubrics: refuse projection (built), or allow it marked unratified?
5. Learners judging with their own key: allowed, recorded and raised in the queue (built), or reviewers only?
6. Relay-mediated signatures: refused (built). Verify the relay's delegation on the agent's pod in a later version?
7. Activity type: ADL `simulation` (built) or `performance`?
8. A scenario is one chain, so saving a draft of version n+1 stops learners starting the published version n until the draft is published. Should learners instead start the latest published version?
