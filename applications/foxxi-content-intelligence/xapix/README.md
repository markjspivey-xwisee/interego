# xapi-x

A superset of xAPI made by decoration, the way [I2IDL-X](../i2idlx/README.md) is a superset of the I2IDL glossary. The design, the code that carries it out, and the decisions taken on it. The lrs-adapter writes the provenance and supersession decorations, the profile is at version 2, and the rules of section 7 are a lint. What is still only designed is listed under "Left to do".

> **Status: part of the Foxxi vertical. Non-normative, not part of the Interego protocol.** xapi-x adds no term to `iep:` or to any other Interego namespace, and it uses no other publisher's verbs, extensions or IRIs. Its own terms are in `xapix:`, declared in [xapix.ttl](xapix.ttl).

## The rule everything else follows

Every xapi-x statement is a valid xAPI 2.0 statement. Every xapi-x profile is a valid xAPI Profiles 1.0 document. A plain LRS stores an xapi-x statement and a plain profile processor reads an xapi-x profile; each loses only the decorations. Nothing in either standard is redefined.

That leaves three places a decoration can go, and xapi-x uses only these:

| Where | What the standard says about it | What xapi-x puts there |
|---|---|---|
| A statement's `context.extensions` and `result.extensions` | A map from IRI to any JSON value. An LRS stores it and does not interpret it. | Provenance, modal status, supersession, a link to controls, ordering. |
| A statement's `context.contextActivities.category` | Activities that tag the statement. A template can select on their type. | One marker: this statement is a projection. |
| A property on a profile's concept or template whose key is an absolute IRI | Profiles 1.0, section 4: a property the specification does not describe must be written as a compact or absolute IRI. A processor that does not know it ignores it. | What design idea a concept evidences; what a template offers next. |

A decoration never changes what a standard member means. `verb`, `object`, `result.success`, `timestamp`, `stored`, voiding: all are read exactly as xAPI reads them.

## Where it lives, and why

- **Layer: vertical (application over L3), under Foxxi**, at `applications/foxxi-content-intelligence/xapix/` with code in `src/xapix/`. The transplant test in `spec/LAYERS.md` settles the layer: every claim here names xAPI, so none of it survives being moved to another stack, and none of it is L1 or L2. It sits under Foxxi because i2idl-x does, because the profile processor it is checked with is Foxxi's (`src/xapi-profile-server/processor.ts`), and because section 4 links profiles to i2idl-x concepts. Other verticals (lrs-adapter, coached-world, llm-telemetry, agp) use it the way coached-world's tests already use Foxxi's processor: by import, with no protocol change.
- **Namespace: `xapix:` = `https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/xapix#`.** The same root as `i2x:`, so it is published the same way: a signed graph on the owner's pod, dereferenced by the relay. It is outside every protocol namespace. **It is published** (2026-11-15, public, authorship signed by the relay) and resolves as Turtle and JSON-LD:

  | Graph | IRI | Triples |
  |---|---|---|
  | Ontology | `https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/xapix` | 58 |
  | Profile | `https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/xapix-profile` | 51 |

  The profile's version (`…/xapix-profile/v/1`) and its template (`…/xapix-profile/templates/descriptor-projection`) are subjects in the profile graph and resolve to it. Both graphs were fetched back and compared triple for triple with `xapix.ttl` and with what `src/xapix/publication.ts` returns. A public graph cannot be unpublished; a change is a new publish that supersedes this one.
- **Ontology: [xapix.ttl](xapix.ttl)**, 15 terms, every one with a label and a comment. `src/xapix/namespace.ts` lists the same 15 and a test fails when the two differ. The repository's ontology lint does not check a vertical's own prefix, so that test is the only thing that would notice an undeclared `xapix:` term.

### What is in code now

| File | What it is |
|---|---|
| `src/xapix/namespace.ts` | The namespace, the profile's IRI, the four `iep:` keys, the 15 term names. |
| `xapix/xapix.ttl` | The ontology. |
| `src/xapix/profile.ts` | The xapi-x profile. Version 2 (current): eleven concepts and a template that selects on the `xapix:Projection` category. Version 1, as first published, is still built by `buildXapixProfileDocV1`. |
| `src/xapix/statement.ts` | What an emitter calls: the projection category, a content digest, supersession, RFC 8785 canonical JSON, a statement's digest, a chain, and `orderBasis`, which says what stands behind an order. |
| `src/xapix/lint.ts` | Rules X1 to X10 as code, with the profile lint's finding shape. |
| `src/xapix/publication.ts` | The profile as the triples that are published, from the same function the profile server reads a profile with. |
| `applications/lrs-adapter/src/projection-statement.ts` | The statement the adapter posts, as a function of its own. It writes the four keys, the projection category, and the digest and supersession when its caller states them. |
| `tests/an-lrs-adapter-statement-follows-the-xapi-x-profile.test.ts` | Runs the adapter's own builder through the specification's `validates` against the profile. |
| `tests/the-xapi-x-namespace-is-declared.test.ts` | Namespace file and ontology agree; the four keys are declared in `docs/ns/iep.ttl`. |
| `tests/xapi-x-decorations-are-emitted-ordered-and-linted.test.ts` | The chain and its basis, and each lint rule with a statement or profile that breaks it. |

| Decoration | Written by | Judged by |
|---|---|---|
| `xapix:Projection` category | lrs-adapter | profile template (determining property) |
| `descriptorDigest` | lrs-adapter, when its caller holds the descriptor's bytes | lint (form) |
| `supersedesStatement`, `context.statement` | lrs-adapter, from its caller | lint X7 |
| `previous`, `previousDigest` | no emitter; `chained()` builds them | `orderBasis`, lint |
| `orderAttestation`, `controls` | nothing | profile declares them; `orderBasis` takes an attestation its reader verified |
| `evidences`, `offers` | no profile yet | lint X9 |

In the examples below, `IEP#` stands for `https://markjspivey-xwisee.github.io/interego/ns/iep#` and `XAPIX#` for the `xapix:` namespace. A real statement writes the full IRI. Every name, address and identifier is made up.

## 1. Provenance: what a statement is a projection of

**What exists.** The lrs-adapter writes up to four keys under `result.extensions`. All four are `iep:` terms declared in `docs/ns/iep.ttl`. No profile declared them until this slice.

| Key | Value | Written when |
|---|---|---|
| `IEP#sourceDescriptor` | IRI of the signed descriptor | always |
| `IEP#modalStatus` | `"Asserted"`, `"Hypothetical"`, `"Counterfactual"` or `"Quoted"` | always (defaults to `"Asserted"`) |
| `IEP#coherentNarratives` | array of strings | the source holds more than one reading |
| `IEP#projectionLossy` | `true` or `false` | always, since 2026-11-15; before that, only `true` and only with several readings |

**Decision: keep them exactly as they are.** Same IRIs, same place. Statements carrying them are already in other people's stores (the adapter's tests round-trip them through two real LRS products), and a key that is renamed is a key those statements no longer have. xapi-x mints no second name; the profile declares the existing IRIs as `ResultExtension` concepts. The specification allows a concept whose IRI is outside the profile's own.

**What xapi-x adds.** The lrs-adapter writes the category on every projection. It writes the digest only when its caller states it, because it is given the descriptor's IRI and not its bytes.

- `xapix:Projection`: the activity type of a category the statement carries. It lets a template select projections and only projections (section 7).
- `xapix:descriptorDigest`: `"sha256:…"` of the descriptor. `sourceDescriptor` is a pointer; with the digest it can be checked. A descriptor fetched from that IRI that hashes differently is not the one this statement came from.

**The descriptor is the record. The statement is a view.** A consumer that needs to trust the statement fetches the descriptor and verifies its signature. xapi-x does not sign statements.

```json
{
  "id": "6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c",
  "actor": { "account": { "homePage": "https://example.org", "name": "fictional-learner" } },
  "verb": { "id": "https://example.org/verbs/made-up-verb", "display": { "en-US": "made-up-verb" } },
  "object": { "objectType": "Activity", "id": "https://example.org/activities/made-up-activity" },
  "result": {
    "response": "A made-up first reading.",
    "extensions": {
      "IEP#sourceDescriptor": "https://pod.example/fictional-learner/context-graphs/1790000000000.ttl",
      "IEP#modalStatus": "Asserted",
      "IEP#coherentNarratives": ["A made-up first reading.", "A made-up second reading."],
      "IEP#projectionLossy": true
    }
  },
  "context": {
    "contextActivities": { "category": [{ "id": "XAPIX#Projection", "definition": { "type": "XAPIX#Projection" } }] },
    "extensions": { "XAPIX#descriptorDigest": "sha256:0f3a…(64 hex)" }
  },
  "timestamp": "2026-11-15T12:00:00.000Z"
}
```

A plain LRS shows one reading in `result.response` and stores the rest. That is the loss, and `projectionLossy` says so.

**Lossy means the statement says less than the descriptor**: the source was not asserted, or it held several readings. The adapter now states it on every projection. On a statement written before 2026-11-15 an absent flag means *not stated*, not *false*.

## 2. Modal status

A descriptor's claim is Asserted, Hypothetical, Counterfactual or Quoted (someone else's claim, repeated without endorsing it). `iep:` has a fifth status, Retracted, and a statement never states it: a retraction is a voiding statement (section 3). xAPI has no such notion: a stored statement reads as something that happened. So the statement states its modal status in `IEP#modalStatus`, and xapi-x fixes what follows from it.

**A consumer must not conclude, from a statement that is not Asserted:**

- that the actor did the thing, or that it happened at all;
- a completion, a success, a pass or a failure, even if `result` has those members;
- a score, a duration or an attempt to add to any total, average, count or streak;
- progress in a pattern: a non-asserted statement does not advance a sequence;
- grounds for a credential, a certificate, a badge or a competency assertion.

It may conclude that someone proposed the claim (Hypothetical) or reasoned about what did not happen (Counterfactual), and it may show the statement as such.

**A plain LRS will conclude all of those things anyway.** It cannot read the extension. So the emitter carries the burden:

- A non-asserted statement carries no `result.success`, `result.completion` or `result.score`.
- It does not use a verb its profile marks as an outcome. Foxxi's projector does this for two statuses: a Hypothetical descriptor is projected with Foxxi's `intended` verb and a Counterfactual with `considered`. It does not do it for Quoted (finding 6).
- An emitter that takes its verb from a caller cannot know the verb is not an outcome, so for it projecting a non-asserted descriptor is off unless the caller opts in. The lrs-adapter does this for Hypothetical and never projects a Counterfactual, which is stricter and allowed. An emitter that chooses the verb itself, as Foxxi's projector does, may project every status.

```json
{
  "actor": { "account": { "homePage": "https://example.org", "name": "fictional-coach" } },
  "verb": { "id": "https://example.org/verbs/proposed", "display": { "en-US": "proposed" } },
  "object": { "objectType": "Activity", "id": "https://example.org/plans/made-up-remediation" },
  "result": {
    "response": "A made-up plan the coach has not committed to.",
    "extensions": {
      "IEP#sourceDescriptor": "https://pod.example/fictional-coach/context-graphs/1790000000500.ttl",
      "IEP#modalStatus": "Hypothetical",
      "IEP#projectionLossy": true
    }
  }
}
```

No `success`, no `completion`, no `score`: a dashboard that counts completions counts nothing here.

## 3. Supersession, voiding and `iep:supersedes`

They are different acts, and xapi-x keeps them different.

| | xAPI voiding | `iep:supersedes` |
|---|---|---|
| Says | The earlier statement must not count. | A newer descriptor is the current account. |
| The earlier one | Stays stored, hidden from normal queries, cannot be un-voided. | Stays in history, readable. |
| Names a replacement | No. | Yes: the superseding descriptor. |

So:

The lrs-adapter writes the revision form from what its caller states in `supersedesStatements`. Foxxi's projector does not yet: a statement's id there is a function of its descriptor's IRI, so the ids it supersedes are known without a lookup.

- **A revision** (the account changed; the earlier one was a fair record at the time). Emit the new statement with `XAPIX#supersedesStatement` naming the earlier statement ids, and `context.statement` as a StatementRef to the most recent of them. Void nothing. An xapi-x consumer reads the newest; a plain LRS shows both, which is the loss.
- **A correction** (the earlier statement was wrong and is being counted). Emit the new statement as above, and also a standard voiding statement for the earlier one. Voiding is done with xAPI's own verb and StatementRef, unchanged.
- **A retraction** (nothing replaces it). A voiding statement alone. Foxxi's projector already does this for a Retracted descriptor.

`supersedesStatement` is not a second copy of `iep:supersedes`. The descriptor link is already reachable through `sourceDescriptor`; this is the same relation between the two *statements*, so a consumer holding only statements can follow it.

```json
{
  "id": "b2e4a1c0-1111-4222-8333-444455556666",
  "actor": { "account": { "homePage": "https://example.org", "name": "fictional-learner" } },
  "verb": { "id": "https://example.org/verbs/made-up-verb" },
  "object": { "objectType": "Activity", "id": "https://example.org/activities/made-up-activity" },
  "result": { "extensions": {
    "IEP#sourceDescriptor": "https://pod.example/fictional-learner/context-graphs/1790000009000.ttl",
    "IEP#modalStatus": "Asserted" } },
  "context": {
    "statement": { "objectType": "StatementRef", "id": "6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c" },
    "extensions": { "XAPIX#supersedesStatement": ["6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c"] }
  }
}
```

For a correction, this goes with it, and it is plain xAPI:

```json
{
  "actor": { "account": { "homePage": "https://example.org", "name": "fictional-learner" } },
  "verb": { "id": "http://adlnet.gov/expapi/verbs/voided" },
  "object": { "objectType": "StatementRef", "id": "6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c" }
}
```

## 4. Typed links from a profile's concepts to i2idl-x

A verb or an activity type should be able to say what design idea a statement using it is evidence of. Profiles 1.0 has `broadMatch`, `exactMatch` and the rest, but their targets must be xAPI concepts of the same type in another profile. A formative assessment is not a verb. Using those properties would misuse the standard.

**Decision: one property, `xapix:evidences`, written on the concept with its absolute IRI as the key.** The value names a concept of the I2IDL glossary or of `i2x:`. A plain profile processor ignores the property.

```json
{
  "id": "https://example.org/profile/verbs/checked-understanding",
  "type": "Verb",
  "inScheme": "https://example.org/profile/v/1",
  "prefLabel": { "en": "checked understanding" },
  "definition": { "en": "The learner answered a low-stakes question placed mid-lesson." },
  "https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/xapix#evidences": [
    { "@id": "https://id.i2idl.org/concept/formative-assessment" }
  ]
}
```

A statement using the verb is unchanged; the link is read from the profile:

```json
{
  "actor": { "account": { "homePage": "https://example.org", "name": "fictional-learner" } },
  "verb": { "id": "https://example.org/profile/verbs/checked-understanding" },
  "object": { "objectType": "Activity", "id": "https://example.org/lessons/made-up/check-2" }
}
```

What the link means is narrow: *a statement with this verb is evidence that the design idea was enacted*. It does not say the verb is the idea, and it does not classify the activity (that is `i2x:isClassifiedBy`, on the activity). Like every link I2IDL-X proposes about an I2IDL concept, it is Hypothetical until reviewed.

The I2IDL concept IRI above shows the shape; the real one comes from the pinned glossary release, and the lint (section 7) checks that the target exists there.

## 5. Hypermedia

Two cases, and neither embeds a control in a statement.

**A statement.** A statement is stored once and read for years. Controls embedded in it would be stale the day a service moved. So:

- A statement that names a source descriptor needs nothing more. The descriptor carries its own `iep:affordance` blocks, each with its target and method. The consumer fetches the descriptor and follows them.
- A statement with no descriptor carries `XAPIX#controls`: one IRI, of a document that lists what can be done now.

```json
{
  "actor": { "account": { "homePage": "https://example.org", "name": "fictional-learner" } },
  "verb": { "id": "https://example.org/verbs/made-up-verb" },
  "object": { "objectType": "Activity", "id": "https://example.org/activities/made-up-activity" },
  "context": { "extensions": { "XAPIX#controls": "https://bridge.example/statements/6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c/controls" } }
}
```

**A template.** What may follow a kind of statement is a fact about the kind, so it goes on the template: `xapix:offers`, naming affordances. Each affordance describes itself (target, method, expected input) where its IRI dereferences.

```json
{
  "id": "https://example.org/profile/templates/attempt-failed",
  "type": "StatementTemplate",
  "inScheme": "https://example.org/profile/v/1",
  "prefLabel": { "en": "attempt failed" },
  "definition": { "en": "A scored attempt below the mastery threshold." },
  "verb": "https://example.org/profile/verbs/failed-attempt",
  "https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/xapix#offers": [
    { "@id": "https://bridge.example/affordances/request-remediation" },
    { "@id": "https://bridge.example/affordances/retry-attempt" }
  ]
}
```

A consumer holding a statement that follows this template may follow either link. It never assembles a URL from an activity id, a registration or a naming convention. An offer is a possibility, not a permission: the affordance's own access rules decide.

## 6. Ordering and attestation

A pattern is a claim about order, and xAPI gives two orderings: `timestamp`, which the emitter writes, and `stored`, which the LRS assigns. A counter the client assigns is a third emitter claim and proves nothing; pull request 910 judged one and did not adopt it. xapi-x adds no counter. It says **who stands behind an order**, in four grades (`xapix:OrderBasis`):

| Basis | Rests on | Who may claim it | What it does not show |
|---|---|---|---|
| `ProviderClaimed` | `timestamp`, `XAPIX#previous` alone, any counter | The emitter, about its own statements. | Anything. It is a claim. |
| `StoreAssigned` | `stored` | The LRS, about arrival at that LRS. | The order things happened in; any other store. |
| `Chained` | `XAPIX#previousDigest`, recomputed by the consumer | The emitter, and it cannot change its mind later. | That nothing was left off the end. |
| `Attested` | `XAPIX#orderAttestation`: a signed descriptor listing the statements' digests in order | Whoever signed it, to the extent they are trusted. | More than its signer knew. |

Rules:

- Only the party that controls a thing may claim it. An emitter claims the order it emitted in. An LRS claims the order it stored in. Nobody claims on another's behalf.
- A conclusion that depends on order states its basis, and over several statements it has the weakest basis among them.
- `follows` in the profile processor orders by `timestamp`, so a pattern match is `ProviderClaimed` unless the consumer checked a chain or an attestation first.
- A stream that is known to be partial (llm-telemetry's are, by design) says so by carrying no attestation. A chain with a gap is two chains.

```json
{
  "id": "c3d5b2e1-aaaa-4bbb-8ccc-ddddeeeeffff",
  "actor": { "account": { "homePage": "https://example.org", "name": "fictional-agent" } },
  "verb": { "id": "https://example.org/verbs/made-up-step" },
  "object": { "objectType": "Activity", "id": "https://example.org/tasks/made-up-task" },
  "context": {
    "registration": "0a1b2c3d-0000-4000-8000-000000000001",
    "extensions": {
      "XAPIX#previous": "b2e4a1c0-1111-4222-8333-444455556666",
      "XAPIX#previousDigest": "sha256:9c1e…(64 hex)",
      "XAPIX#orderAttestation": "https://pod.example/fictional-agent/context-graphs/1790000012000.ttl"
    }
  },
  "timestamp": "2026-11-15T12:00:07.000Z"
}
```

In code (`src/xapix/statement.ts`): `statementDigest` is the SHA-256 of a statement's RFC 8785 canonical JSON without `stored`, `authority` and `version`; `chained` links a run; `orderBasis(statements, attestation?)` returns the strongest basis that holds for the whole run and why a stronger one does not. It is told whether the reader verified an attestation's signature and does not verify one itself. No emitter chains its statements yet.

xAPI's own signed statements (a JWS attachment) attest one statement's content. They say nothing about order, and they compose with this unchanged.

## 7. What a profile gains

**An xapi-x profile** is an xAPI Profiles 1.0 document that passes the lint below. It gains:

1. **Templates that require a decoration.** A template rule is an ordinary rule whose location is a decoration: `$.result.extensions['IEP#sourceDescriptor']` with `presence: included`. The first profile's one template does this.
2. **Concepts that say what they evidence** (section 4) and **templates that say what they offer** (section 5).
3. **Declared decorations.** A profile either declares the decoration keys its statements carry or uses the ones this profile declares.

**The xapi-x profile is a registry, not a profile statements name in `category`.** Profiles 1.0 says a statement naming a profile version in its category must follow one of that profile's patterns, and the processor's `follows` requires every statement of a registration to validate against the one profile. A decoration cuts across domains: a Foxxi lesson statement and a coached-world statement can both be projections. So a domain profile's own templates carry the decoration rules, and statements go on naming the domain profile. The marker a statement carries is the *activity type* `xapix:Projection`, not this profile's version.

**Version 1's template has no determining property**, because nothing in a statement the lrs-adapter wrote then marked it as a projection except the keys themselves. Asked of version 1, every statement is held to it: a statement without the keys is *invalid*, not *unmatched*. That is the right answer to "is this a well-formed projection?" and the wrong template to copy into a domain profile.

**Version 2 selects on `contextCategoryActivityType: [xapix:Projection]`**, now that emitters write the category. A statement that does not claim to be a projection is unmatched. A projection must also say whether it is lossy and must not link to controls. Version 2 declares the six `xapix:` context extensions and the activity type. Version 1's template is kept in it, deprecated, and statements written before 2026-11-16 are judged against version 1. The profile server holds both versions, so `…/v/1` still resolves and still validates. **Version 2 is in the repository and on the profile server; the pod still serves version 1** until version 2 is published there.

### Lint rules

Each is code in `src/xapix/lint.ts`: `lintXapixStatements(statements, profiles)` for X1 to X8 and `lintXapixProfile(profile, examples, resolvers)` for X9 and X10, both returning the profile lint's findings. The last column says what the code can and cannot see.

| | Rule | In code |
|---|---|---|
| X1 | Every key under `iep#` or `xapix#` that a statement carries is declared by a profile, and sits where its type says: a `ResultExtension` in `result`, a `ContextExtension` in `context`. | `xapix-undeclared`, `xapix-misplaced` |
| X2 | A decoration's value follows the concept's `inlineSchema`. | `xapix-value`. Reads the part of JSON Schema the decorations use: type, enum, items, minItems, pattern, `format: iri`. |
| X3 | A statement that names a source descriptor states a modal status, and the reverse. | `xapix-source-and-status` |
| X4 | A statement that is not Asserted carries no `result.success`, `completion` or `score`, and no verb its profile marks as an outcome. | `xapix-outcome-not-asserted`. Profiles 1.0 has no mark for an outcome verb and xapi-x adds none: a verb is one when a template with it requires `result.success`, `completion` or `score`, or when the caller names it. |
| X5 | More than one narrative means `projectionLossy` is `true`. | `xapix-lossy` |
| X6 | A projection that loses anything states `projectionLossy: true`; one that loses nothing states `false`. Never absent. | `xapix-lossy`, for statements written from 2026-11-15; version 2's template requires the flag |
| X7 | `supersedesStatement` never names the statement itself, and a correction comes with a voiding statement. | `xapix-supersedes`: not itself, a list of ids, and `context.statement` names one of them. The correction half is not checkable: nothing in a statement tells a correction from a revision. |
| X8 | No extension claims a place in a sequence with a bare number. | `xapix-bare-position`, by the key's name (sequence, ordinal, position, counter, step index) and a numeric value. A counter under another name is not seen. |
| X9 | The target of every `xapix:evidences` exists in the pinned I2IDL release or in `i2x:`; the target of every `xapix:offers` dereferences to an affordance. | `xapix-link-shape`, `xapix-link-target`. The lint fetches nothing: its caller passes the two lookups, and without them only the shape is checked. |
| X10 | With every decoration removed, the profile is still a valid profile and each statement still follows every template that asks for no decoration. | `xapix-not-a-superset` |
| X11 | No two templates of a profile share their determining properties. | the profile lint's own `same-determining-properties`; not repeated |

## Found while writing this

1. **Only the lrs-adapter wrote the four keys.** The brief named learner-performer-companion as a second emitter. A search of its source finds no statement that carries them. Foxxi's projector writes them too since decision 6 was carried out.
2. **`projectionLossy` was absent when a Hypothetical descriptor was projected with one narrative**, while the audit row the adapter writes to the pod called that projection lossy. Fixed with decision 3: the statement and the audit row now use one test (`projectionIsLossy`).
3. **Foxxi's projector said the same things under other names.** `mesh-event-projector.ts` writes the descriptor as `foxxi:substrateDescriptorIri` and the superseded one as `foxxi:supersededDescriptor`, both in `context.extensions`, and stated modal status only through the verb. Two emitters, two vocabularies for one idea (decision 6, which says what was done about it).
4. **`docs/ns/iep.ttl` names xAPI.** The comment on `iep:sourceDescriptor` says it is "used as an xAPI result.extensions key by the LRS projection". That is a Layer 1 vocabulary describing itself by one technology. It is a comment, not a MUST, and the term itself is neutral; noted, not touched.
5. **The adapter's README lists the keys as surviving two LRS products.** That evidence is the reason section 1 keeps the IRIs.
6. **Foxxi's projector projects a Quoted descriptor with an outcome verb.** A Quoted descriptor is given the verb an Asserted one gets (`completed`, or `failed`), with `foxxi:endorsed: false`. Rule X4 finds it once the verb is named as an outcome verb. Foxxi's profile has no verb for repeating someone else's claim; adding one is a change to Foxxi's profile and is not made here.

## Decisions

The owner was asked eleven questions and answered: decide them, "you know what my thoughts are" (2026-11-15). These are the decisions, each with its reason, so any of them can be reversed by someone who disagrees with the reason.

1. **Home: the Foxxi vertical, beside i2idl-x.** It moves only if a second vertical needs to change xapi-x rather than use it.
2. **Published.** The ontology and the profile are on the pod at the IRIs above. The Foxxi profile server serves the profile as well, as one of the deployment's built-in profiles (`src/xapi-profile-server/built-in.ts`): the pod serves its triples, and the server answers SPARQL, validates a statement against it and resolves each of its IRIs. It is built in, not published through the authoring routes, so that it is the document `src/xapix/profile.ts` builds and nothing else. Its example, a statement the lrs-adapter's own builder makes, is kept with it and served at `/xapi/profiles/examples`, as a published version's are.
3. **The four keys stay `iep#` IRIs in `result.extensions`.** Stored statements carry them. The adapter now writes `projectionLossy` on every projection, `false` included, so a reader can tell a faithful projection from one that did not say.
4. **Four modal statuses in a statement: Asserted, Hypothetical, Counterfactual, Quoted.** Quoted is added because repeating a claim is not making it, and a consumer must not count it either. Retracted is never a stored status: voiding is how xAPI says it, and saying it twice invites the two to disagree.
5. **One rule for non-asserted statements: no outcome members and no outcome verb (X4).** Whether projection is on by default follows from it: off where the caller supplies the verb, allowed where the emitter chooses it.
6. **One vocabulary.** Foxxi's projector writes the `iep#` keys as well as its own `foxxi:` keys for one profile version, then stops writing its own. The first half is done: every projection that is not a voiding statement carries `sourceDescriptor`, `modalStatus` and `projectionLossy` under `result.extensions`, and Foxxi's `performed-descriptor`, `intended-descriptor` and `considered-descriptor` templates hold a statement that carries them to them (the modal status has to be one the template's verb can say). The rules are `recommended`, not `included`, because projections stored before this carry only the `foxxi:` keys and are still projections. Foxxi's profile does not redeclare the keys: this profile declares them, and both are held on the one server. The projector still writes its `foxxi:` keys, and Foxxi's templates still require `foxxi:substrateDescriptorIri`; stopping that is the second half and is not done.
7. **The marker is `xapix:Projection`.** A marker that says "this is a projection of a descriptor" should not belong to one application. Foxxi's `activities/descriptor-projection` stays on stored statements.
8. **A revision does not void; a correction does.** Voiding a statement that was a fair record when it was written would say it never should have counted, which is false. A plain LRS showing both is the stated loss.
9. **Digests are SHA-256 over RFC 8785 canonical JSON** of the statement as its emitter sent it, without `stored`, `authority` and `version`. **Anyone may sign an order attestation.** There is no authority to appoint: the signer is named with the conclusion and the reader decides whether to trust them.
10. **Evidence links target I2IDL's own concept IRIs, or `i2x:` authored concepts where I2IDL has none.** Each is a proposal (Hypothetical) until reviewed, as every link I2IDL-X proposes is.
11. **The lint is a function first**, beside the processor, that a profile's tests call; an affordance on the profile server follows. The rules are a rule set in `src/xapix/lint.ts`, not a second linter: they return the profile lint's findings, call it for the superset check, and leave every question of whether a statement follows a template to the processor.

## Left to do

- **Publish version 2 of the profile on the pod.** The pod serves version 1. A public graph cannot be unpublished, so it is the owner's go-ahead.
- **An emitter that chains.** `chained()` and `orderBasis` exist and no emitter calls them. The first should be one whose statements share a registration (llm-telemetry or coached-world), and it is that vertical's change.
- **An order attestation that is written and verified.** The term is declared and `orderBasis` accepts one its reader verified. Nothing publishes the signed descriptor that lists the digests, and nothing verifies one.
- **`xapix:controls`.** Declared and linted. It needs a document to link to, served by the bridge for a statement that has no descriptor, and no such route exists.
- **`xapix:evidences` and `xapix:offers` on a real profile.** The lint checks them; Foxxi's profile states none, because each evidence link is a proposal that wants review before it is published.
- **The lint as an affordance** on the profile server, and the two lookups for X9 (the pinned I2IDL release; an affordance that dereferences) wired to real sources.
- **Foxxi's projector**: the second half of decision 6 (it stops writing `foxxi:substrateDescriptorIri`, Foxxi's templates stop requiring it, and the readers of that key, `learner-record.ts` and `content-delivery.ts`, move to `sourceDescriptor` first); then the projection category, supersession and no outcome on a statement that is not Asserted; and a verb for a Quoted descriptor (finding 6).
