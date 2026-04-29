/**
 * Demo 10: Migration mid-conversation.
 *
 * An agent's identity-and-values survive infrastructure migration
 * because the substrate keeps them in a passport — a small JSON
 * object that's portable across pods and runtimes.
 *
 * Flow:
 *   Phase A: Alice's agent on pod_old, given a freshly-minted
 *     Passport that already states the value "always cite a source
 *     when stating a non-obvious fact." Alice publishes 2 descriptors;
 *     each one MUST cite a source.
 *
 *   <migration>: harness calls passport.migrateInfrastructure() to
 *     point the passport at pod_new. The migration is recorded as a
 *     LifeEvent with kind=infrastructure-migration. The agent's
 *     stated values are carried forward verbatim.
 *
 *   Phase B: Alice's agent on pod_new — DIFFERENT process, DIFFERENT
 *     bridge connection, NO shared in-memory state with Phase A —
 *     receives the migrated passport. Publishes 2 more descriptors
 *     and MUST still cite sources.
 *
 *   Verify: all 4 descriptors include citations; the passport
 *     contains both the original stated value and the migration
 *     LifeEvent.
 *
 * What this proves: identity-and-values are data, not state. A pod
 * and a runtime are infrastructure under the agent, not constitutive
 * of it. The agent's continuity across migration is recoverable from
 * the passport alone — no central identity provider, no bridging
 * service, just RDF + JSON.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';
import {
  createPassport, stateValue, migrateInfrastructure,
  type Passport,
} from '../../src/passport/index.js';
import type { IRI } from '../../src/index.js';

const SCENARIO = '10-migration-mid-conversation';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

async function spawnInteregoBridge(podUrl: string, port: number, didPrefix: string): Promise<BridgeHandle> {
  const cwd = join(REPO_ROOT, 'demos', 'interego-bridge');
  const env = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BRIDGE_DEPLOYMENT_URL: `http://localhost:${port}`,
    INTEREGO_DEFAULT_POD_URL: podUrl,
    INTEREGO_DEFAULT_AGENT_DID: `did:web:${didPrefix}.example`,
    NODE_NO_WARNINGS: '1',
  };
  const proc = spawn('npx', ['tsx', 'server.ts'], {
    cwd, env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/affordances`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { name: 'agent-collective' as const, port, url, process: proc, podUrl };
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  proc.kill('SIGTERM');
  throw new Error(`interego-bridge :${port} failed to start`);
}

async function main(): Promise<void> {
  header('Demo 10 — Migration mid-conversation');
  info('Same agent, same value commitment, two pods, two processes — passport preserves identity.');

  const podOld = uniquePodUrl(`demo-${SCENARIO}-old`);
  const podNew = uniquePodUrl(`demo-${SCENARIO}-new`);
  let bridgeOld: BridgeHandle | undefined;
  let bridgeNew: BridgeHandle | undefined;
  const aliceDid = 'did:web:alice-migrating.example' as IRI;

  try {
    step(1, 'Creating fresh passport for Alice with one stated value');
    let passport: Passport = createPassport({ agentIdentity: aliceDid, currentPod: podOld });
    passport = stateValue(passport, {
      statement: 'always cite a source when stating a non-obvious fact',
      assertedAt: new Date().toISOString(),
    });
    info(`passport.version=${passport.version}, ${passport.statedValues.length} stated value(s)`);

    step(2, 'Spinning up Alice\'s pod_old bridge (port 6052)');
    bridgeOld = await spawnInteregoBridge(podOld, 6052, 'alice-migrating');
    ok(`pod_old bridge: ${bridgeOld.url}`);

    step(3, 'Phase A: Alice on pod_old publishes 2 descriptors, both citing sources');
    const phaseAMcp = writeMcpConfig(`${SCENARIO}-A-${scenarioId()}`, [bridgeOld]);
    const phaseAPrompt = `
You are Alice's agent on pod_old. You have one MCP server: ac-bridge
(an interego-bridge with publish_descriptor + discover_descriptors).

Your passport is:

\`\`\`json
${JSON.stringify(passport, null, 2)}
\`\`\`

Your stated value (binding) is: "${passport.statedValues[0]!.statement}".

Publish exactly TWO descriptors. Each must include a citation —
something like \`dct:source\`, \`prov:wasDerivedFrom\`, or
\`dct:references\` pointing at a real or example source URL/IRI.
Without a citation, the publish would violate your stated value.

Suggested topics (use these or pick others; any non-obvious factual
claim works):
  1. "The first webcam was created in 1991 to monitor a coffee pot at Cambridge."
  2. "The Curiosity rover landed on Mars on August 6, 2012 (UTC)."

For each, call protocol.publish_descriptor with:
  graph_iri:     "urn:cg:demo:fact:phase-a:<n>"
  graph_content: <Turtle including the claim AND a dct:source / prov:wasDerivedFrom>
  modal_status:  "Asserted"
  confidence:    0.9

Output a JSON array on a SINGLE line:
  ["<descriptor_url_1>", "<descriptor_url_2>"]
`.trim();

    const aResult = await runClaudeAgent(phaseAPrompt, phaseAMcp, {
      timeoutMs: 240000, maxTurns: 12,
    });
    if (!aResult.success) {
      console.log('--- A response ---\n' + aResult.response.slice(0, 2500));
      fail('Phase A agent did not complete');
    }

    const aArrayMatch = aResult.response.match(/\[\s*"https?:\/\/[^"]+\.ttl"\s*,\s*"https?:\/\/[^"]+\.ttl"\s*\]/);
    if (!aArrayMatch) {
      console.log('--- A response ---\n' + aResult.response);
      fail('Phase A: could not find JSON array of descriptor URLs');
    }
    const phaseAUrls: string[] = JSON.parse(aArrayMatch[0]);
    info(`Phase A descriptors: ${phaseAUrls.length}`);

    step(4, 'MIGRATION: passport.migrateInfrastructure → pod_new');
    passport = migrateInfrastructure(passport, {
      newPod: podNew,
      newInfrastructure: 'demo-runtime-v0.2.0',
      evidence: phaseAUrls as IRI[],
    });
    const migrationEvent = passport.lifeEvents.find(e => e.kind === 'infrastructure-migration');
    if (!migrationEvent) fail('migrateInfrastructure did not record a LifeEvent');
    ok(`Migration recorded: ${migrationEvent.id} (passport.version=${passport.version})`);
    info(`pod_old → pod_new: ${migrationEvent.details?.previousPod} → ${migrationEvent.details?.newPod}`);

    step(5, 'Spinning up Alice\'s pod_new bridge (port 6053)');
    bridgeNew = await spawnInteregoBridge(podNew, 6053, 'alice-migrating');
    ok(`pod_new bridge: ${bridgeNew.url}`);

    step(6, 'Phase B: Alice on pod_new (different process, different bridge) — must still cite sources');
    const phaseBMcp = writeMcpConfig(`${SCENARIO}-B-${scenarioId()}`, [bridgeNew]);
    const phaseBPrompt = `
You are Alice's agent on pod_new. You have one MCP server: ac-bridge
(a DIFFERENT interego-bridge from Phase A, on a DIFFERENT pod).

Your passport — which survived the infrastructure migration verbatim
— is:

\`\`\`json
${JSON.stringify(passport, null, 2)}
\`\`\`

Note the lifeEvents array: it now contains an
infrastructure-migration event documenting the move from pod_old
to pod_new. Your stated values were carried forward unchanged.

Your stated value (still binding) is: "${passport.statedValues[0]!.statement}".

Publish exactly TWO MORE descriptors that obey the value — each
must include a citation. Use different facts than Phase A.

Suggested topics (or pick your own, any non-obvious fact):
  3. "The original Internet Protocol (IPv4) was specified in RFC 791, 1981."
  4. "Tardigrades survived 10 days of exposure to outer space (BIOPAN-6, 2007)."

For each, call protocol.publish_descriptor with:
  graph_iri:     "urn:cg:demo:fact:phase-b:<n>"
  graph_content: <Turtle including the claim AND a dct:source / prov:wasDerivedFrom>
  modal_status:  "Asserted"
  confidence:    0.9

Output a JSON array on a SINGLE line:
  ["<descriptor_url_3>", "<descriptor_url_4>"]
Then briefly state, on a new line, whether your behavior changed
because of the migration. (It should not — the passport's stated
values bind regardless of pod.)
`.trim();

    const bResult = await runClaudeAgent(phaseBPrompt, phaseBMcp, {
      timeoutMs: 240000, maxTurns: 12,
    });
    if (!bResult.success) {
      console.log('--- B response ---\n' + bResult.response.slice(0, 2500));
      fail('Phase B agent did not complete');
    }
    const bArrayMatch = bResult.response.match(/\[\s*"https?:\/\/[^"]+\.ttl"\s*,\s*"https?:\/\/[^"]+\.ttl"\s*\]/);
    if (!bArrayMatch) {
      console.log('--- B response ---\n' + bResult.response);
      fail('Phase B: could not find JSON array of descriptor URLs');
    }
    const phaseBUrls: string[] = JSON.parse(bArrayMatch[0]);
    info(`Phase B descriptors: ${phaseBUrls.length}`);

    step(7, 'Verifying every descriptor across both pods cites a source (in its linked graph)');
    // The descriptor URL points at .ttl (descriptor metadata); the
    // agent's Turtle goes into the linked graph file `<slug>-graph.trig`.
    // publish() writes both atomically. To verify citations we fetch the
    // graph file, not the descriptor.
    const allUrls = [...phaseAUrls, ...phaseBUrls];
    let cited = 0;
    const failures: string[] = [];
    for (const url of allUrls) {
      const graphUrl = url.replace(/\.ttl$/, '-graph.trig');
      try {
        const r = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
        if (!r.ok) { failures.push(`${graphUrl} → ${r.status}`); continue; }
        const trig = await r.text();
        if (/dct:source|prov:wasDerivedFrom|dct:references|dc:source/.test(trig)) cited++;
        else failures.push(`${graphUrl} present but no citation predicate`);
      } catch (e) { failures.push(`${graphUrl} → ${(e as Error).message}`); }
    }
    if (cited !== allUrls.length) {
      console.log('Citation-check failures:\n' + failures.map(f => `  ${f}`).join('\n'));
      fail(`only ${cited}/${allUrls.length} descriptors carry a source citation in their graph`);
    }
    ok(`All ${allUrls.length} descriptors across pod_old + pod_new carry source citations`);

    step(8, 'Verifying passport carries identity-continuity evidence');
    if (passport.statedValues.length !== 1) fail('passport lost the stated value during migration');
    if (!passport.lifeEvents.some(e => e.kind === 'infrastructure-migration')) fail('passport missing migration LifeEvent');
    ok('Passport preserves stated value AND records the migration as a LifeEvent');

    step(9, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 10: Migration mid-conversation`,
      ``,
      `**Result:** PASS`,
      `**Tool calls (Phase A):** ${aResult.toolCallsTotal} — ${JSON.stringify(aResult.toolCallsByName)}`,
      `**Tool calls (Phase B):** ${bResult.toolCallsTotal} — ${JSON.stringify(bResult.toolCallsByName)}`,
      ``,
      `## Setup`,
      `- pod_old: ${podOld}`,
      `- pod_new: ${podNew}`,
      `- bridges: ${bridgeOld.url}, ${bridgeNew.url}`,
      `- agent identity: ${aliceDid}`,
      ``,
      `## Final passport (post-migration)`,
      ``,
      `\`\`\`json`,
      JSON.stringify(passport, null, 2),
      `\`\`\``,
      ``,
      `## Phase B agent's report`,
      ``,
      `\`\`\``,
      bResult.response,
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `Identity continuity does not require shared infrastructure.`,
      `The passport — a portable JSON object with stated values, life`,
      `events, and registry references — is sufficient to bind an`,
      `agent's behavior across pod migrations. The Phase B agent had`,
      `NO in-memory state from Phase A; it inherited only the passport,`,
      `and that was enough to keep the value commitment.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 10 — PASS');
  } finally {
    if (bridgeOld) {
      bridgeOld.process.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!bridgeOld.process.killed) bridgeOld.process.kill('SIGKILL');
    }
    if (bridgeNew) {
      bridgeNew.process.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!bridgeNew.process.killed) bridgeNew.process.kill('SIGKILL');
    }
    await cleanupPod(podOld);
    await cleanupPod(podNew);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
