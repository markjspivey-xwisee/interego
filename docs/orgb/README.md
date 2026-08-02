# `orgb/` — a workspace member on infrastructure we do not operate

This directory exists to test one claim, and it is the claim the whole shared-workspace
design rests on:

> A workspace can **span organisations**, because joining needs no shared server — only a
> WebID, a pod, and a grant.

Every "cross-pod" test until now used two pods on **our own** relay, behind **our own**
identity provider. That proves federation between two directories we control. It does not
prove the thing above, and saying it did would be the same kind of overclaim this project
keeps finding in its own work.

So this is a workspace member whose entire record is served by **GitHub Pages** — a static
host that has never heard of the Interego relay, runs none of its code, shares none of its
storage, and cannot authenticate anybody. If the relay can compose a member from here, the
claim is real. If it cannot, the claim was marketing.

## What is here

```
.nojekyll                          so Pages serves .well-known/ at all
orgb/.well-known/context-graphs    the pod manifest, hand-authored Turtle
orgb/context-graphs/e0.ttl         entry 0 — descriptor
orgb/context-graphs/e0-graph.trig  entry 0 — payload
orgb/context-graphs/e1.ttl         entry 1 — descriptor, supersedes e0
orgb/context-graphs/e1-graph.trig  entry 1 — payload
```

The manifest is the same shape `packages/solid/src/client.ts` writes on a real pod: one
`iep:ManifestEntry` per descriptor, mirroring `iep:describes`, `iep:validFrom`,
`iep:contentCid` and `iep:supersedes` in cleartext so a reader can find the chain head from
the manifest alone, without fetching a single descriptor.

That mirroring is what makes this possible. **A pod is a shape, not a product.** Anything
that can serve those bytes over HTTP is one, which is exactly why the design does not need
the other organisation to run our software.

## What this does and does not prove

**Proves:** a member's stream can live on a foreign origin, under a different operator, and
still be read, chain-verified and folded into a workspace by our composer.

**Does not prove:** that the member can *write* here. These files are committed to a git
repository and published by CI — there is no runtime, no access control, and no way for the
member to append without a commit. A real second organisation would run its own pod server
with its own WAC. What is being tested is the **read and compose** half of cross-org
membership, which is the half the composed view depends on.

**Also does not prove** authorship. These records carry no `iep:authorshipProof`, so a
reader can confirm where they are served from and nothing about who wrote them — the same
limit the workspace README states for every other member.

Run it: `applications/shared-workspace/tools/verify-cross-org-live.ts`.
