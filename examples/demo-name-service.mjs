// Cool demo: the Interego name service — attestation-based naming.
//
// A name is a VERIFIABLE ATTESTATION, not a claimed registration:
// `<did> foaf:nick "alice"` published as an ordinary cg:ContextDescriptor
// with Trust + Provenance facets. Resolution is federated discovery +
// a pluggable trust policy — name conflicts resolve by trust, NEVER
// first-come-first-served. No central registrar, no root, no namespace
// governance.
//
// The honest cost: a name is trust-relative, not globally unique — the
// correct trade for a substrate whose non-negotiables are federation,
// verifiability, and no central authority. Where global uniqueness IS
// wanted, did:web / ENS compose as opt-in resolution tiers under this.
// See docs/NAME-SERVICE.md (incl. the ENS comparison).
//
// Built entirely on existing primitives — the descriptor builder, the
// seven facets, cg:supersedes, foaf:nick (W3C FOAF), federated discover.
// NO new ontology terms.
//
// Runs fully offline: the resolvers take an injectable `fetch`, so an
// in-memory pod stands in for infrastructure — no live pod, no network.

import {
  buildNameAttestation,
  resolveName,
  namesFor,
} from '../dist/index.js';

// ── A tiny in-memory pod ─────────────────────────────────────
// resolveName / namesFor walk a pod via discover() + graph fetches.
// This stands one up in memory so the demo needs zero infrastructure.
// (`attestName()` is the one-call "build + publish to a REAL pod"
// version; here we use buildNameAttestation + this mock so the demo
// is runnable anywhere.)
function createInMemoryPod(podUrl) {
  const manifestUrl = podUrl.replace(/\/?$/, '/') + '.well-known/context-graphs';
  const entries = [];
  const graphs = new Map();
  return {
    podUrl,
    publish(built, { descriptorUrl, trustLevel, modalStatus = 'Asserted', validFrom }) {
      graphs.set(descriptorUrl.replace(/\.ttl$/, '-graph.trig'), built.graphContent);
      const lines = [
        `<${descriptorUrl}> a cg:ManifestEntry ;`,
        `    cg:describes <${built.graphIri}> ;`,
        `    cg:trustLevel cg:${trustLevel} ;`,
        `    cg:modalStatus cg:${modalStatus} ;`,
      ];
      if (validFrom) lines.push(`    cg:validFrom "${validFrom}" ;`);
      // A real pod's publish() mirrors the descriptor's cg:supersedes
      // into the manifest entry (see ManifestEntry.supersedes) — so the
      // resolver can find head-of-chain entries without re-fetching every
      // descriptor. Mirror that here from built.descriptor.supersedes.
      for (const s of built.descriptor.supersedes ?? []) {
        lines.push(`    cg:supersedes <${s}> ;`);
      }
      lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, ' .');
      entries.push(lines.join('\n'));
    },
    fetch: async (url) => {
      const mk = (status, body) => ({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Not Found',
        text: async () => body,
        json: async () => ({}),
      });
      if (url === manifestUrl) return mk(200, entries.join('\n\n'));
      if (graphs.has(url)) return mk(200, graphs.get(url));
      return mk(404, '');
    },
  };
}

console.log('=== Interego Name Service — attestation-based naming ===\n');

const POD = 'https://pod.example/';
const pod = createInMemoryPod(POD);
const config = { podUrl: POD, attestingAgentDid: 'did:web:pod.example:agents:resolver' };

const ALICE = 'did:web:pod.example:users:alice';
const IMPOSTOR = 'did:web:elsewhere.example:users:eve';

// ── 1. A name is an attestation, not a claim ──────────────────
console.log('── 1. A name is a verifiable attestation ──\n');
const aliceSelf = buildNameAttestation(
  { subject: ALICE, name: 'alice' },
  { ...config, onBehalfOf: ALICE },
);
console.log('buildNameAttestation({ subject: <alice DID>, name: "alice" }) →');
console.log('  attestation IRI :', aliceSelf.attestationIri);
console.log('  graph           :', aliceSelf.graphContent.trim());
console.log('  facets          :', aliceSelf.descriptor.facets.map((f) => f.type).join(', '));
console.log('  → a signed cg:ContextDescriptor over a foaf:nick triple. No new vocabulary.\n');
pod.publish(aliceSelf, {
  descriptorUrl: POD + 'cg/alice-self.ttl',
  trustLevel: 'SelfAsserted',
  validFrom: '2026-05-01T00:00:00Z',
});

// ── 2. Resolution is trust-ranked, not first-come ─────────────
console.log('── 2. Two parties attest "alice" — resolution is trust-ranked ──\n');
// An impostor self-asserts the SAME name — and does it EARLIER.
const eveSelf = buildNameAttestation(
  { subject: IMPOSTOR, name: 'alice' },
  { ...config, onBehalfOf: IMPOSTOR },
);
pod.publish(eveSelf, {
  descriptorUrl: POD + 'cg/eve-self.ttl',
  trustLevel: 'SelfAsserted',
  validFrom: '2026-04-01T00:00:00Z', // earliest — but that does NOT win
});
// A trust anchor cryptographically verifies alice's binding.
const aliceVerified = buildNameAttestation(
  {
    subject: ALICE,
    name: 'alice',
    trustLevel: 'CryptographicallyVerified',
    proof: 'urn:proof:trust-anchor-kyc-1',
  },
  { ...config, onBehalfOf: 'did:web:trust-anchor.example' },
);
pod.publish(aliceVerified, {
  descriptorUrl: POD + 'cg/alice-verified.ttl',
  trustLevel: 'CryptographicallyVerified',
  validFrom: '2026-05-10T00:00:00Z',
});

const hits = await resolveName('alice', config, { fetch: pod.fetch });
console.log('resolveName("alice") → a RANKED candidate set, not a single winner:');
for (const h of hits) {
  console.log(`  [${h.trustLevel.padEnd(25)}] ${h.subject}`);
}
console.log('  → the cryptographically-verified binding ranks first. The impostor\'s');
console.log('    EARLIER self-assertion does not win — there is no first-come-first-');
console.log('    served, only the resolver\'s trust policy (pluggable; default ranks');
console.log('    CryptographicallyVerified > ThirdPartyAttested > SelfAsserted).\n');

// ── 3. Renames supersede — they never delete ──────────────────
console.log('── 3. A rename supersedes — it never deletes ──\n');
const aliceRenamed = buildNameAttestation(
  {
    subject: ALICE,
    name: 'allie',
    supersedes: [aliceVerified.attestationIri, aliceSelf.attestationIri],
  },
  { ...config, onBehalfOf: ALICE },
);
pod.publish(aliceRenamed, {
  descriptorUrl: POD + 'cg/alice-renamed.ttl',
  trustLevel: 'SelfAsserted',
  validFrom: '2026-05-14T00:00:00Z',
});
const afterRename = await resolveName('alice', config, { fetch: pod.fetch });
const allieHits = await resolveName('allie', config, { fetch: pod.fetch });
const aliceStillForAliceDid = afterRename.filter((h) => h.subject === ALICE).length;
console.log('alice renames to "allie", superseding her prior "alice" attestations:');
console.log(`  resolveName("alice") → ${aliceStillForAliceDid} active binding(s) for alice's own DID`);
console.log(`                         (${afterRename.length} total — the impostor still self-asserts "alice",`);
console.log('                          and that is fine: it is just a low-trust binding)');
console.log(`  resolveName("allie") → ${allieHits.length} binding(s): ${allieHits.map((h) => h.subject).join(', ')}`);
console.log('  → alice\'s old "alice" descriptors are still on the pod, audit-walkable');
console.log('    via cg:supersedes — they are simply no longer surfaced by default.\n');

// ── 4. Reverse lookup ─────────────────────────────────────────
console.log('── 4. Reverse lookup — every active name for a principal ──\n');
const aliceNames = await namesFor(ALICE, config, { fetch: pod.fetch });
console.log(`namesFor(<alice DID>) → ${aliceNames.map((n) => `"${n.name}"`).join(', ') || '(none)'}`);
console.log('  → the superseded "alice" bindings are gone; "allie" remains.\n');

// ── What this demonstrates ────────────────────────────────────
console.log('── What this demonstrates ──');
console.log('   A federated name service with NO central registrar, NO root, NO');
console.log('   namespace governance. A name is a signed attestation; resolution');
console.log('   is discovery + a pluggable trust policy. Conflicts resolve by');
console.log('   trust, never first-come-first-served. Renames supersede, never');
console.log('   delete. Built on cg:ContextDescriptor + foaf:nick + cg:supersedes');
console.log('   — no new ontology terms (L2 pattern, sibling of registry: / passport:).');
console.log('');
console.log('   The honest cost: a name is trust-relative, not globally unique —');
console.log('   the correct trade for a substrate whose non-negotiables are');
console.log('   federation + verifiability + no central authority. Where global');
console.log('   uniqueness IS wanted, did:web / ENS compose as opt-in resolution');
console.log('   tiers under this. See docs/NAME-SERVICE.md.');
