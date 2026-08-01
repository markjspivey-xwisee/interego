/**
 * @module agent-interop-mount
 * @description Mount every registered interop profile onto the relay.
 *
 * Deliberately NOT named for any one protocol. This module iterates the profile
 * REGISTRY and serves whatever is in it: each profile contributes a card path and a
 * wire route table, and gets its routes for free. Adding a protocol is a data file
 * in `@interego/agent-interop/src/profiles/` plus a registry entry — no change here,
 * and no change in server.ts beyond the single `mountAgentInterop(app, deps)` call
 * that sits beside the existing `mountAmep(...)`.
 *
 * It COMPOSES the substrate rather than duplicating it:
 *   - identity comes from the relay's own verified-caller check (never the payload),
 *   - capabilities are PROJECTED from the relay's live published affordances, so a
 *     card can never advertise something the substrate does not actually serve,
 *   - errors render through the profile's own error table, so no internal detail
 *     reaches a caller (the relay audit's error-leak class),
 *   - the engagement store is bounded and owner-scoped by the engine.
 */

import type { Express, Request, Response } from 'express';
import {
  EngagementEngine, renderCard, capabilitiesFromAffordances, isEngineError, availableOperations,
  PROFILES,
  type Capability, type InteropProfile, type InteropErrorKind, type InteropOperation, type Part,
} from '@interego/agent-interop';

export interface AgentInteropDeps {
  /** Absolute public base URL of this relay. */
  publicBase: string;
  /** Agent identity for the card. */
  agent: { id: string; name: string; description: string; tenant?: string };
  /** The relay's LIVE affordance set. Called per card render so the card tracks
   *  what the substrate currently serves rather than a build-time snapshot. */
  affordances: () => ReadonlyArray<{
    action?: string; title?: string; label?: string; comment?: string;
    description?: string; vertical?: string; mediaType?: string; requiresAuth?: boolean;
  }>;
  /** The relay's own caller verification. Returns a stable principal id (DID/WebID)
   *  for a verified caller, or undefined. MUST NOT trust the request body. */
  verifyCaller: (req: Request) => Promise<string | undefined>;
  /** Declarative auth description rendered into the card. */
  auth?: { oauth2?: { metadataUrl: string; pkceRequired: boolean }; bearer?: boolean };
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  /**
   * Actually PERFORM a capability the card advertises.
   *
   * ★ Without this the interop surface was a promise it could not keep: the card
   * advertised 48 capabilities, a peer could ask for one, and the engagement sat in
   * its opening state forever because the mount never transitioned it. Advertising
   * what you cannot do is the failure this substrate exists to avoid.
   *
   * INJECTED rather than implemented here, and that is the security boundary. The
   * relay's own dispatcher already carries the authorization rules — which
   * capabilities need a verified caller, which are write-side, how identity is bound
   * to authorship. Re-deciding any of that here would mean a second copy of an
   * authorization policy, which is precisely how the audit's privilege bugs got in.
   * The mount asks; the relay decides and refuses.
   *
   * `caller` is the VERIFIED principal, never anything from the payload.
   * Resolves to the produced parts, or throws with a caller-safe reason.
   */
  invokeCapability?: (args: {
    capability: string;
    caller: string;
    parts: ReadonlyArray<Part>;
  }) => Promise<
    | { ok: true; output: { name?: string; description?: string; parts: Part[] } }
    | { ok: false; reason: string }
  >;
  log: (msg: string) => void;
}

/** Escape a literal for embedding in a RegExp route. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Render a profile-shaped error. Never echoes internal detail. */
function sendErr(res: Response, profile: InteropProfile, kind: InteropErrorKind, detail?: string): void {
  const spec = profile.errors[kind];
  res.status(spec.status).json({
    // `extra` first so a profile can never accidentally shadow code/message.
    error: { ...(spec.extra ?? {}), code: spec.code, message: spec.message, ...(detail ? { detail } : {}) },
  });
}

/**
 * Compile a profile path template into something Express can register.
 *
 * Three shapes appear in profile route tables:
 *   `/tasks/{id}`         → a plain Express param, `/tasks/:id`
 *   `/tasks/{id}:cancel`  → a CUSTOM METHOD: a literal `:cancel` after the id
 *   `/message:send`       → a CUSTOM METHOD with no id at all
 *
 * ★ A LITERAL COLON IN A PATH IS NEVER A PARAMETER, and the two custom shapes fail
 * in OPPOSITE ways when that is not handled — which is exactly why fixing the first
 * left the second in place.
 *
 *   `/tasks/:id:cancel` makes path-to-regexp THROW at registration ("Missing text
 *   before \"cancel\" param"), taking the relay down at boot. Loud. It got fixed.
 *
 *   `/message:send` does NOT throw. path-to-regexp reads `:send` as a PARAMETER
 *   NAME and compiles `^/<base>/message([^/]+)$` — so `/message:stream`,
 *   `/messageZZZ`, `/messages`, `/message%3Aanything` all reached the state-mutating
 *   send handler and created real, persisted engagements. Undeclared URLs mutating
 *   state, through a door that appears in no route table: the audit's own
 *   unbounded-state class, arrived at from a direction nobody was watching.
 *   Verified before fixing — `POST /<base>/messageZZZ` returned 200 and the
 *   engagement showed up in ListTasks.
 *
 * The lesson is one this repo had already written down and I still missed: when
 * fixing a class of defect, find EVERY instance of the sink pattern, not just the
 * one that announced itself. A crash is a gift; the silent sibling is the bug.
 *
 * So any template whose last segment carries a literal `:verb` compiles WHOLE to an
 * anchored RegExp — every literal escaped, `{id}` the only capture. Nothing but the
 * declared URL can match. Shared by wire AND declined routes so the two can never
 * disagree about what a path means.
 */
function compilePath(mountBase: string, template: string): string | RegExp {
  const hasCustomVerb = /:[A-Za-z][A-Za-z0-9_-]*$/.test(template);
  if (hasCustomVerb) {
    // A custom verb terminates the path, so the id is still bounded — but it may itself
    // contain slashes (see below), hence `.+?` rather than `[^/]+`, lazily so the trailing
    // `:verb` still wins.
    return new RegExp(`^${(mountBase + template).split('{id}').map(escapeRe).join('(.+?)')}$`);
  }
  if (!template.includes('{id}')) {
    return `${mountBase}${template.replace(/\{(\w+)\}/g, ':$1')}`;
  }
  // ★ AN ID THAT IS A URL DOES NOT FIT IN A PATH SEGMENT.
  //
  // Engagement ids here are absolute URLs, because every identifier is meant to be
  // dereferenceable. A wire profile that binds a lookup as `/resource/{id}` gets `:id` from
  // Express, which matches ONE segment — so a peer echoing back the very id it was handed
  // builds `/resource/https://host/engagements/abc` and receives a 404. Measured against a
  // running instance: percent-encoded returned 200, raw returned 404. A conformance suite
  // hid it behind an unrelated skip, so the surface looked green while a peer could not
  // dereference a resource it had just been given.
  //
  // Be strict in what we emit (a real URL) and liberal in what we accept: match across
  // segments so the raw and percent-encoded spellings reach the same resource.
  //
  // ★ EVERY placeholder, not just {id}. Splitting on `{id}` alone left a following
  // `{configId}` as a LITERAL in the pattern, so the per-config sub-route stopped matching
  // and answered 404 instead of its declared refusal. The string branch above had always
  // replaced all of them; the regex branch has to as well.
  //
  // Only {id} crosses segments — it is the one that holds a URL. Every other parameter
  // stays single-segment, so a stray slash cannot be absorbed into it.
  //
  // LAZY for {id}: a template may carry further segments after it, and a greedy `.+`
  // swallows them. `$`-anchored lazy still consumes the whole remainder when it is last.
  const pattern = (mountBase + template)
    .split(/(\{\w+\})/)
    .map(part => (part === '{id}' ? '(.+?)' : /^\{\w+\}$/.test(part) ? '([^/]+)' : escapeRe(part)))
    .join('');
  return new RegExp(`^${pattern}$`);
}

/**
 * The request PAYLOAD, unwrapped from whatever envelope the profile declares.
 *
 * ★ This is where a real correctness bug lived. The mount used to reach into a
 * hardcoded `body.message` for parts, while reading the continuation id from the
 * TOP level — two different answers to "where is the payload?" inside one handler.
 * A protocol that nests its request (`{envelope:{parts, continuationId}}`) then
 * had its parts found and its continuation id missed, so EVERY continuation opened
 * a new engagement instead of appending. Multi-turn was broken for every real
 * client, and the test that covered it passed because it sent the id at the level
 * the implementation happened to read — a test confirming the code rather than the
 * protocol.
 *
 * Both now resolve through the same declared member, so they cannot disagree again.
 */
function payloadOf(body: unknown, envelope: string | undefined): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!envelope) return b;
  const inner = b[envelope];
  // Tolerate an unwrapped body: some clients post the payload directly.
  return (inner && typeof inner === 'object' ? inner : b) as Record<string, unknown>;
}

/**
 * Extract content parts from a request payload without trusting anything else in it.
 *
 * ★ WHY THIS RETURNS A REASON, NOT JUST null. It used to drop any part shape it did
 * not recognise and then, if nothing survived, report "at least one content part is
 * required" — to a caller who had supplied several. Two failures at once: content
 * silently discarded, and an error message describing a different problem than the
 * one that occurred. A caller could not act on either.
 *
 * Inline binary is the case that exposed it. This substrate deliberately does NOT
 * accept bytes in a message: `Part` says so at the type — raw bytes are written to a
 * pod resource and referenced by URL, so inboxes stay small and bytes stay
 * dereferenceable. That is the everything-is-a-URL commitment, and it is a genuine
 * divergence from protocols that allow inline base64. The right answer to a
 * divergence is to state it, not to swallow the part and blame the caller.
 */
type PartsResult =
  | { ok: true; parts: Part[] }
  | { ok: false; reason: string };

/**
 * Narrow the failure arm. The relay compiles WITHOUT strictNullChecks, so `if
 * (!r.ok)` gives no discriminated-union narrowing here and a plain `.reason` access
 * fails to compile — the same reason `isEngineError` exists in the engine package. A
 * user-defined guard narrows regardless of that setting.
 */
function isPartsError(r: PartsResult): r is { ok: false; reason: string } {
  return r.ok === false;
}

function partsFrom(body: unknown, envelope?: string): PartsResult {
  const msg = payloadOf(body, envelope);
  const raw = msg['parts'];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: 'at least one content part is required' };
  }
  const parts: Part[] = [];
  let sawInlineBytes = false;
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    if (typeof o['text'] === 'string') parts.push({ kind: 'text', text: o['text'] });
    else if (o['data'] && typeof o['data'] === 'object') parts.push({ kind: 'data', data: o['data'] as Record<string, unknown> });
    else if (typeof o['url'] === 'string') parts.push({ kind: 'url', url: o['url'] });
    // A base64 member is inline bytes. Recognised precisely so it can be REFUSED
    // with its own reason rather than vanishing.
    else if (typeof o['raw'] === 'string' || typeof o['bytes'] === 'string') sawInlineBytes = true;
  }
  if (parts.length) return { ok: true, parts };
  if (sawInlineBytes) {
    return {
      ok: false,
      reason: 'inline binary content is not accepted; write the bytes to a resource and send a url part referencing it',
    };
  }
  return { ok: false, reason: 'no usable content part: expected one of text, data, or url' };
}

/** The engagement id, from either a named `:id` param or a RegExp capture group
 *  (custom-method routes compile to a RegExp, where Express exposes `params[0]`). */
function engagementIdFrom(req: Request): string {
  const p = req.params as unknown as Record<string, string>;
  const raw = String(p['id'] ?? p['0'] ?? '');
  // ★ decodeURIComponent ONLY if it is actually encoded. Our ids are URLs, so a raw one
  // arrives already containing `://` and slashes; decoding it again is harmless but
  // decoding a raw id that legitimately contains a `%` would corrupt it. Try, and keep the
  // original if the result is not a valid encoding.
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try { return decodeURIComponent(raw); } catch { return raw; }
}


/**
 * Emit the resource's followable next steps as RFC 8288 `Link` headers, and return
 * the engagement body.
 *
 * A representation that makes the client RECONSTRUCT the cancel URL from knowledge
 * of the protocol is resource-shaped but not hypermedia. The affordances come from
 * the profile, which derives them from the ENGINE's transition table — so a terminal
 * engagement advertises nothing, and nothing is advertised that the engine would
 * refuse.
 *
 * Link headers rather than body fields because a protocol whose body schema is
 * normatively closed (no invented top-level fields) can still be navigable this way
 * without violating its own schema. Profiles whose shape is ours to define ALSO
 * carry them in-body.
 */
function sendEngagement(
  res: Response, profile: InteropProfile, engagement: Parameters<InteropProfile['engagement']['render']>[0], base: string,
  operation?: InteropOperation,
): void {
  const available = availableOperations(engagement.state);
  const affordances = profile.engagement.affordances(engagement, { serviceUrl: base, available });
  const links = affordances.map(a => {
    // `iep:action` travels as the extension link relation: the relation itself is a
    // dereferenceable URL that resolves to the action's own description, rather than
    // a bare token the client must already understand.
    const rel = a.action;
    const m = a.method && a.method !== 'GET' ? `; method="${a.method}"` : '';
    const t = a.mediaType ? `; type="${a.mediaType}"` : '';
    return `<${a.target}>; rel="${rel}"${m}${t}`;
  });
  links.push(`<${engagement.id}>; rel="self"`);
  links.push(`<${base}${profile.card.wellKnownPath}>; rel="service-desc"`);
  links.push(`<${profile.id}>; rel="describedby"`);
  res.setHeader('Link', links.join(', '));
  if (profile.wireMediaType) res.type(profile.wireMediaType);
  const body = profile.engagement.render(engagement, { serviceUrl: base });
  // The profile may declare that THIS operation's response nests the resource under
  // a member name rather than returning it bare. The member name is opaque here —
  // the mount never learns why a given protocol wants one.
  const envelope = operation ? profile.responseEnvelope?.[operation] : undefined;
  res.status(200).json(envelope ? { [envelope]: body } : body);
}

export function mountAgentInterop(app: Express, deps: AgentInteropDeps): void {
  const base = deps.publicBase.replace(/\/$/, '');
  const engine = new EngagementEngine(base);

  const identityFor = (capabilities: Capability[]) => ({
    id: deps.agent.id,
    name: deps.agent.name,
    description: deps.agent.description,
    serviceUrl: base,
    ...(deps.agent.tenant ? { tenant: deps.agent.tenant } : {}),
    ...(deps.provider ? { provider: deps.provider } : {}),
    ...(deps.documentationUrl ? { documentationUrl: deps.documentationUrl } : {}),
    capabilities,
    ...(deps.auth ? { auth: deps.auth } : {}),
  });

  for (const profile of Object.values(PROFILES)) {
    // ── The card, at whatever well-known path the profile declares ──────────
    //
    // Public + CORS-open on purpose: a discovery document a peer cannot fetch
    // before authenticating is not discovery. It exposes only what the substrate
    // already publishes as followable affordances.
    app.get(profile.card.wellKnownPath, (req: Request, res: Response) => {
      try {
        const capabilities = capabilitiesFromAffordances(deps.affordances());
        const { document, version, mediaType } = renderCard(profile, identityFor(capabilities));
        const etag = `"${version}"`;
        res.setHeader('Access-Control-Allow-Origin', '*');
        // NOTE: `Access-Control-Expose-Headers` is deliberately NOT set here.
        //
        // It was, and it did nothing in production. A middleware in server.ts
        // freezes every `access-control-*` header (to stop the MCP SDK's
        // sub-routers re-opening the wildcard via their own `cors()` call), and
        // that freeze makes setHeader a SILENT no-op for those names. This
        // handler's version passed a test that boots the mount alone and was
        // absent from the live response — caught only by curling production after
        // deploying. Without it a browser reads the card body but not the `Link`
        // header telling it where to go next.
        //
        // It now lives in cors-allowlist.ts, in the same public carve-out that
        // decides these routes are world-readable — which is the right home for it
        // anyway: whatever declares a document public should declare what a public
        // reader may see.
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.setHeader('ETag', etag);
        // The discovery document describes ITSELF. A peer that fetches the card
        // can follow `describedby` to the published conformance profile — the
        // graph stating which protocol version and binding this implements, and
        // whether that conformance has actually been verified — instead of
        // needing to know out-of-band that such a description exists. Set before
        // the 304 return so a cached client keeps the pointer.
        res.setHeader('Link', [
          `<${base}${profile.card.wellKnownPath}>; rel="self"`,
          `<${profile.id}>; rel="describedby"`,
        ].join(', '));
        // The content-derived version IS the ETag, so a conditional request is
        // answered without re-serialising when capability has not changed.
        if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
        res.type(mediaType).send(JSON.stringify(document, null, 2));
      } catch (err) {
        deps.log(`[agent-interop] card render failed (${profile.slug}): ${(err as Error).message}`);
        sendErr(res, profile, 'internal');
      }
    });

    const mountBase = `${'/'}${profile.slug}/v1`;

    // ── Declared, and deliberately not implemented ───────────────────────────
    //
    // Registered FIRST so an unimplemented operation answers with the protocol's
    // own refusal rather than falling through to a generic 404. "No such URL" and
    // "that operation exists and this agent does not offer it" are different facts,
    // and a client cannot tell the second from a typo when it is told the first.
    //
    // These are refusals, not stubs — nothing here pretends the capability exists,
    // and the card still declares the capability false.
    for (const declined of profile.declinedRoutes ?? []) {
      const dPath = compilePath(mountBase, declined.path);
      const refuse = (_req: Request, res: Response): void => {
        res.status(declined.error.status).json({
          error: {
            ...(declined.error.extra ?? {}),
            code: declined.error.code,
            message: declined.error.message,
          },
        });
      };
      // Dispatch through a lookup rather than a chain, and FAIL LOUDLY if the host
      // app cannot register the verb: a declined route that silently failed to
      // register would 404 again, which is the exact confusion this removes.
      const register = {
        GET: app.get, POST: app.post,
        DELETE: (app as unknown as { delete?: typeof app.get }).delete,
      }[declined.method];
      if (typeof register !== 'function') {
        throw new Error(`[agent-interop] host app cannot register ${declined.method} (declined route ${declined.path})`);
      }
      register.call(app, dPath as never, refuse);
    }

    // ── The wire routes, generated from the profile's own route table ────────
    for (const route of profile.wire) {
      const path = compilePath(mountBase, route.path);
      const handler = async (req: Request, res: Response): Promise<void> => {
        try {
          // ── Protocol version, if this profile pins one ────────────────────
          //
          // Checked BEFORE authentication: a request in a version we do not speak
          // is unanswerable regardless of who sent it, and answering it anyway
          // hands the client a response shaped by rules it is not following. Both
          // the header name and the accepted values come from profile data, so
          // this enforces a version contract without naming a protocol.
          const vh = profile.versionHeader;
          if (vh) {
            const got = req.headers[vh.name.toLowerCase()];
            const v = Array.isArray(got) ? got[0] : got;
            if (v && !vh.supported.includes(v)) {
              sendErr(res, profile, 'unsupportedVersion'); return;
            }
          }

          // ── Request media type ────────────────────────────────────────────
          //
          // A body sent as something we cannot parse is 415, not 400: the request
          // may be perfectly valid in a format we do not accept, and a client that
          // can retry in another encoding needs to be told which of the two it is.
          const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (route.method === 'POST' && ctype && !/^application\/(\w[\w.+-]*\+)?json$/.test(ctype)) {
            sendErr(res, profile, 'unsupportedMediaType'); return;
          }

          const caller = await deps.verifyCaller(req);
          if (!caller) { sendErr(res, profile, 'unauthenticated'); return; }

          if (route.operation === 'sendMessage') {
            // ONE resolution of "where is the payload", used for everything below.
            // Splitting it was the bug: parts came from the envelope, the
            // continuation id from the top level, and they silently disagreed.
            const payload = payloadOf(req.body, profile.requestEnvelope);
            const got = partsFrom(req.body, profile.requestEnvelope);
            // The caller is told which of the several possible problems occurred.
            if (isPartsError(got)) { sendErr(res, profile, 'badRequest', got.reason); return; }
            const parts = (got as { ok: true; parts: Part[] }).parts;
            const capability = typeof payload['skillId'] === 'string' ? payload['skillId'] : undefined;
            // CONTINUATION vs NEW. The profile declares which member carries an existing
            // engagement's id; the mount never names a protocol's field. Without this
            // every send called engine.open(), so continuing a conversation silently
            // FORKED it into a second engagement. appendTurn is owner-scoped by the
            // engine, so a caller cannot append to someone else's engagement — a wrong or
            // guessed id is indistinguishable from a miss.
            const ref = profile.continuationField
              ? payload[profile.continuationField]
              : undefined;
            const r = typeof ref === 'string' && ref
              ? engine.appendTurn({ id: ref, caller, role: 'requester', parts })
              : engine.open({ caller, parts, ...(capability ? { capability } : {}) });
            if (isEngineError(r)) { sendErr(res, profile, r.error.kind, r.error.detail); return; }

            // ── Do the work, if a capability was named and we can perform it ──
            //
            // Synchronous on purpose for now: the engagement reaches a terminal
            // state within the request, so a peer gets a real answer rather than a
            // record it must poll. Streaming and long-running work are declared
            // false on the card and refused at their routes, so nothing here
            // pretends otherwise.
            const eng = (r as { ok: true; value: typeof r.value }).value;
            const cap = eng.capability;
            if (cap && deps.invokeCapability) {
              const began = engine.begin(eng.id, caller);
              if (isEngineError(began)) { sendErr(res, profile, began.error.kind, began.error.detail); return; }
              // ★ A DELIBERATE REFUSAL AND A CRASH ARE DIFFERENT FACTS, and only one
              // of them is safe to repeat to a caller. The invoker RETURNS a refusal
              // whose reason it has chosen to publish; anything THROWN is unexpected
              // and its message is internal.
              //
              // This distinction is structural rather than disciplined because the
              // first version relied on discipline and leaked immediately: it echoed
              // `(err as Error).message` for every failure, so the first live run
              // returned "Cannot read properties of undefined (reading 'endsWith')"
              // to an external peer — an internal stack detail, through a comment
              // that claimed this could not happen. The audit's error-leak class,
              // reintroduced by the very code documenting it.
              let outcome: { ok: true; output: { name?: string; description?: string; parts: Part[] } }
                | { ok: false; reason: string };
              try {
                outcome = await deps.invokeCapability({ capability: cap, caller, parts });
              } catch (err) {
                // Logged in full for us; the caller gets nothing internal.
                deps.log(`[agent-interop] capability ${cap} threw: ${(err as Error)?.message}`);
                outcome = { ok: false, reason: 'the capability could not be completed' };
              }
              // Either way the outcome is recorded ON the engagement and returned as
              // a completed exchange, not a transport error: the peer asked a valid
              // question and the answer is "that did not work".
              if (outcome.ok === false) {
                const failed = engine.fail({ id: eng.id, caller, reason: (outcome as { reason: string }).reason });
                if (isEngineError(failed)) { sendErr(res, profile, failed.error.kind); return; }
                sendEngagement(res, profile, (failed as { ok: true; value: typeof eng }).value, base, route.operation);
                return;
              }
              const done = engine.complete({
                id: eng.id, caller,
                outputs: [(outcome as { output: { name?: string; description?: string; parts: Part[] } }).output],
              });
              if (isEngineError(done)) { sendErr(res, profile, done.error.kind, done.error.detail); return; }
              sendEngagement(res, profile, (done as { ok: true; value: typeof eng }).value, base, route.operation);
              return;
            }

            sendEngagement(res, profile, eng, base, route.operation);
            return;
          }

          if (route.operation === 'getEngagement') {
            const r = engine.get(engagementIdFrom(req), caller);
            if (isEngineError(r)) { sendErr(res, profile, r.error.kind); return; }
            sendEngagement(res, profile, r.value, base, route.operation);
            return;
          }

          if (route.operation === 'listEngagements') {
            const limit = Number.parseInt(String(req.query['limit'] ?? '50'), 10);
            const r = engine.list(caller, Number.isFinite(limit) ? limit : 50);
            if (isEngineError(r)) { sendErr(res, profile, r.error.kind); return; }
            if (profile.wireMediaType) res.type(profile.wireMediaType);
            // The collection member name comes from the profile. This line used to
            // hardcode one particular protocol's field name in a mount that is
            // supposed to be spec-blind; the profile now declares it like every
            // other wire-shape decision.
            const member = profile.responseEnvelope?.[route.operation] ?? 'items';
            res.status(200).json({
              [member]: r.value.map(e => profile.engagement.render(e, { serviceUrl: base })),
            });
            return;
          }

          if (route.operation === 'cancelEngagement') {
            const r = engine.cancel(engagementIdFrom(req), caller);
            if (isEngineError(r)) { sendErr(res, profile, r.error.kind); return; }
            sendEngagement(res, profile, r.value, base, route.operation);
            return;
          }

          sendErr(res, profile, 'unsupportedOperation');
        } catch (err) {
          deps.log(`[agent-interop] ${profile.slug} ${route.operation} failed: ${(err as Error).message}`);
          sendErr(res, profile, 'internal');
        }
      };
      if (route.method === 'GET') app.get(path, handler);
      else app.post(path, handler);
    }

    deps.log(`[agent-interop] mounted profile "${profile.slug}" (${profile.protocolVersion}, ${profile.conformanceStatus}) — card ${profile.card.wellKnownPath}, ${profile.wire.length} operations under ${mountBase}`);
  }
}
