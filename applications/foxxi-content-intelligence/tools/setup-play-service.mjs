#!/usr/bin/env node
/**
 * Steps 3 and 4 of DURABLE-GUEST.md: the Foxxi play service's identity account, and its agent's
 * registration with the relay. Run by an operator, against the live services, on purpose.
 *
 *   FOXXI_PLAY_SERVICE_PRIVATE_KEY=0x… node tools/setup-play-service.mjs [options]
 *
 * With no option it CHANGES NOTHING: it signs in only if the account already exists
 * (`existingOnly`), asks the relay whether it would sign for the service's agent, and prints what
 * it found. Each change needs its own flag:
 *
 *   --create-account        Step 3. Sign in with the service wallet WITHOUT existingOnly, which
 *                           creates the account `u-eth-<12 hex>` and its pod on identity.
 *   --accept-terms=VERSION  Needed with --create-account where identity has hosted terms. The
 *                           script prints the version and the URLs to read first; it never
 *                           agrees on its own.
 *   --register-agent        Step 4. Ask the relay to register the service's own agent on the
 *                           service's own pod (`register_agent`, scope ReadWrite), which writes
 *                           the delegation credential the relay signs grants under.
 *   --audience=ORIGIN       The dashboard's origin, to print the PROVISIONAL_PLAY_CLIENTS entry.
 *   --identity=URL --relay=URL   Default to INTEREGO_IDENTITY_URL / INTEREGO_RELAY_URL, then the
 *                           hosted deployment.
 *
 * The key is read from the environment only, never from the command line (which other processes
 * can read), and neither it nor any token is printed. The script does not touch the bridge's or
 * identity's configuration: it ends by printing the two values identity's
 * PROVISIONAL_PLAY_CLIENTS needs, for a person to set.
 *
 * Exit codes: 0 ready; 1 a request failed or was refused; 2 not ready, and a flag would be needed
 * to go further; 3 terms must be read and accepted first.
 */
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';

const text = value => typeof value === 'string' && value.length > 0 ? value : undefined;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const origin = (value, name) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} is not a URL`); }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error(`${name} must be HTTPS`);
  return url.origin;
};

/** `--flag` and `--name=value` into an options object; anything else is refused, so a typo changes nothing. */
export function parseSetupArgs(argv) {
  const options = { createAccount: false, registerAgent: false };
  for (const arg of argv) {
    if (arg === '--create-account') options.createAccount = true;
    else if (arg === '--register-agent') options.registerAgent = true;
    else if (arg.startsWith('--accept-terms=')) options.acceptTerms = arg.slice('--accept-terms='.length);
    else if (arg.startsWith('--audience=')) options.audience = arg.slice('--audience='.length);
    else if (arg.startsWith('--identity=')) options.identityUrl = arg.slice('--identity='.length);
    else if (arg.startsWith('--relay=')) options.relayUrl = arg.slice('--relay='.length);
    else throw new Error(`Unknown option ${arg.startsWith('--') ? arg.split('=')[0] : '(a bare argument)'}`);
  }
  return options;
}

/**
 * The setup, with its effects injected. `privateKey` is the service wallet's; `fetch` reaches
 * identity and the relay; `log` receives each line of the report. Returns
 * `{ exitCode, ready, service?, changed }` where `changed` lists what this run changed on the
 * live services (empty without a flag).
 */
export async function setupPlayService({ privateKey, options, fetch: request, log, now = Date.now }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) throw new Error('FOXXI_PLAY_SERVICE_PRIVATE_KEY must be set to a 32-byte hex private key (0x + 64 hex)');
  const identityUrl = origin(options.identityUrl ?? 'https://identity.interego.xwisee.com', 'the identity URL');
  const relayUrl = origin(options.relayUrl ?? 'https://relay.interego.xwisee.com', 'the relay URL');
  const audience = options.audience === undefined ? undefined : origin(options.audience, '--audience');
  if (audience !== undefined && audience !== options.audience.replace(/\/+$/, '')) throw new Error('--audience must be an origin, with no path');
  const wallet = new Wallet(privateKey);
  const changed = [];

  const post = async (url, body, bearer) => {
    const response = await request(url, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
    let parsed;
    try { parsed = await response.json(); } catch { parsed = {}; }
    return { ok: response.ok, status: response.status, body: record(parsed) };
  };

  /** One ERC-4361 sign-in. `create` false is `existingOnly`: it opens no account. */
  const signIn = async ({ create, termsVersion }) => {
    const challenge = await post(`${identityUrl}/challenges`, { purpose: 'siwe', address: wallet.address, ...(termsVersion ? { termsVersion } : {}) });
    const nonce = text(challenge.body.nonce);
    if (!challenge.ok || !nonce) return { ok: false, status: challenge.status, body: challenge.body };
    // Identity accepts the terms only as the statement it handed out for this challenge.
    const statement = text(challenge.body.termsStatement) ?? 'Sign in to Interego';
    const message = `${new URL(identityUrl).host} wants you to sign in with your Ethereum account:\n${text(challenge.body.address) ?? wallet.address}`
      + `\n\n${statement}\n\nURI: ${identityUrl}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date(now()).toISOString()}`;
    return post(`${identityUrl}/auth/siwe`, { message, signature: await wallet.signMessage(message), nonce,
      ...(create ? { name: 'Foxxi play service' } : { existingOnly: true }) });
  };

  log(`Service wallet: ${wallet.address}`);
  log(`Identity: ${identityUrl}    Relay: ${relayUrl}`);

  // ── Step 3: the account ────────────────────────────────────────────────────────────────────────
  let session = await signIn({ create: false });
  if (!session.ok) {
    log(`No account signs in with this wallet yet (identity answered ${session.status}${text(session.body.error) ? `: ${session.body.error}` : ''}).`);
    if (!options.createAccount) {
      log('Nothing was changed. To create the account (step 3), run again with --create-account.');
      return { exitCode: 2, ready: false, changed };
    }
    session = await signIn({ create: true, termsVersion: options.acceptTerms });
    if (!session.ok && session.body.code === 'hosted_terms_required') {
      log(`Identity requires agreement to its hosted terms, version ${session.body.termsVersion ?? '(not stated)'}.`);
      if (text(session.body.termsUrl)) log(`  Terms:   ${session.body.termsUrl}`);
      if (text(session.body.privacyUrl)) log(`  Privacy: ${session.body.privacyUrl}`);
      log(options.acceptTerms
        ? `The version given (--accept-terms=${options.acceptTerms}) is not the current one. Nothing was created.`
        : 'Read them, then run again with --create-account --accept-terms=<that version>. Nothing was created.');
      return { exitCode: 3, ready: false, changed };
    }
    if (!session.ok) {
      log(`Identity refused to create the account (${session.status}${text(session.body.error) ? `: ${session.body.error}` : ''}). Nothing was created.`);
      return { exitCode: 1, ready: false, changed };
    }
    changed.push('created the identity account');
    log('Created the identity account.');
  }
  const token = text(session.body.token), userId = text(session.body.userId), agentDid = text(session.body.agentDid);
  if (!token || !userId || !agentDid) {
    log('Identity signed the wallet in but did not name its user and agent; cannot go on.');
    return { exitCode: 1, ready: false, changed };
  }
  log(`Account: ${userId}    Agent: ${agentDid}`);

  // ── Step 4: the relay's delegation credential for that agent ────────────────────────────────────
  const verify = async () => {
    const answer = await post(`${relayUrl}/tool/verify_agent`, { agent_id: agentDid, pod_name: userId });
    const signing = record(answer.body.signing);
    return { verified: answer.ok && answer.body.verified === true, canSign: signing.canSignDelegatedRequests === true,
      note: text(signing.note) ?? text(answer.body.reason) ?? text(answer.body.error) };
  };
  let standing = await verify();
  if (!(standing.verified && standing.canSign)) {
    log(`The relay does not sign for this agent yet (verified: ${standing.verified}, canSignDelegatedRequests: ${standing.canSign}${standing.note ? `; ${standing.note}` : ''}).`);
    if (!options.registerAgent) {
      log(`${changed.length ? 'Nothing else' : 'Nothing'} was changed. To register the agent with the relay (step 4), run again with --register-agent.`);
      return { exitCode: 2, ready: false, changed, service: { userId, agentDid } };
    }
    // No agent_id: over REST the relay defaults it to the session's own canonical DID, which is the
    // one this must register. No pod is named either: it defaults to the caller's own.
    const registered = await post(`${relayUrl}/tool/register_agent`, { scope: 'ReadWrite', label: 'Foxxi play service' }, token);
    if (!registered.ok || text(registered.body.error)) {
      log(`The relay refused the registration (${registered.status}${text(registered.body.error) ? `: ${registered.body.error}` : ''}).`);
      return { exitCode: 1, ready: false, changed, service: { userId, agentDid } };
    }
    changed.push('registered the agent with the relay');
    log(`Registered the agent with the relay (${registered.body.registered === false ? 'credential re-signed' : 'new registration'}).`);
    standing = await verify();
  }

  // ── What the relay signs this service as: the two values identity compares exactly ───────────────
  const probe = await post(`${relayUrl}/tool/sign_request`, { purpose: 'foxxi-play-status-probe' }, token);
  let signedAs = {};
  try { signedAs = record(JSON.parse(text(probe.body._signed_payload) ?? '{}')); } catch { /* reported below */ }
  const signsAgent = text(signedAs.agent_id), signsPod = text(signedAs.subject_pod_url);
  const ready = standing.verified && standing.canSign && !!signsAgent && !!signsPod;
  log(`Relay: verified ${standing.verified}, canSignDelegatedRequests ${standing.canSign}${standing.note ? ` (${standing.note})` : ''}.`);
  if (!signsAgent || !signsPod) {
    log(`The relay did not sign a probe request (${probe.status}${text(probe.body.error) ? `: ${probe.body.error}` : ''}), so the values for identity are not known.`);
    return { exitCode: 1, ready: false, changed, service: { userId, agentDid } };
  }
  log(`The relay signs this service as agent ${signsAgent}`);
  log(`                          on pod ${signsPod}`);
  if (!ready) {
    log('Not ready: the relay signed, but its check of the agent did not pass. Grants would be refused by identity.');
    return { exitCode: 1, ready: false, changed, service: { userId, agentDid: signsAgent, podUrl: signsPod } };
  }
  log('');
  log('Ready. Remaining steps are yours (DURABLE-GUEST.md, steps 5 to 7):');
  log('  5. Set FOXXI_PLAY_SERVICE_PRIVATE_KEY and FOXXI_PLAY_AUDIENCE on the bridge; check GET /play/status.');
  log('  6. Merge this entry into identity\'s PROVISIONAL_PLAY_CLIENTS (choose maxPods; keep the other entries):');
  log(`     ${JSON.stringify({ [audience ?? 'https://<dashboard origin>']: { agentDid: signsAgent, podUrl: signsPod, namespace: 'foxxi', maxPods: 25 } })}`);
  log('  7. Try it from a browser.');
  log(changed.length ? `This run: ${changed.join('; ')}.` : 'This run changed nothing.');
  return { exitCode: 0, ready: true, changed, service: { userId, agentDid: signsAgent, podUrl: signsPod } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseSetupArgs(process.argv.slice(2));
    options.identityUrl ??= process.env.INTEREGO_IDENTITY_URL;
    options.relayUrl ??= process.env.INTEREGO_RELAY_URL;
    const outcome = await setupPlayService({
      privateKey: process.env.FOXXI_PLAY_SERVICE_PRIVATE_KEY?.trim(), options, log: line => console.log(line),
      fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }),
    });
    process.exit(outcome.exitCode);
  } catch (error) {
    console.error(`setup-play-service: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
