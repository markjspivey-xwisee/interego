/**
 * WHOSE KEY AN AGENT'S CONTENT IS SEALED TO.
 *
 * ── ★★ WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * `relayAgentKey` is ONE process-wide X25519 keypair, and every registration site stamped its
 * public half as the agent's `encryptionPublicKey`. So every "recipient" on this fleet resolved to
 * the same bytes: encrypting a workspace "to its members" encrypted it to one key the relay holds,
 * and the relay could read all of it. That is server-side encryption at rest wearing the name of
 * end-to-end, and no member held a key at all.
 *
 * Worse, an agent that registered its own key had it OVERWRITTEN on the next pod-status call, so
 * there was no way to opt out of the arrangement.
 *
 * These pin the three properties that make the fix safe to ship:
 *   · a supplied key is recorded, so end-to-end is reachable
 *   · a key already set is never overwritten, so it survives
 *   · supplying nothing keeps the old behaviour exactly, so every existing pod is untouched
 *
 * Run: npx tsx deploy/mcp-relay/tests/agent-encryption-key.test.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');

let bad = 0;
const check = (ok: boolean, what: string, detail?: string): void => {
  if (!ok) bad++;
  process.stdout.write((ok ? '  ok   ' : '  FAIL ') + what + (detail ? ' — ' + detail : '') + '\n');
};

process.stdout.write('\nan agent may hold its own encryption key\n');

/**
 * The policy is one function so there is one answer. Six registration sites each deciding for
 * themselves is how five of them get fixed and the sixth keeps clobbering the key.
 */
const start = SERVER.indexOf('function encryptionKeyToRecord(');
const end = SERVER.indexOf('\n}', start);
const body = start > 0 ? SERVER.slice(start, end) : '';
check(body.length > 0, 'the key policy lives in one function');

check(/if \(given &&/.test(body) && /return given;/.test(body),
  '★ a supplied key is recorded — without this, end-to-end is unreachable');

check(/existing !== relayAgentKey\.publicKey/.test(body) && /return existing;/.test(body),
  '★★ a key the agent already set is NEVER overwritten — the relay used to clobber it every pod-status call');

check(/return relayAgentKey\.publicKey;/.test(body),
  '★ and supplying nothing keeps the old behaviour, so every existing pod is untouched');

/**
 * ★ A MALFORMED KEY IS REFUSED RATHER THAN RECORDED. Recording an unusable key would encrypt to
 * nobody — the publish would succeed, the envelope would name a recipient that cannot open it, and
 * the failure would surface as an empty channel much later.
 */
check(/\{43\}=\$/.test(body),
  '★ a value that is not a base64 X25519 public key is refused, not recorded');

/**
 * ★★ AND THE OVERWRITE SITES ACTUALLY GO THROUGH IT. The policy being correct is worth nothing if
 * a site still writes `relayAgentKey.publicKey` unconditionally. Two of the historical six are the
 * overwrite path; they must now consult the policy.
 */
const overwrites = (SERVER.match(/\?\s*\{ \.\.\.a, encryptionPublicKey: relayAgentKey\.publicKey/g) ?? []).length;
check(overwrites === 0,
  '★★ no site overwrites an agent key with the relay\'s unconditionally',
  overwrites > 0 ? `${overwrites} unconditional overwrite(s) remain` : undefined);

check(/encryption_public_key/.test(SERVER),
  'register_agent accepts one, so a client has a way to supply it');

process.stdout.write(bad ? '\n' + bad + ' assertion(s) failed\n' : '\nan agent can hold its own key, and keep it.\n');
process.exit(bad ? 1 : 0);
