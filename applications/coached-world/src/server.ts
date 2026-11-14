/**
 * HTTP surface for one coached world. Guests are provisional-play owners.
 * The page, the feed and the leaderboard are this process; the graphs are
 * the Interego record of the same state.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlayError } from '../../../deploy/identity/provisional-play.js';
import { PlayGrantError } from '../../foxxi-content-intelligence/src/play-grant.js';
import { affordancesManifestTurtle } from '../../_shared/affordance-mcp/index.js';
import { WorldError } from './errors.js';
import { createLocalDoor, createRelayDoor, type GuestDoor } from './guest-play.js';
import { HttpLrs } from './lrs.js';
import { loadPackFile } from './pack.js';
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
  readonly url: string;
  readonly world: CoachedWorld;
  close(): Promise<void>;
}

export async function start(opts: {
  readonly port?: number; readonly host?: string; readonly packPath?: string;
  readonly bots?: boolean; readonly tick?: boolean; readonly botMs?: number; readonly forceLocal?: boolean;
} = {}): Promise<Running> {
  const host = opts.host ?? '127.0.0.1';
  const pack = loadPackFile(opts.packPath ?? join(dirname(fileURLToPath(import.meta.url)), '../packs/mandate.json'));
  const sessions = new Map<string, string>();
  const challenges = new Map<string, number>();
  const live: { door?: GuestDoor; world?: CoachedWorld; timer?: ReturnType<typeof setInterval> } = {};

  const server = createServer(async (req, res) => {
    try {
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
  const origin = `http://${host}:${address.port}`;
  const relayKey = process.env['CPW_PLAY_SERVICE_PRIVATE_KEY'];
  const relayAudience = process.env['CPW_PLAY_AUDIENCE'];
  const identityUrl = process.env['CPW_IDENTITY_URL'];
  live.door = !opts.forceLocal && relayKey && relayAudience && identityUrl
    ? createRelayDoor({ audience: relayAudience, identityUrl, relayUrl: process.env['CPW_RELAY_URL'] ?? 'https://relay.interego.xwisee.com', servicePrivateKey: relayKey })
    : createLocalDoor(origin);
  const lrsUrl = process.env['CPW_LRS_URL'];
  const world = await CoachedWorld.create({
    pack, base: `${origin}/`, didHost: didHost(origin),
    ...(lrsUrl ? { lrs: new HttpLrs(lrsUrl, process.env['CPW_LRS_AUTHORIZATION']), actorHomePage: process.env['CPW_LRS_ACTOR_HOME'] } : {}),
  });
  live.world = world;
  if (opts.bots !== false) {
    const ms = opts.botMs ?? 4_000;
    if (ms > 0) live.timer = setInterval(() => { void world.exclusive(() => world.tick()).catch(() => undefined); }, ms);
  }
  return {
    url: origin, world,
    close: () => new Promise(resolve => { if (live.timer) clearInterval(live.timer); server.close(() => resolve()); }),
  };
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
    ctx.challenges.set(challenge, Date.now() + 120_000);
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
    const graphs = await ctx.world.exclusive(() => ctx.world.graphs());
    send(res, 200, { graphs: graphs.map(g => ({ id: g.id, kind: g.kind, version: g.version, turtle: g.turtle, graph: g.graph, canonical: g.canonical, signature: g.signature, supersedes: g.supersedes ?? null })) });
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
  const known = writes && ['/faction', '/missions', '/missions/intervene', '/market/transfer', '/pacts', '/gate/refresh'].includes(url.pathname);
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
