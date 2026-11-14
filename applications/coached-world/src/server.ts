/**
 * HTTP surface for one coached world. Guests are provisional-play owners.
 * The page, the feed and the leaderboard are this process; the graphs are
 * the Interego record of the same state.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { PlayError } from '../../../deploy/identity/provisional-play.js';
import { PlayGrantError } from '../../foxxi-content-intelligence/src/play-grant.js';
import { affordancesManifestTurtle } from '../../_shared/affordance-mcp/index.js';
import { WorldError } from './errors.js';
import { MAX_CHALLENGES, MAX_SESSIONS, bound } from './bounded.js';
import { createLocalDoor, createRelayDoor, type GuestDoor } from './guest-play.js';
import { FoxxiCourseLauncher } from './course-launch.js';
import { HttpLrs } from './lrs.js';
import { loadPackFile } from './pack.js';
import { publicOrigin } from './public-url.js';
import { RATE_RULES, RateLimiter, clientKey, rateClassFor } from './rate-limit.js';
import { CoachedWorld } from './world.js';
import { AFFORDANCES } from '../affordances.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '../public');
const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/guest.js': { file: 'guest.js', type: 'text/javascript; charset=utf-8' },
};

export interface Running {
  /** Where this process listens. */
  readonly url: string;
  /** What the world calls itself: the public URL when one was given, otherwise `url`. */
  readonly origin: string;
  readonly world: CoachedWorld;
  close(): Promise<void>;
}

/** What `GET /health` answers. `build` is the field the deploy verifier compares with the commit it shipped. */
interface Health {
  readonly build: string;
  readonly startedAt: string;
  readonly pack: { readonly id: string; readonly title: string };
}

export async function start(opts: {
  readonly port?: number; readonly host?: string; readonly packPath?: string;
  readonly bots?: boolean; readonly tick?: boolean; readonly botMs?: number; readonly forceLocal?: boolean;
  /**
   * The origin people reach this world at, when it is not the listen address (behind a proxy).
   * It becomes the guest audience, the bootstrap address, the base of every graph IRI and the
   * DID host. Unset, all of those are the listen address, as before.
   */
  readonly publicUrl?: string;
  /**
   * Read the caller's address from the last entry of `X-Forwarded-For`. Defaults to whether a
   * public URL was given: a process with one is behind a proxy, and one without is not.
   */
  readonly trustProxy?: boolean;
  /** The clock the request limits read. For tests. */
  readonly now?: () => number;
} = {}): Promise<Running> {
  const host = opts.host ?? '127.0.0.1';
  // Checked before anything listens: a public URL that is wrong is a refusal to start.
  const publicUrl = opts.publicUrl ? publicOrigin(opts.publicUrl) : undefined;
  const trustProxy = opts.trustProxy ?? publicUrl !== undefined;
  // With a public URL the guest audience is that URL: it is what the browser's proofs name and
  // what identity has this application registered under. A different value could not work, so
  // it is refused here instead of at the first guest.
  const statedAudience = process.env['CPW_PLAY_AUDIENCE'];
  if (!opts.forceLocal && publicUrl && statedAudience && statedAudience !== publicUrl) {
    throw new Error(`CPW_PLAY_AUDIENCE (${statedAudience}) is not the public URL (${publicUrl}). Unset it, or make them the same.`);
  }
  const pack = loadPackFile(opts.packPath ?? join(dirname(fileURLToPath(import.meta.url)), '../packs/mandate.json'));
  const sessions = new Map<string, string>();
  const challenges = new Map<string, number>();
  const limiter = new RateLimiter(opts.now);
  const health: Health = {
    build: process.env['INTEREGO_BUILD_SHA'] || 'unset',
    startedAt: new Date().toISOString(),
    pack: { id: pack.id, title: pack.title },
  };
  const live: { door?: GuestDoor; world?: CoachedWorld; timer?: ReturnType<typeof setInterval> } = {};

  const server = createServer(async (req, res) => {
    try {
      // Before anything that can throw or read a body, so a refusal carries it too.
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      // The deploy verifier asks this as soon as the port is bound, so it answers before the
      // world exists, needs no session, and is not counted against anyone's limit.
      if (req.method === 'GET' && pathname === '/health') {
        send(res, 200, {
          status: live.world ? 'ok' : 'starting', build: health.build, service: 'coached-world-bridge',
          startedAt: health.startedAt, pack: health.pack, consultants: live.world?.consultantCount ?? 0,
          door: live.door ? (live.door.local ? 'local' : 'relay') : null,
        });
        return;
      }
      const limit = rateClassFor(req.method, pathname);
      if (limit) {
        const verdict = limiter.take(limit, clientKey(req.headers['x-forwarded-for'], req.socket.remoteAddress, trustProxy), RATE_RULES[limit]);
        if (!verdict.ok) {
          res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
          // The body is not read: the connection is closed after the answer instead.
          res.setHeader('Connection', 'close');
          send(res, 429, { error: 'rate-limited', retryAfterSeconds: verdict.retryAfterSeconds });
          return;
        }
      }
      if (!live.door || !live.world) { send(res, 503, { error: 'starting' }); return; }
      await route(req, res, { door: live.door, world: live.world, sessions, challenges, tick: opts.tick === true });
    } catch (error) {
      if (error instanceof WorldError) send(res, error.status, { error: error.code, detail: error.message });
      else if (error instanceof PlayError) send(res, error.status, { error: error.code });
      else if (error instanceof PlayGrantError) send(res, error.status, { error: error.code });
      else send(res, 500, { error: 'internal' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  const origin = publicUrl ?? url;
  const relayKey = process.env['CPW_PLAY_SERVICE_PRIVATE_KEY'];
  const identityUrl = process.env['CPW_IDENTITY_URL'];
  const relayAudience = statedAudience || publicUrl;
  live.door = !opts.forceLocal && relayKey && relayAudience && identityUrl
    ? createRelayDoor({ audience: relayAudience, identityUrl, relayUrl: process.env['CPW_RELAY_URL'] ?? 'https://relay.interego.xwisee.com', servicePrivateKey: relayKey })
    : createLocalDoor(origin);
  const lrsUrl = process.env['CPW_LRS_URL'];
  const launcher = launchLauncher();
  const world = await CoachedWorld.create({
    pack, base: `${origin}/`, didHost: didHost(origin),
    ...(lrsUrl ? { lrs: new HttpLrs(lrsUrl, process.env['CPW_LRS_AUTHORIZATION']), actorHomePage: process.env['CPW_LRS_ACTOR_HOME'] } : {}),
    ...(launcher ? { launcher } : {}),
  });
  live.world = world;
  if (opts.bots !== false) {
    const ms = opts.botMs ?? 4_000;
    if (ms > 0) live.timer = setInterval(() => { void world.exclusive(() => world.tick()).catch(() => undefined); }, ms);
  }
  return {
    url, origin, world,
    close: () => new Promise(resolve => { if (live.timer) clearInterval(live.timer); server.close(() => resolve()); }),
  };
}

function launchLauncher(): FoxxiCourseLauncher | undefined {
  const url = process.env['CPW_FOXXI_LAUNCH_URL'];
  const key = process.env['CPW_FOXXI_LAUNCH_KEY'];
  if (!url || !key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined;
  const wallet = new Wallet(key);
  return new FoxxiCourseLauncher(url, async payload => {
    const message = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    return wallet.signMessage(message);
  });
}

function didHost(origin: string): string {
  const url = new URL(origin);
  return url.port ? `${url.hostname}%3A${url.port}` : url.hostname;
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: {
  door: GuestDoor; world: CoachedWorld; sessions: Map<string, string>; challenges: Map<string, number>; tick: boolean;
}): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = FILES[url.pathname];
  if (req.method === 'GET' && file) {
    res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store', 'Content-Security-Policy': csp(ctx.door) });
    res.end(readFileSync(join(PUBLIC, file.file)));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/play/guest') {
    send(res, 200, { enabled: true, audience: ctx.door.audience, identityUrl: ctx.door.identityUrl, bootstrapUrl: `${ctx.door.identityUrl}/play/provisional`, local: ctx.door.local });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/play/grant') {
    const body = await readJson(req);
    const thumbprint = body['publicKeyThumbprint'];
    const challenge = body['challenge'];
    if (typeof thumbprint !== 'string' || typeof challenge !== 'string') throw new WorldError(400, 'invalid_play_grant_request');
    send(res, 200, await ctx.door.grant(thumbprint, challenge));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/play/provisional') {
    if (!ctx.door.bootstrap) throw new WorldError(404, 'use-identity');
    send(res, 200, await ctx.door.bootstrap(await readJson(req)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/session/challenge') {
    const challenge = randomBytes(32).toString('base64url');
    const now = Date.now();
    // Nobody is signed in yet, so this table is bounded here: what has expired goes, and past the
    // cap the oldest goes, so asking for challenges cannot grow the process without limit.
    for (const [issued, expires] of ctx.challenges) if (expires < now) ctx.challenges.delete(issued);
    bound(ctx.challenges, MAX_CHALLENGES - 1);
    ctx.challenges.set(challenge, now + 120_000);
    send(res, 200, { challenge });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/session') {
    const body = await readJson(req);
    const challenge = body['challenge'];
    if (typeof challenge !== 'string' || (ctx.challenges.get(challenge) ?? 0) < Date.now()) throw new PlayError(401, 'invalid_browser_proof');
    ctx.challenges.delete(challenge);
    const guest = await ctx.door.verify({ ...body, audience: ctx.door.audience });
    const consultant = await ctx.world.exclusive(() => ctx.world.admit(guest));
    const token = randomBytes(32).toString('base64url');
    bound(ctx.sessions, MAX_SESSIONS - 1);
    ctx.sessions.set(token, consultant.id);
    send(res, 200, { token, ownerDid: guest.ownerDid, name: consultant.name });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/world') {
    const id = who(req, ctx.sessions);
    send(res, 200, await ctx.world.exclusive(() => ctx.world.view(id)));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/profile') { send(res, 200, ctx.world.profile); return; }
  if (req.method === 'GET' && url.pathname === '/graphs') {
    // The newest graphs only: older ones are dropped, and the answer says how many. A `supersedes`
    // may name one of those; it is still that descriptor's IRI.
    const { graphs, stats } = await ctx.world.exclusive(() => ({ graphs: [...ctx.world.graphs()], stats: ctx.world.graphStats() }));
    send(res, 200, {
      retained: stats.retained, dropped: stats.dropped,
      graphs: graphs.map(g => ({ id: g.id, kind: g.kind, version: g.version, turtle: g.turtle, graph: g.graph, canonical: g.canonical, signature: g.signature, supersedes: g.supersedes ?? null })),
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/affordances') {
    if (req.headers.accept?.includes('text/turtle')) {
      res.writeHead(200, { 'Content-Type': 'text/turtle; charset=utf-8' });
      res.end(affordancesManifestTurtle(`${ctx.door.audience}/affordances`, AFFORDANCES, ctx.door.audience, { verticalLabel: 'Coached world' }));
      return;
    }
    send(res, 200, { affordances: AFFORDANCES });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/tick') {
    if (!ctx.tick) throw new WorldError(404, 'tick-closed');
    send(res, 200, await ctx.world.exclusive(() => ctx.world.tick()));
    return;
  }
  const writes = req.method === 'POST' || req.method === 'DELETE';
  const known = writes && ['/faction', '/missions', '/missions/intervene', '/market/transfer', '/pacts', '/gate/launch', '/gate/refresh'].includes(url.pathname);
  if (!known) { send(res, 404, { error: 'not-found' }); return; }
  const id = who(req, ctx.sessions);
  if (!id) throw new WorldError(401, 'sign-in');
  const body = await readJson(req);
  if (req.method === 'POST' && url.pathname === '/faction') {
    const factionId = text(body, 'factionId');
    send(res, 200, await ctx.world.exclusive(async () => { await ctx.world.joinFaction(id, factionId); return ctx.world.view(id); }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/missions') {
    send(res, 200, await ctx.world.exclusive(() => ctx.world.startMission(id)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/missions/intervene') {
    send(res, 200, await ctx.world.exclusive(() => ctx.world.intervene(id, text(body, 'diagnosis'), text(body, 'interventionId'))));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/market/transfer') {
    send(res, 200, await ctx.world.exclusive(() => ctx.world.transfer(id, text(body, 'agentId'))));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/pacts') {
    send(res, 200, await ctx.world.exclusive(() => ctx.world.proposePact(id, text(body, 'factionId'))));
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/pacts') {
    send(res, 200, await ctx.world.exclusive(() => ctx.world.dissolvePact(id, text(body, 'factionId'))));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/gate/launch') {
    send(res, 200, await ctx.world.exclusive(() => ctx.world.launchGate(id)));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/gate/refresh') {
    send(res, 200, await ctx.world.exclusive(() => ctx.world.refreshGate(id)));
    return;
  }
  send(res, 404, { error: 'not-found' });
}

function who(req: IncomingMessage, sessions: Map<string, string>): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return sessions.get(header.slice(7));
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value) throw new WorldError(400, 'missing-field', key);
  return value;
}

function csp(door: GuestDoor): string {
  const connect = door.identityUrl === door.audience ? "'self'" : `'self' ${door.identityUrl}`;
  return `default-src 'self'; script-src 'self'; style-src 'self'; connect-src ${connect}; img-src 'self' data:`;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 262_144) throw new WorldError(413, 'body-too-large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WorldError(400, 'json-object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorldError) throw error;
    throw new WorldError(400, 'invalid-json');
  }
}
