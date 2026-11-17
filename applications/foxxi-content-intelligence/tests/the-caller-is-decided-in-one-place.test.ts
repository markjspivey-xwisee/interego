/**
 * The caller of a signed /agent/* route is decided in one place.
 *
 * WHY. bridge/server.ts decided "who is calling" three times: `verifyDelegatedCaller`,
 * `bindSignedCaller`, and an inline copy in /agent/issue-credential. Each recovered the
 * signer, compared it with the signed `agent_id`, and built `did:ethr:<signer>` itself. A
 * fourth site then re-derived "was that direct?" by rebuilding the same string. Three copies
 * of an identity rule drift, and a new way to be a caller would have had to be taught to all
 * of them.
 *
 * Now src/caller-principal.ts holds the rule and `resolveSignedPrincipal` in server.ts is the
 * one caller of it. This test reads server.ts as text (as
 * subject-kind-not-caller-controlled.test.ts does) and holds it there:
 *
 *   - no `did:ethr:${…signer}` template,
 *   - no mention of `recoverSignedRequest`,
 *   - no `mergeSignedEnvelope(` call,
 *
 * outside the resolver, except at the sites named below. Those sites are keyed on the WALLET
 * (prove you hold the key that owns this pod; is this claim the signer's own address) and
 * never answer "which agent is calling", so they do not go through the resolver. Each carries
 * its reason. The table is exact: a new site fails, and so does an entry that no longer
 * matches anything.
 *
 * The unit tests of the rule itself are in caller-principal.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8');
const lines = server.split('\n');

/** A place in server.ts with a name: a top-level function or const, a route, an MCP handler, or an instrumentation hook. */
const SITE_STARTS: RegExp[] = [
  /^(?:export )?(?:async )?function (\w+)/,
  /^app\.\w+\('([^']+)'/,
  /^(?:export )?const (\w+)\b/,
  /^ {2}'(foxxi\.[\w.]+)': async \(/,
  /^ {6}(authorizeInstrumentation: \(req, \w+\))/,
];

const SIGNER_DID = /did:ethr:(?:0x)?\$\{[^}]*signer[^}]*\}/gi;
const RECOVER = /\brecoverSignedRequest\b/g;
const MERGE_CALL = /\bmergeSignedEnvelope\(/g;

type Counts = { signerDid?: number; recover?: number; merge?: number };

function found(): Record<string, Counts> {
  const out: Record<string, Counts> = {};
  let site = '(top of file)';
  for (const line of lines) {
    for (const re of SITE_STARTS) {
      const m = re.exec(line);
      if (m) { site = m[1]!; break; }
    }
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('import ')) continue;
    // The definition of mergeSignedEnvelope is not a call to it.
    const code = line.replace(/^function mergeSignedEnvelope\(/, 'function (');
    const add = (k: keyof Counts, n: number): void => {
      if (n > 0) { out[site] ??= {}; out[site]![k] = (out[site]![k] ?? 0) + n; }
    };
    add('signerDid', (code.match(SIGNER_DID) ?? []).length);
    add('recover', (code.match(RECOVER) ?? []).length);
    add('merge', (code.match(MERGE_CALL) ?? []).length);
  }
  return out;
}

/** The resolver: the one site that recovers a signed request in order to decide WHICH AGENT is calling. */
const RESOLVER = 'resolveSignedPrincipal';

/**
 * Every other site, and why it is keyed on the wallet rather than on the caller principal.
 */
const WALLET_KEYED: Record<string, Counts & { why: string }> = {
  mergeSignedEnvelope: {
    recover: 1,
    why: 'the helper itself: verifies an envelope, merges the signed args, returns the recovered address and ignores agent_id by design',
  },
  assertTenantOwnerWrite: {
    signerDid: 1,
    why: 'names the wallet that must own the target pod, from an address mergeSignedEnvelope already recovered',
  },
  resolveCaller: {
    recover: 1,
    why: 'the directory/role resolver: it maps a wallet to a directory role, and is a different question from which agent signed',
  },
  'foxxi.ingest_content_package': {
    merge: 1,
    why: 'anyone who signs may bring a package; the recovered address is checked as the owner of the pod it lands in',
  },
  'foxxi.publish_authoring_policy': {
    merge: 1,
    why: 'the recovered address is checked as the owner of the pod the policy is written to',
  },
  'foxxi.assign_audience': {
    merge: 1,
    why: 'the recovered address is checked as the owner of the pod the assignment is written to',
  },
  'foxxi.register_self_sovereign_learner': {
    recover: 1,
    why: 'proof-of-possession for self-enrolment: a wallet enrols only the pod named for that wallet',
  },
  'foxxi.publish_ontology': {
    recover: 1, signerDid: 2,
    why: 'proof-of-possession: the signing wallet must own the pod, and the ontology is attributed to that wallet',
  },
  'foxxi.bootstrap_tenant': {
    merge: 1,
    why: 'the recovered address is checked as the owner of the pod being bootstrapped',
  },
  'authorizeInstrumentation: (req, learner)': {
    recover: 1, signerDid: 2,
    why: 'self-instrumentation: is the claimed learner DID exactly the signer\'s own address (boolean; no principal is produced)',
  },
  'authorizeInstrumentation: (req, asker)': {
    recover: 1, signerDid: 2,
    why: 'the same exact-address comparison for the asker of a second vertical-bridge mount',
  },
  verifyPrivatePerformanceCaller: {
    recover: 1,
    why: 'passes recoverSignedRequest to makePrivatePerformanceVerifier, which reads agent_id before, and compares the signer after, the delegated check it is also given',
  },
  verifyDelegatedTenantAdmin: {
    recover: 1,
    why: 'delegated tenant admin: the delegation is anchored on the TENANT pod being administered, not on the agent\'s own pod, and needs an explicit capability',
  },
  '/agent/calibration/merge': {
    recover: 1, signerDid: 2,
    why: 'recovers each CONTRIBUTION inside the body (not the caller) and counts distinct contributor wallets',
  },
  verifyOwnSubjectXapiCaller: {
    recover: 1,
    why: 'passes recoverSignedRequest to composeOwnSubjectXapiVerifier, which binds a human controller through the identity service',
  },
};

describe('the caller of a signed /agent/* route is decided in one place', () => {
  const sites = found();

  it('the resolver recovers the signed request, once, and builds no caller DID itself', () => {
    expect(sites[RESOLVER]).toEqual({ recover: 1 });
  });

  it('every other mention is at a named wallet-keyed site, and the list is exact', () => {
    const { [RESOLVER]: _resolver, ...rest } = sites;
    const expected = Object.fromEntries(Object.entries(WALLET_KEYED).map(([site, { why: _why, ...counts }]) => [site, counts]));
    expect(rest).toEqual(expected);
  });

  it('every allow-listed site says why', () => {
    for (const [site, { why }] of Object.entries(WALLET_KEYED)) expect(why.length, site).toBeGreaterThan(20);
  });

  const body = (signature: string): string => {
    const at = server.indexOf(signature);
    expect(at, `${signature} not found`).toBeGreaterThan(-1);
    const rest = server.slice(at);
    const end = rest.indexOf('\n}\n');
    return end < 0 ? rest : rest.slice(0, end + 3);
  };

  it('the resolver is the only caller of the pure decision', () => {
    expect(server.match(/\bdecideCallerPrincipal\(/g)).toHaveLength(1);
    expect(body(`function ${RESOLVER}(`)).toContain('decideCallerPrincipal(recoverSignedRequest(body)');
  });

  it('the three former copies are shims over the resolver, each stating its own options', () => {
    const bind = body('async function bindSignedCaller(');
    expect(bind).toContain(`${RESOLVER}(body, { agentIdBounds: true, anchorRefusalExplains: true`);
    const verify = body('async function verifyDelegatedCallerPrincipal(');
    expect(verify).toContain(`${RESOLVER}(body, { agentIdBounds: false, anchorRefusalExplains: false })`);
    expect(body('async function verifyDelegatedCaller(')).toContain('verifyDelegatedCallerPrincipal(body)');
    const issue = body("app.post('/agent/issue-credential',");
    expect(issue).toContain(`${RESOLVER}(req.body, {`);
    expect(issue).toMatch(/agentIdBounds: false, anchorRefusalExplains: false,\s*unsignedHint: 'sign_request the issuance args/);
    // Nothing else reaches the resolver directly.
    expect(server.match(new RegExp(`\\b${RESOLVER}\\(`, 'g'))).toHaveLength(4); // its definition and the three shims
  });

  it('the delegation reads happen only behind the resolver and the tenant-admin check', () => {
    const calls = (re: RegExp): string[] => {
      const out: string[] = [];
      let site = '(top of file)';
      for (const line of lines) {
        for (const s of SITE_STARTS) { const m = s.exec(line); if (m) { site = m[1]!; break; } }
        const t = line.trimStart();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        if (re.test(line)) out.push(site);
      }
      return out;
    };
    expect(calls(/\bverifyAgentDelegation\(/)).toEqual(['signedCallerDelegationChecks', 'verifyDelegatedTenantAdmin']);
  });

  it('learner kind is read from how the caller was authenticated, not rebuilt from strings', () => {
    const fn = body('async function resolveForCaller(');
    expect(fn).toContain("principal.authMode === 'direct' ? 'human' : 'agent'");
    expect(fn).not.toMatch(/did:ethr:/);
  });
});
