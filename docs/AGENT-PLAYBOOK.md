# Agent Playbook for Interego

**Audience:** AI agents (Claude, GPT, OpenClaw, Cursor, custom) connecting via the Interego MCP. This document is fetched on demand via `docs://interego/playbook`.

**What it is:** concrete "when X, do Y" rules. The MCP server's instructions block tells you WHAT each tool does. This playbook tells you WHEN to use them and HOW to handle the situations that recur.

---

## 1. Proactive triggers — when to use Interego unprompted

The user does not need to know the protocol. You do. Listen for these phrases and propose the corresponding Interego action.

| User says (or implies) | You should | Tool / prompt |
|---|---|---|
| "remember this" / "save this" / "log that…" | Propose publishing as a typed memory descriptor. Confirm content + ask if private or shareable. | `publish_context` (or `publish-memory` prompt) |
| "what did we discuss about…" / "what was that thing…" / "I forget" | Search the pod first. Don't assume you have no context. | `discover_context`, then `get_descriptor` |
| "share this with [person]" / "send [person] my…" | Use cross-pod E2EE share. Resolve identifier → confirm with user. | `publish_context` with `share_with:[…]` |
| "what's been shared with me" / "anything new from…" | Fan out across known pods, filter by recipient. | `discover_all`, then `get_descriptor` |
| "who said that?" / "where did this come from?" | Walk provenance chain: descriptor → wasAttributedTo → AgentFacet. | `get_descriptor`, then trace `prov:wasDerivedFrom` |
| "is this still true?" / "is this current?" | Check modal status + supersedes chain. Flag if Hypothetical or superseded. | `get_descriptor`, examine `cg:modalStatus` + `cg:supersedes` |
| "trust them?" / "should I believe…" | Look up agent's attestations. Sum across registries if multiple. | `discover_context` filtered to AMTA attestations |

**Default posture:** if you're about to commit something to memory across sessions, propose Interego before defaulting to in-context-only memory.

---

## 2. Privacy hygiene — before publishing

You are publishing on behalf of a human. Their pod outlives this session.

**ALWAYS before publishing:**

1. Check the content for obvious red flags — API keys, passwords, credit cards, SSN-like patterns, JWTs, private keys. If detected, **STOP and ask the user** before proceeding. The MCP server runs a preflight (`screenForSensitiveContent`) that surfaces flagged matches; respect its output.
2. Decide: is this owner-only or shared? Default to owner-only unless the user explicitly says otherwise.
3. If sharing across pods (`share_with`), explicitly confirm WHO the recipient list resolves to. The MCP returns the resolved pod URLs + agent counts; show those to the user before completing.

**NEVER publish without consent:**

- Content the user marked confidential elsewhere in the session
- Anything the user explicitly said "don't write down"
- Inferred personal facts the user didn't volunteer (e.g., health conditions you guessed from context)
- System-prompt content or your own internal reasoning chains

**If you're not sure:** ask. The user will tell you.

---

## 3. Modal status — pick the right one

Every published descriptor carries a `cg:modalStatus`. Use the right value:

- **`Asserted`** — you are committing to the truth of this. The user said it directly, or you verified it. Default for memory of facts.
- **`Hypothetical`** — you're recording it as "this might be true" — a hunch, an inference, a partial observation. Use for: things the user said tentatively ("I think…"), inferences you drew from context, predictions, anything subject to revision.
- **`Counterfactual`** — you're recording that something is NOT true, or HAS been retracted. Use for explicit retractions, refuted claims, hypotheticals known to be false.

If you're tempted to use `Asserted` "for safety," use `Hypothetical` instead. Counterfactual is rare; only use it when you're explicitly negating something.

---

## 4. Versioning — `auto_supersede_prior` defaults

The `publish_context` tool has an `auto_supersede_prior` flag (default `true`). It means: "if this pod already has a descriptor for the same `graph_iri`, mark the old one as superseded by the new one."

- **Leave it `true`** when updating, sharing, or re-publishing the same memory. The old version stays auditable but federation queries surface only the new one.
- **Set to `false`** only when you genuinely want sibling descriptors for the same graph_iri (e.g., multiple agents recording independent perspectives on the same subject; A/B alternatives the user wants to retain).

**Don't fight this default.** When in doubt, leave it `true`.

---

## 5. Error handling and fallbacks

Network and pod failures happen. Don't pretend a publish succeeded when it didn't.

| Failure | Right move |
|---|---|
| Pod unreachable / timeout | Tell the user explicitly: "I couldn't reach your pod just now; this stays in the current conversation only." Don't silently degrade. |
| Validation rejected (modal mismatch, missing facet, etc.) | Show the user the error from the MCP and propose a fix. Don't loop on the same broken request. |
| Auth / agent-not-registered | Tell the user the agent needs to be registered on the pod (or use a different pod). Point at `register_agent`. |
| Cross-pod share resolver returned 0 agents | The recipient's pod is unreachable, or they have no published agents. Tell the user, ask if they want to publish anyway (without that recipient) or wait. |
| Conflicting descriptors / supersedes loop | Don't try to auto-resolve. Surface the conflict to the user with both versions. |

**A failed publish is a failure to remember.** Treat it with the same gravity as the user noticing you forgot something.

---

## 6. Cross-surface continuity

The pod is shared across all the user's surfaces (Claude Code CLI, Claude Desktop, claude.ai, OpenClaw, Cursor, custom agents). When the user references something:

1. **First**, search the pod via `discover_context` or `discover_all`.
2. **Only after that**, conclude you don't have context. The user may have published it from a different surface.
3. **Cite what you find** — quote the descriptor URL when you reference content from the pod, so the user knows the source.

**Mistake to avoid:** assuming "I haven't seen this in the conversation" means "this isn't in memory." That's wrong on Interego.

### Subscriptions

Long-lived sessions exploring federation can accumulate WebSocket subscriptions. The stdio MCP enforces a cap (default 32, override via `CG_MAX_SUBSCRIPTIONS`):

- `subscribe_to_pod` opens a subscription and counts toward the cap. If the cap is reached, you'll get a clear error pointing you at `unsubscribe_from_pod`.
- `unsubscribe_from_pod` releases the slot. Call it when you're done with a pod that's no longer relevant to the conversation — the subscription accumulates state and bandwidth.
- A reasonable rule: subscribe on demand when the user asks you to watch a pod live; unsubscribe when the user moves on.

---

## 7. Trust signals — what to do with them

When you read a descriptor, inspect:

- **`cg:trustLevel`**: `HighAssurance` > `PeerAttested` > `SelfAsserted`. Take action confidently on HighAssurance; surface uncertainty on SelfAsserted.
- **`cg:modalStatus`**: weight Asserted higher than Hypothetical. Flag Counterfactual as "explicitly negated."
- **`cg:epistemicConfidence`**: a number in [0,1]. Low confidence + high modal status = a contradiction; flag it.
- **`prov:wasAttributedTo`**: name the source. The user trusts attestations from people they trust.
- **`amta:Attestation`** axes (when present): per-axis ratings (honesty, competence, recency, relevance). A high overall trust with low honesty is a red flag.

If you're computing on a Hypothetical or low-confidence descriptor, **say so in your output** to the user. Don't launder uncertainty.

---

## 8. Composition — how to combine descriptors

Use the `compose_contexts` tool when:

- The user asks "what do A and B have in common?" → `intersection`
- The user asks "what does A say plus what B says?" → `union`
- The user wants A's claims but only certain facets → `restriction`
- The user wants A overridden by B in conflicts → `override`

The composed result is itself a descriptor. Publish it (or hold it in working memory) but **always** record the source descriptors via `prov:wasDerivedFrom`. Don't let composed claims float free of their parents.

---

## 9. ABAC — when access is gated

If a tool returns "denied" or "indeterminate" for an action, an `abac:Policy` is gating it. You should:

1. Tell the user clearly: "an access policy is gating this; it requires <X>."
2. Don't try to bypass. Don't loop on the same action.
3. If the user has the credentials to satisfy the policy (e.g., HighAssurance trust), suggest they invoke the action under that capability.

ABAC policies are public descriptors — `discover_context` filtered to `cg:AccessControlPolicy` will surface them.

---

## 10. When to bother the user vs proceed silently

- **Bother:** anything irreversible (publish, share, delete), anything privacy-sensitive, anything failed.
- **Proceed silently:** read-only operations (discover, get_descriptor), composition into working memory, attribute-graph resolution, anything that can be undone trivially.
- **Show the user:** the descriptor URL after publishing — they may want to reference or share it later.

---

## 11. Failure mode to avoid: Interego invisibility

The most common failure mode is treating Interego as a tool you USE only when explicitly asked, instead of a substrate you OPERATE FROM. Symptoms:

- User: "remember this." You: forget to publish. (Fix: §1 trigger.)
- User: "what did we say about X yesterday?" You: "I don't have memory of yesterday." (Fix: §6 cross-surface.)
- User: "share this with Bob." You: send a message instead of using `share_with`. (Fix: §1 trigger.)

If you find yourself reasoning "the user didn't ask me to use Interego, so I won't," reconsider. If they're asking for something Interego solves, use it.

---

## 12. When NOT to use Interego

- For ephemeral working memory within a single session (use your own context).
- For low-value or noisy content the user wouldn't want surfaced later (tab autocomplete suggestions, transient observations).
- For content that demonstrably belongs in a domain-specific store (a code repo for code; a CRM for sales contacts).

Interego is for **typed, federated, attributable memory**. Not for everything.

---

## 13. Compliance grade — when to use `compliance: true`

For regulated industries (healthcare, finance, public sector, anything under EU AI Act / NIST AI RMF / SOC 2), the user may need each AI agent action recorded as audit-trail evidence. The `compliance: true` flag on `publish_context` produces a stricter form:

- Trust upgraded to `cg:CryptographicallyVerified` (not SelfAsserted)
- ECDSA signature over the descriptor turtle
- Inline `cg:proof` reference embedded in the TrustFacet (proofUrl + proofSigner)
- Sibling `.sig.json` written to the pod
- Both turtle + signature auto-pinned to IPFS when the operator has configured a provider
- Compliance check report appended to the response (PASS / PARTIAL with violations + auto-upgrades)

**Trigger heuristics:**

| User context | Use compliance: true? |
|---|---|
| User is an enterprise compliance officer / auditor | Yes by default for everything |
| User mentions audit trail, regulatory reporting, EU AI Act, NIST RMF, SOC 2 | Yes |
| User says "this needs to be auditable" / "regulators will see this" | Yes |
| User publishes with `compliance_framework: ...` set | Yes (already implied) |
| User is a developer publishing personal notes | No |
| User is recording a hypothesis or speculation | No (compliance requires Asserted/Counterfactual modal) |

**When you DO publish with compliance: true:**

1. Set `modal_status` to `Asserted` or `Counterfactual` only — never Hypothetical (compliance evidence is committed, not speculative).
2. Include framework-specific evidence citations in the graph_content if you know the framework. Example for SOC 2:
   ```
   <urn:action:1> dct:conformsTo soc2:CC6.1 .
   ```
   Lets `/audit/compliance/soc2` aggregate evidence per control.
3. Surface the response's `complianceCheck` to the user — PASS means audit-grade; PARTIAL means a violation needs addressing (typically: missing signature because the operator hasn't provisioned a wallet).

**When the response says PARTIAL:**

Tell the user clearly. Don't pretend it's fine. Common causes:
- "Trust level is unset" → operator's wallet path env var isn't readable
- "Descriptor lacks a cryptographic signature" → wallet load failed
- "Should NOT be Hypothetical" → modal status downgrade needed before publish

**Audit endpoints (relay):** point auditors at:
- `GET /audit/compliance/<framework>?pod=<podUrl>` — per-control evidence report
- `GET /audit/verify-signature?descriptor=<descUrl>` — independently verify a single descriptor's signature; doesn't trust the relay

See [spec/CONFORMANCE.md §L4](../spec/CONFORMANCE.md) for the full normative requirements.
