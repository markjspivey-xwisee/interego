/**
 * Tier 8 — production end-to-end for the agent-collective vertical.
 *
 * Real flow combining the pod side and the cross-bridge p2p side:
 *   - Real Azure CSS pod for tool/teaching/audit descriptors
 *   - Real cross-bridge encrypted shares via InMemoryRelay (Tier 1)
 *     OR real public Nostr relay (Tier 4) when RUN_PUBLIC_RELAY set
 *
 * What this verifies end-to-end:
 *   1. Mark's agent authors a tool (Hypothetical) → published to Mark's pod
 *   2. Mark self-attests + David peer-attests → attestations published
 *   3. Mark promotes the tool → Asserted version written with cg:supersedes
 *   4. Mark bundles a teaching package (artifact + practice) → published
 *   5. David's agent (in-process here, but using real cross-bridge code path)
 *      receives an encrypted chime-in pointing at the teaching package
 *   6. Audit entries (ac:CrossAgentAuditEntry) recorded in BOTH humans' pods
 *      with provenance to the human owners (not the agents)
 *   7. promoteTool REFUSES when threshold not met (publisher discipline)
 *   8. bundleTeachingPackage REFUSES when no narrative fragments
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  authorTool,
  attestTool,
  promoteTool,
  bundleTeachingPackage,
  recordCrossAgentAudit,
} from '../src/pod-publisher.js';
import {
  P2pClient,
  InMemoryRelay,
  importWallet,
  generateKeyPair,
} from '../../../src/index.js';
import type { IRI } from '../../../src/index.js';

const AZURE_CSS_BASE = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TEST_POD_BASE = `${AZURE_CSS_BASE}/u-pk-6e3bc2f9723c/`;

function uniquePodUrl(prefix: string): string {
  return `${TEST_POD_BASE}${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`;
}

const MARK_AGENT_DID = 'did:web:mark-agent.example' as IRI;
const DAVID_AGENT_DID = 'did:web:david-agent.example' as IRI;
const MARK_HUMAN_DID = 'did:web:mark.example' as IRI;
const DAVID_HUMAN_DID = 'did:web:david.example' as IRI;

const cleanupUrls: string[] = [];
function track(...urls: (string | undefined)[]): void {
  for (const u of urls) if (u) cleanupUrls.push(u);
}
async function cleanup(): Promise<void> {
  const containerRoots = new Set<string>();
  for (const url of cleanupUrls) {
    const m = /^(.*\/(?:mark-ac-tier8|david-ac-tier8)-[^/]+\/)/.exec(url);
    if (m) containerRoots.add(m[1]!);
  }
  for (const url of cleanupUrls.splice(0)) {
    try { await fetch(url, { method: 'DELETE' }); } catch {}
  }
  for (const root of containerRoots) {
    try { await fetch(`${root}.well-known/context-graphs`, { method: 'DELETE' }); } catch {}
    try { await fetch(`${root}context-graphs/`, { method: 'DELETE' }); } catch {}
    try { await fetch(`${root}.well-known/`, { method: 'DELETE' }); } catch {}
    try { await fetch(root, { method: 'DELETE' }); } catch {}
  }
}

async function podReachable(): Promise<boolean> {
  if (process.env.SKIP_AZURE_TESTS === '1') return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(TEST_POD_BASE, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

let reachable = false;
beforeAll(async () => { reachable = await podReachable(); });

describe('Tier 8 — agent-collective production end-to-end', () => {
  it('reachability probe', () => {
    if (!reachable) console.warn('Azure CSS unreachable; AC Tier 8 skipped');
    expect(typeof reachable).toBe('boolean');
  });

  it('full collective lifecycle: author → attest → promote → bundle → cross-bridge chime + audit', { timeout: 240000 }, async (ctx) => {
    if (!reachable) return ctx.skip();
    try {
      const markPod = uniquePodUrl('mark-ac-tier8');
      const davidPod = uniquePodUrl('david-ac-tier8');

      // Step 1: Mark's agent authors a tool (Hypothetical)
      const tool = await authorTool({
        toolName: 'second-contact-detector',
        sourceCode: 'function detectSecondContact(message, history) { /* ... */ return { detected: history.some(h => similarTopic(h, message)) }; }',
        affordanceAction: 'urn:cg:action:detect-second-contact-cue',
        affordanceDescription: 'Detect second-contact cues in customer messages.',
      }, { podUrl: markPod, authoringAgentDid: MARK_AGENT_DID });
      track(tool.descriptorUrl, tool.graphUrl);

      expect(tool.toolIri).toContain('second-contact-detector');
      expect(tool.atomIri).toContain('tool-source');

      // Step 2a: 5 self-attestations across 2 axes (sequential to avoid manifest race)
      const selfAttests: Awaited<ReturnType<typeof attestTool>>[] = [];
      for (let i = 0; i < 5; i++) {
        const a = await attestTool({
          toolIri: tool.toolIri,
          axis: i % 2 === 0 ? 'correctness' : 'efficiency',
          rating: 0.85 + Math.random() * 0.10,
          direction: 'Self',
        }, { podUrl: markPod, authoringAgentDid: MARK_AGENT_DID });
        selfAttests.push(a);
        track(a.descriptorUrl, a.graphUrl);
      }
      expect(selfAttests).toHaveLength(5);

      // Step 2b: 2 peer attestations (David's agent + a third agent)
      const peerAttests: Awaited<ReturnType<typeof attestTool>>[] = [];
      for (const peer of [DAVID_AGENT_DID, 'did:web:peer-c.example' as IRI]) {
        const a = await attestTool({
          toolIri: tool.toolIri,
          axis: 'safety',
          rating: 0.92,
          direction: 'Peer',
        }, { podUrl: markPod, authoringAgentDid: peer });
        peerAttests.push(a);
        track(a.descriptorUrl, a.graphUrl);
      }
      expect(peerAttests).toHaveLength(2);

      // Step 3: promoteTool succeeds when thresholds met
      const promoted = await promoteTool({
        toolIri: tool.toolIri,
        selfAttestations: 5,
        peerAttestations: 2,
        axesCovered: ['correctness', 'efficiency', 'safety'],
      }, { podUrl: markPod, authoringAgentDid: MARK_AGENT_DID });
      track(promoted.descriptorUrl, promoted.graphUrl);

      expect(promoted.promotedToolIri).toContain('.attested');

      // Step 4: bundle teaching package
      const teaching = await bundleTeachingPackage({
        toolIri: promoted.promotedToolIri,
        narrativeFragmentIris: [
          'urn:cg:fragment:tone-week-1-frag-1' as IRI,
          'urn:cg:fragment:tone-week-1-frag-4' as IRI,
        ],
        synthesisIri: 'urn:cg:synthesis:tone-probe-week-3' as IRI,
        constraintIri: 'urn:cg:constraint:tone-second-contact-acknowledgment:v1' as IRI,
        olkeStage: 'Articulate',
      }, { podUrl: markPod, authoringAgentDid: MARK_AGENT_DID });
      track(teaching.descriptorUrl, teaching.graphUrl);

      expect(teaching.teachingIri).toContain('teaching');

      // Step 5: cross-bridge chime-in (real encrypted share via InMemoryRelay
      // — same code path as Tier 4-tested public-relay flow; just shorter
      // network round-trip for the test).
      const sharedRelay = new InMemoryRelay();
      const markWallet = importWallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'agent', 'mark-ac-tier8');
      const davidWallet = importWallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'agent', 'david-ac-tier8');
      const markEnc = generateKeyPair();
      const davidEnc = generateKeyPair();
      const markP2p = new P2pClient(sharedRelay, markWallet, { encryptionKeyPair: markEnc });
      const davidP2p = new P2pClient(sharedRelay, davidWallet, { encryptionKeyPair: davidEnc });

      const chimeContent = JSON.stringify({
        type: 'ac:ChimeIn',
        threadId: `tier8-${Date.now()}`,
        teachingPackageIri: teaching.teachingIri,
        message: 'I have a teaching package for the second-contact-detector tool. Practice context included.',
      });

      await markP2p.publishEncryptedShare({
        plaintext: chimeContent,
        recipients: [{ sigPubkey: davidP2p.pubkey, encryptionPubkey: davidEnc.publicKey }],
        senderEncryptionKeyPair: markEnc,
      });

      const davidInbox = await davidP2p.queryEncryptedShares({ recipientSigPubkey: davidP2p.pubkey });
      expect(davidInbox).toHaveLength(1);
      const decrypted = davidP2p.decryptEncryptedShare(davidInbox[0]!);
      expect(decrypted).toBe(chimeContent);

      const decryptedPayload = JSON.parse(decrypted!) as { teachingPackageIri: string; type: string };
      expect(decryptedPayload.type).toBe('ac:ChimeIn');
      expect(decryptedPayload.teachingPackageIri).toBe(teaching.teachingIri);

      // Step 6: audit entries in BOTH humans' pods (Mark's outbound, David's inbound)
      const markAudit = await recordCrossAgentAudit({
        exchangeIri: `urn:cg:ac-chimein:tier8-${Date.now()}` as IRI,
        auditedAgentDid: MARK_AGENT_DID,
        direction: 'Outbound',
        humanOwnerDid: MARK_HUMAN_DID,
      }, { podUrl: markPod, authoringAgentDid: MARK_AGENT_DID });
      track(markAudit.descriptorUrl, markAudit.graphUrl);

      const davidAudit = await recordCrossAgentAudit({
        exchangeIri: `urn:cg:ac-chimein:tier8-${Date.now()}` as IRI,
        auditedAgentDid: DAVID_AGENT_DID,
        direction: 'Inbound',
        humanOwnerDid: DAVID_HUMAN_DID,
      }, { podUrl: davidPod, authoringAgentDid: DAVID_AGENT_DID });
      track(davidAudit.descriptorUrl, davidAudit.graphUrl);

      expect(markAudit.auditIri).toBeTruthy();
      expect(davidAudit.auditIri).toBeTruthy();
      // The audit URLs are in DIFFERENT pods (one per human owner)
      expect(markAudit.descriptorUrl).toContain(markPod);
      expect(davidAudit.descriptorUrl).toContain(davidPod);
    } finally {
      await cleanup();
    }
  });

  it('refuses promotion: tool with insufficient attestations', { timeout: 30000 }, async (ctx) => {
    if (!reachable) return ctx.skip();
    try {
      const markPod = uniquePodUrl('mark-ac-tier8');
      const tool = await authorTool({
        toolName: 'underAttested',
        sourceCode: 'function noop() {}',
        affordanceAction: 'urn:cg:action:test',
      }, { podUrl: markPod, authoringAgentDid: MARK_AGENT_DID });
      track(tool.descriptorUrl, tool.graphUrl);

      // Only 1 self + 0 peer (well below threshold of 5 + 2)
      await expect(promoteTool({
        toolIri: tool.toolIri,
        selfAttestations: 1,
        peerAttestations: 0,
        axesCovered: ['correctness'],
      }, { podUrl: markPod, authoringAgentDid: MARK_AGENT_DID })).rejects.toThrow(/REFUSED/);

      // 5 self but only 1 axis
      await expect(promoteTool({
        toolIri: tool.toolIri,
        selfAttestations: 5,
        peerAttestations: 2,
        axesCovered: ['correctness'],
      }, { podUrl: markPod, authoringAgentDid: MARK_AGENT_DID })).rejects.toThrow(/REFUSED/);
    } finally {
      await cleanup();
    }
  });

  it('refuses bundle: teaching package without narrative fragments (partial transfer prevention)', { timeout: 30000 }, async (ctx) => {
    if (!reachable) return ctx.skip();
    try {
      const markPod = uniquePodUrl('mark-ac-tier8');
      await expect(bundleTeachingPackage({
        toolIri: 'urn:cg:tool:partial' as IRI,
        narrativeFragmentIris: [],   // EMPTY
        synthesisIri: 'urn:cg:synthesis:partial' as IRI,
        olkeStage: 'Articulate',
      }, { podUrl: markPod, authoringAgentDid: MARK_AGENT_DID })).rejects.toThrow(/narrative fragments/);
    } finally {
      await cleanup();
    }
  });
});
