# http-guard

Non-normative shared implementation for vertical bridges. Four small pieces a public HTTP
surface needs before its own routes run. None of them imports a web framework, so the same
code serves a plain `node:http` server and an express app.

| Export | What it is |
| --- | --- |
| `RateLimiter`, `clientKey`, `foldAddress` | Fixed-window limit per client. The client is an address: IPv4 whole, IPv6 folded to its /56, anything unparseable counted together as `unknown`. With `trustProxy` the address is the last `X-Forwarded-For` entry (the one the nearest proxy wrote); without it, the socket peer. The table of windows has its own ceiling. |
| `bound(map, max)` | Drop the oldest entries of a `Map` until it holds at most `max`. For tables a caller can fill before being verified. |
| `publicOrigin(value)` | A configured public URL must be an origin and nothing else: https, or http only for `localhost` / `127.0.0.1`. Throws `PublicUrlError` saying what is wrong. |
| `healthBody({ service, build, status, extra })` | The `/health` body. `build` is the field `tools/railway-redeploy.mjs` compares with the commit it deployed; it is `unset` when none was given. |

## Adopting it in a bridge

```ts
import { RateLimiter, clientKey, healthBody, publicOrigin } from '../../_shared/http-guard/index.js';

const origin = publicOrigin(configuredPublicUrl);          // refuses to start on a bad value
const limiter = new RateLimiter();
const RULE = { limit: 120, windowMs: 60_000 };

// node:http
const who = clientKey(req.headers['x-forwarded-for'], req.socket.remoteAddress, trustProxy);
const verdict = limiter.take('write', who, RULE);
if (!verdict.ok) { res.setHeader('Retry-After', String(verdict.retryAfterSeconds)); /* answer 429 */ }

// express: the same call inside a middleware
app.use((req, res, next) => {
  const v = limiter.take('write', clientKey(req.headers['x-forwarded-for'], req.socket.remoteAddress, trustProxy), RULE);
  if (v.ok) next(); else res.status(429).set('Retry-After', String(v.retryAfterSeconds)).json({ error: 'rate-limited' });
});

// GET /health
send(200, healthBody({ service: 'my-bridge', build: buildSha, extra: { startedAt } }));
```

Read environment variables in the bridge's entry file and pass the values in; nothing here
reads `process.env`.

## Who uses it

`applications/coached-world` (where these pieces were first written). Foxxi's bridge still uses
`express-rate-limit` for its own routes; that was left as it is. This module is shaped so those
limiters could move to it one route at a time: `take(name, client, rule)` is the whole contract,
and the name keeps one route's windows apart from another's.

Tests: `applications/_shared/tests/http-guard.test.ts`.
