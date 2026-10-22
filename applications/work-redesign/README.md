# Work Redesign — decide which work moves to agents, price it honestly, and keep a record people hold

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** One specific use case among many possible. The Interego protocol does not depend on any of this; multiple alternative verticals could exist over the same substrate. Vocabulary in this document (`wrd:` namespace) is vertical-scoped, non-normative, and lives in [`ontology/wrd.ttl`](ontology/wrd.ttl).
>
> Status: Working Draft. Layer: application-over-L3. No L1/L2/L3 ontologies are extended.

## What it does

An operations lead maps how a team's work is actually done. They can capture it by hand, or paste an SOP and let their **own** AI agent draft a task map, where every claim cites a verbatim span that the platform checks. They review that draft in the same editable table before signing it.

Everyone named on a task ratifies or disputes its description with their own signature, through a link to that task. A disputed description is revised, and the revision carries the dispute it answers. Each task is then classified by how knowable its cause and effect is: Evident, Knowable, Emergent or Turbulent. The classification comes from seven evidence questions, and the people named on the task can ratify or dispute it. The regime decides what may change:

- Only Evident work may move to an agent acting within an earned grant.
- Knowable work is valued only with expert evidence.
- Emergent work changes only through safe-to-fail probes, which are never priced.
- Turbulent work is stabilised first.

The operator proposes who does each task: a person, an agent, or both. They value the change with ranges. Every input says where it came from, and a seeded Monte Carlo gives P10, P50 and P90 for two figures:

- a cash figure, in which freed person-hours count only where the work is left unfilled;
- a figure in which freed hours are redeployed at their current cost.

An approver countersigns or declines. The approver must not be the submitter, from any of their keys, and must not be a person whose work the decision changes. After the measurement window has actually ended, someone other than the submitter records what happened. The platform grades that result against the predicted band, scaled for the declared ramp.

Agents earn a revocable grant on one registered kind of task only from runs that people reviewed. Anyone named in a record, or who signed one, can take a copy of every record about their work.

Every record is a signed Interego context descriptor on the operator's pod. The platform generates no text and invents no numbers. Every refusal is a typed HTTP refusal.

## How this differs

- **Classify the kind of work before choosing a method, and let the method change what is allowed.** A published decision table (`wrd:RuleR0` … `wrd:RuleR4`, read from `wrd.ttl` at runtime) places each task from signed evidence answers. These include whether a reviewer can check the output and how soon feedback arrives. The regime then limits the allocation levels. Allocation is refused until every task in the workflow is classified, and a "don't know" answer never defaults to a regime.
- **People and agents are one workforce, at levels we define.** The levels are: a person; a person with an agent assisting; an agent drafts and a person decides; an agent acts and a person audits; an agent acts within an earned grant. Every person and registered agent named on a task signs for its description. A person named to decide on or audit an agent's work can acknowledge that role or object to it, and an approver must name the objection to approve over it.
- **Ranges, not points, with the source of every number.** Every input is low / likely / high, with its basis: measured, from a document, reported by the performer, or an estimate. The result gives two figures side by side: cash, and with freed hours redeployed. It also shows freed person-hours with what happens to them, a cost breakdown, a sensitivity ranking that marks unmeasured estimates, and pilot size by the rule of three.
- **Predictions stay Hypothetical until an accountable person countersigns, and stay "approved; prediction unmeasured" until the world answers.** A measured outcome supersedes the countersigned record on the same graph. It is graded against the ramp-adjusted band, and an interval that straddles a band edge is inconclusive. Before-after measurements are labelled "no comparison group" wherever they appear.
- **The people described hold, ratify, dispute and revise their record.** A disputed description blocks changes to that task until it is revised and ratified again. Each person can copy every record about them to a pod they name, or download it. The copies keep the platform's original signature, so they still verify.
- **Grants are earned, scoped, revocable and for agents only, each with an accountable principal.** Earning a grant on one registered kind of task needs all of the following:
  - person-reviewed runs on the agent's currently declared model;
  - a rating of 0.9 over at least 20 runs;
  - at least 5 distinct registered reviewers the admin attests are different people;
  - ready-claim precision of at least 0.9.

  Revocation is a superseding Retracted record. Revocation and model changes are checked on every use. People are never given enforced grants.
- **Capture with cited evidence that the platform checks and never repairs, and with any assistance declared.** A quote that does not appear in the document is flagged `unverified`, never corrected. The draft says who drafted it, or the record says "not declared".

## Built on

- **Cynefin** (Snowden; Cognitive Edge): the four regimes, and safe-to-fail probes with amplify and dampen conditions. The regimes are `skos:closeMatch` to `agp:Evident` … `agp:Turbulent`.
- **The rule of three** (Hanley & Lippman-Hand): pilot sizing. Zero critical failures in ⌈3 / ceiling⌉ runs bounds the rate below the ceiling at 95%, one-sided.
- **xoshiro128\*\*** (Blackman & Vigna): the seeded generator. The seed is `sha256(canonicalJson({planIri, inputs}))`, so the same plan and inputs give the same bands and the same record.
- **Triangular three-point estimates**, and NPV with a linear ramp and a monthly discount rate.
- **Interego's judgment kit** (`applications/_shared/judgment-kit/loop.ts`): calibration, attestation, reputation and the earned-autonomy rule.

## When not to use this

- Work with no signal anyone can measure. The tool refuses to value it; use probes instead.
- One-off decisions that will not recur. Calibration and grants need repetition.
- Changes nobody will measure. The record would stay "approved; prediction unmeasured" forever, and the tool will say so.

## Run it

**The offline demo** walks the whole lifecycle against an in-memory pod. It runs deterministically and needs no network:

```bash
npx tsx applications/work-redesign/demo/run.ts            # prints every step; writes demos/output/wrd-<time>.md (gitignored)
npx tsx applications/work-redesign/demo/run.ts --serve    # then keeps the bridge and web UI up at http://127.0.0.1:6100/ui
npx tsx applications/work-redesign/demo/run.ts --serve --port=6197
```

The demo drives the bridge the way a Path-A agent does. It reads `/affordances?format=jsonld`, calls only the targets it declares, and signs each envelope with a persona key. Along the way it asserts every refusal, `R-A` to `R-AM`, with its status. Those refusals cover:

- allocation before classification;
- a fabricated quote;
- a disputed description;
- self-countersigning from either of the submitter's keys;
- a subject countersigning;
- a replayed envelope;
- an outcome recorded before its window ends;
- an unearned grant, and a grant to a person;
- every use of a revoked grant;
- an altered run envelope;
- a stale envelope;
- a holder copy to the platform pod;
- a tampered record.

The demo's doubles cover only the network (the pod), time (a clock the walk moves, so a nine-week window can pass) and the people. The people are persona keys derived from published seeds, and a scripted draft stands in for the client's own agent. Every record it writes carries `"demo": true` and a `wrd:demoRecord true` triple. The web UI shows "scripted by the offline demo, not evidence" on every row and calibration cell built on those records.

**The bridge:**

```bash
WRD_DEFAULT_POD_URL=https://pod.example/team/ \
WRD_PLATFORM_KEY=0x<64 hex> \
WRD_ADMIN_ADDRESSES=0x<admin address> \
npx tsx applications/work-redesign/bridge/server.ts
```

| Variable | Meaning |
|---|---|
| `PORT` | Default `6100`. |
| `HOST` | Default `127.0.0.1`. The bridge holds a signing key and its reads are unauthenticated, so it never binds every interface unless told to. |
| `BRIDGE_DEPLOYMENT_URL` | The public base URL. Default `http://127.0.0.1:<PORT>`. |
| `WRD_DEFAULT_POD_URL` | The pod used when a call names none. It must be a public http(s) host: the SSRF guard refuses loopback and private addresses. |
| `WRD_PLATFORM_KEY` | The hex secp256k1 key the bridge signs records with. Without it the bridge generates an **ephemeral** key and says so at startup. Records written under that key are not trusted after a restart. |
| `WRD_ADMIN_ADDRESSES` | Comma list of the addresses that may change the role registry. With none, every registry change is refused. |
| `WRD_TRUSTED_PLATFORM_ADDRESSES` | Comma list of earlier platform keys whose records stay trusted, for key rotation. |

The bridge serves:

- the affordance manifest at `/affordances`, as Turtle, JSON-LD or HMD;
- MCP at `/mcp`;
- the vocabulary at `/ns/wrd` and `/ns/wrd/shapes`;
- the web UI at `/ui`, also linked from the entry point as "Web UI".

**The web UI** (`/ui`) is a plain client over the affordance manifest. It needs no build step and adds no endpoint of its own. A strict Content-Security-Policy applies: no inline script or style, and untrusted text is rendered as text nodes only. It signs in one of three modes, and always shows which one:

1. **Your wallet.** When the browser has an EIP-191 wallet, the page signs with `personal_sign` over `canonicalJson(payload)`. An admin must first add your address to the pod's registry.
2. **Demo keys.** Only on the offline demo server. A red banner says the keys are held by that server and these are not signatures by real people.
3. **Read only.** Otherwise, with a sentence saying why.

The views are:

- **Tasks.** Ratify, dispute, revise, retire, add and classify tasks, and copy the link for the people named.
- **Roles.** The registry, kinds of task and pod policy.
- **Capture.** By hand, or from a document: a drafting packet for your own agent, the draft pasted into the editable table, and a quote preview in the browser.
- **Plan.** Disabled until every task is classified. Levels are limited by regime and grant, and Emergent tasks get a probe editor.
- **Value.** Ranges with a basis for each input. Unsigned drafts are kept in the browser.
- **Decisions.** Submit, countersign or decline, record outcomes, see the version chain, and print a one-decision summary.
- **Calibration**, **Agents & grants**, and **My record** (copy to your pod, or download).
- A shareable task link, `/ui#task=<iri>`, for the people a task names.

To read another pod, add `?pod=<url>` to the address.

**Tests:**

```bash
npx vitest run applications/work-redesign/tests
```

There are three test modules:

- `engines.test.ts`: the pure engines.
- `bridge-lifecycle.test.ts`: the bridge over loopback HTTP.
- `demo-and-ui.test.ts`: the whole demo walk, the UI's headers and inert shell, and a check that the UI calls only declared tools and reaches every one of them.

## Affordances

| Tool | What it does | Who signs |
|---|---|---|
| `wrd.update_registry` | Sets roles (approver, operator, worker, agent), each key's person reference, agents' principals and declared models, kinds of task, and the pod policy, which can only tighten the published policy. | An admin address configured on the bridge |
| `wrd.task_map_packet` | Returns instructions and the document for your own agent to draft a task map. It samples nothing and writes nothing. | Nobody (read-only) |
| `wrd.record_task_map` | Records a drafted task map. Every quote is checked against the document; a map with no verified quote is refused. | A registered operator or agent |
| `wrd.capture_workflow` | Records a workflow captured by hand. | A registered operator or agent |
| `wrd.revise_task` | Revises, adds or retires a task. A revision carries the disputes it answers. | An operator, or (to revise) someone named on the task |
| `wrd.ratify_task` | Ratifies or disputes a task's description or classification, or acknowledges or objects to an assignment in a plan. | The person or agent named |
| `wrd.classify_task` | Answers the seven evidence questions. The published rule places the regime, or places nothing. | An operator, an approver, or someone named on the task |
| `wrd.propose_allocation` | Proposes who does each task: valued changes, or a probe plan for Emergent work. | A registered operator |
| `wrd.value_plan` | Runs the seeded Monte Carlo valuation of a valued plan. | A registered operator |
| `wrd.submit_decision` | Submits a valued or probe decision, as a Hypothetical record. | A registered operator |
| `wrd.countersign_decision` | Approves or declines a submitted decision. | An approver who is neither the submitter nor a person the decision changes |
| `wrd.record_outcome` | Records what was measured after the window, or which probe conditions fired. | An operator or approver who is not the submitter |
| `wrd.log_agent_run` | Logs an agent's run, with or without a person's review. | The agent signs the run; an operator or approver who is not its principal signs the review |
| `wrd.grant_autonomy` | Grants an agent autonomy on one kind of task, once earned. | An approver who is not the agent's principal |
| `wrd.revoke_grant` | Revokes a grant. | An approver |
| `wrd.holder_copy` | Copies every record that names you or carries your signature to a pod you name, or returns it for download. | The holder |
| `wrd.list_records` | The read model: registry, workflows, tasks, plans, valuations, decisions, grants, runs and integrity. | Nobody (GET) |
| `wrd.calibration` | Prediction cells, agent-run cells and probe signals. | Nobody (GET) |
| `wrd.demo_envelope` | **Offline demo only**, declared in `wrdDemoAffordances`. Signs a payload with a persona key the demo server holds. A production bridge neither advertises nor routes it. | — |

## Records and lifecycle

Each kind of record is one graph. Every change is a new descriptor that supersedes the previous head by its `descriptorUrl`. Every descriptor carries a content-bound authorship proof from the platform key. A version counts as current only if all three hold:

- it sits in `<pod>/wrd/records/`;
- its proof verifies against a platform key the bridge trusts;
- it sits at the URL its own proof names.

A current version whose graph bytes no longer match its proof is **altered**, and every lifecycle call that needs it answers 409.

```
Task            captured[H] ──every party ratifies──▶ ratified[A];  any dispute ──▶ disputed[H] ──revise──▶ captured[H];  retire ──▶ retired[Retracted]
Classification  classified[H] ──every party ratifies──▶ ratified[A];  dispute (with own answers) ──▶ disputed[H] ──classify again──▶ …
Plan            proposed[H] (valued | probe; bound to the classifications and task texts it was checked against)
Valuation       valued[H] (same plan + inputs ⇒ same record)
Decision        submitted[H] ──approve──▶ countersigned[A, "approved; prediction unmeasured"] ──outcome──▶ measured[A]
                          └──decline──▶ declined[Counterfactual, prediction not to be measured]
AgentRun        reviewed[A];  or acted-under-grant[H] ──a person reviews later──▶ reviewed[A]
Grant           granted[A] ──revoke──▶ revoked[Retracted, valid from the grant to the revocation] ──re-earned──▶ granted[A]
```

`[H]` is Hypothetical, `[A]` is Asserted. The modal status a descriptor carries must match the status in its signed payload.

**Envelope.** An envelope has the form `{payload, signature}`. The signature is EIP-191 `personal_sign` over `canonicalJson(payload)`. Every payload carries:

- `intent`;
- `podUrl`, which must equal the pod the call targets;
- `issuedAt`, accepted from 15 minutes before to 2 minutes after the bridge's clock;
- a `nonce`, refused if reused.

Identity is only the address recovered from the signature: no affordance takes a caller DID, key or seed. Payloads that change an existing record also bind the head they read, and are refused with 409 if it has moved on:

| Payloads | Bind the head's |
|---|---|
| ratify, revise | `descriptorUrl` and `graphDigest` |
| countersign, outcome | `recordId`, `descriptorUrl` and `graphDigest` |
| revoke | `recordId` and `descriptorUrl` |

**Quote rule.** Normalise both the document and the quote: Unicode NFC, curly quotes made straight, any whitespace run collapsed to one space, then trimmed. Matching is case-sensitive, and a quote needs at least 12 characters. Offsets index the normalised document. A quote that does not match is `unverified` with a reason, and is never repaired.

**Valuation.** Each run makes 5000 independent triangular draws, which the record states. The result gives P10, P50 and P90 for the weekly change and for the NPV over the horizon (linear ramp, monthly discount), plus P(NPV > 0) and the payback month, for both figures. It also reports:

- freed person-hours per task and in total, with each task's disposition (redeployed, absorbed, unfilled, undecided);
- a cost breakdown at likely values: value, expected loss, person cost, oversight cost, agent cost;
- the value-to-cost ratio as a band;
- a one-at-a-time sensitivity ranking, with each input's basis;
- inputs counted by basis, single-number inputs flagged "no range given", and estimated agent costs set beside measured run costs;
- pilot size.

Its stated assumptions:

- Inputs are independent; correlation is not modelled.
- Value per unit is unchanged by the change.
- The ramp is linear.
- Failure costs are expected costs: rate times cost per failure.
- Oversight is costed at the task's hourly cost.
- Freed hours count as cash only where the work stays unfilled.
- Estimates are unmeasured.

Percentiles do not add, so the UI never totals P50s across decisions.

**Outcome grading.** The measurement window must start at or after the countersign and must have ended. The predicted band is scaled by the mean ramp factor over the window. With a measured interval, a result that straddles a band edge is inconclusive: it is excluded from calibration and counted. Every outcome records its disposition: kept, reverted or stopped-early. Only a kept valued decision changes a task's effective allocation.

**Calibration.**

- Prediction cells are kept per metric × decision level × comparison class. They show coverage against the nominal 0.8, Brier score and mean level distance, and stay Hypothetical below 20 samples.
- Agent-run cells are kept per agent × kind of task × model.
- Probe signals are reported apart: a probe predicts nothing.

**Grant policy.** The defaults are published in `wrd.ttl` (`wrd:defaultGrantPolicy`):

- 20 person-reviewed runs on the declared model;
- a rating of at least 0.9;
- at least 5 person confirmations from at least 5 distinct registered reviewers the admin attests are different people. **This bridge cannot verify that they are different people.**
- ready-claim precision of at least 0.9, with no critical failure among the agent's ready claims;
- for critical work, ⌈3 / 0.01⌉ = 300 clean runs.

A pod policy may only tighten these.

## Projections

None are built in v1. An xAPI statement per agent run or decision event would lose:

- the modal status (Hypothetical, Asserted, Counterfactual, Retracted);
- the supersedes chain;
- quote offsets and verdicts;
- the input bases;
- the signed envelopes.

A task may cite an external task term (`externalTaskTerm`, for example an O\*NET task statement, CC BY 4.0) beside its local kind of task.

## Deviations and honest limits

**People and signatures**

- **People are told apart by an admin attestation, not by the bridge.** Separation of duties and "distinct reviewers" compare the person reference an admin declares for each key. One person may hold several keys. The bridge cannot verify that two person references are two people, and every report says so.
- **Workers need an EIP-191 wallet** to ratify, dispute, acknowledge or take a copy. Passkey and did:key signing are not built. There is deliberately no unsigned "claim this task by link".
- **A classifier who holds the approver role answers as an approver**, so their answers count as expert evidence for Knowable work. In the demo, Ana is an operator and an approver, so her classifications record `answeredBy.role: approver`.

**Access and storage**

- **Reads are not scoped in v1.** `wrd.list_records` and `wrd.calibration` are unauthenticated GETs: anyone who can reach the bridge reads every record on the pod, including dispute notes and addresses. The UI says so on every screen. `HOST` defaults to loopback, and document text is stored only when the operator opts in.
- **The bridge writes to the pod with plain HTTP and no pod credentials.** Use a pod, or a container on it, that accepts the bridge's writes. Pods on loopback or private addresses are refused by the SSRF guard. Holder copies likewise need a pod that accepts the bridge's writes; otherwise use the download. Copies are plaintext: encrypted copies are out of scope.

**Integrity and replay**

- **Replay protection is an in-process nonce ledger, plus the freshness window, plus lifecycle state.** A restart inside the window could accept a replayed non-lifecycle envelope, such as a classification, whose effect is a duplicate superseding record. Supersede is serialised per graph within one process; two bridge processes on one pod can still race between read and write.
- **A party with write access to the pod can still delete records, or overwrite a genuine descriptor in place.** Descriptors that are unsigned, foreign, replayed to another URL, or holder copies are all ignored. Edits that change a record's bytes or its modal status are detected and answered 409. Other facet edits are not covered by the platform's proof.
- **An ephemeral platform key makes earlier records untrusted after a restart.** Set `WRD_PLATFORM_KEY`. A bridge with a new key starts new chains, and the registry records `replacedUntrusted: true`.

**What the platform records**

- **Measured outcomes and probe signals are entered and signed by a person, not instrumented.** Agent outputs are referenced by digest only.
- **Freed-hours dispositions live on the valuation inputs**, because the cash figure is computed from them. The decision binds the valuation hash and shows them.
- **Probe decisions bind no valuation and carry no prediction.** They are still submitted, countersigned under the same separation rules, and read as amplify, dampen or neither.
- **A disputed classification blocks changes to that task only**, not plans that leave it unchanged.
- **Kinds of task are declared by an admin in the registry**, like every other registry change.

**Interface and demo**

- **Affordances beyond the original list.** `wrd.log_agent_run` exists because a grant has to be earned from real reviewed runs. `wrd.revise_task` exists because a dispute needs a way to be answered. `wrd.demo_envelope` is demo only. The registry affordance is `wrd.update_registry`.
- **The bridge's answers carry more than the minimum.** `wrd.list_records` also returns `records`, `integrity` (per altered or forked graph, its heads and why) and `orphaned` on tasks. Unexpected failures answer 500, not the shared bridge's default 400.
- **The document-capture quote preview runs in the browser**, by a port of the published rule. The platform's check when you sign is the one that counts.
- **In the demo UI, a run logged from the page states `performedAt` as the newest record time on the pod.** That is the demo server's scripted clock, not the browser's. In wallet mode the run envelope is signed by the agent's own key and pasted in.
- **The wallet signing path in the UI was not exercised against a real wallet extension in this build.** The demo-key path was driven in headless Chromium: every view, a signed registry change, a refusal shown in the page, the task link and a record download. The canonical-JSON port follows `@interego/core`'s algorithm; the bridge verifies whatever arrives.

## What v1 does not do

- No text generation of any kind. Drafting is the client's own agent, through the packet.
- No HRIS or LMS import.
- No LRS projection.
- No cross-organisation aggregates.
- No encrypted copies.
- No read scoping.
- No passkey or did:key signing.
