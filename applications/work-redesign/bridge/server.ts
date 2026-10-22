/**
 * The work-redesign bridge process: read the configuration, compose, listen. Nothing else.
 *
 * This is the ONLY file in the vertical that reads the environment, and the only one that
 * imports the shared ontology server; it holds no handler, so nothing needs to import it.
 *
 *   PORT                            default 6100
 *   HOST                            default 127.0.0.1 — this bridge holds a signing key and its
 *                                   reads are unauthenticated in v1, so it never binds every
 *                                   interface unless told to. Bound to loopback, it answers only
 *                                   the Host names 127.0.0.1, localhost and [::1] on PORT and the
 *                                   host of BRIDGE_DEPLOYMENT_URL, and refuses any other (421):
 *                                   the DNS-rebinding guard
 *   BRIDGE_DEPLOYMENT_URL           the public base URL (default http://127.0.0.1:<PORT>)
 *   WRD_DEFAULT_POD_URL             the pod to use when a call names none
 *   WRD_PLATFORM_KEY                hex secp256k1 key the bridge signs records with; absent → an
 *                                   EPHEMERAL key, and records written now are not trusted
 *                                   after a restart
 *   WRD_ADMIN_ADDRESSES             comma list of addresses that may change the role registry
 *   WRD_TRUSTED_PLATFORM_ADDRESSES  comma list of earlier platform keys whose records stay trusted
 */
import { createWallet, importWallet } from '@interego/core';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { attachOntologyServing } from '../../_shared/ontology-serve/index.js';
import { wrdAffordances } from '../affordances.js';
import { WRD_NS, WRD_ONTOLOGY_IRI, readOntologyTurtle, readShapesTurtle } from '../src/ontology.js';
import { createWrdHandlers, type PlatformSigner } from './handlers.js';
import { attachUi, hostAllowlistGuard, isLoopbackBind, servedHostNames } from './ui.js';

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');

const PORT = parseInt(process.env['PORT'] ?? '6100', 10);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const base = (process.env['BRIDGE_DEPLOYMENT_URL'] ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const loopback = isLoopbackBind(HOST);
const defaultPodUrl = process.env['WRD_DEFAULT_POD_URL'];
const key = process.env['WRD_PLATFORM_KEY'];

let platform: PlatformSigner;
if (key) {
  platform = { wallet: importWallet(key.startsWith('0x') ? key : `0x${key}`, 'agent', 'wrd-platform'), keyKind: 'configured' };
} else {
  platform = { wallet: await createWallet('agent', 'wrd-platform'), keyKind: 'ephemeral' };
  process.stdout.write(`work-redesign: no WRD_PLATFORM_KEY — using an EPHEMERAL platform key ${platform.wallet.address}; records written now will not be trusted after a restart\n`);
}

const app = createVerticalBridge({
  verticalName: 'work-redesign',
  affordances: wrdAffordances,
  handlers: createWrdHandlers({
    ...(defaultPodUrl ? { defaultPodUrl } : {}),
    platform,
    adminAddresses: list(process.env['WRD_ADMIN_ADDRESSES']),
    trustedPlatformAddresses: list(process.env['WRD_TRUSTED_PLATFORM_ADDRESSES']),
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

app.listen(PORT, HOST, () => {
  process.stdout.write(`work-redesign bridge ${base}  MCP ${base}/mcp  UI ${base}/ui  (platform ${platform.wallet.address}, ${platform.keyKind})\n`);
});
