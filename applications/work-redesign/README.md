# Work Redesign — decide which work moves to agents, price it honestly, and keep a record people hold

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** One specific use case among many possible. The Interego protocol does not depend on any of this; multiple alternative verticals could exist over the same substrate. Vocabulary in this document (`wrd:` namespace) is vertical-scoped, non-normative, and lives in [`ontology/wrd.ttl`](ontology/wrd.ttl).
>
> Status: Working Draft. Layer: application-over-L3. No L1/L2/L3 ontologies are extended.

## What it does

An operations lead maps how a team's work is actually done. They can capture it by hand, or paste an SOP and let their **own** AI agent draft a task map, where every claim cites a verbatim span that the platform checks. They review that draft in the same editable table before signing it.

Everyone named on a task ratifies or disputes its description with their own signature, through a link to that task. A disputed description is revised, and the revision carries the dispute it answers. Each task is then classified by how knowable its cause and effect is: Evident, Knowable, Emergent or Turbulent. The classification comes from seven evidence questions, and the people named on the task can ratify or dispute it. The regime decides what may change:

- Only Evident work may move to an agent acting within an earned grant.
- Knowable work is valued only when its classification was answered by an approver or by a person named on the task, or ratified by everyone named on it (expertise itself is not checked).
- Emergent work changes only through safe-to-fail probes, which are never priced.
- Turbulent work is stabilised first.

The operator proposes who does each task: a person, an agent, or both. They value the change with ranges. Every input says where it came from, and a seeded Monte Carlo gives P10, P50 and P90 for two figures:

- a cash figure, in which freed person-hours count only where the work is left unfilled;
- a figure in which freed hours are redeployed at their current cost.

An approver countersigns or declines. From none of their keys may the approver have proposed the plan, requested its valuation or submitted the decision; nor may they be a person whose work the decision changes, or the accountable principal of an agent it puts on the work. Approval re-checks everything submission checked. After the measurement window has actually ended, someone who neither prepared nor approved the decision records what happened. The platform grades that result against the predicted band, scaled for the declared ramp.

Agents earn a revocable grant on one registered kind of task only from runs that people reviewed and accepted. Anyone named in a record, or who signed one, can take a copy of every record about their work.

Every record is a signed Interego context descriptor on the operator's pod. The platform generates no text and invents no numbers. Every refusal is a typed HTTP refusal.

## How this differs

- **Classify the kind of work before choosing a method, and let the method change what is allowed.** A published decision table (`wrd:RuleR0` … `wrd:RuleR4`) places each task from signed evidence answers. These include whether a reviewer can check the output and how soon feedback arrives. The rules, the regime each one yields, each regime's method and its permitted levels are read from `wrd.ttl` at runtime. The conditions each rule tests are code (`classifyTask` in `src/work.ts`) that follows the rule's published `wrd:condition` text. The regime then limits the allocation levels. Allocation is refused until every task in the workflow is classified; answers that match no rule are refused (R0) rather than defaulted, and an unknown checkability or feedback speed keeps otherwise-Evident work at Knowable. An agent is put on a task only once everyone named on it has ratified its classification: their silence is not assent.
- **People and agents are one workforce, at levels we define.** The levels are: a person; a person with an agent assisting; an agent drafts and a person decides; an agent acts and a person audits; an agent acts within an earned grant. Every person and registered agent named on a task signs for its description. A person named to decide on or audit an agent's work can acknowledge that role or object to it, and an approver must name the objection to approve over it.
- **Ranges, not points, with the source of every number.** Every input is low / likely / high, with its basis: measured, from a document, reported by the performer, an estimate, or not applicable (zero, for a cost the state does not have). The result gives two figures side by side: cash, and with freed hours redeployed. It also shows freed person-hours with what happens to them, a cost breakdown, a sensitivity ranking that marks unmeasured estimates, and pilot size by the rule of three.
- **Predictions stay Hypothetical until an accountable person countersigns, and stay "approved; prediction unmeasured" until the world answers.** A measured outcome supersedes the countersigned record on the same graph. It is graded against the ramp-adjusted band, and an interval that straddles a band edge is inconclusive. Before-after measurements are labelled "no comparison group" wherever they appear.
- **The people described hold, ratify, dispute and revise their record.** A disputed description blocks changes to that task until it is revised and ratified again. Each person can copy every record about them to a pod they name, or download it. The copies keep the platform's original signature, and a download verifies offline (see **Sign and verify from a terminal**).
- **Grants are earned, scoped, revocable and for agents only, each with an accountable principal.** Earning a grant on one registered kind of task needs all of the following:
  - at least 20 person-reviewed runs on the agent's currently declared model, of which a person accepted at least 90%;
  - at least 5 distinct registered reviewers the admin attests are different people;
  - at least 20 runs the agent itself called ready, of which a person accepted at least 90%, with no critical failure among them.

  How often the agent's own label agreed with its reviewer is reported beside these, never in their place: an agent that truthfully calls most of its work reworked earns nothing. A run under a grant is accepted only on a task that an approved decision put at "agent acts within grant" for that agent, only while the task's current classification still permits it, and only when the agent calls the run ready itself. Revocation is a superseding Retracted record. Revocation and model changes are checked on every use, and work a decision put under a revoked grant is shown with no authorised performer until a new decision changes it. People are never given enforced grants.
- **Capture with cited evidence that the platform checks and never repairs, and with any assistance declared.** A quote that does not appear in the document is flagged `unverified`, never corrected. Capture from a document requires the signer to declare who drafted the map (a person, an agent, or "not declared"); manual capture records no drafting declaration, and neither declaration is verified.

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

The demo drives the bridge the way a Path-A agent does. It reads `/affordances?format=jsonld`, calls only the targets it declares, and signs each envelope with a persona key. Along the way it asserts every refusal, `R-A` to `R-AT`, with its status. Those refusals cover:

- allocation before classification, and an agent placed before its task's classification is ratified;
- a fabricated quote;
- a disputed description;
- self-countersigning from either of the submitter's keys, a proposer countersigning from their second key, and an agent's principal countersigning;
- a subject countersigning;
- approving over an assignment nobody acknowledged, without naming it;
- the approver grading the decision they approved;
- a replayed envelope;
- an outcome recorded before its window ends;
- an unearned grant, a grant to a person, and a grant to an agent whose own labels agreed with its reviewers every time but whose work a person accepted once in 20;
- a run under a grant that the agent itself calls reworked;
- every use of a revoked grant;
- an altered run envelope;
- a stale envelope;
- a holder copy to the platform pod;
- a tampered record.

The demo doubles the network (the pod), time, the people, and what those people report:

- **Time** is a clock that moves only when the walk calls `wrd.demo_advance_clock`, a demo-only affordance, so a nine-week window can pass.
- **The people** are persona keys derived from published seeds and held by the demo process.
- **The draft** is scripted, standing in for the client's own agent. The platform verifies it; it does not produce it.
- **The agents' runs** are scripted: their outputs are digests of fixed strings, and the walk chooses their self-assessments and the reviewers' verdicts.
- **The one measured outcome** is computed from the prediction itself (its P50 times the ramp factor), so it lands in band by construction.

Every record it writes carries `"demo": true` and a `wrd:demoRecord true` triple. The web UI shows "scripted by the offline demo, not evidence" on every row and calibration cell built on those records.

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
| `HOST` | Default `127.0.0.1`. The bridge holds a signing key and its reads are unauthenticated, so it never binds every interface unless told to. Bound to loopback, it answers only the Host names `127.0.0.1`, `localhost` and `[::1]` on `PORT` and the host of `BRIDGE_DEPLOYMENT_URL`. Any other Host is refused with 421, so a page that rebinds its own DNS name to 127.0.0.1 gets nothing. |
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

**Sign and verify from a terminal.** Two commands, run from the repository root. The first signs an envelope without a browser wallet; the second verifies a downloaded record without the bridge. Neither needs anything this repository does not already install.

To sign a payload with a local key, take a template from `wrd.envelope_template`, fill the paths its `fill` lists, and save it as `payload.json`. The key file holds one hex secp256k1 key. The template's `issuedAt` is the bridge's own clock, and its `nonce` is fresh. The command keeps both, and supplies them only when a payload lacks them.

```bash
npx tsx -e "(async () => {
  const { importWallet, signMessageRaw, canonicalJson } = await import('@interego/core');
  const { readFileSync } = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  const [keyFile, payloadFile] = process.argv.slice(1);
  const key = readFileSync(keyFile, 'utf8').trim();
  const signer = importWallet(key.startsWith('0x') ? key : '0x' + key, 'human', 'signer');
  const p = JSON.parse(readFileSync(payloadFile, 'utf8'));
  const payload = { ...p, issuedAt: p.issuedAt ?? new Date().toISOString(), nonce: p.nonce ?? randomUUID() };
  process.stdout.write(JSON.stringify({ payload, signature: await signMessageRaw(signer, canonicalJson(payload)) }) + '\n');
})()" ./my-key.hex ./payload.json > envelope.json

curl -X POST -H 'content-type: application/json' --data "{\"envelope\": $(cat envelope.json)}" http://127.0.0.1:6100/wrd/update_registry
```

To verify a downloaded record (the file **My record** saves, or a `wrd.holder_copy` response), name the platform address you expect. `wrd.list_records` reports it as `bridge.platform.address`, and the bridge prints it at startup. Each record's proof must verify, bind the graph bytes in the file, and come from that address. The command exits 1 if any record fails:

```bash
npx tsx -e "(async () => {
  const { readFileSync } = await import('node:fs');
  const { verifyHolderBundle } = await import('./applications/work-redesign/bridge/pod-helpers.ts');
  const [bundleFile, ...platform] = process.argv.slice(1);
  const out = await verifyHolderBundle(JSON.parse(readFileSync(bundleFile, 'utf8')), platform);
  for (const r of out.records) process.stdout.write((r.verified ? 'ok   ' : 'FAIL ') + (r.recordKind ?? '?') + ' ' + (r.status ?? '') + ' ' + r.descriptorUrl + (r.why ? ' — ' + r.why : '') + '\n');
  process.stdout.write((out.ok ? 'verified: ' : 'NOT verified: ') + (out.why ?? out.records.length + ' record(s)') + '\n');
  process.exitCode = out.ok ? 0 : 1;
})()" ./wrd-record.json 0x<platform address>
```

Both were run against the served demo. A registry change signed with the first command was accepted, and the same envelope sent again was refused (409). A 49-record download verified, failed in full against the wrong address, and failed on exactly the record whose graph had one value changed.

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
- **Decisions.** Submit, countersign or decline, approve over a silent assignment by naming it, record outcomes, see the version chain, and print a one-decision summary.
- Every signing form can show the exact payload it signs: its JSON Schema and a template filled from the pod, from `wrd.envelope_template`.
- **Calibration**, **Agents & grants**, and **My record** (copy to your pod, or download).
- A shareable task link, `/ui#task=<iri>`, for the people a task names.

To read another pod, add `?pod=<url>` to the address.

**Tests:**

```bash
npx vitest run applications/work-redesign/tests
```

There are three test modules:

- `engines.test.ts`: the pure engines.
- `bridge-lifecycle.test.ts`: the bridge over loopback HTTP, including a restarted bridge on the same pod refusing replays.
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
| `wrd.classify_task` | Answers the seven evidence questions for the task text it read (bound by `taskTextSha256`). The published rule places the regime, or places nothing. An agent named on the task answers as an agent, which is never expert evidence. | An operator, an approver, or a person or agent named on the task |
| `wrd.propose_allocation` | Proposes who does each task: valued changes, or a probe plan for Emergent work. | A registered operator |
| `wrd.value_plan` | Runs the seeded Monte Carlo valuation of a valued plan. Inputs that give no finite result are refused. | A registered operator |
| `wrd.submit_decision` | Submits a valued or probe decision, as a Hypothetical record. Refused while another approved decision on one of its tasks is unmeasured. | A registered operator |
| `wrd.countersign_decision` | Approves or declines a submitted decision. Approval re-checks what submission checked, and needs every assignment acknowledged or named as considered. | An approver who did not propose, value or submit it, is not a person it changes, and is not the principal of an agent it names |
| `wrd.record_outcome` | Records what was measured after the window, or which probe conditions fired. | An operator or approver who neither prepared nor approved the decision |
| `wrd.log_agent_run` | Logs an agent's run, with or without a person's review. A run under a grant is checked against the grant, the decision that put the task under it, and the task's current classification. | The agent signs the run; an operator or approver who is not its principal signs the review |
| `wrd.grant_autonomy` | Grants an agent autonomy on one kind of task, once earned. | An approver who is not the agent's principal |
| `wrd.revoke_grant` | Revokes a grant, bound to the version read. Work under it is shown with no authorised performer. | An approver |
| `wrd.holder_copy` | Copies every record that names you or carries your signature to a pod you name, or returns it for download. | The holder |
| `wrd.list_records` | The read model: registry, workflows, tasks, plans, valuations, decisions, grants, runs and integrity. | Nobody (GET) |
| `wrd.calibration` | Prediction cells, agent-run cells and probe signals. | Nobody (GET) |
| `wrd.envelope_template` | The JSON Schema of one intent's payload, and a template filled from the pod's current heads with the paths still to fill. Signs nothing and writes nothing. | Nobody (GET) |
| `wrd.demo_envelope` | **Offline demo only**, declared in `wrdDemoAffordances`. Signs a payload with a persona key the demo server holds. A production bridge neither advertises nor routes it. | — |
| `wrd.demo_advance_clock` | **Offline demo only**, declared in `wrdDemoAffordances`. Moves the demo's clock forward by whole weeks so a measurement window can pass. A production bridge neither advertises nor routes it. | — |

## Records and lifecycle

Each kind of record is one graph. Every change is a new descriptor that supersedes the previous head by its `descriptorUrl`. Every descriptor carries a content-bound authorship proof from the platform key. A version counts as current only if all three hold:

- it sits in `<pod>/wrd/records/`;
- its proof verifies against a platform key the bridge trusts;
- it sits at the URL its own proof names.

A current version whose graph bytes no longer match its proof is **altered**, and every lifecycle call that needs it answers 409.

```
Task            captured[H] ──every party ratifies──▶ ratified[A];  any dispute ──▶ disputed[H] ──revise──▶ captured[H];  retire ──▶ retired[Retracted]
                (a revision that removes someone named owes them a ratification: it stays captured until they ratify, and they can dispute it)
Classification  classified[H] ──every party ratifies──▶ ratified[A];  dispute (with own answers) ──▶ disputed[H] ──classify again──▶ …
Plan            proposed[H] (valued | probe; bound to the classifications and task texts it was checked against)
Valuation       valued[H] (same plan + inputs ⇒ same record)
Decision        submitted[H] ──approve──▶ countersigned[A, "approved; prediction unmeasured", in force] ──outcome──▶ measured[A]
                          └──decline──▶ declined[Counterfactual, prediction not to be measured]
AgentRun        reviewed[A];  or acted-under-grant[H] ──a person reviews later──▶ reviewed[A]
Grant           granted[A] ──revoke──▶ revoked[Retracted, valid from the grant to the revocation; work under it suspended] ──re-earned──▶ granted[A]
```

`[H]` is Hypothetical, `[A]` is Asserted. The modal status a descriptor carries must match the status in its signed payload.

**Envelope.** An envelope has the form `{payload, signature}`. The signature is EIP-191 `personal_sign` over `canonicalJson(payload)`. Every payload carries:

- `intent`;
- `podUrl`, which must equal the pod the call targets;
- `issuedAt`, accepted from 15 minutes before to 2 minutes after the bridge's clock;
- a `nonce`, refused if reused (see **Integrity and replay** below).

Identity is only the address recovered from the signature: no affordance takes a caller DID, key or seed. Payloads that change an existing record also bind the head they read, and are refused with 409 if it has moved on:

| Payloads | Bind |
|---|---|
| classify | the task description's `taskTextSha256` |
| ratify, revise | the head's `descriptorUrl` and `graphDigest` |
| countersign, outcome, revoke | the head's `recordId`, `descriptorUrl` and `graphDigest` |

**Payload shapes.** Each envelope affordance's description in the manifest summarises its payload in one line. `wrd.envelope_template` returns the full JSON Schema (draft 2020-12) and a template filled from the pod. A malformed payload is answered 400 with that schema as `expectedPayload`.

**Quote rule.** Normalise both the document and the quote: Unicode NFC, curly quotes made straight, any whitespace run collapsed to one space, then trimmed. Matching is case-sensitive, and a quote needs at least 12 characters. Offsets index the normalised document. A quote that does not match is `unverified` with a reason, and is never repaired.

**Valuation.** Each run makes 5000 independent triangular draws, which the record states. The result gives P10, P50 and P90 for the weekly change and for the NPV over the horizon (linear ramp, monthly discount), plus P(NPV > 0) and the payback month, for both figures. It also reports:

- freed person-hours per task and in total, with each task's disposition (redeployed, absorbed, unfilled, undecided);
- a cost breakdown at likely values: value, expected loss, person cost, oversight cost, agent cost;
- the value-to-cost ratio as a band;
- a one-at-a-time sensitivity ranking, with each input's basis;
- inputs counted by basis, single-number inputs flagged "no range given", and estimated agent costs set beside the costs agents reported on person-reviewed runs, labelled "agent-reported";
- pilot size.

The inputs it refuses (400, nothing recorded):

- any value above 10^12, and any inputs whose result is not a finite number;
- `measured` on a proposed state without a `source`: the proposed state has not run yet;
- `not-applicable` that is not 0 / 0 / 0, or outside a task's current or proposed state;
- zero oversight hours on a proposed state in which a person decides on or audits an agent's work.

Its stated assumptions:

- Inputs are independent; correlation is not modelled.
- Value per unit is unchanged by the change.
- The ramp is linear.
- Failure costs are expected costs: rate times cost per failure.
- Oversight is costed at the task's hourly cost.
- Freed hours count as cash only where the work stays unfilled.
- Estimates are unmeasured.

Percentiles do not add, so the UI never totals P50s across decisions.

**Outcome grading.** The measurement window must start at or after the countersign and must have ended. It must also be as long as the `windowWeeks` the decision declared: a shorter window is refused for a kept change, and for a reverted or stopped-early change is recorded as `windowShorterThanPlanned` and left out of calibration. The predicted band is scaled by the mean ramp factor over the window. With a measured interval, a result that straddles a band edge is inconclusive: it is excluded from calibration and counted. Every outcome records its disposition: kept, reverted or stopped-early. The pilot check counts the person-reviewed runs on the plan's agent-level tasks inside the window, against the pilot size.

**What is in force.** An approved valued decision is in force from its countersign, while it is measured. A kept outcome keeps it in force; a reverted or stopped-early outcome returns its tasks to their earlier allocation. Only one approved, unmeasured decision may change a task at a time: a second is refused at submission and at approval until the first has an outcome.

**Calibration.**

- Prediction cells are kept per metric × decision level × comparison class. They show coverage against the nominal 0.8, Brier score and mean level distance, and stay Hypothetical below 20 samples.
- Agent-run cells are kept per agent × kind of task × model.
- Probe signals are reported apart: a probe predicts nothing.

**Grant policy.** The defaults are published in `wrd.ttl` (`wrd:defaultGrantPolicy`):

- 20 person-reviewed runs on the declared model, of which a person accepted at least 90% (`wrd:floor`, applied by the judgment kit's earned-autonomy rule to acceptance outcomes);
- at least 5 person confirmations from at least 5 distinct registered reviewers the admin attests are different people. **This bridge cannot verify that they are different people.**
- at least 20 runs the agent called ready, of which a person accepted at least 90%, with no critical failure among them;
- for critical work, ⌈3 / 0.01⌉ = 300 clean runs.

The calibration view's agent cells show both the share a person accepted and how often the agent's own label matched the reviewer's (`hitRate`).

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
- **Expert evidence for Knowable work is who answered, not a label on an input.** It is classification answers from an approver or from a person named on the task, or a classification everyone named on it ratified. A classifier named on the task answers as `performer` (a person) or `agent`; one who is not, as `approver` if they hold that role. In the demo, Ana is an operator and an approver who is not named on the tasks she classifies, so her classifications record `answeredBy.role: approver`.
- **Separation of duties compares person references.** Whoever proposed, valued or submitted a decision, the people it changes, and the principals of agents it names cannot approve it. Whoever prepared or approved it cannot grade it.

**Access and storage**

- **Reads are not scoped in v1.** `wrd.list_records` and `wrd.calibration` are unauthenticated GETs: anyone who can reach the bridge reads every record on the pod, including dispute notes and addresses. The UI says so on every screen. `HOST` defaults to loopback, and document text is stored only when the operator opts in. On loopback, and always in the demo, a request whose Host header is not one of the bridge's own names is refused (421) before any route except the shared `/health`, which returns only the status and build. A bridge bound to another interface does not check Host: put it behind a proxy that does.
- **The bridge writes to the pod with plain HTTP and no pod credentials.** Use a pod, or a container on it, that accepts the bridge's writes. Pods on loopback or private addresses are refused by the SSRF guard. Holder copies likewise need a pod that accepts the bridge's writes; otherwise use the download. Copies are plaintext: encrypted copies are out of scope.

**Integrity and replay**

- **Replay protection reads the pod.** Every record version stores the signer and nonce of the envelope that authorised it, and a write is refused (409) when the graph's chain already holds that pair, so it holds after a restart. Writes that start a graph mint an IRI from the nonce, or one unique to their subject, so a replay finds the graph already there. An in-process ledger, bounded to 100 000 entries and claimed only for registered keys and admins, refuses repeats before any read. Supersede is serialised per graph within one process; two bridge processes on one pod can still race between read and write.
- **A party with write access to the pod can still delete records, or overwrite a genuine descriptor in place.** Descriptors that are unsigned, foreign, replayed to another URL, or holder copies are all ignored. Edits that change a record's bytes or its modal status are detected and answered 409. Other facet edits are not covered by the platform's proof.
- **An ephemeral platform key makes earlier records untrusted after a restart.** Set `WRD_PLATFORM_KEY`. A bridge with a new key starts new chains, and the registry records `replacedUntrusted: true`.

**What the platform records**

- **Measured outcomes and probe signals are entered and signed by a person, not instrumented.** Agent outputs are referenced by digest only.
- **Agent run costs are what the agent reports.** They are counted only on runs a person reviewed, and are labelled "agent-reported on person-reviewed runs". Nothing meters them.
- **Freed-hours dispositions live on the valuation inputs**, because the cash figure is computed from them. The decision binds the valuation hash and shows them.
- **Probe decisions bind no valuation and carry no prediction.** They are still submitted, countersigned under the same separation rules, and read as amplify, dampen or neither.
- **A disputed classification blocks changes to that task only**, not plans that leave it unchanged.
- **Kinds of task are declared by an admin in the registry**, like every other registry change.

**Interface and demo**

- **Affordances beyond the original list.** `wrd.log_agent_run` exists because a grant has to be earned from real reviewed runs. `wrd.revise_task` exists because a dispute needs a way to be answered. `wrd.envelope_template` exists because a Path-A agent must be able to discover what to sign. `wrd.demo_envelope` and `wrd.demo_advance_clock` are demo only. The registry affordance is `wrd.update_registry`.
- **Every lifecycle path is exercised against the in-memory pod, not a real Solid server.** The production composition (`bridge/server.ts`) has been started, and its health, manifest and UI read. A real deployment needs a pod that accepts the bridge's writes without credentials (a credentialled fetch is not built), a stable `WRD_PLATFORM_KEY`, and admin addresses. The admin can sign with the terminal command above instead of a browser wallet.
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
- No interviews. Capture is by hand or from a document's text; the UI loads `.txt` or `.md` files, and nothing extracts text from PDF, Word or spreadsheets.
- No generated options. People propose allocations; the platform checks, values and records them.
- No withdrawing a submitted decision. An approver declines it, and the operator proposes a new plan.
- No correlated-failure stress test. Inputs are drawn independently.
