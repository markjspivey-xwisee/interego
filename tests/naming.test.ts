/**
 * Tests for src/naming/ — the Interego name service.
 *
 * Naming is attestation-based: a name is `<did> foaf:nick "alice"` in an
 * ordinary descriptor with Trust/Provenance facets, resolved by
 * federated discovery + a pluggable trust policy. These cover the pure
 * builder + policy, then the resolvers end-to-end through an injected
 * mock fetch (manifest + graph). See docs/NAME-SERVICE.md.
 */

import { describe, it, expect } from 'vitest';
import {
  buildNameAttestation,
  resolveName,
  namesFor,
  defaultNameTrustPolicy,
  resolveIdentifier,
  directoryNameIndex,
  podDirectoryToTurtle,
  parsePodDirectory,
} from '../src/index.js';
import type { IRI, NamingConfig, NameCandidate, FetchFn, PodDirectoryData } from '../src/index.js';

const FOAF_NICK = 'http://xmlns.com/foaf/0.1/nick';
const ALICE_DID = 'did:web:pod.example:users:alice' as IRI;
const BOB_DID = 'did:web:pod.example:users:bob' as IRI;

const CONFIG: NamingConfig = {
  podUrl: 'https://pod.example/',
  attestingAgentDid: 'did:web:pod.example:agents:a1' as IRI,
};

// ── buildNameAttestation (pure) ──────────────────────────────────────

describe('buildNameAttestation', () => {
  it('describes a name graph and emits a foaf:nick binding', () => {
    const built = buildNameAttestation({ subject: ALICE_DID, name: 'alice' }, CONFIG);
    expect(built.attestationIri).toMatch(/^urn:cg:name:[0-9a-f]{16}$/);
    expect(built.graphIri).toMatch(/^urn:graph:cg:name:[0-9a-f]{16}$/);
    expect(built.descriptor.describes).toContain(built.graphIri);
    expect(built.graphContent).toContain(`<${ALICE_DID}>`);
    expect(built.graphContent).toContain(`<${FOAF_NICK}>`);
    expect(built.graphContent).toContain('"alice"');
  });

  it('is content-addressed — same (subject,name) → same IRI, different name → different', () => {
    const a = buildNameAttestation({ subject: ALICE_DID, name: 'alice' }, CONFIG);
    const a2 = buildNameAttestation({ subject: ALICE_DID, name: 'alice' }, CONFIG);
    const b = buildNameAttestation({ subject: ALICE_DID, name: 'alyce' }, CONFIG);
    expect(a.attestationIri).toBe(a2.attestationIri);
    expect(a.attestationIri).not.toBe(b.attestationIri);
  });

  it('defaults to a SelfAsserted Trust facet', () => {
    const built = buildNameAttestation({ subject: ALICE_DID, name: 'alice' }, CONFIG);
    const trust = built.descriptor.facets.find(f => f.type === 'Trust') as { trustLevel?: string };
    expect(trust?.trustLevel).toBe('SelfAsserted');
  });

  it('honors ThirdPartyAttested and CryptographicallyVerified trust levels', () => {
    const third = buildNameAttestation(
      { subject: ALICE_DID, name: 'alice', trustLevel: 'ThirdPartyAttested' }, CONFIG);
    const verified = buildNameAttestation(
      { subject: ALICE_DID, name: 'alice', trustLevel: 'CryptographicallyVerified', proof: 'urn:proof:1' as IRI }, CONFIG);
    const t = (b: typeof third) => (b.descriptor.facets.find(f => f.type === 'Trust') as { trustLevel?: string })?.trustLevel;
    expect(t(third)).toBe('ThirdPartyAttested');
    expect(t(verified)).toBe('CryptographicallyVerified');
  });

  it('records cg:supersedes for a rename', () => {
    const prior = buildNameAttestation({ subject: ALICE_DID, name: 'old' }, CONFIG);
    const renamed = buildNameAttestation(
      { subject: ALICE_DID, name: 'new', supersedes: [prior.attestationIri] }, CONFIG);
    expect(renamed.descriptor.supersedes).toContain(prior.attestationIri);
  });

  it('rejects an empty name', () => {
    expect(() => buildNameAttestation({ subject: ALICE_DID, name: '   ' }, CONFIG)).toThrow(/empty/);
  });
});

// ── defaultNameTrustPolicy (pure) ────────────────────────────────────

function candidate(over: Partial<NameCandidate>): NameCandidate {
  return {
    name: 'alice', subject: ALICE_DID,
    attestationIri: 'urn:cg:name:0000000000000000' as IRI,
    attestationUrl: 'https://pod.example/cg/x.ttl',
    podUrl: 'https://pod.example/',
    trustLevel: 'SelfAsserted', modalStatus: 'Asserted',
    superseded: false, score: 0, ...over,
  };
}

describe('defaultNameTrustPolicy', () => {
  it('drops retracted (Counterfactual / Retracted) and superseded attestations', () => {
    const out = defaultNameTrustPolicy([
      candidate({ attestationIri: 'urn:cg:name:active' as IRI }),
      candidate({ attestationIri: 'urn:cg:name:cf' as IRI, modalStatus: 'Counterfactual' }),
      candidate({ attestationIri: 'urn:cg:name:rt' as IRI, modalStatus: 'Retracted' }),
      candidate({ attestationIri: 'urn:cg:name:sup' as IRI, superseded: true }),
    ]);
    expect(out.map(c => c.attestationIri)).toEqual(['urn:cg:name:active']);
  });

  it('ranks by trust level: CryptographicallyVerified > ThirdPartyAttested > SelfAsserted', () => {
    const out = defaultNameTrustPolicy([
      candidate({ attestationIri: 'urn:cg:name:self' as IRI, trustLevel: 'SelfAsserted' }),
      candidate({ attestationIri: 'urn:cg:name:verified' as IRI, trustLevel: 'CryptographicallyVerified' }),
      candidate({ attestationIri: 'urn:cg:name:third' as IRI, trustLevel: 'ThirdPartyAttested' }),
    ]);
    expect(out.map(c => c.attestationIri)).toEqual([
      'urn:cg:name:verified', 'urn:cg:name:third', 'urn:cg:name:self',
    ]);
  });

  it('uses recency as the within-level tiebreaker', () => {
    const out = defaultNameTrustPolicy([
      candidate({ attestationIri: 'urn:cg:name:old' as IRI, attestedAt: '2026-01-01T00:00:00Z' }),
      candidate({ attestationIri: 'urn:cg:name:new' as IRI, attestedAt: '2026-05-01T00:00:00Z' }),
    ]);
    expect(out[0]?.attestationIri).toBe('urn:cg:name:new');
  });
});

// ── resolveName / namesFor (mock-fetch, end-to-end) ──────────────────

interface FakeAttestation {
  readonly descriptorUrl: string;
  readonly subject: IRI;
  readonly name: string;
  readonly trustLevel?: string;
  readonly modalStatus?: string;
  readonly validFrom?: string;
  readonly supersedes?: readonly string[];
}

/** A mock FetchFn serving a pod's manifest + its name-graph TriGs. */
function mockPod(podUrl: string, attestations: readonly FakeAttestation[]): FetchFn {
  const manifestUrl = podUrl.replace(/\/?$/, '/') + '.well-known/context-graphs';
  const graphByUrl = new Map<string, string>();
  const entries: string[] = [];

  for (const a of attestations) {
    const built = buildNameAttestation({ subject: a.subject, name: a.name }, CONFIG);
    graphByUrl.set(a.descriptorUrl.replace(/\.ttl$/, '-graph.trig'), built.graphContent);
    const lines = [
      `<${a.descriptorUrl}> a cg:ManifestEntry ;`,
      `    cg:describes <${built.graphIri}> ;`,
    ];
    if (a.trustLevel) lines.push(`    cg:trustLevel cg:${a.trustLevel} ;`);
    if (a.modalStatus) lines.push(`    cg:modalStatus cg:${a.modalStatus} ;`);
    if (a.validFrom) lines.push(`    cg:validFrom "${a.validFrom}" ;`);
    for (const s of a.supersedes ?? []) lines.push(`    cg:supersedes <${s}> ;`);
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/ ;$/, ' .');
    entries.push(lines.join('\n'));
  }
  const manifest = entries.join('\n\n');

  return async (url) => {
    const mk = (status: number, body: string) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      text: async () => body,
      json: async () => ({}),
    });
    if (url === manifestUrl) return mk(200, manifest);
    const g = graphByUrl.get(url);
    if (g !== undefined) return mk(200, g);
    return mk(404, '');
  };
}

/** Compose several single-pod mocks into one (each tries its own pod). */
function mergeMocks(...mocks: FetchFn[]): FetchFn {
  return async (url, init) => {
    for (const m of mocks) {
      const r = await m(url, init);
      if (r.ok) return r;
    }
    return mocks[0]!(url, init);
  };
}

describe('resolveName', () => {
  it('resolves a name to its principal (case-insensitive)', async () => {
    const fetch = mockPod(CONFIG.podUrl, [
      { descriptorUrl: 'https://pod.example/cg/n1.ttl', subject: ALICE_DID, name: 'alice',
        trustLevel: 'SelfAsserted', validFrom: '2026-05-01T00:00:00Z' },
    ]);
    const hits = await resolveName('ALICE', CONFIG, { fetch });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.subject).toBe(ALICE_DID);
    expect(hits[0]?.trustLevel).toBe('SelfAsserted');
  });

  it('returns an empty set for an unknown name and never throws on an unreachable pod', async () => {
    const fetch = mockPod(CONFIG.podUrl, [
      { descriptorUrl: 'https://pod.example/cg/n1.ttl', subject: ALICE_DID, name: 'alice' },
    ]);
    expect(await resolveName('nobody', CONFIG, { fetch })).toEqual([]);
    const dead: FetchFn = async () => { throw new Error('network down'); };
    await expect(resolveName('alice', CONFIG, { fetch: dead })).resolves.toEqual([]);
  });

  it('aggregates across federated pods and ranks by trust level', async () => {
    const podA = mockPod('https://pod-a.example/', [
      { descriptorUrl: 'https://pod-a.example/cg/n.ttl', subject: ALICE_DID, name: 'alice',
        trustLevel: 'SelfAsserted' },
    ]);
    const podB = mockPod('https://pod-b.example/', [
      { descriptorUrl: 'https://pod-b.example/cg/n.ttl', subject: BOB_DID, name: 'alice',
        trustLevel: 'CryptographicallyVerified' },
    ]);
    const hits = await resolveName('alice', CONFIG, {
      pods: ['https://pod-a.example/', 'https://pod-b.example/'],
      fetch: mergeMocks(podA, podB),
    });
    expect(hits).toHaveLength(2);
    // The CryptographicallyVerified binding outranks the SelfAsserted one.
    expect(hits[0]?.trustLevel).toBe('CryptographicallyVerified');
    expect(hits[0]?.subject).toBe(BOB_DID);
  });

  it('drops a superseded attestation from the default-policy result', async () => {
    const oldIri = buildNameAttestation({ subject: ALICE_DID, name: 'alice' }, CONFIG).attestationIri;
    const fetch = mockPod(CONFIG.podUrl, [
      // the renamed binding, which supersedes the prior one
      { descriptorUrl: 'https://pod.example/cg/new.ttl', subject: ALICE_DID, name: 'allie',
        supersedes: [oldIri] },
      // the prior binding — still on the pod, but superseded
      { descriptorUrl: 'https://pod.example/cg/old.ttl', subject: ALICE_DID, name: 'alice' },
    ]);
    expect(await resolveName('alice', CONFIG, { fetch })).toEqual([]); // superseded → dropped
    const live = await resolveName('allie', CONFIG, { fetch });
    expect(live).toHaveLength(1);
  });
});

describe('namesFor', () => {
  it('returns every active name attested for a subject', async () => {
    const fetch = mockPod(CONFIG.podUrl, [
      { descriptorUrl: 'https://pod.example/cg/1.ttl', subject: ALICE_DID, name: 'alice' },
      { descriptorUrl: 'https://pod.example/cg/2.ttl', subject: ALICE_DID, name: 'a.spivey' },
      { descriptorUrl: 'https://pod.example/cg/3.ttl', subject: BOB_DID, name: 'bob' },
    ]);
    const names = await namesFor(ALICE_DID, CONFIG, { fetch });
    expect(names.map(n => n.name).sort()).toEqual(['a.spivey', 'alice']);
    expect(names.every(n => n.subject === ALICE_DID)).toBe(true);
  });
});

// ── resolveIdentifier TN tier (the name service as a resolver tier) ──

describe('resolveIdentifier — TN name tier (opt-in)', () => {
  it('resolves a bare name when options.naming is supplied', async () => {
    const fetch = mockPod(CONFIG.podUrl, [
      { descriptorUrl: 'https://pod.example/cg/n1.ttl', subject: ALICE_DID, name: 'alice',
        trustLevel: 'CryptographicallyVerified' },
    ]);
    const r = await resolveIdentifier('alice', { fetch, naming: { config: CONFIG } });
    expect(r.kind).toBe('name');
    expect(r.tiersHit).toContain('TN');
    expect(r.nameCandidates).toHaveLength(1);
    expect(r.nameCandidates?.[0]?.subject).toBe(ALICE_DID);
    // the top candidate's subject is mirrored into webId for single-answer callers
    expect(r.webId).toBe(ALICE_DID);
  });

  it('leaves a bare name as kind=unknown when naming is NOT supplied (opt-in)', async () => {
    const r = await resolveIdentifier('alice', {});
    expect(r.kind).toBe('unknown');
    expect(r.tiersHit).not.toContain('TN');
    expect(r.nameCandidates).toBeUndefined();
  });

  it('does not run the name tier for a structured identifier (did:)', async () => {
    const fetch = mockPod(CONFIG.podUrl, [
      { descriptorUrl: 'https://pod.example/cg/n1.ttl', subject: ALICE_DID, name: 'alice' },
    ]);
    const r = await resolveIdentifier('did:web:somewhere.example:users:x', {
      fetch, naming: { config: CONFIG },
    });
    expect(r.kind).toBe('did'); // structured kind — TN only runs for kind=unknown
    expect(r.tiersHit).not.toContain('TN');
  });

  it('traces "no candidates" when naming is supplied but the name is unknown', async () => {
    const fetch = mockPod(CONFIG.podUrl, []);
    const r = await resolveIdentifier('ghost', { fetch, naming: { config: CONFIG } });
    expect(r.kind).toBe('unknown'); // no candidates → stays unknown
    expect(r.trace?.TN).toMatch(/no candidates/);
  });

  it('auto-detects the @-prefixed host-free name form', async () => {
    const fetch = mockPod(CONFIG.podUrl, [
      { descriptorUrl: 'https://pod.example/cg/n1.ttl', subject: ALICE_DID, name: 'alice' },
    ]);
    // @alice is syntactically a name — detected even without relying on
    // the kind being 'unknown'.
    const r = await resolveIdentifier('@alice', { fetch, naming: { config: CONFIG } });
    expect(r.kind).toBe('name');
    expect(r.tiersHit).toContain('TN');
    expect(r.nameCandidates?.[0]?.subject).toBe(ALICE_DID);
  });

  it('marks @-names as kind=name even without a naming config, with a helpful trace', async () => {
    const r = await resolveIdentifier('@alice', {});
    expect(r.kind).toBe('name'); // the @ marker is enough to detect the KIND
    expect(r.tiersHit).not.toContain('TN'); // ...but resolution needs options.naming
    expect(r.trace?.TN).toMatch(/pass options\.naming/);
  });
});

describe('resolveName — @-prefix', () => {
  it('strips a single leading @ — resolveName("@alice") === resolveName("alice")', async () => {
    const fetch = mockPod(CONFIG.podUrl, [
      { descriptorUrl: 'https://pod.example/cg/n1.ttl', subject: ALICE_DID, name: 'alice' },
    ]);
    const withAt = await resolveName('@alice', CONFIG, { fetch });
    const without = await resolveName('alice', CONFIG, { fetch });
    expect(withAt).toHaveLength(1);
    expect(withAt[0]?.subject).toBe(without[0]?.subject);
  });
});

// ── Pod-directory name-index — federation hints (foaf:nick on cg:owner) ──

describe('PodDirectory — foaf:nick name hints', () => {
  it('round-trips ownerNicks through podDirectoryToTurtle / parsePodDirectory', () => {
    const dir: PodDirectoryData = {
      id: 'urn:directory:test' as IRI,
      entries: [
        {
          podUrl: 'https://pod-a.example/' as IRI,
          owner: ALICE_DID,
          ownerNicks: ['alice', 'a.spivey'],
        },
        {
          podUrl: 'https://pod-b.example/' as IRI,
          owner: BOB_DID,
          ownerNicks: ['bob'],
        },
        // Entry with no hints stays a plain entry (the no-hint path).
        { podUrl: 'https://pod-c.example/' as IRI },
      ],
    };
    const ttl = podDirectoryToTurtle(dir);
    expect(ttl).toContain('foaf:');
    expect(ttl).toContain(`<${ALICE_DID}> foaf:nick "alice"`);
    expect(ttl).toContain(`<${BOB_DID}> foaf:nick "bob"`);

    const parsed = parsePodDirectory(ttl);
    const aliceEntry = parsed.entries.find(e => e.owner === ALICE_DID);
    const bobEntry = parsed.entries.find(e => e.owner === BOB_DID);
    expect(aliceEntry?.ownerNicks?.slice().sort()).toEqual(['a.spivey', 'alice']);
    expect(bobEntry?.ownerNicks).toEqual(['bob']);
    expect(parsed.entries.find(e => e.podUrl === 'https://pod-c.example/')?.ownerNicks).toBeUndefined();
  });

  it('round-trips ownerNicks containing newlines / quotes / backslashes / tabs', () => {
    // Regression for the just-shipped escape/unescape asymmetry — escape used
    // to cover only \\ and ", but unescape decoded \n / \r / \t too, so a
    // nick containing a control char produced malformed Turtle (or, on the
    // reverse path, corrupted data). The shared helper closes the gap.
    const adversarial = [
      'alice\nbob',
      'has"quotes"',
      'back\\slash',
      'tab\there',
      'cr\rstuff',
      'all\\"\n\r\tchars',
    ];
    const dir: PodDirectoryData = {
      id: 'urn:directory:adversarial' as IRI,
      entries: [{
        podUrl: 'https://pod.example/' as IRI,
        owner: ALICE_DID,
        ownerNicks: adversarial,
      }],
    };
    const ttl = podDirectoryToTurtle(dir);
    // Cheap sanity: a literal LF inside a "..." literal is malformed
    // Turtle. After escaping there must be zero LFs inside the nick body —
    // they should all have become the two-character escape `\n`.
    for (const line of ttl.split('\n')) {
      // Every foaf:nick line must have BOTH quotes on the same emitted line.
      if (line.includes('foaf:nick')) {
        const opens = (line.match(/(?<!\\)"/g) ?? []).length;
        expect(opens % 2).toBe(0); // balanced
        expect(opens).toBeGreaterThanOrEqual(2);
      }
    }
    const parsed = parsePodDirectory(ttl);
    const entry = parsed.entries.find(e => e.owner === ALICE_DID);
    expect(entry?.ownerNicks?.slice().sort()).toEqual(adversarial.slice().sort());
  });

  it('omits the foaf: prefix when no entry has hints (keeps the common path tight)', () => {
    const dir: PodDirectoryData = {
      id: 'urn:directory:plain' as IRI,
      entries: [{ podUrl: 'https://pod-x.example/' as IRI, owner: ALICE_DID }],
    };
    const ttl = podDirectoryToTurtle(dir);
    expect(ttl).not.toContain('foaf:');
  });

  it('directoryNameIndex builds a lowercase name → hint map across directories', () => {
    const dirA: PodDirectoryData = {
      id: 'urn:directory:a' as IRI,
      entries: [{
        podUrl: 'https://pod-a.example/' as IRI,
        owner: ALICE_DID,
        ownerNicks: ['Alice'],
      }],
    };
    const dirB: PodDirectoryData = {
      id: 'urn:directory:b' as IRI,
      entries: [{
        podUrl: 'https://pod-b.example/' as IRI,
        owner: BOB_DID,
        ownerNicks: ['alice'], // Bob also claims "alice" — a contested name
      }],
    };
    const idx = directoryNameIndex([dirA, dirB]);
    const hits = idx.get('alice') ?? [];
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.podUrl).sort()).toEqual([
      'https://pod-a.example/',
      'https://pod-b.example/',
    ]);
    // Reverse-lookup case verified separately; sanity-check that
    // `bob` is also indexed off `dirB`'s alice-claimer if it appears.
    expect(idx.get('bob')).toBeUndefined();
  });
});

// ── resolveName / namesFor — directory-hint narrowing ────────────────

describe('resolveName — narrows the pod walk via directory hints', () => {
  it('only visits pods the directory advertises for the target name', async () => {
    // Count manifest fetches per pod URL to verify which pods got walked.
    let podAManifestFetches = 0;
    let podBManifestFetches = 0;
    const podAMock = mockPod('https://pod-a.example/', [
      { descriptorUrl: 'https://pod-a.example/cg/n.ttl', subject: ALICE_DID, name: 'alice',
        trustLevel: 'CryptographicallyVerified' },
    ]);
    const podBMock = mockPod('https://pod-b.example/', [
      { descriptorUrl: 'https://pod-b.example/cg/n.ttl', subject: BOB_DID, name: 'bob' },
    ]);
    const fetch: FetchFn = async (url, init) => {
      if (typeof url === 'string') {
        if (url.startsWith('https://pod-a.example/') && url.endsWith('.well-known/context-graphs')) podAManifestFetches++;
        if (url.startsWith('https://pod-b.example/') && url.endsWith('.well-known/context-graphs')) podBManifestFetches++;
      }
      return mergeMocks(podAMock, podBMock)(url, init);
    };

    const dir: PodDirectoryData = {
      id: 'urn:directory:t' as IRI,
      entries: [
        { podUrl: 'https://pod-a.example/' as IRI, owner: ALICE_DID, ownerNicks: ['alice'] },
        { podUrl: 'https://pod-b.example/' as IRI, owner: BOB_DID, ownerNicks: ['bob'] },
      ],
    };

    const hits = await resolveName('alice', CONFIG, {
      pods: ['https://pod-a.example/', 'https://pod-b.example/'],
      directories: [dir],
      fetch,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.subject).toBe(ALICE_DID);
    // pod-b should have been narrowed out — only pod-a (the alice-hosting
    // pod) walked, since the directory advertises bob there, not alice.
    expect(podAManifestFetches).toBeGreaterThan(0);
    expect(podBManifestFetches).toBe(0);
  });

  it('falls back to the full pod list when no hint matches (stale-hint safety net)', async () => {
    const podA = mockPod('https://pod-a.example/', [
      { descriptorUrl: 'https://pod-a.example/cg/n.ttl', subject: ALICE_DID, name: 'alice' },
    ]);
    const podB = mockPod('https://pod-b.example/', []);
    const fetch = mergeMocks(podA, podB);

    // Directory advertises neither pod for "alice" — hints are stale.
    // The resolver MUST fall through to the unfiltered pod list.
    const dir: PodDirectoryData = {
      id: 'urn:directory:stale' as IRI,
      entries: [
        { podUrl: 'https://pod-a.example/' as IRI, owner: ALICE_DID, ownerNicks: ['oldname'] },
      ],
    };

    const hits = await resolveName('alice', CONFIG, {
      pods: ['https://pod-a.example/', 'https://pod-b.example/'],
      directories: [dir],
      fetch,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.subject).toBe(ALICE_DID);
  });

  it('keeps config.podUrl in the walk even when the directory does not list it', async () => {
    const localPod = mockPod(CONFIG.podUrl, [
      { descriptorUrl: 'https://pod.example/cg/local.ttl', subject: ALICE_DID, name: 'alice' },
    ]);
    const podA = mockPod('https://pod-a.example/', [
      { descriptorUrl: 'https://pod-a.example/cg/n.ttl', subject: BOB_DID, name: 'alice' },
    ]);
    const fetch = mergeMocks(localPod, podA);

    const dir: PodDirectoryData = {
      id: 'urn:directory:t' as IRI,
      entries: [{
        podUrl: 'https://pod-a.example/' as IRI,
        owner: BOB_DID,
        ownerNicks: ['alice'],
      }],
    };

    const hits = await resolveName('alice', CONFIG, {
      pods: [CONFIG.podUrl, 'https://pod-a.example/'],
      directories: [dir],
      fetch,
    });

    // Both bindings surface — the local pod is kept as a safety net even
    // though the directory only hints pod-a.
    const subjects = hits.map(h => h.subject).sort();
    expect(subjects).toEqual([ALICE_DID, BOB_DID].sort());
  });
});

describe('namesFor — narrows the pod walk via directory hints (reverse lookup)', () => {
  it('only visits pods whose directory entry has this subject as owner', async () => {
    let podAManifestFetches = 0;
    let podBManifestFetches = 0;
    const podAMock = mockPod('https://pod-a.example/', [
      { descriptorUrl: 'https://pod-a.example/cg/n.ttl', subject: ALICE_DID, name: 'alice' },
    ]);
    const podBMock = mockPod('https://pod-b.example/', [
      { descriptorUrl: 'https://pod-b.example/cg/n.ttl', subject: BOB_DID, name: 'bob' },
    ]);
    const fetch: FetchFn = async (url, init) => {
      if (typeof url === 'string') {
        if (url.startsWith('https://pod-a.example/') && url.endsWith('.well-known/context-graphs')) podAManifestFetches++;
        if (url.startsWith('https://pod-b.example/') && url.endsWith('.well-known/context-graphs')) podBManifestFetches++;
      }
      return mergeMocks(podAMock, podBMock)(url, init);
    };

    const dir: PodDirectoryData = {
      id: 'urn:directory:t' as IRI,
      entries: [
        { podUrl: 'https://pod-a.example/' as IRI, owner: ALICE_DID, ownerNicks: ['alice'] },
        { podUrl: 'https://pod-b.example/' as IRI, owner: BOB_DID, ownerNicks: ['bob'] },
      ],
    };

    const names = await namesFor(ALICE_DID, CONFIG, {
      pods: ['https://pod-a.example/', 'https://pod-b.example/'],
      directories: [dir],
      fetch,
    });
    expect(names).toHaveLength(1);
    expect(names[0]?.name).toBe('alice');
    expect(podAManifestFetches).toBeGreaterThan(0);
    expect(podBManifestFetches).toBe(0);
  });
});
