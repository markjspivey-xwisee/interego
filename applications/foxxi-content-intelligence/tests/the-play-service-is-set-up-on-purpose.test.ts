/**
 * The operator's setup of the play service (tools/setup-play-service.mjs): DURABLE-GUEST.md steps
 * 3 and 4, which create an account on identity and write a credential through the relay.
 *
 * ★ WHAT MUST HOLD. Run with no flag it changes nothing. Each change happens only under its own
 * flag. It never agrees to terms by itself. And nothing it prints contains the key or a token.
 *
 * Identity's own ERC-4361 reader checks every sign-in message the script builds
 * (deploy/identity/siwe-message.ts). Identity's accounts and the relay's registry are stood in
 * for, following the handlers as read: /auth/siwe with `existingOnly`, /challenges handing out the
 * terms statement, register_agent defaulting to the session's own agent, verify_agent, and
 * sign_request adding `agent_id` and `subject_pod_url`.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { parseSetupArgs, setupPlayService, type SetupFetch, type SetupOptions } from '../tools/setup-play-service.mjs';
import { parseSiweMessage } from '../../../deploy/identity/siwe-message.js';

const KEY = `0x${'7'.repeat(64)}`;
const wallet = new ethers.Wallet(KEY);
const IDENTITY = 'https://identity.example';
const RELAY = 'https://relay.example';
const USER = `u-eth-${wallet.address.slice(2, 14).toLowerCase()}`;
const AGENT = `did:web:identity.example:agents:mcp-client-${USER}`;
const POD = `https://pods.example/${USER}/`;
const TERMS = { version: '2026-11-06-r2', statement: 'I agree to the Hosted Interego Terms of Service, version 2026-11-06-r2.' };

function services(start: { account?: boolean; registered?: boolean; terms?: boolean; registerRefused?: boolean } = {}) {
  const state = { account: start.account ?? false, registered: start.registered ?? false, termsAccepted: undefined as string | undefined };
  const calls: string[] = [];
  const challenges = new Map<string, { terms: boolean }>();
  let n = 0;
  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch: SetupFetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(`${init.method} ${url}${body['existingOnly'] === true ? ' existingOnly' : ''}`);
    if (url === `${IDENTITY}/challenges`) {
      const nonce = `nonce${String(++n).padStart(27, '0')}`;
      const terms = !!start.terms && body['termsVersion'] === TERMS.version;
      challenges.set(nonce, { terms });
      return reply(200, { nonce, address: wallet.address, ...(terms ? { termsStatement: TERMS.statement } : {}) });
    }
    if (url === `${IDENTITY}/auth/siwe`) {
      const parsed = parseSiweMessage(String(body['message']));
      if (parsed.ok === false) return reply(400, { error: `not ERC-4361: ${parsed.reason}` });
      const challenge = challenges.get(String(body['nonce']));
      if (!challenge || parsed.fields.nonce !== body['nonce'] || parsed.fields.address !== wallet.address
        || ethers.verifyMessage(String(body['message']), String(body['signature'])) !== wallet.address) return reply(401, { error: 'bad sign-in' });
      if (!state.account) {
        if (body['existingOnly'] === true) return reply(401, { error: 'Invalid credentials' });
        if (start.terms && !(challenge.terms && parsed.fields.statement === TERMS.statement)) {
          return reply(428, { error: 'Review the terms', code: 'hosted_terms_required', termsVersion: TERMS.version,
            termsUrl: `${IDENTITY}/terms`, privacyUrl: `${IDENTITY}/privacy` });
        }
        state.account = true;
        if (start.terms) state.termsAccepted = TERMS.version;
      }
      return reply(200, { token: 'cg2_secret-service-token', userId: USER, agentDid: AGENT, podUrl: POD });
    }
    const authed = init.headers['Authorization'] === 'Bearer cg2_secret-service-token';
    if (url === `${RELAY}/tool/verify_agent`) {
      return reply(200, state.registered
        ? { verified: true, signing: { canSignDelegatedRequests: true } }
        : { verified: false, reason: 'no registry row', signing: { canSignDelegatedRequests: false, note: 'No delegation credential was readable on this pod.' } });
    }
    if (url === `${RELAY}/tool/register_agent`) {
      if (!authed) return reply(401, { error: 'Authentication required for write operations' });
      if (start.registerRefused) return reply(200, { error: 'register_agent: forbidden' });   // the relay refuses in a 200 body
      if (body['agent_id'] !== undefined || body['pod_name'] !== undefined || body['scope'] !== 'ReadWrite') return reply(200, { error: 'unexpected arguments' });
      const again = state.registered;
      state.registered = true;
      return reply(200, { registered: !again, repaired: again, agent: AGENT, scope: 'ReadWrite' });
    }
    if (url === `${RELAY}/tool/sign_request`) {
      if (!authed) return reply(401, { error: 'unauthenticated' });
      return reply(200, { _signature: `0x${'12'.repeat(65)}`, _signed_payload: JSON.stringify({ ...body, agent_id: AGENT, subject_pod_url: POD, timestamp: 't' }) });
    }
    return reply(404, {});
  };
  return { state, calls, fetch };
}

async function run(s: ReturnType<typeof services>, argv: string[]) {
  const lines: string[] = [];
  const options: SetupOptions = { ...parseSetupArgs(argv), identityUrl: IDENTITY, relayUrl: RELAY };
  const outcome = await setupPlayService({ privateKey: KEY, options, fetch: s.fetch, log: line => { lines.push(line); } });
  return { outcome, out: lines.join('\n') };
}
const writes = (calls: string[]) => calls.filter(call => call.includes('/tool/register_agent') || (call.includes('/auth/siwe') && !call.endsWith('existingOnly')));

describe('setting up the play service', () => {
  it('with no flag changes nothing: it signs in existingOnly, and stops at the first thing a flag would do', async () => {
    const none = services();
    const first = await run(none, []);
    expect(first.outcome).toMatchObject({ exitCode: 2, ready: false, changed: [] });
    expect(first.out).toContain('--create-account');
    expect(writes(none.calls)).toEqual([]);
    expect(none.state).toMatchObject({ account: false, registered: false });

    const account = services({ account: true });
    const second = await run(account, []);
    expect(second.outcome).toMatchObject({ exitCode: 2, ready: false, changed: [], service: { userId: USER, agentDid: AGENT } });
    expect(second.out).toContain('--register-agent');
    expect(writes(account.calls)).toEqual([]);
    expect(account.state.registered).toBe(false);
  });

  it('creates the account only under --create-account, and registers the agent only under --register-agent', async () => {
    const s = services();
    const created = await run(s, ['--create-account']);
    expect(created.outcome).toMatchObject({ exitCode: 2, changed: ['created the identity account'] });
    expect(s.state).toMatchObject({ account: true, registered: false });

    const registered = await run(s, ['--register-agent', '--audience=https://foxxi.example']);
    expect(registered.outcome).toEqual({ exitCode: 0, ready: true, changed: ['registered the agent with the relay'],
      service: { userId: USER, agentDid: AGENT, podUrl: POD } });
    // The entry for identity names what the relay signed, and the audience given.
    expect(registered.out).toContain(JSON.stringify({ 'https://foxxi.example': { agentDid: AGENT, podUrl: POD, namespace: 'foxxi', maxPods: 25 } }));

    // Run again with both flags once everything is in place: nothing is created or registered twice.
    s.calls.length = 0;
    const again = await run(s, ['--create-account', '--register-agent']);
    expect(again.outcome).toMatchObject({ exitCode: 0, ready: true, changed: [] });
    expect(writes(s.calls)).toEqual([]);
    expect(again.out).toContain('This run changed nothing.');
  });

  it('never agrees to terms by itself: it prints the version and the links, and creates nothing until that version is given', async () => {
    const s = services({ terms: true });
    const asked = await run(s, ['--create-account']);
    expect(asked.outcome).toMatchObject({ exitCode: 3, changed: [] });
    expect(asked.out).toContain(TERMS.version);
    expect(asked.out).toContain(`${IDENTITY}/terms`);
    expect(s.state.account).toBe(false);

    const wrong = await run(s, ['--create-account', '--accept-terms=2020-01-01']);
    expect(wrong.outcome).toMatchObject({ exitCode: 3, changed: [] });
    expect(s.state.account).toBe(false);

    const agreed = await run(s, ['--create-account', `--accept-terms=${TERMS.version}`, '--register-agent']);
    expect(agreed.outcome).toMatchObject({ exitCode: 0, ready: true, changed: ['created the identity account', 'registered the agent with the relay'] });
    expect(s.state.termsAccepted).toBe(TERMS.version);
  });

  it('reports a registration the relay refuses in a 200 body as a failure, not as ready', async () => {
    const s = services({ account: true, registerRefused: true });
    const refused = await run(s, ['--register-agent']);
    expect(refused.outcome).toMatchObject({ exitCode: 1, ready: false, changed: [] });
    expect(refused.out).toContain('register_agent: forbidden');
  });

  it('prints neither the key nor a token, whatever happens', async () => {
    const outputs: string[] = [];
    for (const [start, argv] of [[{}, []], [{}, ['--create-account', '--register-agent']], [{ terms: true }, ['--create-account']],
      [{ account: true, registerRefused: true }, ['--register-agent']], [{ account: true, registered: true }, ['--audience=https://foxxi.example']]] as const) {
      const result = await run(services(start), [...argv]);
      outputs.push(result.out, JSON.stringify(result.outcome));
    }
    for (const out of outputs) {
      expect(out).not.toContain(KEY);
      expect(out).not.toContain(KEY.slice(2));
      expect(out).not.toContain('cg2_secret-service-token');
    }
  });

  it('refuses a missing or malformed key, an unknown option, and a non-HTTPS or pathful address, before any request', async () => {
    const s = services();
    const options: SetupOptions = { createAccount: false, registerAgent: false, identityUrl: IDENTITY, relayUrl: RELAY };
    for (const privateKey of [undefined, '', 'abc', KEY.slice(2)]) {
      await expect(setupPlayService({ privateKey, options, fetch: s.fetch, log: () => undefined })).rejects.toThrow(/FOXXI_PLAY_SERVICE_PRIVATE_KEY/);
    }
    await expect(setupPlayService({ privateKey: KEY, options: { ...options, identityUrl: 'http://identity.example' }, fetch: s.fetch, log: () => undefined })).rejects.toThrow(/HTTPS/);
    await expect(setupPlayService({ privateKey: KEY, options: { ...options, audience: 'https://foxxi.example/app' }, fetch: s.fetch, log: () => undefined })).rejects.toThrow(/origin/);
    expect(s.calls).toEqual([]);
    for (const argv of [['--create'], ['--key=0x1'], ['create-account'], ['--register-agent=yes']]) expect(() => parseSetupArgs(argv), argv[0]).toThrow(/Unknown option/);
    expect(parseSetupArgs(['--create-account', '--accept-terms=v1', '--audience=https://a.example'])).toEqual(
      { createAccount: true, registerAgent: false, acceptTerms: 'v1', audience: 'https://a.example' });
  });
});
