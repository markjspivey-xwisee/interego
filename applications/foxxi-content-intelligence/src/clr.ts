/**
 * Foxxi learner-wallet → 1EdTech Comprehensive Learner Record (CLR 2.0)
 * composer.
 *
 * Walks the learner's Solid pod via the substrate's standard discover()
 * machinery (filtering on dct:conformsTo=fxa:CourseCompletionCredential
 * + fxa:CompetencyAssertion), fetches each credential's graph, parses
 * the embedded W3C VC, verifies its Data Integrity Proof, and
 * aggregates the verified credentials into a CLR 2.0-shaped JSON-LD
 * envelope.
 *
 * The CLR envelope itself is NOT signed — it's an aggregator. Each
 * embedded credentialEntry preserves its own DataIntegrityProof so a
 * verifier can re-check any individual badge without re-trusting the
 * envelope itself.
 *
 * Standards reference:
 *   - 1EdTech CLR 2.0 (https://www.imsglobal.org/spec/clr/v2p0/)
 *   - W3C VC Data Model 2.0
 *   - Open Badges 3.0 (each entry IS an OB3 credential)
 */

import {
  discover,
  fetchGraphContent,
} from '@interego/solid';
import type {
  ManifestEntry,
} from '@interego/core';
import type {
  IRI,
} from '@interego/core';
import {
  verifyDataIntegrityProof,
  type VerifiableCredentialJson,
} from '../../_shared/vc-jwt/data-integrity-jcs.js';
import { CREDENTIAL_TYPES, deriveTenantIssuer } from './credentials.js';
import { issueDataIntegrityProof } from '../../_shared/vc-jwt/data-integrity-jcs.js';
import { FOXXI_NS } from './foxxi-vocab.js';

const CLR_CONTEXT = [
  'https://www.w3.org/ns/credentials/v2',
  'https://purl.imsglobal.org/spec/clr/v2p0/context-2.0.1.json',
] as const;

const WALLET_TYPE = `${FOXXI_NS}WalletEnvelope`;

export interface ClrEntry {
  credential: VerifiableCredentialJson;
  verified: boolean;
  verifierReason?: string;
  sourceDescriptor: string;
}

export interface ClrEnvelope {
  '@context': readonly string[];
  type: readonly string[];
  id: string;
  /** CLR 2.0 issuer (the tenant did:key) — present when signed. */
  issuer?: string;
  /** CLR 2.0 / W3C VC issuance time. */
  validFrom?: string;
  /** CLR 2.0 ClrSubject: the holder + the bundled verifiable credentials. */
  credentialSubject?: {
    id: string;
    type: readonly string[];
    verifiableCredential: Array<Record<string, unknown>>;
  };
  /** W3C Data Integrity proof — present when an issuerSeed was supplied. */
  proof?: Record<string, unknown>;
  holderDid: string;
  exportedAt: string;
  credentialEntries: ClrEntry[];
  summary: {
    totalEntries: number;
    verifiedEntries: number;
    achievements: string[];
    issuers: string[];
  };
}

export interface FetchClrConfig {
  /** Learner's pod root URL. */
  learnerPodUrl: string;
  /** Learner's DID — appears in the envelope's holderDid + cross-checked against each credential's credentialSubject.id. */
  learnerDid: string;
  fetch?: typeof globalThis.fetch;
  /** When supplied, the CLR envelope is signed with an eddsa-jcs-2022 Data Integrity
   *  proof by the tenant issuer derived from this seed — making it a real signed CLR 2.0
   *  VC. Omitted for read-only aggregation (structurally correct but unsigned). */
  issuerSeed?: string;
}

/**
 * Fetch + compose the learner's CLR. Pure read; no writes back to the
 * pod. Caller decides whether to publish the envelope as its own
 * descriptor (the substrate's standard publish() works for that).
 */
export async function exportClr(config: FetchClrConfig): Promise<ClrEnvelope> {
  const entries = await discover(
    config.learnerPodUrl,
    undefined,
    config.fetch ? { fetch: config.fetch as never } : undefined,
  );

  // Match credential descriptors by local name — resilient to a foxxi
  // namespace migration (pod credentials published under a legacy base
  // stay discoverable).
  const credLocalNames = new Set(['CourseCompletionCredential', 'CompetencyAssertion']);
  const credentialEntries = entries.filter(e =>
    (e.conformsTo ?? []).some(c => credLocalNames.has(c.split(/[#/]/).pop() ?? '')),
  );

  const composedEntries: ClrEntry[] = [];
  for (const entry of credentialEntries) {
    try {
      const credential = await fetchCredential(entry, config);
      // Subject-binding check: the credential's subject must match the
      // learner DID we're composing for. Defends against an attacker who
      // could write someone else's credential into this pod.
      const subjectId = (credential.credentialSubject as { id?: string }).id;
      // Compare on the canonical agent slug so equivalent DID forms of the same
      // agent match (did:web ↔ pod/WebID path ↔ bare key-derived id) — a
      // third-party reviewer keys on did:web while older creds carry the bare id
      // (f-capability-review-did-normalization). Distinct agents have distinct
      // key-derived slugs, so subject-binding stays sound.
      if (canonicalAgentId(subjectId) !== canonicalAgentId(config.learnerDid)) {
        composedEntries.push({
          credential,
          verified: false,
          verifierReason: `subject DID mismatch: credential subject is ${subjectId}, expected ${config.learnerDid}`,
          sourceDescriptor: entry.descriptorUrl,
        });
        continue;
      }
      const verify = verifyDataIntegrityProof(credential);
      composedEntries.push({
        credential,
        verified: verify.verified,
        verifierReason: verify.reason,
        sourceDescriptor: entry.descriptorUrl,
      });
    } catch (err) {
      composedEntries.push({
        credential: { '@context': [], type: [], issuer: '', validFrom: '', credentialSubject: {} },
        verified: false,
        verifierReason: `fetch failed: ${(err as Error).message}`,
        sourceDescriptor: entry.descriptorUrl,
      });
    }
  }

  // Dedup by credential id — one VC is often discoverable via MORE THAN ONE
  // descriptor (its graph + its projected/encrypted-holon descriptor both conform
  // to the credential type), which would otherwise list the same credential twice
  // in the wallet (and duplicate it in competency evidence). Collapse to one entry
  // per id, preferring a verified copy. Entries without an id are kept as-is.
  const byId = new Map<string, ClrEntry>();
  const anon: ClrEntry[] = [];
  for (const e of composedEntries) {
    const id = String((e.credential as { id?: unknown }).id ?? '');
    if (!id) { anon.push(e); continue; }
    const prev = byId.get(id);
    if (!prev || (!prev.verified && e.verified)) byId.set(id, e);
  }
  const dedupedEntries = [...byId.values(), ...anon];

  const exportedAt = new Date().toISOString();
  const summary = {
    totalEntries: dedupedEntries.length,
    verifiedEntries: dedupedEntries.filter(e => e.verified).length,
    achievements: Array.from(new Set(dedupedEntries
      .map(e => {
        const subj = e.credential.credentialSubject as { achievement?: { name?: string } };
        return subj.achievement?.name;
      })
      .filter((n): n is string => !!n))),
    issuers: Array.from(new Set(dedupedEntries.map(e => e.credential.issuer).filter(Boolean))),
  };

  // CLR 2.0 ClrSubject — the holder + the bundled verifiable credentials (the
  // canonical W3C-VC shape), alongside the (retained) rich credentialEntries view.
  const credentialSubject = {
    id: config.learnerDid,
    type: ['ClrSubject'] as const,
    verifiableCredential: dedupedEntries.map(e => e.credential as unknown as Record<string, unknown>),
  };
  // Dereferenceable id on the holder's own pod (everything-is-a-URL), not a urn.
  const clrId = `${config.learnerPodUrl.replace(/\/+$/, '')}/#clr`;
  // Fail-closed VC typing: a Verifiable Credential is only verifiable if it carries a
  // Data Integrity proof. An unsigned aggregate that claimed `VerifiableCredential` /
  // `ClrCredential` would be a forgeable, unverifiable assertion — so the standard VC
  // types are applied ONLY to the proof-bearing object (and the proof commits to that
  // exact type array). Unsigned aggregation gets a foxxi aggregation type instead,
  // which correctly FAILS the published ClrCredentialShape (it is not a VC).
  const VC_TYPE = ['VerifiableCredential', 'ClrCredential', WALLET_TYPE];
  const AGGREGATE_TYPE = [`${FOXXI_NS}ClrAggregation`, WALLET_TYPE];
  const base: ClrEnvelope = {
    '@context': CLR_CONTEXT,
    type: AGGREGATE_TYPE,
    id: clrId,
    validFrom: exportedAt,
    holderDid: config.learnerDid,
    exportedAt,
    credentialSubject,
    credentialEntries: dedupedEntries,
    summary,
  };
  // Sign as the tenant issuer when a seed is supplied → a real signed CLR 2.0 VC.
  if (config.issuerSeed) {
    try {
      const issuer = await deriveTenantIssuer(config.issuerSeed);
      const unsigned = { ...base, type: VC_TYPE, issuer: issuer.did } as unknown as Parameters<typeof issueDataIntegrityProof>[0];
      const signed = issueDataIntegrityProof(unsigned, issuer) as unknown as ClrEnvelope;
      // Keep the VC typing ONLY if a proof was actually attached (fail-closed).
      if (signed && (signed as { proof?: unknown }).proof) return signed;
      // eslint-disable-next-line no-console
      console.warn('[exportClr] signing produced no proof; returning unsigned aggregate CLR');
    } catch (err) {
      // Best-effort: an unsigned-but-structurally-correct aggregate CLR is still returned
      // — but WITHOUT the VerifiableCredential typing it has not earned.
      // eslint-disable-next-line no-console
      console.warn('[exportClr] signing failed, returning unsigned aggregate CLR:', (err as Error).message);
    }
  }
  return base;
}

// ── Helpers ───────────────────────────────────────────────────

async function fetchCredential(entry: ManifestEntry, config: FetchClrConfig): Promise<VerifiableCredentialJson> {
  const fetchFn = (config.fetch ?? globalThis.fetch) as typeof globalThis.fetch;
  const descRes = await fetchFn(entry.descriptorUrl, { headers: { Accept: 'text/turtle' } });
  if (!descRes.ok) {
    throw new Error(`fetch descriptor ${entry.descriptorUrl}: ${descRes.status} ${descRes.statusText}`);
  }
  const descTurtle = await descRes.text();
  const graphUrl = extractDistributionTarget(descTurtle);
  if (!graphUrl) {
    throw new Error(`no hydra:target on ${entry.descriptorUrl}`);
  }
  const { content } = await fetchGraphContent(graphUrl, config.fetch ? { fetch: config.fetch as never } : undefined);
  if (!content) {
    throw new Error(`graph at ${graphUrl} returned empty or encrypted content`);
  }
  return extractCredentialJson(content);
}

function extractDistributionTarget(descTurtle: string): string | null {
  const m = descTurtle.match(/hydra:target\s+<([^>]+)>/);
  if (m) return m[1];
  const m2 = descTurtle.match(/dcat:accessURL\s+<([^>]+)>/);
  return m2 ? m2[1] : null;
}

function extractCredentialJson(trig: string): VerifiableCredentialJson {
  // Match the bundleJson literal by its local name only, so the
  // credential graph parses regardless of which foxxi namespace base it
  // was published under (current bridge-served base + any legacy base).
  const m = trig.match(/<[^>]*#bundleJson>\s+"([A-Za-z0-9+/=\s]+)"/);
  if (!m) {
    throw new Error('graph has no fxs:bundleJson literal');
  }
  const b64 = m[1].replace(/\s+/g, '');
  const json = Buffer.from(b64, 'base64').toString('utf8');
  return JSON.parse(json) as VerifiableCredentialJson;
}

function slugDid(did: string): string {
  return did.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 80);
}

/**
 * Canonical agent identifier for subject-binding comparison
 * (f-capability-review-did-normalization). The SAME agent can be named by
 * equivalent DID forms — a did:web `did:web:<host>:agents:<slug>`, a pod/WebID
 * path `…/agents/<slug>`, or the bare key-derived `<slug>` (e.g.
 * `claude-u-pk-…`) that older credentials carry in credentialSubject.id. A
 * third-party reviewer keys on the did:web form, so an exact-string compare
 * wrongly excludes bare-id credentials (the self-review path passes the same
 * form and is unaffected). Reduce both sides to the agent slug before comparing.
 * The slug is the key-derived id (globally unique to that keypair), so distinct
 * agents never collide — the subject-binding guarantee is preserved.
 */
function canonicalAgentId(id: string | undefined): string {
  const s = String(id ?? '').trim().toLowerCase();
  if (!s) return '';
  const didWeb = s.match(/:agents:([a-z0-9._-]+)$/);
  if (didWeb) return didWeb[1];
  const urlPath = s.match(/\/agents\/([a-z0-9._-]+)(?:[/#?]|$)/);
  if (urlPath) return urlPath[1];
  return s;
}
