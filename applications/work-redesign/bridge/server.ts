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
 *                                   refuses any other (421): the DNS-rebinding guard. Bound to
 *                                   any other address (the image, behind Railway's edge), it
 *                                   trusts one proxy hop for the client address (req.ip) the web
 *                                   UI's sign-in routes count relay calls by; on loopback none
 *   WRD_TRUST_PROXY_HOPS            0 to 4: how many proxies in front of the bridge set
 *                                   X-Forwarded-For, for that client address, whatever HOST is.
 *                                   Unset: 1 off loopback, 0 on it. A loopback bridge behind a
 *                                   reverse proxy on the same machine sets 1, or every caller is
 *                                   the proxy's address and the per-address limits act as the
 *                                   bridge's own; a bridge reached with no proxy in front sets 0,
 *                                   or a caller names its own address. Any other value stops the
 *                                   bridge
 *   BRIDGE_DEPLOYMENT_URL          the public base URL (default http://127.0.0.1:<PORT>)
 *   WRD_DEFAULT_POD_URL             the pod to use when a call names none
 *   WRD_SERVED_PODS                 comma list of the pods records are read from and written to;
 *                                   default the default pod. A call naming any other pod is
 *                                   refused (403 pod-not-served); with neither set, every call is
 *                                   refused (403: this bridge serves no pod)
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
 *                                   Graphs written before the key stay plaintext on the pod
 *                                   (the read model counts them under plaintext). Absent →
 *                                   plaintext records, and the startup says they are
 *                                   world-readable on a pod that serves anonymous reads. Keep a
 *                                   copy: a lost key leaves every sealed record unreadable (409),
 *                                   with no way back, and every keyed IRI and the record id of
 *                                   every version sealed to it name its fingerprint, so a bridge
 *                                   with another key (or none) on a pod holding records written
 *                                   under it refuses every write (409), from that key's first
 *                                   sealed write on
 *   WRD_REQUIRE_RECORD_KEY          1 → the bridge does not start (exit 1) without a valid
 *                                   WRD_RECORD_KEY (blank counts as missing), so a deployment
 *                                   cannot fall back to plaintext records; 0 or unset → no such
 *                                   guard (a local run's default). The image sets it to 1. Read
 *                                   as it is, not through env(): any other value, a blank or
 *                                   whitespace one included (an unresolved reference on the
 *                                   service overriding the image's 1, say), stops the bridge
 *                                   (exit 1, saying why) rather than turn the guard off
 *   WRD_PUBLIC_READS                1 → wrd.list_records and wrd.calibration answer unsigned
 *                                   GETs from anyone who can reach the bridge; otherwise they
 *                                   answer 401, reads need a signed read (wrd.read_records,
 *                                   wrd.read_calibration) from an admin or a registered key, and
 *                                   the GET wrd.envelope_template fills only the shape and the
 *                                   head binding; wrd.read_envelope_template fills it all for
 *                                   that signed read, sent in the POST body (never in a URL)
 *   WRD_PLATFORM_KEY                64 hex: the secp256k1 key the bridge signs records with; a
 *                                   malformed value stops the bridge; absent → an EPHEMERAL key,
 *                                   and records written now are not trusted after a restart
 *   WRD_REQUIRE_PLATFORM_KEY        1 → the bridge does not start (exit 1) without a valid
 *                                   WRD_PLATFORM_KEY (blank counts as missing), so a deployment
 *                                   cannot fall back to an ephemeral key whose records the next
 *                                   restart sets aside; 0 or unset → no such guard. The image sets
 *                                   it to 1. Read as it is, like WRD_REQUIRE_RECORD_KEY: any other
 *                                   value, blank or whitespace included, stops the bridge (exit 1,
 *                                   saying why)
 *   WRD_ADMIN_ADDRESSES             comma list of 0x addresses that may change the role registry; a
 *                                   value that is not one (a user DID goes in WRD_ADMIN_DIDS) stops
 *                                   the bridge
 *   WRD_ADMIN_DIDS                  comma list of did:web:<WRD_IDENTITY_HOST>:users:<id>: people who
 *                                   sign in with their Interego account and are admins too. Not
 *                                   baked into the image; a malformed value stops the bridge
 *   WRD_TRUSTED_RELAY_ADDRESSES     comma list of 0x addresses of Interego relay delegation keys. A
 *                                   request in the relay's signed shape whose signature recovers to
 *                                   one is relay-delegated: the person is the user the signed-in
 *                                   agent belongs to, read from WRD_IDENTITY_HOST. RELAY-ATTESTED,
 *                                   NOT USER-HELD: whoever holds a listed key, or controls the
 *                                   identity host, can act here as any person. Empty → no request is
 *                                   relay-delegated. A malformed value stops the bridge
 *   WRD_RETIRED_RELAY_ADDRESSES     comma list of 0x addresses of relay delegation keys retired from
 *                                   new requests (key rotation): no request they sign now is
 *                                   relay-delegated, and a countersign they signed still re-verifies
 *                                   when its outcome is recorded. An address in both lists, a
 *                                   malformed one, or one set without WRD_IDENTITY_HOST stops the
 *                                   bridge
 *   WRD_IDENTITY_HOST               the identity host agents and users are on (a bare host name);
 *                                   required with a relay address or an admin DID
 *   WRD_RELAY_URL                   the relay a person signs in through (http(s) base URL), reported
 *                                   to the web UI, whose "Sign in with your Interego account" goes
 *                                   through it (bridge/ui.ts; on only with a trusted relay address).
 *                                   The relay's OAuth access token a person signs in with (about
 *                                   an hour) passes through this bridge on every signature, and the
 *                                   relay's /identity-token trades it for their identity-server
 *                                   token (good on the account itself for up to a day), so its
 *                                   operator is trusted with their account for that day
 *   WRD_CHAT_AGENTS_DECIDE          1 → acts that change who may do what (the registry, countersign,
 *                                   an outcome, grant, revoke) are taken from chat agents too; unset or 0 → only
 *                                   from this bridge's web UI (agent slug work-redesign-…); any other
 *                                   value stops the bridge
 *   WRD_TRUSTED_PLATFORM_ADDRESSES  comma list of earlier platform keys whose records stay trusted.
 *                                   An address that signed records on the pod stays listed for as
 *                                   long as the pod is used: dropping it cuts every line holding a
 *                                   version it signed, and writes to those graphs answer 409
 */
import { createWallet, importWallet, deriveEncryptionKeyPair, type EncryptionKeyPair, type FetchFn } from '@interego/core';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { attachOntologyServing } from '../../_shared/ontology-serve/index.js';
import { wrdAffordances } from '../affordances.js';
import { WRD_NS, WRD_ONTOLOGY_IRI, readOntologyTurtle, readShapesTurtle } from '../src/ontology.js';
import { createWrdHandlers, type PlatformSigner } from './handlers.js';
import { operatorPodFetch } from './pod-helpers.js';
import { didDocumentFetcher, parseRelaySignIn } from './relay-sign-in.js';
import { isAddress } from '../src/records.js';
import { attachUi, hostAllowlistGuard, isLoopbackBind, parseEveryQueryPair, servedHostNames } from './ui.js';

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
// An image declares every variable it reads (`ENV NAME=`), so an empty value means unset; the
// exceptions are WRD_REQUIRE_RECORD_KEY and WRD_REQUIRE_PLATFORM_KEY, read as they are below.
const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
};

const PORT = parseInt(env('PORT') ?? '6100', 10);
const HOST = env('HOST') ?? '127.0.0.1';
const base = (env('BRIDGE_DEPLOYMENT_URL') ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const loopback = isLoopbackBind(HOST);
// The client address the web UI's sign-in routes limit relay calls by (req.ip) is the one this many
// proxy hops in front saw. A malformed value stops the bridge rather than count every caller as one.
const proxyHopsValue = env('WRD_TRUST_PROXY_HOPS');
if (proxyHopsValue !== undefined && !/^[0-4]$/.test(proxyHopsValue)) {
  process.stderr.write(`work-redesign bridge did not start: WRD_TRUST_PROXY_HOPS is ${JSON.stringify(proxyHopsValue.slice(0, 40))}; set it to how many proxies in front of the bridge set X-Forwarded-For (0 to 4), or unset it for 1 off loopback and 0 on loopback\n`);
  process.exit(1);
}
const proxyHops = proxyHopsValue !== undefined ? Number(proxyHopsValue) : loopback ? 0 : 1;
const defaultPodUrl = env('WRD_DEFAULT_POD_URL');
const servedPods = list(env('WRD_SERVED_PODS') ?? defaultPodUrl);
const writeSecret = env('WRD_POD_WRITE_SECRET');
const recordKeyHex = env('WRD_RECORD_KEY');
// Not through env(): a blank value must not read as unset here, where unset turns the guard off.
const requireRecordKeyValue = process.env['WRD_REQUIRE_RECORD_KEY'];
const requirePlatformKeyValue = process.env['WRD_REQUIRE_PLATFORM_KEY'];
const publicReads = env('WRD_PUBLIC_READS') === '1';
const key = env('WRD_PLATFORM_KEY');
const adminAddresses = list(env('WRD_ADMIN_ADDRESSES'));

// Sign in with an Interego account (relay-delegated): every value is checked here, and a malformed
// one stops the bridge, as a malformed key does, rather than switch the route off or on unseen.
const signInRead = parseRelaySignIn({
  relays: env('WRD_TRUSTED_RELAY_ADDRESSES'), retiredRelays: env('WRD_RETIRED_RELAY_ADDRESSES'), identityHost: env('WRD_IDENTITY_HOST'), relayUrl: env('WRD_RELAY_URL'),
  adminDids: env('WRD_ADMIN_DIDS'), chatAgentsDecide: env('WRD_CHAT_AGENTS_DECIDE'),
});
if (!signInRead.ok) {
  process.stderr.write(`work-redesign bridge did not start: ${signInRead.why}\n`);
  process.exit(1);
}
const signIn = signInRead.config;
// An admin address is an address: a user DID read here would be lower-cased into another user
// (a user DID is compared as spelled), so one in this list stops the bridge rather than admit the wrong person.
const notAnAddress = adminAddresses.find((a): boolean => !isAddress(a));
if (notAnAddress !== undefined) {
  process.stderr.write(`work-redesign bridge did not start: WRD_ADMIN_ADDRESSES holds ${JSON.stringify(notAnAddress.slice(0, 120))}, which is not a 0x address (40 hex characters); a user DID is an admin through WRD_ADMIN_DIDS\n`);
  process.exit(1);
}

// The guard is on only for exactly 1 and off only for 0 or unset: any other value, blank or
// whitespace included, is a misconfiguration that would otherwise switch it off without a word.
if (requireRecordKeyValue !== undefined && requireRecordKeyValue !== '0' && requireRecordKeyValue !== '1') {
  process.stderr.write(`work-redesign bridge did not start: WRD_REQUIRE_RECORD_KEY is ${requireRecordKeyValue.trim() === '' ? 'blank' : 'neither 1 nor 0'}; set it to 1 to require a record key, or to 0 (or unset it) to allow plaintext records\n`);
  process.exit(1);
}
const requireRecordKey = requireRecordKeyValue === '1';
// A deployment that requires a record key does not start without one: on a pod that serves
// anonymous reads, plaintext records would be readable by anyone. env() reads a blank key as unset.
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

// The same reading for the platform key's guard: on only for exactly 1, off only for 0 or unset.
if (requirePlatformKeyValue !== undefined && requirePlatformKeyValue !== '0' && requirePlatformKeyValue !== '1') {
  process.stderr.write(`work-redesign bridge did not start: WRD_REQUIRE_PLATFORM_KEY is ${requirePlatformKeyValue.trim() === '' ? 'blank' : 'neither 1 nor 0'}; set it to 1 to require a platform key, or to 0 (or unset it) to allow an ephemeral one\n`);
  process.exit(1);
}
const requirePlatformKey = requirePlatformKeyValue === '1';
// A deployment that requires a platform key does not start without one: an ephemeral key's records
// are set aside after the next restart (every deploy is one), and trusting its address afterwards
// forks every graph a later key wrote to. env() reads a blank key as unset.
if (requirePlatformKey && key === undefined) {
  process.stderr.write('work-redesign bridge did not start: WRD_REQUIRE_PLATFORM_KEY=1 and WRD_PLATFORM_KEY is not set (64 hex characters); an ephemeral key\'s records would not be trusted after the next restart\n');
  process.exit(1);
}
// A platform key that is set but malformed stops the bridge, whether or not one is required.
if (key !== undefined && !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
  process.stderr.write('work-redesign bridge did not start: WRD_PLATFORM_KEY must be 64 hex characters (32 bytes)\n');
  process.exit(1);
}

let platform: PlatformSigner;
if (key) {
  platform = { wallet: importWallet(key.startsWith('0x') ? key : `0x${key}`, 'agent', 'wrd-platform'), keyKind: 'configured' };
} else {
  platform = { wallet: await createWallet('agent', 'wrd-platform'), keyKind: 'ephemeral' };
  process.stdout.write(`work-redesign: no WRD_PLATFORM_KEY — using an EPHEMERAL platform key ${platform.wallet.address}; records written now will not be trusted after a restart\n`);
}

const baseFetch = globalThis.fetch.bind(globalThis);
const identityHost = signIn.identityHost;
// One DID-document reader (and so one cache) for the handlers and the web UI's sign-in.
const fetchDidDocument = didDocumentFetcher(baseFetch);
const uiRelayPolicy = identityHost !== null && signIn.relayAddresses.length > 0
  ? { relayAddresses: signIn.relayAddresses, identityHost, fetchDidDocument } : null;
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
    adminAddresses,
    adminDids: signIn.adminDids,
    trustedPlatformAddresses: list(env('WRD_TRUSTED_PLATFORM_ADDRESSES')),
    // Agents' DID documents are read through the SSRF guard, 8 s and 64 KiB at most, kept ten minutes.
    ...(identityHost !== null ? {
      relayDelegation: {
        relayAddresses: signIn.relayAddresses, retiredRelayAddresses: signIn.retiredRelayAddresses, identityHost, fetchDidDocument,
        chatAgentsDecide: signIn.chatAgentsDecide, ...(signIn.relayUrl !== null ? { relayUrl: signIn.relayUrl } : {}),
      },
    } : {}),
  }),
  deploymentUrl: base,
  ...(defaultPodUrl ? { defaultPodUrl } : {}),
  hypermediaLinks: [{ label: 'Web UI', href: `${base}/ui`, rel: 'alternate', type: 'text/html' }],
  middleware: (a) => {
    // First, so it stands in front of the ontology, the UI and every route the factory mounts after this hook.
    if (loopback) a.use(hostAllowlistGuard(servedHostNames(PORT, base)));
    // The web UI's sign-in routes limit each client address (req.ip) on their relay calls. In the
    // image the bridge listens behind Railway's edge, one proxy hop, so req.ip is the client only
    // when that hop is trusted; a loopback bridge trusts none unless WRD_TRUST_PROXY_HOPS says a
    // proxy on the same machine stands in front, so no caller picks its own address.
    if (proxyHops > 0) a.set('trust proxy', proxyHops);
    // Every query parameter reaches the handlers, so the GET template's signed-read check sees past the default parser's first 1000.
    parseEveryQueryPair(a);
    attachOntologyServing(a, {
      mountPath: '/ns/wrd', ontologyIri: WRD_ONTOLOGY_IRI, namespace: WRD_NS,
      ontologyTurtle: readOntologyTurtle, shapesTurtle: readShapesTurtle,
    });
    // "Sign in with your Interego account" in the web UI, through WRD_RELAY_URL; it names a person only through a relay this bridge trusts.
    attachUi(a, { base, ...(signIn.relayUrl !== null ? { signIn: { relayUrl: signIn.relayUrl, policy: uiRelayPolicy } } : {}) });
  },
});

process.stdout.write(`work-redesign: records read and written on ${servedPods.length > 0 ? servedPods.join(', ') : 'NO pod: set WRD_DEFAULT_POD_URL or WRD_SERVED_PODS, or every call is refused'}\n`);
process.stdout.write(`work-redesign: pod credential: ${writeSecret ? 'configured (sent under the default pod\'s path only)' : 'not configured'}\n`);
process.stdout.write(recordKey
  ? `work-redesign: records written from now on are sealed to the record key (public key ${recordKey.publicKey}); records written before it stay plaintext on the pod (the read model counts them under plaintext); descriptors and the manifest stay public\n`
  : 'work-redesign: WARNING: no WRD_RECORD_KEY — records are written in PLAINTEXT, and on a pod that serves anonymous reads (the gate does) anyone can read every record\n');
process.stdout.write(signIn.relayAddresses.length > 0
  ? `work-redesign: sign-in with an Interego account: RELAY-ATTESTED, not user-held: requests the relay (${signIn.relayAddresses.join(', ')}) signs act as the user their agent belongs to on ${identityHost ?? ''}; whoever holds that key or controls that host can act as anyone here. Decisive acts from chat agents: ${signIn.chatAgentsDecide ? 'taken (WRD_CHAT_AGENTS_DECIDE=1)' : 'refused (only this bridge\'s web UI; WRD_CHAT_AGENTS_DECIDE=1 lifts it)'}; ${signIn.adminDids.length} admin DID(s); ${signIn.retiredRelayAddresses.length} retired relay key(s) whose stored countersigns still re-verify\n`
  : 'work-redesign: sign-in with an Interego account: off (WRD_TRUSTED_RELAY_ADDRESSES is empty); every signature is a key its signer holds\n');
process.stdout.write(signIn.relayUrl !== null && uiRelayPolicy !== null
  ? `work-redesign: web UI sign-in with an Interego account: through ${signIn.relayUrl}, as the client ${base}/ui/oauth/client.json (a Client ID Metadata Document; where the relay cannot read it, as for an http deployment URL, the same metadata is registered once by Dynamic Client Registration when the page first asks how to sign in). The relay's OAuth access token a person signs in with (about an hour; it lets its holder call the relay's tools as them, and the relay's /identity-token trades it for their identity-server token, good on the account itself for up to a day) passes through this bridge on every signature: whoever runs it is trusted with that account for up to a day after each sign-in\n`
  : `work-redesign: web UI sign-in with an Interego account: off (${signIn.relayUrl === null ? 'WRD_RELAY_URL is not set' : 'no trusted relay: WRD_TRUSTED_RELAY_ADDRESSES is empty'})\n`);
if (signIn.relayUrl !== null && uiRelayPolicy !== null) {
  process.stdout.write(proxyHops > 0
    ? `work-redesign: web UI sign-in limits count each caller by the address ${proxyHops} proxy hop(s) in front saw (X-Forwarded-For; ${proxyHopsValue !== undefined ? `WRD_TRUST_PROXY_HOPS=${proxyHops}` : 'off loopback'})\n`
    : `work-redesign: web UI sign-in limits count each caller by the address that connects to the bridge (no proxy hop trusted${proxyHopsValue !== undefined ? ', WRD_TRUST_PROXY_HOPS=0' : ' on loopback'}); behind a reverse proxy every caller is the proxy's address, so set WRD_TRUST_PROXY_HOPS to the hops in front\n`);
}
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
