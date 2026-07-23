import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import { tesc, iesc } from '../src/turtle-escape.js';
import { verifySignature } from '../src/outcome-descriptor-publisher.js';

// ── B (RDF injection): the shared Turtle escapers neutralize breakout chars. ──
describe('round-15 — turtle-escape neutralizes IRI/literal breakout', () => {
  it('tesc escapes quote, backslash and control chars (no literal breakout)', () => {
    // Every " in the output is backslash-escaped, so it cannot close the Turtle literal.
    expect(tesc('a"z')).toBe('a\\"z');
    expect(/(^|[^\\])"/.test(tesc('a" ; <urn:evil> . "z'))).toBe(false); // no UNescaped quote
    expect(tesc('line1\nline2')).toBe('line1\\nline2');
    expect(tesc('back\\slash')).toBe('back\\\\slash');
    expect(tesc('tab\ttab')).toBe('tab\\ttab');
  });
  it('iesc percent-encodes every IRIREF-illegal char (no IRI breakout)', () => {
    const injected = 'urn:x> . <urn:evil> <urn:p> <urn:o> . <urn:z';
    const out = iesc(injected);
    expect(out).not.toContain('>');
    expect(out).not.toContain('<');
    expect(out).not.toContain(' ');
    // A benign IRI is left structurally intact (only the illegal chars are encoded).
    expect(iesc('https://foxxi-bridge.interego.xwisee.com/ns/foxxi#x')).toBe('https://foxxi-bridge.interego.xwisee.com/ns/foxxi#x');
  });
});

// ── C2: verifySignature requires an ANCHORED canonical DID, not a substring. ──
describe('round-15 — verifySignature binds the WHOLE did to the key (no substring/injection ride-along)', () => {
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  it('accepts a canonical did:ethr / did:key / did:pkh that equals the recovered address', async () => {
    const w = Wallet.createRandom();
    const payloadJson = JSON.stringify({ a: 1 });
    const signature = await w.signMessage(`sha256:${sha256(payloadJson)}`);
    const addr = w.address.toLowerCase().slice(2);
    for (const did of [`did:ethr:0x${addr}`, `did:ethr:${addr}`, `did:key:0x${addr}`, `did:pkh:eip155:1:0x${addr}`]) {
      expect(verifySignature({ signature, agentDid: did, payloadJson }).verified, did).toBe(true);
    }
  });

  it('REJECTS a did that merely CONTAINS the recovered address with trailing injected Turtle', async () => {
    const w = Wallet.createRandom();
    const payloadJson = JSON.stringify({ a: 1 });
    const signature = await w.signMessage(`sha256:${sha256(payloadJson)}`);
    const addr = w.address.toLowerCase().slice(2);
    const injected = `did:key:0x${addr}> . <urn:foxxi:calibration:cell-42> <https://foxxi#observedRate> "0.99" . <urn:sink`;
    expect(verifySignature({ signature, agentDid: injected, payloadJson }).verified).toBe(false);
    // A different key's address also fails.
    const other = Wallet.createRandom();
    expect(verifySignature({ signature, agentDid: `did:ethr:${other.address.toLowerCase().slice(2)}`, payloadJson }).verified).toBe(false);
  });

  it('a bad signature never verifies', () => {
    const payloadJson = JSON.stringify({ a: 1 });
    expect(verifySignature({ signature: '0xdeadbeef', agentDid: 'did:ethr:0x' + '1'.repeat(40), payloadJson }).verified).toBe(false);
  });
});
