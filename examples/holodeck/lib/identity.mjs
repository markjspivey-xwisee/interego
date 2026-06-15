// Identity manager — persistent agent identities for the holodeck.
//
// Each agent has:
//   label        — short human-readable name ('alice', 'critic', 'judge')
//   wallet       — ECDSA private key, persisted under .holodeck/identities/<label>/
//   did          — did:ethr:<address>
//   podUrl       — eth-<addr-slug> pod on the production CSS gate
//   createdAt    — minted timestamp
//   notes        — free-text description
//   mcpConfigPath — path to the per-agent MCP config JSON we hand to `claude --mcp-config`
//
// Wallets are never sent over the wire. The MCP proxy reads the key
// from disk + signs requests locally before they leave the box.

import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const HOLODECK_DIR = resolve(__dirname, '..', '.holodeck');
export const IDENTITIES_DIR = join(HOLODECK_DIR, 'identities');

function ensureIdentitiesDir() {
  if (!existsSync(HOLODECK_DIR)) mkdirSync(HOLODECK_DIR, { recursive: true });
  if (!existsSync(IDENTITIES_DIR)) mkdirSync(IDENTITIES_DIR, { recursive: true });
}

export function podUrlForDid(did) {
  const gate = (process.env.CG_GATE_URL ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io').replace(/\/$/, '');
  const m = did.match(/0x([0-9a-fA-F]+)/);
  const slug = m && m[1]
    ? m[1].slice(-12).toLowerCase()
    : createHash('sha256').update(did).digest('hex').slice(0, 12);
  return `${gate}/eth-${slug}/`;
}

/**
 * Mint a new identity. If `label` already exists, throws unless
 * `force` is true (in which case the prior identity is overwritten —
 * use carefully, it gives the agent a new DID + pod).
 */
export function mintIdentity({ label, notes, force = false }) {
  ensureIdentitiesDir();
  if (!/^[a-z0-9_-]{1,32}$/.test(label)) throw new Error(`label must be 1-32 chars [a-z0-9_-]; got ${label}`);
  const dir = join(IDENTITIES_DIR, label);
  if (existsSync(dir) && !force) throw new Error(`identity "${label}" already exists`);
  if (existsSync(dir) && force) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const wallet = Wallet.createRandom();
  const did = `did:ethr:${wallet.address}`;
  const podUrl = podUrlForDid(did);
  const meta = {
    label, did, address: wallet.address, podUrl,
    notes: notes ?? '',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, 'wallet.json'), JSON.stringify({ privateKey: wallet.privateKey, did, address: wallet.address }, null, 2));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeMcpConfig(label);
  return meta;
}

export function deleteIdentity(label) {
  const dir = join(IDENTITIES_DIR, label);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function loadIdentityMeta(label) {
  const p = join(IDENTITIES_DIR, label, 'meta.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function loadWallet(label) {
  const p = join(IDENTITIES_DIR, label, 'wallet.json');
  if (!existsSync(p)) throw new Error(`no wallet for "${label}"`);
  const { privateKey } = JSON.parse(readFileSync(p, 'utf8'));
  return new Wallet(privateKey);
}

export function listIdentities() {
  ensureIdentitiesDir();
  return readdirSync(IDENTITIES_DIR)
    .filter(name => existsSync(join(IDENTITIES_DIR, name, 'meta.json')))
    .map(name => loadIdentityMeta(name))
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Write the MCP config JSON that `claude --mcp-config <path>` reads
 * to wire the Interego MCP for THIS identity. The MCP proxy script
 * reads INTEREGO_WALLET_KEY + INTEREGO_LABEL + INTEREGO_DID from env
 * and signs all writes with that wallet.
 */
export function writeMcpConfig(label) {
  const meta = loadIdentityMeta(label);
  if (!meta) throw new Error(`identity "${label}" not found`);
  const wallet = loadWallet(label);
  const shimPath = join(__dirname, 'mcp-shim.mjs').replace(/\\/g, '/');
  const config = {
    mcpServers: {
      interego: {
        command: 'node',
        args: [shimPath],
        env: {
          INTEREGO_WALLET_KEY: wallet.privateKey,
          INTEREGO_LABEL: meta.label,
          INTEREGO_DID: meta.did,
          INTEREGO_POD_URL: meta.podUrl,
          ...(process.env.CG_RELAY_URL ? { CG_RELAY_URL: process.env.CG_RELAY_URL } : {}),
          ...(process.env.CG_GATE_URL  ? { CG_GATE_URL:  process.env.CG_GATE_URL  } : {}),
        },
      },
    },
  };
  const p = join(IDENTITIES_DIR, label, 'mcp-config.json');
  writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}

export function mcpConfigPath(label) {
  return join(IDENTITIES_DIR, label, 'mcp-config.json');
}
