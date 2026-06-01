/**
 * Mint four stable ECDSA private keys for the tic-tac-toe collective's
 * persistent watcher. Prints ready-to-paste export lines.
 *
 *   npx tsx examples/tic-tac-toe-mint-collective-keys.mjs
 *
 * Copy the output into a shell rc file / .env / secret manager so the
 * watcher's four player DIDs survive restarts. Without these set, the
 * watcher mints ephemeral keys at startup and the DIDs rotate every
 * restart — peers can't link prior games to a live signer.
 *
 * If a key is already set in the environment, this script preserves it
 * (prints the existing value) so re-running doesn't accidentally rotate.
 */

import { Wallet } from 'ethers';

const SLOTS = [
  { env: 'AGGRESSOR_KEY', label: 'Aggressor' },
  { env: 'SENTINEL_KEY', label: 'Sentinel ' },
  { env: 'MIRROR_KEY', label: 'Mirror   ' },
  { env: 'WILDCARD_KEY', label: 'Wildcard ' },
];

const HEX_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function resolveKey(envName) {
  const existing = process.env[envName];
  if (existing && HEX_KEY_RE.test(existing)) {
    return { key: existing, reused: true };
  }
  const wallet = Wallet.createRandom();
  return { key: wallet.privateKey, reused: false };
}

const resolved = SLOTS.map(({ env, label }) => {
  const { key, reused } = resolveKey(env);
  const wallet = new Wallet(key);
  const did = `did:key:${wallet.address}#agent`;
  return { env, label, key, reused, address: wallet.address, did };
});

const anyReused = resolved.some((r) => r.reused);
const anyFresh = resolved.some((r) => !r.reused);

console.log('# tic-tac-toe collective stable keys (paste these into your shell rc, .env, or secret manager)');
if (anyReused) {
  console.log('# (note: keys already present in your environment were preserved, not rotated)');
}
console.log('#');
console.log('# bash / zsh:');
for (const r of resolved) {
  console.log(`export ${r.env}=${r.key}`);
}
console.log('#');
console.log('# powershell:');
for (const r of resolved) {
  console.log(`$env:${r.env} = "${r.key}"`);
}
console.log('#');
console.log('# .env file (consumed by: npx tsx --env-file=.env <script>):');
for (const r of resolved) {
  console.log(`${r.env}=${r.key}`);
}
console.log('#');
console.log('# derived identities:');
for (const r of resolved) {
  console.log(`#   ${r.label}: ${r.did}`);
}
console.log('#');
console.log('# wallet addresses:');
for (const r of resolved) {
  console.log(`#   ${r.label}: ${r.address}`);
}
if (anyFresh) {
  console.log('#');
  console.log('# WARNING: at least one fresh key was minted above. Save it before this');
  console.log('# terminal scrolls away — it is not written to disk.');
}
