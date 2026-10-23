/**
 * practice-evidence bridge: compose and listen. Nothing else lives here.
 *
 * This is the ONLY file in the vertical that reads the environment, and the only one that
 * imports the shared ontology-serving module. Every handler is in ./handlers.ts, which tests drive
 * directly; this module listens at import, so nothing defined here could be tested.
 *
 * Environment:
 *   PORT                            default 6110
 *   HOST                            default 127.0.0.1 (a key-holding bridge does not listen on
 *                                   every interface unless told to)
 *   BRIDGE_DEPLOYMENT_URL           the public base URL
 *   PEV_DEFAULT_POD_URL             the operator pod
 *   PEV_SERVED_PODS                 comma-separated pods records are read from and written to;
 *                                   default the operator pod; '*' (explicit) is any public pod
 *   PEV_POD_WRITE_SECRET            the operator pod's credential (bearer), sent on reads and
 *                                   writes under that pod's path only; never logged
 *   PEV_BRIDGE_MODEL_FOR            registered (default) | anyone: who may use this bridge's own
 *                                   model; registered = an address holding a role on the pod
 *   PEV_MODEL_CALLS_PER_HOUR        "<per signer>,<total>", default 120,2000
 *   PEV_ATTEMPTS_PER_HOUR           "<per signer>,<total>", default 20,500
 *   PEV_PLATFORM_KEY                the platform signing key; absent → an ephemeral key, and the
 *                                   startup lines say what that means
 *   PEV_TRUSTED_PLATFORM_ADDRESSES  earlier platform addresses whose records stay trusted
 *   PEV_RECORD_KEY                  64 hex (an optional 0x): the key every record written to the
 *                                   operator pod is encrypted to, as an envelope only this bridge
 *                                   can open, and the key new attempt IRIs are keyed with (an
 *                                   HMAC), so no one without it can tell whose an attempt is.
 *                                   Descriptors and the manifest stay readable: signer, record
 *                                   kind, modal status, times, trust level, the authors, ratifiers,
 *                                   reviewers and admins they name (never a learner), the chain of
 *                                   versions, and per attempt how many versions, when, whether
 *                                   reviewed and whether redacted. Absent → records are plaintext
 *                                   and attempt IRIs are a plain hash of the learner's address
 *                                   (anyone holding a candidate address can find that learner's
 *                                   attempts), and the startup lines say so. Malformed → the bridge
 *                                   does not start. Plaintext records and plain attempt IRIs
 *                                   written earlier stay as they are, and readable. Losing it makes
 *                                   every encrypted record unreadable: back it up. A keyed attempt
 *                                   IRI and a sealed record's descriptor URL name the key's public
 *                                   fingerprint (printed at startup), and a bridge with another
 *                                   key, or none, writes nothing on a pod whose own records carry
 *                                   either mark, and answers nothing from it but the scenario list
 *                                   (409 record-key-mismatch). Where a pod writer removed the
 *                                   marks, only the acts that read a sealed record are refused
 *                                   (record-not-trusted, records-sealed), and a bridge with
 *                                   another key marks the pod with its own at its first sealed
 *                                   write. Holder copies are never encrypted. Never logged.
 *   PEV_REQUIRE_RECORD_KEY=1        a deployment guard: the bridge does not start (exit 1) unless
 *                                   PEV_RECORD_KEY is set and well-formed, so a deployment whose
 *                                   key is blank or missing (an unresolved reference, a forgotten
 *                                   setting) never writes plaintext to a pod that serves reads to
 *                                   anyone. The pev image sets it; unset or 0 (local runs, the
 *                                   demo) → no guard. Any other value → the bridge does not start,
 *                                   a blank one included (empty or only whitespace, as an
 *                                   unresolved reference or an empty override of the image's 1
 *                                   leaves it): unlike every other variable, a blank value here is
 *                                   not read as unset. Surrounding whitespace is ignored.
 *   PEV_ADMIN_ADDRESSES             addresses that may change roles and withdraw reviews
 *   PEV_ADMIN_DIDS                  people who may change roles and withdraw reviews when they sign
 *                                   in with their Interego account: did:web:<PEV_IDENTITY_HOST>:
 *                                   users:<id>, comma-separated. Not baked into the image.
 *   PEV_TRUSTED_RELAY_ADDRESSES     Interego sign-in: the relay delegation addresses whose signed
 *                                   requests act as the person whose agent they name (comma list;
 *                                   the image sets the live relay's). Empty → the route is off and
 *                                   only keys a person holds sign acts. RELAY-ATTESTED, NOT
 *                                   USER-HELD: whoever holds a listed key, or controls the identity
 *                                   host, can act as any person here; records made this way carry
 *                                   authority relay-delegated.
 *   PEV_IDENTITY_HOST               the host agents and users live on (identity.interego.xwisee.com
 *                                   in the image): an agent's DID document is read from
 *                                   https://<host>/agents/<slug>/did.json and its controller, a
 *                                   did:web:<host>:users:<id>, is the person
 *   PEV_RELAY_URL                   the relay a person signs in through, reported to the web UI
 *                                   (https://relay.interego.xwisee.com in the image). With a relay
 *                                   trusted, it turns on the web UI's "Sign in with your Interego
 *                                   account" (ui.ts): the person signs in on the relay's own page,
 *                                   and every act is signed by the relay through this bridge, so
 *                                   the relay's OAuth access token for that sign-in (an hour)
 *                                   passes through the bridge (never logged or kept). The OAuth
 *                                   client id is BRIDGE_DEPLOYMENT_URL/ui/oauth/client.json when
 *                                   that is https; otherwise it registers by DCR.
 *   PEV_CHAT_AGENTS_DECIDE=1        lets a chat agent signed in through the relay (claude-…,
 *                                   chatgpt-…) take the decisive acts: register_role,
 *                                   ratify_scenario, countersign_attempt, override_attempt,
 *                                   retract_review, and redact_attempt on another learner's
 *                                   attempt; by default only this bridge's own web UI
 *                                   (practice-evidence-… agents) may
 *                                   Each of these five settings, malformed, stops the
 *                                   bridge before it listens.
 *   PEV_LLM_API_KEY | ANTHROPIC_API_KEY, PEV_LLM_MODEL
 *                                   this bridge's own model route; a key without a model is NO
 *                                   route (this bridge never picks a model)
 *   PEV_DEMO_ROLES=1                demo role keys held by this bridge: loopback HOST and
 *                                   BRIDGE_DEPLOYMENT_URL only, and never with PEV_PLATFORM_KEY
 *
 * Run:
 *   PEV_DEFAULT_POD_URL=https://your-pod.example/practice/ PEV_ADMIN_ADDRESSES=0x… \
 *     npx tsx applications/practice-evidence/bridge/server.ts
 */
import { createWallet, deriveEncryptionKeyPair, importWallet, type EncryptionKeyPair, type Wallet } from '@interego/core';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { attachOntologyServing } from '../../_shared/ontology-serve/index.js';
import { pevAffordances } from '../affordances.js';
import { anthropicTextModel, type TextModel } from '../src/model.js';
import { PEV_ACTION, PEV_NS, PEV_ONTOLOGY_IRI, readOntologyTurtle, readShapesTurtle } from '../src/ontology.js';
import { attemptIriSecret, freshNonce, iriKeyFingerprint, isAddress, signEnvelope, type KeyKind, type Role } from '../src/records.js';
import { cachedDidDocuments, isUserDid } from '../src/relay-delegated.js';
import {
  createPevHandlers, describeStartup, DECISIVE_ACTS, DECISIVE_ON_ANOTHERS_ATTEMPT, DEFAULT_BUDGETS, DEMO_ROLE_NAMES, WEB_UI_AGENT_PREFIX,
  type DemoRoleName, type DemoSigner, type HourlyLimit, type PevDeps,
} from './handlers.js';
import { didDocumentFetch, operatorPodFetch } from './pod-helpers.js';
import { attachUi, hostAllowlistGuard, relayCallFetch } from './ui.js';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const warn = (line: string): void => { process.stderr.write(`${line}\n`); };
const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
};
const list = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
/** PEV_RECORD_KEY: 32 bytes as hex, an optional 0x prefix. */
const RECORD_KEY_HEX = /^(0x)?[0-9a-fA-F]{64}$/;
/** PEV_IDENTITY_HOST: a lower-case DNS name with no scheme, port or path (did:web names it as it is). */
const IDENTITY_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const PORT = parseInt(env('PORT') ?? '6110', 10);
const HOST = env('HOST') ?? '127.0.0.1';
const base = (env('BRIDGE_DEPLOYMENT_URL') ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const loopback = LOOPBACK.has(HOST);
const baseIsLoopback = ((): boolean => { try { return LOOPBACK.has(new URL(base).hostname); } catch { return false; } })();
/** PEV_RELAY_URL: https, or http on a loopback host for a local relay. */
const relayUrlOk = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch { return false; }
};

/** "<per signer>,<total>" as an hourly limit; the default when absent or not two positive integers. */
function hourly(name: string, fallback: HourlyLimit): HourlyLimit {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const [a, b] = raw.split(',').map((x) => Number(x.trim()));
  if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
    warn(`${name}: expected "<per signer>,<total>" as positive integers; using ${fallback.perSigner},${fallback.total}`);
    return fallback;
  }
  return { perSigner: a, total: b };
}

const DEMO_LABELS: Readonly<Record<DemoRoleName, string>> = {
  'admin': 'Admin (demo key)', 'author': 'Author (demo key)', 'reviewer': 'Reviewer (demo key)',
  'second-reviewer': 'Second reviewer (demo key)', 'learner': 'Learner (demo key)', 'second-learner': 'Second learner (demo key)',
  'judge-agent': 'Judge agent (demo key)',
};
const DEMO_GRANTS: readonly { readonly role: DemoRoleName; readonly grants: readonly Role[] }[] = [
  { role: 'author', grants: ['author'] },
  { role: 'reviewer', grants: ['reviewer'] },
  { role: 'second-reviewer', grants: ['reviewer'] },
  { role: 'judge-agent', grants: ['judge', 'agent'] },
  { role: 'learner', grants: ['learner'] },
  { role: 'second-learner', grants: ['learner'] },
];

async function main(): Promise<void> {
  const defaultPodUrl = env('PEV_DEFAULT_POD_URL');
  const servedRaw = env('PEV_SERVED_PODS');
  const anyPod = servedRaw === '*';
  const servedPods = anyPod ? [] : list(servedRaw ?? defaultPodUrl);
  const writeSecret = env('PEV_POD_WRITE_SECRET');
  const modelFor = env('PEV_BRIDGE_MODEL_FOR') === 'anyone' ? 'anyone' : 'registered';
  const budgets = {
    modelCallsPerHour: hourly('PEV_MODEL_CALLS_PER_HOUR', DEFAULT_BUDGETS.modelCallsPerHour),
    attemptsPerHour: hourly('PEV_ATTEMPTS_PER_HOUR', DEFAULT_BUDGETS.attemptsPerHour),
  };

  const keyHex = env('PEV_PLATFORM_KEY');
  let platformWallet: Wallet;
  let platformKeyKind: KeyKind;
  if (keyHex) {
    platformWallet = importWallet(keyHex, 'agent', 'pev-platform');
    platformKeyKind = 'configured';
  } else {
    platformWallet = await createWallet('agent', 'pev-platform-ephemeral');
    platformKeyKind = 'ephemeral';
  }

  // Read as set, not through env(): a blank value (an unresolved service reference, or an empty
  // override of the image's 1) is not "no guard", or a deployment would start writing plaintext.
  const requireSet = process.env['PEV_REQUIRE_RECORD_KEY'];
  if (requireSet !== undefined && requireSet.trim() === '') {
    warn(`PEV_REQUIRE_RECORD_KEY is set but blank (${JSON.stringify(requireSet)}), as an unresolved reference or an empty override of the image's 1 leaves it; it takes 1 (refuse to start without PEV_RECORD_KEY) or 0, and a blank value is not read as either. Not listening.`);
    process.exitCode = 1;
    return;
  }
  const requireRaw = requireSet?.trim();
  if (requireRaw !== undefined && requireRaw !== '1' && requireRaw !== '0') {
    warn(`PEV_REQUIRE_RECORD_KEY is ${JSON.stringify(requireRaw)}; it takes 1 (refuse to start without PEV_RECORD_KEY) or 0. Not listening.`);
    process.exitCode = 1;
    return;
  }
  const requireRecordKey = requireRaw === '1';
  const recordKeyHex = env('PEV_RECORD_KEY');
  if (recordKeyHex !== undefined && !RECORD_KEY_HEX.test(recordKeyHex)) {
    warn('PEV_RECORD_KEY is not 64 hex characters (32 bytes, an optional 0x prefix): records encrypted to a mistyped or truncated key could not be opened with the right one. Not listening.');
    process.exitCode = 1;
    return;
  }
  if (recordKeyHex === undefined && requireRecordKey) {
    warn('PEV_REQUIRE_RECORD_KEY=1 and PEV_RECORD_KEY is not set (or is blank, as an unresolved reference is): this deployment would write every transcript, judgment and reviewer reason in plaintext to its pod. Set PEV_RECORD_KEY to 64 hex characters (32 bytes) and back it up, or, for a local run only, unset PEV_REQUIRE_RECORD_KEY. Not listening.');
    process.exitCode = 1;
    return;
  }
  const recordKey: EncryptionKeyPair | undefined = recordKeyHex !== undefined ? deriveEncryptionKeyPair(recordKeyHex, 'pev-records') : undefined;

  const trusted = list(env('PEV_TRUSTED_PLATFORM_ADDRESSES'));
  const admins = list(env('PEV_ADMIN_ADDRESSES'));
  for (const [name, values] of [['PEV_TRUSTED_PLATFORM_ADDRESSES', trusted], ['PEV_ADMIN_ADDRESSES', admins]] as const) {
    const bad = values.filter((x) => !isAddress(x));
    if (bad.length > 0) warn(`${name}: ignoring ${bad.length} value(s) that are not 0x addresses`);
  }

  // ── Interego sign-in (relay-delegated identity). Relay-attested, not user-held: every one of
  // these decides who can act as whom, so a malformed value stops the bridge instead of being read
  // as something nobody meant.
  const relayAddresses = list(env('PEV_TRUSTED_RELAY_ADDRESSES'));
  const badRelay = relayAddresses.filter((x): boolean => !isAddress(x));
  if (badRelay.length > 0) {
    warn(`PEV_TRUSTED_RELAY_ADDRESSES: ${badRelay.length} value(s) are not 0x addresses (40 hex digits): ${badRelay.map((x) => JSON.stringify(x.slice(0, 50))).join(', ')}. A relay address decides whose requests act as any person here, so a mistyped one is not ignored. Not listening.`);
    process.exitCode = 1;
    return;
  }
  const identityHost = env('PEV_IDENTITY_HOST');
  if (identityHost !== undefined && !IDENTITY_HOST.test(identityHost)) {
    warn(`PEV_IDENTITY_HOST is ${JSON.stringify(identityHost.slice(0, 80))}; it takes a lower-case host name with no scheme, port or path, such as identity.interego.xwisee.com. Not listening.`);
    process.exitCode = 1;
    return;
  }
  if (relayAddresses.length > 0 && identityHost === undefined) {
    warn('PEV_TRUSTED_RELAY_ADDRESSES is set and PEV_IDENTITY_HOST is not: a relay-signed request names an agent on the identity host, and without one no agent can be checked. Set PEV_IDENTITY_HOST (identity.interego.xwisee.com), or empty PEV_TRUSTED_RELAY_ADDRESSES to turn Interego sign-in off. Not listening.');
    process.exitCode = 1;
    return;
  }
  const adminDids = list(env('PEV_ADMIN_DIDS'));
  if (adminDids.length > 0 && identityHost === undefined) {
    warn('PEV_ADMIN_DIDS is set and PEV_IDENTITY_HOST is not: an admin DID is did:web:<identity host>:users:<id>. Set PEV_IDENTITY_HOST. Not listening.');
    process.exitCode = 1;
    return;
  }
  const badDids = identityHost === undefined ? [] : adminDids.filter((d) => !isUserDid(d, identityHost));
  if (badDids.length > 0) {
    warn(`PEV_ADMIN_DIDS: ${badDids.length} value(s) are not did:web:${identityHost ?? ''}:users:<id>: ${badDids.map((x) => JSON.stringify(x.slice(0, 120))).join(', ')}. An admin is a person (a user, never an agent) on the identity host. Not listening.`);
    process.exitCode = 1;
    return;
  }
  const relayUrl = env('PEV_RELAY_URL');
  if (relayUrl !== undefined && !relayUrlOk(relayUrl)) {
    warn(`PEV_RELAY_URL is ${JSON.stringify(relayUrl.slice(0, 120))}; it takes the relay's https URL, such as https://relay.interego.xwisee.com (http only on a loopback host). Not listening.`);
    process.exitCode = 1;
    return;
  }
  const decideRaw = env('PEV_CHAT_AGENTS_DECIDE');
  if (decideRaw !== undefined && decideRaw !== '1' && decideRaw !== '0') {
    warn(`PEV_CHAT_AGENTS_DECIDE is ${JSON.stringify(decideRaw.slice(0, 40))}; it takes 1 (chat agents signed in through the relay may take the decisive acts: change roles, ratify a rubric, countersign or override a judgment, withdraw a review, remove another learner's transcript) or 0. Not listening.`);
    process.exitCode = 1;
    return;
  }
  const chatAgentsDecide = decideRaw === '1';
  // The web UI's "Sign in with your Interego account": on when there is a relay to sign in through
  // and the route trusts it. Its relay calls follow no redirect, are capped and timed, and go through
  // the SSRF guard unless the operator's relay is on loopback (a local relay, which the guard refuses).
  const uiSignIn = relayUrl !== undefined && relayAddresses.length > 0 && identityHost !== undefined;
  const relayIsLoopback = relayUrl !== undefined && ((): boolean => { try { return LOOPBACK.has(new URL(relayUrl).hostname); } catch { return false; } })();

  const llmKey = env('PEV_LLM_API_KEY') ?? env('ANTHROPIC_API_KEY');
  const llmModel = env('PEV_LLM_MODEL');
  const model: TextModel | undefined = llmKey && llmModel
    ? anthropicTextModel({ apiKey: llmKey, model: llmModel, keySource: 'bridge-env' }) : undefined;

  const demoOn = env('PEV_DEMO_ROLES') === '1';
  if (demoOn && !loopback) {
    warn(`PEV_DEMO_ROLES=1 needs a loopback HOST (127.0.0.1, localhost or ::1); HOST is ${HOST}. Not listening.`);
    process.exitCode = 1;
    return;
  }
  if (demoOn && !baseIsLoopback) {
    warn(`PEV_DEMO_ROLES=1 needs BRIDGE_DEPLOYMENT_URL on a loopback host; it is ${base}, so the Host guard would admit that host. Not listening.`);
    process.exitCode = 1;
    return;
  }
  if (demoOn && keyHex) {
    warn('PEV_DEMO_ROLES=1 runs with an ephemeral platform key only: role changes a demo admin signs would otherwise stay trusted after demo mode is off. Unset PEV_PLATFORM_KEY (and use a demo pod path). Not listening.');
    process.exitCode = 1;
    return;
  }
  let demoSigner: DemoSigner | undefined;
  let demoAdmin: Wallet | undefined;
  if (demoOn) {
    const roles = await Promise.all(DEMO_ROLE_NAMES.map(async (role) => ({
      role, label: DEMO_LABELS[role], wallet: await createWallet(role === 'judge-agent' ? 'agent' : 'human', `pev-demo-${role}`),
    })));
    demoSigner = { roles };
    demoAdmin = roles.find((r) => r.role === 'admin')?.wallet;
  }

  const baseFetch = globalThis.fetch.bind(globalThis);
  const deps: PevDeps = {
    platformWallet, platformKeyKind,
    trustedPlatformAddresses: trusted.filter((x) => isAddress(x)),
    ...(recordKey ? { recordKey } : {}),
    adminAddresses: [...admins.filter((x) => isAddress(x)), ...(demoAdmin ? [demoAdmin.address] : [])],
    // The agent's DID document is read SSRF-guarded, in 8 s, at most 64 KiB, and kept 10 minutes.
    ...(identityHost !== undefined ? {
      relayDelegation: {
        relayAddresses: relayAddresses.map((x) => x.toLowerCase()), identityHost,
        fetchDidDocument: cachedDidDocuments(didDocumentFetch(globalThis.fetch.bind(globalThis))),
      },
      adminDids,
    } : {}),
    chatAgentsDecide,
    ...(relayUrl !== undefined ? { relayUrl } : {}),
    fetchFn: operatorPodFetch(defaultPodUrl, writeSecret, baseFetch),
    holderFetchFn: baseFetch,
    byokFetch: baseFetch,
    deploymentUrl: base,
    ...(defaultPodUrl ? { defaultPodUrl } : {}),
    ...(anyPod ? { servedPods: '*' as const } : servedPods.length > 0 ? { servedPods } : {}),
    bridgeModelFor: modelFor, budgets,
    ...(model ? { model } : {}),
    ...(demoSigner ? { demoSigner } : {}),
  };
  const handlers = createPevHandlers(deps);

  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
  try { allowedHosts.push(new URL(base).host); } catch { /* the base is not a URL; the loopback names remain */ }

  const app = createVerticalBridge({
    verticalName: 'practice-evidence',
    affordances: pevAffordances,
    handlers,
    deploymentUrl: base,
    ...(defaultPodUrl ? { defaultPodUrl } : {}),
    hypermediaLinks: [
      { label: 'Web UI', href: `${base}/ui`, rel: 'alternate', type: 'text/html' },
      { label: 'pev ontology', href: `${base}/ns/pev`, rel: 'describedby', type: 'text/turtle' },
    ],
    middleware: (a) => {
      // The web UI's sign-in routes limit each client address (req.ip) on its relay calls. In the
      // image the bridge listens behind Railway's edge, one proxy hop, so req.ip is the client only
      // when that hop is trusted; a loopback bridge trusts none, so no caller picks its own address.
      if (!loopback) a.set('trust proxy', 1);
      if (loopback) a.use(hostAllowlistGuard(allowedHosts));
      attachOntologyServing(a, {
        mountPath: '/ns/pev', ontologyIri: PEV_ONTOLOGY_IRI, namespace: PEV_NS,
        ontologyTurtle: readOntologyTurtle, shapesTurtle: readShapesTurtle,
      });
      attachUi(a, uiSignIn && relayUrl !== undefined
        ? { interego: { relayUrl, deploymentUrl: base, relayFetch: relayCallFetch(baseFetch, { privateRelay: relayIsLoopback }) } }
        : {});
    },
  });

  say(`practice-evidence bridge  ${base}`);
  say(`  web UI ${base}/ui  |  MCP ${base}/mcp  |  manifest ${base}/affordances  |  ontology ${base}/ns/pev`);
  say(`  pod: ${defaultPodUrl ?? 'none (each act names its pod)'}; records read and written on: ${anyPod ? 'any public pod (PEV_SERVED_PODS=*)' : servedPods.length > 0 ? servedPods.join(', ') : 'NO pod: set PEV_DEFAULT_POD_URL or PEV_SERVED_PODS, or every act is refused'}`);
  say(`  pod credential: ${writeSecret ? 'configured, sent on reads and writes under the operator pod' : 'not configured'}`);
  say(recordKey
    ? `  records are encrypted to this bridge's record key (PEV_RECORD_KEY, public key ${recordKey.publicKey}, fingerprint k${iriKeyFingerprint(attemptIriSecret(recordKey))}, which every record it seals and every attempt IRI it keys names on the pod): the pod holds the graph of every record written from now on only as ciphertext, and new attempt IRIs are keyed with it, so no one without the key can tell whose an attempt is. Still readable by anyone the pod lets read: descriptors and the manifest (signer, record kind, modal status, times, trust level, the authors, ratifiers, reviewers and admins they name, never a learner) and, per attempt, how many versions, when, whether reviewed and whether redacted. Records and attempt IRIs written before the key was set stay as they were: plaintext, and a plain hash of the learner's address. Back the key up: without it no encrypted record can be read again`
    : '  records are plaintext: anyone the pod lets read pev/records/ reads every transcript (a pod that serves reads anonymously serves them to everyone), and attempt IRIs are a plain hash of the learner\'s address, so anyone holding a candidate address finds that learner\'s attempts. Set PEV_RECORD_KEY (64 hex) to encrypt them');
  say(`  platform key: ${platformKeyKind}, address ${platformWallet.address}`);
  if (platformKeyKind === 'ephemeral') {
    say('  records written now become untrusted after a restart unless you add this address to PEV_TRUSTED_PLATFORM_ADDRESSES');
  }
  say(model
    ? `  model route: ${model.provider} ${model.requestedModel} (this bridge's key), for ${modelFor === 'anyone' ? 'ANY signer (PEV_BRIDGE_MODEL_FOR=anyone): anyone who reaches this bridge spends this key, up to the hourly limits' : 'addresses holding a role on the pod'}; per hour ${budgets.modelCallsPerHour.perSigner} calls per signer, ${budgets.modelCallsPerHour.total} in total`
    : llmKey
      ? '  model route: none: a key is set but PEV_LLM_MODEL is not, and this bridge never picks a model; packet routes only'
      : '  model route: none: packet routes only (or a per-request key)');
  say(`  attempts per hour: ${budgets.attemptsPerHour.perSigner} per signer, ${budgets.attemptsPerHour.total} in total (counted in this process only)`);
  say(`  admins: ${deps.adminAddresses?.length ?? 0} address(es), ${relayAddresses.length > 0 ? adminDids.length : 0} Interego DID(s)`);
  const decisive = `${[...DECISIVE_ACTS].join(', ')}, and ${[...DECISIVE_ON_ANOTHERS_ATTEMPT].join(', ')} on another learner's attempt`;
  say(relayAddresses.length > 0 && identityHost !== undefined
    ? `  Interego sign-in: ON, relay-attested, not user-held. A request the relay (${relayAddresses.join(', ')}) signs for an agent on ${identityHost} acts as that agent's controller there, a did:web:${identityHost}:users:… person; whoever holds that relay delegation key, or controls ${identityHost}, can act as any person on this bridge. Records made this way carry authority relay-delegated. ${chatAgentsDecide ? `Chat agents may take ${decisive} (PEV_CHAT_AGENTS_DECIDE=1).` : `Only this bridge's web UI (${WEB_UI_AGENT_PREFIX}… agents) may take ${decisive}; PEV_CHAT_AGENTS_DECIDE=1 lets chat agents.`} Relay: ${relayUrl ?? 'PEV_RELAY_URL not set'}`
    : `  Interego sign-in: off (PEV_TRUSTED_RELAY_ADDRESSES is empty): only keys a person holds sign acts${adminDids.length > 0 ? `; the ${adminDids.length} admin DID(s) in PEV_ADMIN_DIDS cannot act until it is on` : ''}`);
  if (relayAddresses.length > 0) {
    say(uiSignIn
      ? `  web UI sign-in: ON, through ${relayUrl ?? ''}, as the OAuth client "Practice Evidence" (${base.startsWith('https://') ? `its Client ID Metadata Document is ${base}/ui/oauth/client.json, if the relay takes one; otherwise it registers dynamically` : 'registered dynamically: the deployment URL is not https, so the relay cannot read a Client ID Metadata Document'}). The relay's access token a person signs in with (it lasts an hour) passes through this bridge on every act it signs and is never logged or kept`
      : '  web UI sign-in: off (PEV_RELAY_URL is not set): people sign in through Claude, ChatGPT or another relay client only');
  }
  for (const line of (await describeStartup(deps)).lines) say(`  ${line}`);

  if (demoSigner && demoAdmin) {
    say('  DEMO MODE: this bridge holds role keys and signs as whichever role a page picks. Records it writes say so. Do not run demo mode on a shared deployment.');
    for (const r of demoSigner.roles) say(`    ${r.role}: ${r.wallet.address}`);
    if (!defaultPodUrl) {
      say('  demo roles were not registered: set PEV_DEFAULT_POD_URL');
    } else {
      for (const g of DEMO_GRANTS) {
        const who = demoSigner.roles.find((x) => x.role === g.role);
        if (!who) continue;
        for (const role of g.grants) {
          const envelope = await signEnvelope(demoAdmin, {
            v: 1, action: PEV_ACTION.registerRole, issuedAt: new Date().toISOString(), nonce: freshNonce(), podUrl: defaultPodUrl,
            address: who.wallet.address, role, change: 'add',
          });
          const result = await handlers['pev.register_role']!({ envelope }) as Record<string, unknown>;
          if (result['kind'] === 'refusal') {
            say(`  registering ${g.role} as ${role}: ${String(result['iep:refusalReason'])}: ${String(result['error'])}`);
            if (result['iep:refusalReason'] === 'record-not-trusted') {
              for (const line of (await describeStartup(deps)).lines) say(`    ${line}`);
            }
          }
        }
      }
    }
  }

  // Express 5 hands a failed bind to this callback rather than throwing, so it is handled here:
  // ignored, "listening" was printed and the process exited 0, which a container platform reads
  // as a clean stop and does not restart. `::` falls back to 0.0.0.0 on a host without IPv6, as
  // Node does for a listen with no host.
  const listen = (host: string): void => {
    app.listen(PORT, host, (err?: Error) => {
      if (err) {
        if (host === '::' && (err as NodeJS.ErrnoException).code === 'EAFNOSUPPORT') { listen('0.0.0.0'); return; }
        warn(`practice-evidence bridge did not start: cannot listen on ${host}:${PORT}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      say(`  listening on ${host}:${PORT}`);
    });
  };
  listen(HOST);
}

main().catch((e: unknown) => {
  warn(`practice-evidence bridge did not start: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
