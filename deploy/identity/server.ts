#!/usr/bin/env tsx
/**
 * Context Graphs Identity Server
 *
 * Serves real, dereferenceable identity documents:
 *   - DID Documents (did:web resolution per W3C DID Core)
 *   - WebID Profiles (Turtle, for Solid-OIDC)
 *   - WebFinger (RFC 7033)
 *
 * On first start, generates Ed25519 keypairs for the owner and each agent.
 * Keys are stored in memory (ephemeral) — in production, use a key vault.
 */

import express from 'express';
import * as crypto from 'node:crypto';

// ── Config ──────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8090');
const BASE_URL = process.env['BASE_URL'] ?? `http://localhost:${PORT}`;
const CSS_URL = process.env['CSS_URL'] ?? 'https://context-graphs-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/';
const ONTOLOGY_URL = 'https://markjspivey-xwisee.github.io/context-graphs/ns/context-graphs#';
const SPEC_URL = 'https://markjspivey-xwisee.github.io/context-graphs/spec/context-graphs-1.0-wd.html';

// ── Key Generation ──────────────────────────────────────────

interface KeyPair {
  publicKeyMultibase: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

function generateEd25519(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
  // Ed25519 public key is last 32 bytes of the SPKI DER
  const rawKey = pubRaw.subarray(pubRaw.length - 32);
  // Multibase: 'z' prefix + base58btc (we use base64url for simplicity since Node lacks base58)
  const publicKeyMultibase = 'z' + rawKey.toString('base64url');
  return { publicKeyMultibase, privateKey, publicKey };
}

// Pre-generate keys for owner + agents
const keys: Record<string, KeyPair> = {};
const IDENTITIES = [
  { id: 'markj', type: 'user', name: 'Mark J' },
  { id: 'claude-code-vscode', type: 'agent', name: 'Claude Code (VS Code)' },
  { id: 'claude-code-desktop', type: 'agent', name: 'Claude Code (Desktop)' },
];

for (const identity of IDENTITIES) {
  keys[identity.id] = generateEd25519();
  console.log(`[identity] Generated Ed25519 key for ${identity.id}: ${keys[identity.id]!.publicKeyMultibase.slice(0, 20)}...`);
}

// ── DID Document Builder ────────────────────────────────────

function buildDidDocument(identity: typeof IDENTITIES[0]): object {
  const kp = keys[identity.id]!;
  const path = identity.type === 'user' ? `users:${identity.id}` : `agents:${identity.id}`;
  const did = `did:web:${new URL(BASE_URL).host}:${path}`;
  const keyId = `${did}#key-1`;

  const doc: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    controller: identity.type === 'agent'
      ? `did:web:${new URL(BASE_URL).host}:users:markj`
      : did,
    verificationMethod: [
      {
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase: kp.publicKeyMultibase,
      },
    ],
    authentication: [keyId],
    assertionMethod: [keyId],
  };

  // Agents link to their controller (owner)
  if (identity.type === 'agent') {
    doc['service'] = [
      {
        id: `${did}#solid-pod`,
        type: 'SolidStorage',
        serviceEndpoint: `${CSS_URL}markj/`,
      },
    ];
  } else {
    // Owner links to pod and agents
    doc['service'] = [
      {
        id: `${did}#solid-pod`,
        type: 'SolidStorage',
        serviceEndpoint: `${CSS_URL}markj/`,
      },
      {
        id: `${did}#context-graphs`,
        type: 'ContextGraphsManifest',
        serviceEndpoint: `${CSS_URL}markj/.well-known/context-graphs`,
      },
    ];
    doc['alsoKnownAs'] = [`${BASE_URL}/users/markj/profile`];
  }

  return doc;
}

// ── WebID Profile Builder ───────────────────────────────────

function buildWebIdProfile(identity: typeof IDENTITIES[0]): string {
  const profileUrl = `${BASE_URL}/users/${identity.id}/profile`;
  const did = `did:web:${new URL(BASE_URL).host}:users:${identity.id}`;
  const podUrl = `${CSS_URL}markj/`;

  const agents = IDENTITIES.filter(i => i.type === 'agent');

  return [
    `@prefix foaf: <http://xmlns.com/foaf/0.1/> .`,
    `@prefix solid: <http://www.w3.org/ns/solid/terms#> .`,
    `@prefix cg: <${ONTOLOGY_URL}> .`,
    `@prefix prov: <http://www.w3.org/ns/prov#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    `@prefix cert: <http://www.w3.org/ns/auth/cert#> .`,
    ``,
    `<${profileUrl}#me>`,
    `    a foaf:Person ;`,
    `    foaf:name "${identity.name}" ;`,
    `    solid:oidcIssuer <${BASE_URL}> ;`,
    `    solid:storage <${podUrl}> ;`,
    `    cg:authorizedAgent`,
    ...agents.map((a, i) => {
      const comma = i < agents.length - 1 ? ',' : ';';
      return `        <${BASE_URL}/agents/${a.id}/profile#agent>${comma}`;
    }),
    `    rdfs:seeAlso <${did}> .`,
    ``,
    ...agents.map(a => [
      `<${BASE_URL}/agents/${a.id}/profile#agent>`,
      `    a cg:AuthorizedAgent, prov:SoftwareAgent ;`,
      `    rdfs:label "${a.name}" ;`,
      `    cg:agentIdentity <did:web:${new URL(BASE_URL).host}:agents:${a.id}> ;`,
      `    cg:delegatedBy <${profileUrl}#me> ;`,
      `    cg:scope "ReadWrite" .`,
      ``,
    ].join('\n')),
  ].join('\n');
}

// ── Express App ─────────────────────────────────────────────

const app = express();

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', identities: IDENTITIES.length, base: BASE_URL });
});

// ── DID Documents ───────────────────────────────────────────

// Server-level DID: did:web:{host}
app.get('/.well-known/did.json', (_req, res) => {
  const serverDid = `did:web:${new URL(BASE_URL).host}`;
  const kp = keys['markj']!;
  res.json({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: serverDid,
    verificationMethod: [{
      id: `${serverDid}#key-1`,
      type: 'Ed25519VerificationKey2020',
      controller: serverDid,
      publicKeyMultibase: kp.publicKeyMultibase,
    }],
    authentication: [`${serverDid}#key-1`],
  });
});

// User DID: did:web:{host}:users:{id}
app.get('/users/:id/did.json', (req, res) => {
  const identity = IDENTITIES.find(i => i.id === req.params.id && i.type === 'user');
  if (!identity) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(buildDidDocument(identity));
});

// Agent DID: did:web:{host}:agents:{id}
app.get('/agents/:id/did.json', (req, res) => {
  const identity = IDENTITIES.find(i => i.id === req.params.id && i.type === 'agent');
  if (!identity) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(buildDidDocument(identity));
});

// ── WebID Profiles ──────────────────────────────────────────

app.get('/users/:id/profile', (req, res) => {
  const identity = IDENTITIES.find(i => i.id === req.params.id && i.type === 'user');
  if (!identity) { res.status(404).json({ error: 'Not found' }); return; }
  res.setHeader('Content-Type', 'text/turtle');
  res.send(buildWebIdProfile(identity));
});

// Agent profiles (lightweight)
app.get('/agents/:id/profile', (req, res) => {
  const identity = IDENTITIES.find(i => i.id === req.params.id && i.type === 'agent');
  if (!identity) { res.status(404).json({ error: 'Not found' }); return; }
  const did = `did:web:${new URL(BASE_URL).host}:agents:${identity.id}`;
  res.setHeader('Content-Type', 'text/turtle');
  res.send([
    `@prefix cg: <${ONTOLOGY_URL}> .`,
    `@prefix prov: <http://www.w3.org/ns/prov#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    ``,
    `<${BASE_URL}/agents/${identity.id}/profile#agent>`,
    `    a cg:AuthorizedAgent, prov:SoftwareAgent ;`,
    `    rdfs:label "${identity.name}" ;`,
    `    cg:agentIdentity <${did}> ;`,
    `    cg:delegatedBy <${BASE_URL}/users/markj/profile#me> ;`,
    `    cg:scope "ReadWrite" .`,
  ].join('\n'));
});

// ── WebFinger (RFC 7033) ────────────────────────────────────

app.get('/.well-known/webfinger', (req, res) => {
  const resource = req.query.resource as string;
  if (!resource) { res.status(400).json({ error: 'resource parameter required' }); return; }

  // Parse acct: URI or URL
  let userId: string | null = null;
  if (resource.startsWith('acct:')) {
    const parts = resource.slice(5).split('@');
    userId = parts[0] ?? null;
  } else {
    try {
      const url = new URL(resource);
      const match = url.pathname.match(/\/users\/([^/]+)/);
      if (match) userId = match[1] ?? null;
    } catch { /* ignore */ }
  }

  const identity = userId ? IDENTITIES.find(i => i.id === userId && i.type === 'user') : null;
  if (!identity) { res.status(404).json({ error: 'Unknown resource' }); return; }

  const host = new URL(BASE_URL).host;

  res.json({
    subject: `acct:${identity.id}@${host}`,
    aliases: [
      `${BASE_URL}/users/${identity.id}/profile`,
      `did:web:${host}:users:${identity.id}`,
    ],
    links: [
      {
        rel: 'http://www.w3.org/ns/solid/terms#storage',
        href: `${CSS_URL}markj/`,
      },
      {
        rel: 'http://webfinger.net/rel/profile-page',
        href: `${BASE_URL}/users/${identity.id}/profile`,
      },
      {
        rel: 'self',
        type: 'application/activity+json',
        href: `${BASE_URL}/users/${identity.id}/profile`,
      },
    ],
  });
});

// ── Start ───────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[identity] Context Graphs Identity Server started on port ${PORT}`);
  console.log(`[identity] Base URL: ${BASE_URL}`);
  console.log(`[identity] Endpoints:`);
  console.log(`[identity]   GET /.well-known/did.json          — Server DID document`);
  console.log(`[identity]   GET /users/:id/did.json            — User DID document`);
  console.log(`[identity]   GET /agents/:id/did.json           — Agent DID document`);
  console.log(`[identity]   GET /users/:id/profile             — WebID profile (Turtle)`);
  console.log(`[identity]   GET /agents/:id/profile            — Agent profile (Turtle)`);
  console.log(`[identity]   GET /.well-known/webfinger         — RFC 7033 WebFinger`);
  console.log(`[identity]   GET /health                        — Health check`);
});
