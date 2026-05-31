/**
 * CSS write-gate.
 *
 * The deployment's Community Solid Server is configured allow-all
 * (`css:config/ldp/authorization/allow-all.json`) — privacy of payload
 * is handled at the Interego client-side encryption layer, not at the
 * ACL layer. That's fine for confidentiality, but it lets anyone who
 * knows the pod URL inject junk descriptors.
 *
 * This gate sits in front of CSS and:
 *   GET / HEAD / OPTIONS  →  passthrough (anonymous reads stay open —
 *                            the pod-browser, federation discover(),
 *                            descriptor dereferencing all still work)
 *   POST / PUT / PATCH / DELETE  →  require Authorization: Bearer
 *                                   matching WRITE_SECRET; reject 401
 *                                   otherwise; strip header + forward
 *                                   to CSS (so CSS sees an anonymous
 *                                   write it accepts, but only authed
 *                                   callers reach this point).
 *
 * One env var: WRITE_SECRET — shared with the bridge + any seeder
 * tools that publish to the pod.
 *
 * No deps — uses Node 20+ built-in fetch.
 */

import { createServer } from 'http';
import { Readable } from 'stream';

const PORT = Number(process.env.PORT ?? 8080);
const CSS_INTERNAL_URL = process.env.CSS_INTERNAL_URL
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
// CSS validates that incoming requests' Host header matches its
// configured CSS_BASE_URL ("outside the configured identifier space"
// errors otherwise). When the gate connects to CSS at an internal
// hostname (after CSS is moved behind the gate), the Host header must
// stay the public hostname so CSS accepts. Defaults to the host of
// CSS_INTERNAL_URL when not set.
const CSS_HOST_HEADER = process.env.CSS_HOST_HEADER ?? null;
const WRITE_SECRET = process.env.WRITE_SECRET;

if (!WRITE_SECRET) {
  console.error('[css-gate] WRITE_SECRET env var is required');
  process.exit(1);
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Timing-safe string compare so wrong-key attempts don't leak length.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const server = createServer(async (req, res) => {
  const method = (req.method ?? 'GET').toUpperCase();

  // Health: anyone can hit /healthz on the gate itself (does NOT proxy).
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, gating: 'writes-only', upstream: CSS_INTERNAL_URL }));
    return;
  }

  // Write-method gate: require Authorization: Bearer <WRITE_SECRET>.
  if (WRITE_METHODS.has(method)) {
    const auth = req.headers['authorization'] ?? '';
    const expected = `Bearer ${WRITE_SECRET}`;
    if (!safeEqual(auth, expected)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="interego-css-gate"',
      });
      res.end(JSON.stringify({
        error: 'anonymous writes denied',
        detail: `${method} requires Authorization: Bearer <WRITE_SECRET>; reads (GET/HEAD/OPTIONS) remain anonymous.`,
      }));
      return;
    }
    // Strip the bearer before forwarding so CSS doesn't try to parse it
    // as a DPoP/OIDC token. CSS is allow-all behind the gate; auth is
    // the gate's job, not CSS's.
    delete req.headers['authorization'];
  }

  // Proxy through.
  const upstreamUrl = `${CSS_INTERNAL_URL.replace(/\/+$/, '')}${req.url}`;
  // Forward headers. Host header gets explicitly rewritten — to
  // CSS_HOST_HEADER if set (the public hostname CSS thinks it lives at,
  // per CSS_BASE_URL), else the host of the internal URL. The former
  // is required when CSS is behind the gate at an internal hostname
  // but still has CSS_BASE_URL set to its original public URL — CSS
  // rejects requests whose Host doesn't match its baseUrl space.
  const headers = { ...req.headers };
  try {
    const u = new URL(CSS_INTERNAL_URL);
    headers['host'] = CSS_HOST_HEADER ?? u.host;
  } catch { /* ignore */ }

  // Build the upstream request body: only methods that can have one.
  //
  // We BUFFER the body instead of streaming via `Readable.toWeb(req)`.
  // Streaming the duplex='half' request through Node fetch to Azure
  // Container Apps' ingress hangs for bodies > a few KB and eventually
  // returns 504 "stream timeout" — the failure mode is consistent for
  // string-body fetches from the client through here. Buffering keeps
  // the request a normal HTTP/1.1 PUT with Content-Length, which Azure
  // proxies cleanly. Trade-off: each request holds its body in memory.
  // The gate fronts CSS for Interego descriptor / manifest writes —
  // bounded to descriptor + manifest sizes, well under any sane limit.
  let upstreamBody;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = Buffer.concat(chunks);
    // Set Content-Length explicitly so fetch doesn't fall back to chunked.
    headers['content-length'] = String(upstreamBody.length);
    delete headers['transfer-encoding'];
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: upstreamBody,
      redirect: 'manual',
    });
  } catch (err) {
    console.error('[css-gate] upstream fetch failed:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream CSS unreachable', detail: err.message }));
    return;
  }

  // Mirror response back to the client.
  const responseHeaders = {};
  upstreamRes.headers.forEach((v, k) => { responseHeaders[k] = v; });
  res.writeHead(upstreamRes.status, responseHeaders);
  if (upstreamRes.body) {
    Readable.fromWeb(upstreamRes.body).pipe(res);
  } else {
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[css-gate] listening on :${PORT}`);
  console.log(`[css-gate] upstream: ${CSS_INTERNAL_URL}`);
  console.log(`[css-gate] write methods (POST/PUT/PATCH/DELETE) require Authorization: Bearer <WRITE_SECRET>`);
  console.log(`[css-gate] read methods (GET/HEAD/OPTIONS) pass through anonymously`);
});
