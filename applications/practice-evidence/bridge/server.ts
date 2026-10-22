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
 *                                   can open; descriptors and the manifest stay readable (signer,
 *                                   record kind, modal status, times). Absent → records are
 *                                   plaintext, and the startup lines say so. Malformed → the
 *                                   bridge does not start. Plaintext records written earlier stay
 *                                   readable. Losing it makes every encrypted record unreadable:
 *                                   back it up. Holder copies are never encrypted. Never logged.
 *   PEV_ADMIN_ADDRESSES             addresses that may change roles and withdraw reviews
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
import { freshNonce, isAddress, signEnvelope, type KeyKind, type Role } from '../src/records.js';
import {
  createPevHandlers, describeStartup, DEFAULT_BUDGETS, DEMO_ROLE_NAMES,
  type DemoRoleName, type DemoSigner, type HourlyLimit, type PevDeps,
} from './handlers.js';
import { operatorPodFetch } from './pod-helpers.js';
import { attachUi, hostAllowlistGuard } from './ui.js';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const warn = (line: string): void => { process.stderr.write(`${line}\n`); };
const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
};
const list = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
/** PEV_RECORD_KEY: 32 bytes as hex, an optional 0x prefix. */
const RECORD_KEY_HEX = /^(0x)?[0-9a-fA-F]{64}$/;

const PORT = parseInt(env('PORT') ?? '6110', 10);
const HOST = env('HOST') ?? '127.0.0.1';
const base = (env('BRIDGE_DEPLOYMENT_URL') ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const loopback = LOOPBACK.has(HOST);
const baseIsLoopback = ((): boolean => { try { return LOOPBACK.has(new URL(base).hostname); } catch { return false; } })();

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

  const recordKeyHex = env('PEV_RECORD_KEY');
  if (recordKeyHex !== undefined && !RECORD_KEY_HEX.test(recordKeyHex)) {
    warn('PEV_RECORD_KEY is not 64 hex characters (32 bytes, an optional 0x prefix): records encrypted to a mistyped or truncated key could not be opened with the right one. Not listening.');
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
      if (loopback) a.use(hostAllowlistGuard(allowedHosts));
      attachOntologyServing(a, {
        mountPath: '/ns/pev', ontologyIri: PEV_ONTOLOGY_IRI, namespace: PEV_NS,
        ontologyTurtle: readOntologyTurtle, shapesTurtle: readShapesTurtle,
      });
      attachUi(a);
    },
  });

  say(`practice-evidence bridge  ${base}`);
  say(`  web UI ${base}/ui  |  MCP ${base}/mcp  |  manifest ${base}/affordances  |  ontology ${base}/ns/pev`);
  say(`  pod: ${defaultPodUrl ?? 'none (each act names its pod)'}; records read and written on: ${anyPod ? 'any public pod (PEV_SERVED_PODS=*)' : servedPods.length > 0 ? servedPods.join(', ') : 'NO pod: set PEV_DEFAULT_POD_URL or PEV_SERVED_PODS, or every act is refused'}`);
  say(`  pod credential: ${writeSecret ? 'configured, sent on reads and writes under the operator pod' : 'not configured'}`);
  say(recordKey
    ? `  records are encrypted to this bridge's record key (PEV_RECORD_KEY, public key ${recordKey.publicKey}): the pod holds the graph of every record written from now on only as ciphertext; descriptors and the manifest stay readable (signer, record kind, modal status, times), and records written before the key was set stay plaintext. Back the key up: without it no encrypted record can be read again`
    : '  records are plaintext: anyone the pod lets read pev/records/ reads every transcript (a pod that serves reads anonymously serves them to everyone). Set PEV_RECORD_KEY (64 hex) to encrypt them');
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
  say(`  admins: ${deps.adminAddresses?.length ?? 0}`);
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
