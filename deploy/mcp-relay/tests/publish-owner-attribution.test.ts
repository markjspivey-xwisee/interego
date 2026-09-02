#!/usr/bin/env tsx
/**
 * A delegated cross-pod publish is authored on behalf of the pod it lands on.
 *
 * The incident this pins was a valid Claude delegation onto another user's pod.  Scope and
 * CAS both passed, but the relay built the descriptor first from Claude's session-owner WebID.
 * The served pod therefore disagreed with the signed `ownerWebId`, making descriptor binding
 * fail on the new link alone.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePublishOwnerAttribution } from '../publish-owner-attribution.js';
import { stripComments } from './strip-comments.js';

let pass = 0;
let fail = 0;
function ok(condition: boolean, name: string, detail = ''): void {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const CLAUDE_OWNER = 'https://identity.example/users/claude/profile#me';
const TARGET_OWNER = 'https://identity.example/users/release-owner/profile#me';

// Authorization is checked before owner discovery.  This is both a write gate and an
// information boundary: an unauthorized caller does not get a target-registry read for free.
{
  let reads = 0;
  const result = await resolvePublishOwnerAttribution({
    authorized: false,
    sessionOwnerWebId: CLAUDE_OWNER,
    readTargetOwnerWebId: async () => { reads += 1; return TARGET_OWNER; },
  });
  ok(!result.ok && result.code === 403 && result.error === 'scope_violation',
    'an unauthorized publish is refused');
  ok(reads === 0, 'an unauthorized publish never reads the target owner');
}

// The reproducer: an authorized writer whose session belongs to a different pod.  The target
// registry wins; the session owner remains diagnostic context and never becomes attribution.
{
  const result = await resolvePublishOwnerAttribution({
    authorized: true,
    sessionOwnerWebId: CLAUDE_OWNER,
    readTargetOwnerWebId: async () => TARGET_OWNER,
  });
  ok(result.ok && result.ownerWebId === TARGET_OWNER,
    'an authorized cross-pod publish uses the target pod owner');
  ok(result.differsFromSessionOwner === true,
    'the cross-pod attribution rewrite is explicit');
}

// Same-pod publishing stays byte-for-byte stable on the owner field.
{
  const result = await resolvePublishOwnerAttribution({
    authorized: true,
    sessionOwnerWebId: TARGET_OWNER,
    readTargetOwnerWebId: async () => `  ${TARGET_OWNER}  `,
  });
  ok(result.ok && result.ownerWebId === TARGET_OWNER,
    'same-pod attribution preserves the owner WebID');
  ok(result.differsFromSessionOwner === false,
    'same-pod attribution is not reported as rewritten');
}

// Falling back to the caller is the original defect, so both absence and lookup failure must
// refuse rather than mint another unverifiable descriptor.
{
  const absent = await resolvePublishOwnerAttribution({
    authorized: true,
    sessionOwnerWebId: CLAUDE_OWNER,
    readTargetOwnerWebId: async () => null,
  });
  ok(!absent.ok && absent.code === 503 && absent.error === 'target_owner_unavailable',
    'a target pod with no published owner fails closed');

  const failed = await resolvePublishOwnerAttribution({
    authorized: true,
    sessionOwnerWebId: CLAUDE_OWNER,
    readTargetOwnerWebId: async () => { throw new Error('registry offline'); },
  });
  ok(!failed.ok && failed.code === 503 && /registry offline/.test(failed.reason ?? ''),
    'a target owner lookup failure fails closed with its cause');
}

// server.ts opens a listener on import, so pin the integration ordering from source: scope first,
// target-owner resolution second, descriptor construction third.  All owner-bearing sinks retain
// the one reassigned variable, preventing one facet from drifting back to the session owner.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const source = stripComments(readFileSync(join(here, '..', 'server.ts'), 'utf8'), 'server.ts');
  const handler = source.slice(source.indexOf('async function handlePublishContext'));
  const scopeAt = handler.indexOf('const scopeCheck = await runScopeGate(agentId, podUrl)');
  const ownerAt = handler.indexOf('await resolvePublishOwnerAttribution({');
  const descriptorAt = handler.indexOf('ContextDescriptor.create(descId)');
  ok(scopeAt >= 0 && ownerAt > scopeAt && descriptorAt > ownerAt,
    'scope -> target owner -> descriptor ordering is wired into publish_context');
  ok(/ownerWebId = attribution\.ownerWebId!/.test(handler),
    'the resolved target owner becomes the single downstream owner value');
  ok(/\.delegatedBy\(ownerWebId as IRI, agentId as IRI/.test(handler),
    'AgentFacet.onBehalfOf consumes the resolved owner');
  ok(/issuer: ownerWebId as IRI/.test(handler),
    'TrustFacet.issuer consumes the resolved owner');
  ok(/ownerWebId: ownerWebId as IRI/.test(handler),
    'the signed authorship proof consumes the resolved owner');
}

console.log(`publish-owner-attribution: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
