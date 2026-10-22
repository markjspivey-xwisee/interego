/**
 * The work-redesign bridge process: read the configuration, compose, listen. Nothing else.
 *
 * This is the ONLY file in the vertical that reads the environment, and the only one that
 * imports the shared ontology server; it holds no handler, so nothing needs to import it.
 *
 *   PORT                            default 6100
 *   HOST                            default 127.0.0.1 — this bridge holds a signing key, so it
 *                                   never binds every interface unless told to. Bound to
 *                                   loopback, it answers only the Host names 127.0.0.1, localhost
 *                                   and [::1] on PORT and the host of BRIDGE_DEPLOYMENT_URL, and
 *                                   refuses any other (421): the DNS-rebinding guard
 *   BRIDGE_DEPLOYMENT_URL           the public base URL (default http://127.0.0.1:<PORT>)
 *   WRD_DEFAULT_POD_URL             the pod to use when a call names none
 *   WRD_SERVED_PODS                 comma list of the pods records are read from and written to;
 *                                   default the default pod. A call naming any other pod is
 *                                   refused (403 pod-not-served); with neither set, every call is
 *   WRD_POD_WRITE_SECRET            the operator pod's credential (bearer), sent on reads and
 *                                   writes whose URL lies under WRD_DEFAULT_POD_URL's path and
 *                                   origin, and nowhere else; never to a holder's pod; never
 *                                   printed. Requests carrying it go out with redirect: 'manual'.
 *                                   The SSRF guard re-issues a GET's redirect hop through the same
 *                                   fetch, which adds the credential again only when the new URL
 *                                   is still under the pod's path (so never outside the pod)
 *   WRD_RECORD_KEY                  64 hex: the record key. Every new record's graph is sealed
 *                                   to the X25519 key derived from it, and the entity IRIs the
 *                                   bridge derives are keyed with a key derived from it;
 *                                   descriptors and the manifest stay public (signers, kinds,
 *                                   modal status, times, supersedes and derivation links).
 *                                   Absent → plaintext records, and the startup says they are
 *                                   world-readable on a pod that serves anonymous reads. Keep a
 *                                   copy: a lost key leaves every sealed record unreadable (409),
 *                                   with no way back, and every keyed IRI names its key's
 *                                   fingerprint, so a bridge with another key (or none) on a pod
 *                                   holding keyed records refuses every write (409)
 *   WRD_REQUIRE_RECORD_KEY          1 → the bridge does not start (exit 1) without a valid
 *                                   WRD_RECORD_KEY (blank counts as missing), so a deployment
 *                                   cannot fall back to plaintext records. The image sets it;
 *                                   unset by default for a local run
 *   WRD_PUBLIC_READS                1 → wrd.list_records and wrd.calibration answer unsigned
 *                                   GETs from anyone who can reach the bridge; otherwise they
 *                                   answer 401, reads need a signed read (wrd.read_records,
 *                                   wrd.read_calibration) from an admin or a registered key, and
 *                                   the GET wrd.envelope_template fills only the shape and the
 *                                   head binding; wrd.read_envelope_template fills it all for
 *                                   that signed read, sent in the POST body (never in a URL)
 *   WRD_PLATFORM_KEY                hex secp256k1 key the bridge signs records with; absent → an
 *                                   EPHEMERAL key, and records written now are not trusted
 *                                   after a restart
 *   WRD_ADMIN_ADDRESSES             comma list of addresses that may change the role registry
 *   WRD_TRUSTED_PLATFORM_ADDRESSES  comma list of earlier platform keys whose records stay trusted
 */
import { createWallet, importWallet, deriveEncryptionKeyPair, type EncryptionKeyPair, type FetchFn } from '@interego/core';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { attachOntologyServing } from '../../_shared/ontology-serve/index.js';
import { wrdAffordances } from '../affordances.js';
import { WRD_NS, WRD_ONTOLOGY_IRI, readOntologyTurtle, readShapesTurtle } from '../src/ontology.js';
import { createWrdHandlers, type PlatformSigner } from './handlers.js';
import { operatorPodFetch } from './pod-helpers.js';
import { attachUi, hostAllowlistGuard, isLoopbackBind, servedHostNames } from './ui.js';

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
// An image declares every variable it reads (`ENV NAME=`), so an empty value means unset.
const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
};

const PORT = parseInt(env('PORT') ?? '6100', 10);
const HOST = env('HOST') ?? '127.0.0.1';
const base = (env('BRIDGE_DEPLOYMENT_URL') ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const loopback = isLoopbackBind(HOST);
const defaultPodUrl = env('WRD_DEFAULT_POD_URL');
const servedPods = list(env('WRD_SERVED_PODS') ?? defaultPodUrl);
const writeSecret = env('WRD_POD_WRITE_SECRET');
const recordKeyHex = env('WRD_RECORD_KEY');
const requireRecordKey = env('WRD_REQUIRE_RECORD_KEY') === '1';
const publicReads = env('WRD_PUBLIC_READS') === '1';
const key = env('WRD_PLATFORM_KEY');

// A deployment that requires a record key does not start without one: on a pod that serves
// anonymous reads, plaintext records would be readable by anyone. env() reads blank as unset.
if (requireRecordKey && recordKeyHex === undefined) {
  process.stderr.write('work-redesign bridge did not start: WRD_REQUIRE_RECORD_KEY=1 and WRD_RECORD_KEY is not set (64 hex characters); records would be written in plaintext\n');
  process.exit(1);
}
// A record key that is set but malformed stops the bridge: falling back to plaintext would
// publish what the operator meant to seal.
let recordKey: EncryptionKeyPair | undefined;
if (recordKeyHex !== undefined) {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(recordKeyHex)) {
    process.stderr.write('work-redesign bridge did not start: WRD_RECORD_KEY must be 64 hex characters (32 bytes)\n');
    process.exit(1);
  }
  recordKey = deriveEncryptionKeyPair(recordKeyHex, 'wrd-records');
}

let platform: PlatformSigner;
if (key) {
  platform = { wallet: importWallet(key.startsWith('0x') ? key : `0x${key}`, 'agent', 'wrd-platform'), keyKind: 'configured' };
} else {
  platform = { wallet: await createWallet('agent', 'wrd-platform'), keyKind: 'ephemeral' };
  process.stdout.write(`work-redesign: no WRD_PLATFORM_KEY — using an EPHEMERAL platform key ${platform.wallet.address}; records written now will not be trusted after a restart\n`);
}

const baseFetch = globalThis.fetch.bind(globalThis);
const app = createVerticalBridge({
  verticalName: 'work-redesign',
  affordances: wrdAffordances,
  handlers: createWrdHandlers({
    ...(defaultPodUrl ? { defaultPodUrl } : {}),
    servedPods,
    // The operator pod's credential goes only to that pod's path; holder copies go out without it.
    fetchFn: operatorPodFetch(defaultPodUrl, writeSecret, baseFetch) as unknown as FetchFn,
    holderFetchFn: baseFetch as unknown as FetchFn,
    ...(recordKey ? { recordKey } : {}),
    publicReads,
    platform,
    adminAddresses: list(env('WRD_ADMIN_ADDRESSES')),
    trustedPlatformAddresses: list(env('WRD_TRUSTED_PLATFORM_ADDRESSES')),
  }),
  deploymentUrl: base,
  ...(defaultPodUrl ? { defaultPodUrl } : {}),
  hypermediaLinks: [{ label: 'Web UI', href: `${base}/ui`, rel: 'alternate', type: 'text/html' }],
  middleware: (a) => {
    // First, so it stands in front of the ontology, the UI and every route the factory mounts after this hook.
    if (loopback) a.use(hostAllowlistGuard(servedHostNames(PORT, base)));
    attachOntologyServing(a, {
      mountPath: '/ns/wrd', ontologyIri: WRD_ONTOLOGY_IRI, namespace: WRD_NS,
      ontologyTurtle: readOntologyTurtle, shapesTurtle: readShapesTurtle,
    });
    attachUi(a, { base });
  },
});

process.stdout.write(`work-redesign: records read and written on ${servedPods.length > 0 ? servedPods.join(', ') : 'NO pod: set WRD_DEFAULT_POD_URL or WRD_SERVED_PODS, or every call is refused'}\n`);
process.stdout.write(`work-redesign: pod credential: ${writeSecret ? 'configured (sent under the default pod\'s path only)' : 'not configured'}\n`);
process.stdout.write(recordKey
  ? `work-redesign: records sealed to the record key (public key ${recordKey.publicKey}); descriptors and the manifest stay public\n`
  : 'work-redesign: WARNING: no WRD_RECORD_KEY — records are written in PLAINTEXT, and on a pod that serves anonymous reads (the gate does) anyone can read every record\n');
process.stdout.write(`work-redesign: reads: ${publicReads ? 'PUBLIC (WRD_PUBLIC_READS=1): anyone who can reach this bridge reads every record' : 'signed reads only (wrd.read_records, wrd.read_calibration); unsigned GETs answer 401'}\n`);

// Express 5 hands a failed bind to this callback rather than throwing, so it is handled here:
// ignored, the banner printed and the process exited 0, which a container platform reads as a
// clean stop and does not restart. `::` falls back to 0.0.0.0 on a host without IPv6, as Node does
// for a listen with no host.
const listen = (host: string): void => {
  app.listen(PORT, host, (err?: Error) => {
    if (err) {
      if (host === '::' && (err as NodeJS.ErrnoException).code === 'EAFNOSUPPORT') { listen('0.0.0.0'); return; }
      process.stderr.write(`work-redesign bridge did not start: cannot listen on ${host}:${PORT}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`work-redesign bridge ${base}  MCP ${base}/mcp  UI ${base}/ui  (platform ${platform.wallet.address}, ${platform.keyKind}; listening on ${host}:${PORT})\n`);
  });
};
listen(HOST);
