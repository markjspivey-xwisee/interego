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
  type Capability, type InteropProfile, type InteropErrorKind, type Part,
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
    error: { code: spec.code, message: spec.message, ...(detail ? { detail } : {}) },
  });
}

/** Extract content parts from a request body without trusting anything else in it.
 *  Unknown members are ignored rather than reflected. */
function partsFrom(body: unknown): Part[] | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const msg = (b['message'] ?? b) as Record<string, unknown>;
  const raw = msg['parts'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts: Part[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    if (typeof o['text'] === 'string') parts.push({ kind: 'text', text: o['text'] });
    else if (o['data'] && typeof o['data'] === 'object') parts.push({ kind: 'data', data: o['data'] as Record<string, unknown> });
    else if (typeof o['url'] === 'string') parts.push({ kind: 'url', url: o['url'] });
  }
  return parts.length ? parts : null;
}

/** The engagement id, from either a named `:id` param or a RegExp capture group
 *  (custom-method routes compile to a RegExp, where Express exposes `params[0]`). */
function engagementIdFrom(req: Request): string {
  const p = req.params as unknown as Record<string, string>;
  return decodeURIComponent(String(p['id'] ?? p['0'] ?? ''));
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
  res.status(200).json(profile.engagement.render(engagement, { serviceUrl: base }));
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
        // Without this, a BROWSER client gets the card body but cannot read a
        // single one of the headers below: the CORS default exposes only a short
        // safelist, and neither Link nor ETag is on it. The conditional-request
        // path the ETag exists for, and the profile pointer the card is described
        // by, were both invisible to exactly the client class that needs an
        // unauthenticated discovery document in the first place.
        res.setHeader('Access-Control-Expose-Headers', 'Link, ETag');
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

    // ── The wire routes, generated from the profile's own route table ────────
    const mountBase = `${'/'}${profile.slug}/v1`;
    for (const route of profile.wire) {
      // Path conversion. Two shapes appear in profile route tables:
      //   `/tasks/{id}`         → a plain Express param, `/tasks/:id`
      //   `/tasks/{id}:cancel`  → an AIP-style CUSTOM METHOD: a literal `:cancel`
      //                           suffix after the id.
      // The second CANNOT be expressed as `/tasks/:id:cancel` — path-to-regexp
      // reads the suffix as a second parameter and THROWS at registration
      // ("Missing text before \"cancel\" param"), which would take the relay down
      // at boot rather than merely mis-route. So a custom-method route is compiled
      // to an explicit RegExp, where the id is a capture group.
      const custom = /\{id\}:([A-Za-z][A-Za-z0-9_-]*)$/.exec(route.path);
      const path: string | RegExp = custom
        ? new RegExp(`^${escapeRe(mountBase + route.path.slice(0, custom.index))}([^/]+):${custom[1]}$`)
        : `${mountBase}${route.path.replace(/\{id\}/g, ':id')}`;
      const handler = async (req: Request, res: Response): Promise<void> => {
        try {
          const caller = await deps.verifyCaller(req);
          if (!caller) { sendErr(res, profile, 'unauthenticated'); return; }

          if (route.operation === 'sendMessage') {
            const parts = partsFrom(req.body);
            if (!parts) { sendErr(res, profile, 'badRequest', 'at least one content part is required'); return; }
            const capability = typeof (req.body ?? {}).skillId === 'string' ? (req.body as { skillId: string }).skillId : undefined;
            // CONTINUATION vs NEW. The profile declares which body member carries an
            // existing engagement's id; the mount never names a protocol's field. Without
            // this every send called engine.open(), so continuing a conversation silently
            // FORKED it into a second engagement. appendTurn is owner-scoped by the
            // engine, so a caller cannot append to someone else's engagement — a wrong or
            // guessed id is indistinguishable from a miss.
            const ref = profile.continuationField
              ? (req.body ?? {})[profile.continuationField]
              : undefined;
            const r = typeof ref === 'string' && ref
              ? engine.appendTurn({ id: ref, caller, role: 'requester', parts })
              : engine.open({ caller, parts, ...(capability ? { capability } : {}) });
            if (isEngineError(r)) { sendErr(res, profile, r.error.kind, r.error.detail); return; }
            sendEngagement(res, profile, r.value, base);
            return;
          }

          if (route.operation === 'getEngagement') {
            const r = engine.get(engagementIdFrom(req), caller);
            if (isEngineError(r)) { sendErr(res, profile, r.error.kind); return; }
            sendEngagement(res, profile, r.value, base);
            return;
          }

          if (route.operation === 'listEngagements') {
            const limit = Number.parseInt(String(req.query['limit'] ?? '50'), 10);
            const r = engine.list(caller, Number.isFinite(limit) ? limit : 50);
            if (isEngineError(r)) { sendErr(res, profile, r.error.kind); return; }
            if (profile.wireMediaType) res.type(profile.wireMediaType);
            res.status(200).json({ tasks: r.value.map(e => profile.engagement.render(e, { serviceUrl: base })) });
            return;
          }

          if (route.operation === 'cancelEngagement') {
            const r = engine.cancel(engagementIdFrom(req), caller);
            if (isEngineError(r)) { sendErr(res, profile, r.error.kind); return; }
            sendEngagement(res, profile, r.value, base);
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
