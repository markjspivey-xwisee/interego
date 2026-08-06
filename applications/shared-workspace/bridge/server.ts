/**
 * shared-workspace bridge — the runtime a workspace member that is an AGENT runs in.
 *
 * ── WHY A SERVICE AND NOT A LIBRARY CALL ─────────────────────────────────────
 *
 * `applications/shared-workspace/src/` has had both halves — `readStream` and `appendEntry`
 * — since increment 2, and every caller of them until now has been a script holding a
 * human's bearer token. That demonstrates the substrate and it does not demonstrate an
 * agent: a script a person runs writes what the person told it to.
 *
 * A member that is an agent needs three things a library cannot have on its own: an
 * identity of its own (a wallet, here, in `WSP_AGENT_PRIVATE_KEY`), a place to keep the key
 * where no caller can reach it, and an address a caller can poke without being handed the
 * key. That is a process with an HTTP surface, which is what this is.
 *
 * ★ WHAT THE OPERATOR OF THIS PROCESS CAN AND CANNOT DO, stated plainly because the whole
 * comparison this vertical exists to make turns on it. Whoever runs this container holds
 * the agent's key and could therefore write the agent's log — the same way whoever holds
 * your laptop could write yours. What they CANNOT do is write anybody else's: the substrate
 * resolves this wallet to one pod and refuses writes elsewhere with `scope_violation`. The
 * agent's records live on the agent's pod, signed by the agent's key, readable and
 * auditable by anyone, and they outlive both this container and this workspace. That is the
 * difference from a design where every participant is a row in one server's database and
 * the server's own authorization vector does not distinguish between them.
 *
 * Run:
 *   PORT=6070 \
 *   WSP_AGENT_PRIVATE_KEY=0x… \
 *   WSP_RELAY_URL=https://relay.interego.xwisee.com \
 *   WSP_IDENTITY_URL=https://identity.interego.xwisee.com \
 *   BRIDGE_DEPLOYMENT_URL=https://wsp-bridge.example \
 *     npx tsx applications/shared-workspace/bridge/server.ts
 */

import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { wspAffordances } from '../affordances.js';
import { openAgentSession, type AgentSession } from '../src/agent-session.js';
import { respondAsMember } from '../src/respond.js';

const PORT = parseInt(process.env['PORT'] ?? '6070', 10);
const RELAY = (process.env['WSP_RELAY_URL'] ?? 'https://relay.interego.xwisee.com').replace(/\/$/, '');
const IDENTITY = (process.env['WSP_IDENTITY_URL'] ?? 'https://identity.interego.xwisee.com').replace(/\/$/, '');
const KEY = process.env['WSP_AGENT_PRIVATE_KEY'] ?? '';

/**
 * The session is opened once and reused.
 *
 * ★ AND A FAILED OPEN IS NOT CACHED. An earlier shape of this memoised the promise, so one
 * transient identity-server blip left the process permanently unable to be its own member,
 * answering the same stale error to every request until somebody restarted it. A rejection
 * clears the slot; a success does not.
 */
let sessionPromise: Promise<AgentSession> | null = null;
function session(): Promise<AgentSession> {
  if (KEY === '') {
    return Promise.reject(new Error(
      'WSP_AGENT_PRIVATE_KEY is unset, so this process holds no identity and is not a member of '
      + 'anything. It will not fall back to another identity: an agent that borrows one is not the '
      + 'author of what it writes.',
    ));
  }
  sessionPromise ??= openAgentSession({ privateKey: KEY, relay: RELAY, identityHost: IDENTITY })
    .catch((e: unknown) => { sessionPromise = null; throw e; });
  return sessionPromise;
}

const handlers = {
  'wsp.respond_as_member': async (args: Record<string, unknown>) => {
    const workspace = typeof args['workspace'] === 'string' ? args['workspace'].trim() : '';
    if (workspace === '') throw new Error('workspace is required — the agent is told WHICH channel and nothing else');
    if (!/^https:\/\/[^\s<>"]+$/.test(workspace)) {
      throw new Error(`workspace must be an https IRI this reader can dereference, got: ${workspace.slice(0, 120)}`);
    }
    const slug = typeof args['slug'] === 'string' && args['slug'] !== '' ? args['slug'] : undefined;
    const s = await session();
    const result = await respondAsMember(s, { workspace, ...(slug !== undefined ? { slug } : {}) });
    // The identity is reported so a caller can see WHICH pod answered without being able to
    // influence it. The key is never in this object, and there is no branch that puts it there.
    return {
      agent: {
        pod: s.identity.podName,
        podUrl: s.identity.podUrl,
        webId: s.identity.webId,
        agentDid: s.identity.agentDid,
        delegatedScope: s.identity.scope,
        address: s.identity.address,
      },
      ...result,
    };
  },
};

const app = createVerticalBridge({
  verticalName: 'shared-workspace',
  affordances: wspAffordances,
  handlers,
  middleware: (a) => {
    // The page that triggers this is a published Artifact on claude.ai, and its call goes
    // through the relay's affordance follower rather than the browser — but a direct browser
    // probe of /affordances is how anybody checks what this thing advertises, so the manifest
    // and the entry point answer CORS. The capability itself is reached through the relay.
    a.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.status(204).end(); return; }
      next();
    });
    // ★ Reports whether this process HOLDS an identity, and never what it is. A deploy that
    // landed without its key looks identical to a healthy one at /health — the factory's
    // healthcheck answers before any of this — and the failure then surfaces as a refusal on
    // the first real call, minutes later, to whoever happened to click.
    a.get('/wsp/identity', (_req, res) => {
      if (KEY === '') { res.status(503).json({ seated: false, why: 'WSP_AGENT_PRIVATE_KEY is unset' }); return; }
      session().then(
        s => res.json({
          pod: s.identity.podName, podUrl: s.identity.podUrl, webId: s.identity.webId,
          agentDid: s.identity.agentDid, delegatedScope: s.identity.scope, address: s.identity.address,
        }),
        (e: unknown) => res.status(502).json({ error: 'identity_unavailable', message: (e as Error).message }),
      );
    });
  },
});

app.listen(PORT, () => {
  /* eslint-disable no-console -- a service's startup banner IS its deploy log; the
     unset-key warning below is the only place an operator finds out before the first
     refusal that this container booted as nobody. */
  console.log(`shared-workspace bridge on http://localhost:${PORT}`);
  console.log(`  MCP: http://localhost:${PORT}/mcp  |  Manifest: http://localhost:${PORT}/affordances`);
  console.log(`  Agent identity: http://localhost:${PORT}/wsp/identity`);
  if (KEY === '') console.warn('WSP_AGENT_PRIVATE_KEY unset — this process is nobody and will refuse every call.');
  /* eslint-enable no-console */
});
