# Signing from an authenticated app

The authenticated MCP app can open one pending signing request in a fresh browser
tab without asking the holder to sign in again. The holder still reviews and
signs the exact action receipt with a registered passkey or wallet. The handoff
does not count as a signature or grant account access.

## Protocol

1. The interaction advertises `urn:interego:client-interaction:open-signing-page`
   as `openAction`. Only its original authenticated user, client and actor may
   invoke it. Opening invalidates an earlier launch, browser session and review.
2. The broker returns a signing URL with a random, single-use launch code in its
   fragment. The code expires after at most two minutes, bounded by the request
   and originating authorization. The durable encrypted record stores its hash.
3. The signing page immediately removes the fragment and exchanges the code via
   a JSON POST to `/client-interactions/:id/exchange`. The broker requires the
   actual browser `Origin` to equal the configured signing origin and atomically
   consumes the code using the interaction store's compare-and-swap.
4. The returned random browser credential stays in memory and expires after at
   most five minutes, bounded by the request and originating authorization. Its
   hash binds the request, owner, client, actor, authorization digest, authority
   binding, origin and generation.
5. The page uses `X-Interego-Browser-Signing` for JSON POSTs to that request's
   `status`, `review` and `submit` controls. It never exchanges this credential
   for a general bearer. A supplied invalid scoped credential cannot fall back
   to an `Authorization` header.

The review returns the registered direct signing keys and exact receipt. Signing
uses the existing domain-separated challenge and registered-key verification.
Authority checks, receipt binding, action guards, publication preconditions and
replay verification are unchanged. Scoped browser access cannot list pending
requests, create signing grants, renew authorization or cancel requests.

## Completion and revocation

Every nonterminal browser operation revalidates the originating authorization.
Renewal, cancellation and a new launch invalidate previous capabilities.
Successful, failed and ambiguous terminal submissions immediately erase the
stored OAuth bearer and draft. The admitted browser can read only a minimal
terminal result or retrieve the same submission result until its fixed expiry;
this uses the retained non-secret authorization digest for binding and does not
revalidate the erased bearer. It cannot review or execute another action.

## Host integration and privacy

The MCP tool wrapper removes launch fragments from model-visible text and
structured content. Only `_meta['interego/browser-signing']` carries the full
launch URL to the widget. The widget obtains it when the user clicks Open,
validates its origin, path, request ID and fragment, then opens the signing page.
URL elicitation passes a fresh launch directly to the host's URL control.
Completion callbacks contain only request identity and status, with full signing
details available separately for inspection.

A bare request ID grants no access. Standalone links and hosts without this
handoff keep the existing account-login flow. The one-prompt behavior applies to
an authenticated app handoff, not every possible way to reach the signing page.
Older passkey records with an ambiguous registration domain still require the
existing account recovery flow before they can sign.

## Verification

The broker and production HTTP handler tests exercise one-use exchange, expiry,
origin and request binding, grant revocation, excluded operations, exact receipt
signatures, terminal credential erasure and replay. The signing-page integration
uses test-owned cryptographic keys to assert one WebAuthn call and no login or
browser storage access. MCP tests check that launch secrets remain private to
the widget and URL control.

The Identity Server Tests workflow also runs
`INTEREGO_TEST_CHROMIUM=1 npx vitest run tests/browser-signing-handoff.chromium.test.ts`.
This uses Chromium's native WebAuthn API with a test-owned virtual authenticator,
a fresh browser context, and both same-origin and cross-origin signing pages.
It does not exercise a person's physical passkey prompt.
