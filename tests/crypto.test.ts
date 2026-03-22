import { describe, it, expect } from 'vitest';
import {
  sha256,
  cryptoComputeCid,
  pinToIpfs,
  createIpfsAnchor,
  pinPgslFragment,
  pinDescriptor,
  createWallet,
  importWallet,
  exportPrivateKey,
  createDelegation,
  verifyDelegationSignature,
  signDescriptor,
  verifyDescriptorSignature,
  createAgentToken,
  createSiweMessage,
  formatSiweMessage,
  signSiweMessage,
  verifySiweSignature,
  ContextDescriptor,
  toTurtle,
} from '../src/index.js';
import type { IRI, IpfsConfig } from '../src/index.js';

const localIpfsConfig: IpfsConfig = { provider: 'local' };

// ═════════════════════════════════════════════════════════════
//  SHA-256 Hashing (real via ethers.js)
// ═════════════════════════════════════════════════════════════

describe('SHA-256 (real)', () => {
  it('produces deterministic hashes', () => {
    const a = sha256('hello');
    const b = sha256('hello');
    expect(a).toBe(b);
  });

  it('produces correct known hash', () => {
    // SHA-256 of "hello" is well-known
    const hash = sha256('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('different content produces different hashes', () => {
    const a = sha256('hello');
    const b = sha256('world');
    expect(a).not.toBe(b);
  });
});

// ═════════════════════════════════════════════════════════════
//  IPFS CID Computation (real content-addressing)
// ═════════════════════════════════════════════════════════════

describe('IPFS CID (real)', () => {
  it('computes deterministic CID', () => {
    const a = cryptoComputeCid('test content');
    const b = cryptoComputeCid('test content');
    expect(a).toBe(b);
  });

  it('different content produces different CID', () => {
    const a = cryptoComputeCid('content A');
    const b = cryptoComputeCid('content B');
    expect(a).not.toBe(b);
  });

  it('CID starts with bafkrei (CIDv1 raw + sha256)', () => {
    const cid = cryptoComputeCid('hello world');
    expect(cid.startsWith('bafkrei')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════
//  IPFS Pinning (local = real CID, no network)
// ═════════════════════════════════════════════════════════════

describe('IPFS Pinning (local)', () => {
  it('local pins content and returns real CID', async () => {
    const result = await pinToIpfs('test content', 'test.txt', localIpfsConfig);
    expect(result.cid).toBeTruthy();
    expect(result.cid.startsWith('bafkrei')).toBe(true);
    expect(result.provider).toBe('local');
    expect(result.url).toContain('ipfs://');
  });

  it('deterministic CID for same content', async () => {
    const a = await pinToIpfs('same content', 'a.txt', localIpfsConfig);
    const b = await pinToIpfs('same content', 'b.txt', localIpfsConfig);
    expect(a.cid).toBe(b.cid);
  });

  it('creates IPFS anchor', async () => {
    const pin = await pinToIpfs('anchor content', 'anchor.txt', localIpfsConfig);
    const anchor = createIpfsAnchor('anchor content', pin);
    expect(anchor.cid).toBe(pin.cid);
    expect(anchor.contentHash).toBeTruthy();
    expect(anchor.contentHash.length).toBe(64); // SHA-256 hex
  });

  it('pins PGSL fragment', async () => {
    const anchor = await pinPgslFragment(
      'urn:pgsl:fragment:L2:test' as IRI,
      'fragment content',
      localIpfsConfig,
    );
    expect(anchor.cid.startsWith('bafkrei')).toBe(true);
  });

  it('pins descriptor Turtle', async () => {
    const desc = ContextDescriptor.create('urn:cg:test:pin' as IRI)
      .describes('urn:graph:test' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .asserted(0.9)
      .selfAsserted('did:web:test' as IRI)
      .version(1)
      .build();

    const turtle = toTurtle(desc);
    const anchor = await pinDescriptor(desc.id, turtle, localIpfsConfig);
    expect(anchor.cid.startsWith('bafkrei')).toBe(true);
    expect(anchor.contentHash.length).toBe(64);
  });
});

// ═════════════════════════════════════════════════════════════
//  Real Wallets (ethers.js secp256k1)
// ═════════════════════════════════════════════════════════════

describe('Real Wallets', () => {
  it('creates real human wallet with valid Ethereum address', async () => {
    const wallet = await createWallet('human', 'Mark');
    expect(wallet.address.startsWith('0x')).toBe(true);
    expect(wallet.address.length).toBe(42);
    expect(wallet.type).toBe('human');
  });

  it('creates real agent wallet', async () => {
    const wallet = await createWallet('agent', 'Claude Code');
    expect(wallet.address.startsWith('0x')).toBe(true);
    expect(wallet.type).toBe('agent');
    expect(wallet.chainId).toBe(0); // local mode default
  });

  it('different wallets have different addresses (real randomness)', async () => {
    const a = await createWallet('agent', 'Alice');
    const b = await createWallet('agent', 'Bob');
    expect(a.address).not.toBe(b.address);
  });

  it('exports and imports private key', async () => {
    const original = await createWallet('agent', 'Exportable');
    const privateKey = exportPrivateKey(original.address);
    expect(privateKey.startsWith('0x')).toBe(true);
    expect(privateKey.length).toBe(66); // 0x + 64 hex chars

    const imported = importWallet(privateKey, 'agent', 'Imported');
    expect(imported.address).toBe(original.address);
  });
});

// ═════════════════════════════════════════════════════════════
//  Real Wallet Delegation (EIP-712)
// ═════════════════════════════════════════════════════════════

describe('Real Delegation (EIP-712)', () => {
  it('creates and verifies real delegation signature', async () => {
    const owner = await createWallet('human', 'Owner');
    const agent = await createWallet('agent', 'Agent');

    const delegation = await createDelegation(owner, agent, 'ReadWrite');
    expect(delegation.ownerAddress).toBe(owner.address);
    expect(delegation.agentAddress).toBe(agent.address);
    expect(delegation.signature.startsWith('0x')).toBe(true);
    expect(delegation.signature.length).toBe(132); // 0x + 130 hex (65 bytes ECDSA)

    // Verify the delegation — recovers signer and checks it matches owner
    const valid = verifyDelegationSignature(delegation);
    expect(valid).toBe(true);
  });

  it('rejects tampered delegation', async () => {
    const owner = await createWallet('human', 'Owner2');
    const agent = await createWallet('agent', 'Agent2');

    const delegation = await createDelegation(owner, agent, 'ReadWrite');

    // Tamper with the scope
    const tampered = { ...delegation, scope: 'Admin' };
    const valid = verifyDelegationSignature(tampered);
    // The message field still has the original scope, so this should still verify
    // But if we tamper the message too:
    const deepTampered = {
      ...delegation,
      message: delegation.message.replace('ReadWrite', 'Admin'),
    };
    const deepValid = verifyDelegationSignature(deepTampered);
    expect(deepValid).toBe(false); // signature doesn't match tampered message
  });
});

// ═════════════════════════════════════════════════════════════
//  Real Descriptor Signing (ECDSA)
// ═════════════════════════════════════════════════════════════

describe('Real Descriptor Signing', () => {
  it('signs and verifies a descriptor', async () => {
    const agent = await createWallet('agent', 'Signer');
    const turtle = '@prefix cg: <urn:cg:> . cg:test cg:value "hello" .';

    const signed = await signDescriptor('urn:cg:test:signed' as IRI, turtle, agent);
    expect(signed.signature.startsWith('0x')).toBe(true);
    expect(signed.signature.length).toBe(132); // real ECDSA signature
    expect(signed.signerAddress).toBe(agent.address);

    const verification = await verifyDescriptorSignature(signed, turtle);
    expect(verification.valid).toBe(true);
    expect(verification.recoveredAddress?.toLowerCase()).toBe(agent.address.toLowerCase());
  });

  it('rejects tampered content', async () => {
    const agent = await createWallet('agent', 'Signer2');
    const turtle = '@prefix cg: <urn:cg:> . cg:test cg:value "original" .';

    const signed = await signDescriptor('urn:cg:test:tampered' as IRI, turtle, agent);

    const tampered = '@prefix cg: <urn:cg:> . cg:test cg:value "MODIFIED" .';
    const verification = await verifyDescriptorSignature(signed, tampered);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain('mismatch');
  });

  it('rejects signature from wrong wallet', async () => {
    const agent = await createWallet('agent', 'RealSigner');
    const turtle = '@prefix cg: <urn:cg:> . cg:test cg:value "test" .';

    const signed = await signDescriptor('urn:cg:test:wrong' as IRI, turtle, agent);

    // Claim it was signed by a different address
    const faked = { ...signed, signerAddress: '0x0000000000000000000000000000000000000000' };
    const verification = await verifyDescriptorSignature(faked, turtle);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain('mismatch');
  });
});

// ═════════════════════════════════════════════════════════════
//  ERC-8004 Agent Identity Token
// ═════════════════════════════════════════════════════════════

describe('ERC-8004 Agent Identity', () => {
  it('creates agent identity token', async () => {
    const owner = await createWallet('human', 'TokenOwner');
    const agent = await createWallet('agent', 'TokenAgent');

    const token = await createAgentToken(owner, agent, 'urn:agent:test:token' as IRI, {
      name: 'Test Agent',
      description: 'A test agent with real wallet',
      capabilities: ['discover', 'publish', 'compose'],
      delegationScope: 'ReadWrite',
    });

    expect(token.tokenId).toBeTruthy();
    expect(token.ownerAddress).toBe(owner.address);
    expect(token.agentAddress).toBe(agent.address);
    expect(token.agentUri).toBe('urn:agent:test:token');
    expect(token.metadata.capabilities).toContain('publish');
  });
});

// ═════════════════════════════════════════════════════════════
//  ERC-4361 SIWE (real signature verification)
// ═════════════════════════════════════════════════════════════

describe('SIWE (real crypto)', () => {
  it('creates and formats SIWE message', () => {
    const msg = createSiweMessage(
      'context-graphs.example.com',
      '0x1234567890abcdef1234567890abcdef12345678',
      'Sign in to Context Graphs',
      'https://context-graphs.example.com',
      1,
      ['https://pod.example.com/markj/'],
    );

    expect(msg.domain).toBe('context-graphs.example.com');
    expect(msg.version).toBe('1');
    expect(msg.nonce.length).toBeGreaterThan(0);

    const formatted = formatSiweMessage(msg);
    expect(formatted).toContain('wants you to sign in');
    expect(formatted).toContain('0x1234567890');
  });

  it('signs and verifies SIWE with real wallet', async () => {
    const wallet = await createWallet('human', 'SIWE-Human');

    const msg = createSiweMessage(
      'app.test.com',
      wallet.address,
      'Authenticate to publish context',
      'https://app.test.com',
      84532,
    );

    const signature = await signSiweMessage(msg, wallet);
    expect(signature.startsWith('0x')).toBe(true);
    expect(signature.length).toBe(132); // real ECDSA

    const result = await verifySiweSignature(msg, signature);
    expect(result.valid).toBe(true);
    expect(result.address?.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('rejects signature from wrong address', async () => {
    const wallet = await createWallet('human', 'SIWE-Wrong');
    const otherAddress = '0x0000000000000000000000000000000000000001';

    const msg = createSiweMessage(
      'app.test.com',
      otherAddress, // different from wallet
      'Should fail',
      'https://app.test.com',
    );

    const signature = await signSiweMessage(msg, wallet);
    const result = await verifySiweSignature(msg, signature);
    expect(result.valid).toBe(false); // recovered address won't match otherAddress
  });

  it('rejects expired SIWE message', async () => {
    const wallet = await createWallet('human', 'SIWE-Expired');

    const msg = createSiweMessage(
      'test.com',
      wallet.address,
      'Expired',
      'https://test.com',
    );

    const expired = { ...msg, expirationTime: '2020-01-01T00:00:00Z' };
    const signature = await signSiweMessage(expired, wallet);
    const result = await verifySiweSignature(expired, signature);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('expired');
  });
});
