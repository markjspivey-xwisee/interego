# Dual-audience verticals — a design discipline

**Every Interego vertical has at least two first-class audiences.** One is
the individual whose data it is (the protagonist — learner, knowledge
worker, patient, citizen). The other is the institutional operator who
runs the deployment (the L&D leader, edtech vendor, ops lead, regulator-
facing compliance manager, healthcare coordinator). The substrate's job
is to give each audience its own first-class affordances over the same
underlying descriptors — with the protagonist's pod as the sovereign
source of truth.

This page names the principle, lists the substrate mechanisms that
enable it, and shows how the pilot verticals (learning, organizational
working memory) apply it.

## The principle

A vertical fails the dual-audience test if it can only be used by one
side of the relationship. Examples of failure modes:

- **Protagonist-only:** the vertical lets the individual collect /
  curate / share their data, but the institution that wants
  cohort-level reporting has to leave Interego to get it. Result: the
  institution doesn't adopt, the individual has no peers on the
  network.
- **Institutional-only:** the vertical gives the institution a
  dashboard, but the individual whose data populates it has no agency,
  no portability, and no view into what's been said about them. Result:
  the protagonist becomes data exhaust, the design slides toward
  surveillance, and a single vendor lock-in re-emerges.

Interego is positioned to solve this *because* its substrate primitives
are bilateral by construction: the pod is the protagonist's; ABAC + per-
graph `share_with` + aggregate-privacy queries give the institution
useful views without seizing control.

## The substrate mechanisms that make it possible

The dual-audience model isn't a vertical-specific design — it falls
out of L1/L2 primitives that already exist:

| Audience side | Substrate mechanism |
|---|---|
| Protagonist sovereignty | Pod-rooted identity ([`spec/architecture.md`](../spec/architecture.md) §6); auth-methods.jsonld lives on the protagonist's pod, not the server. |
| Institutional read access | Per-graph `share_with` recipient lists ([CLAUDE.md §E2EE conventions](../CLAUDE.md)); ABAC policy descriptors ([`docs/ns/abac.ttl`](ns/abac.ttl)); WebID-based delegation via [`docs/ns/passport.ttl`](ns/passport.ttl). |
| Institutional aggregation without surveillance | Aggregate-privacy queries ([`spec/AGGREGATE-PRIVACY.md`](../spec/AGGREGATE-PRIVACY.md)); ZK range / temporal / merkle proofs ([`src/crypto/`](../src/crypto/)); attestation aggregation that returns counts / proofs / thresholds without exposing individual records. |
| Institutional authorship | Institutions publish their own descriptors (training content, credentials, policies) to *their own* pod; protagonists' agents discover via federation and pull. The institution is a peer, not a hub. |
| Bilateral audit trail | Every action is signed ([`src/compliance/`](../src/compliance/)); both sides see who said what when, in their own vocabulary (`eu-ai-act:`, `nist-rmf:`, `soc2:` for the institution; `passport:LifeEvent` chain for the protagonist). |
| Modal honesty in both directions | `cg:modalStatus` (Asserted / Hypothetical / Counterfactual) keeps institutional inferences distinct from protagonist commitments; no side gets to silently upgrade tentative claims into facts. |

If a vertical wants a dual-audience surface and discovers the
substrate doesn't already enable it without new ontology terms, that's
a finding worth bringing back to L2 for a pattern proposal — but in
practice the existing primitives have covered every dual-audience case
we've designed against.

## Pilots and how they apply the principle

### Learning — [`applications/learner-performer-companion/`](../applications/learner-performer-companion/) + [`applications/lrs-adapter/`](../applications/lrs-adapter/)

| Audience | First-class affordances |
|---|---|
| **Learner / performer** (the protagonist — a human, optionally driven by their agent) | Wallet (Open Badges 3.0 / IMS CLR 2.0 / IEEE LERS-shaped VCs), grounded chat with verbatim citation, xAPI history pulled from any institutional LRS into the learner's pod, performance records, IDP / OKR plans. Owns the pod; can revoke any institutional read at any time. |
| **Enterprise edtech professional** (the operator — L&D lead, edtech vendor, compliance manager, IEEE LERS / ADL TLA implementer) | Publishes authoritative training content + cohort templates + credentials to the institution's own pod; learners' agents discover via federation. Projects descriptors outbound as xAPI Statements to LRS systems via [`lrs-adapter/`](../applications/lrs-adapter/) (with the learner's per-graph consent). Runs aggregate-privacy queries for cohort completion rates / competency distributions without seeing individuals. Compliance-grade publish (`compliance: true`, `compliance_framework: 'eu-ai-act'`) for regulator-facing evidence. |

The interop standards — **IEEE LERS, ADL TLA, xAPI 2.0, W3C Verifiable
Credentials, Open Badges 3.0, IMS CLR 2.0, SCORM, cmi5** — connect the
two audiences without either dictating the other. The institution
publishes in the format the learner's wallet can consume; the learner
chooses what to import.

### Organizational working memory — [`applications/organizational-working-memory/`](../applications/organizational-working-memory/)

| Audience | First-class affordances |
|---|---|
| **Knowledge worker / individual contributor** | Their own slice of the org's memory: projects they own, decisions they're in, follow-ups assigned to them, notes they captured. ABAC-scoped views by default; cross-team visibility through explicit `share_with` on individual descriptors. |
| **Org-level operator** (PM lead, ops, exec) | Aggregate dashboards over decision lineage, project health, follow-up flow, decision-revision frequency. Aggregate-privacy queries (counts / thresholds / proofs) where individual visibility would be inappropriate. Compliance-grade publish for board-facing or auditor-facing decision provenance. |

The shared substrate: typed descriptors on the org pod, navigated via
the uniform `ls / cat / grep / recent` source-adapter verbs the
individual sees, AND via the dashboard-shaped aggregate queries the
operator sees. Same underlying descriptors; different affordance
surfaces.

## Authoring discipline for new verticals

When you propose a new vertical, the second slide should answer:

1. **Who are the two (or more) audiences?** Name them concretely. "End users" and "operators" is too vague; use job titles + the decisions they own.
2. **What does each audience read?** What's the affordance surface they touch directly?
3. **What does each audience write?** Where does authored content land — on whose pod?
4. **Where do their views derive from the same descriptors?** This is where the substrate earns its keep — the institution's view is *a function of* the individuals' pods, not a parallel store.
5. **What does the substrate not enable yet?** Honest enumeration of gaps. Most cases the answer is "nothing new is needed"; sometimes it's "we need an L2 pattern for X."

A vertical that can't answer these has not earned its dual-audience
framing yet; it's likely an MVP for one audience that needs the second
audience scoped before broad release.

## What this is NOT

- **Not a permission model.** ABAC + per-graph `share_with` is the
  permission model; dual-audience is a *design discipline* about
  affordance design.
- **Not a SaaS multi-tenancy story.** Interego is federated by
  construction; "tenant" doesn't appear in the L1 spec.
- **Not anti-institutional.** The principle is bilateral. Institutions
  are first-class peers, not adversaries or hubs.
- **Not a constraint on protocol terms.** This is a vertical-authoring
  discipline. The L1/L2/L3 ontologies don't enumerate audiences; they
  enumerate primitives that compose into audience-specific surfaces.

## See also

- [`spec/AGGREGATE-PRIVACY.md`](../spec/AGGREGATE-PRIVACY.md) — how the institutional aggregate view derives from individual pods without surveillance.
- [`docs/ns/abac.ttl`](ns/abac.ttl) — the L2 ABAC pattern for institutional read access.
- [`docs/ns/passport.ttl`](ns/passport.ttl) — capability passports for delegated authorship.
- [`applications/README.md`](../applications/README.md) — vertical-authoring discipline.
