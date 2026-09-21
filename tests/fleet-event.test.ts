/**
 * tools/fleet-event.ts: the fleet's operations as descriptors. What is tested is the pure part —
 * the arguments, the events they build, the publish_context call they become — against the
 * shapes the workflows actually pass: auto-deploy's deploy matrix, the audit's captured log, the
 * collector's dry-run output. main() and the relay are exercised by the live runs, not here.
 */
import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { componentsFromMatrix, eventsFromArgs, parseArgs, publishArgs, quarterOf, summaryFromLog } from '../tools/fleet-event.js';

const DID = 'did:key:z6MkfleetTestAgent';
const NOW = new Date('2026-09-21T01:30:00.000Z');
const ctx = { agentDid: DID, now: NOW };
const parse = (turtle: string) => new Parser().parse(turtle);

describe('the arguments', () => {
  it('names the kind first and keeps every value of a repeated flag', () => {
    const p = parseArgs(['deploy', '--sha', 'abc', '--component', 'relay', '--component', 'css', '--dry-run']);
    expect(p.kind).toBe('deploy');
    expect(p.flags.get('component')).toEqual(['relay', 'css']);
    expect(p.dryRun).toBe(true);
  });
  it('refuses an unknown kind, a flag without a value and a bare word', () => {
    expect(() => parseArgs(['rotate'])).toThrow(/deploy \| incident \| review/);
    expect(() => parseArgs(['deploy', '--sha'])).toThrow(/--sha needs a value/);
    expect(() => parseArgs(['deploy', 'relay'])).toThrow(/unexpected argument relay/);
  });
});

describe('the deploy matrix', () => {
  it('reads the services out of the matrix auto-deploy passes', () => {
    expect(componentsFromMatrix('{"include":[{"service":"relay"},{"service":"jev-harness-bridge"}]}')).toEqual(['relay', 'jev-harness-bridge']);
  });
  it('refuses a matrix that is not that shape', () => {
    expect(() => componentsFromMatrix('nope')).toThrow(/not JSON/);
    expect(() => componentsFromMatrix('{"include":"relay"}')).toThrow(/no include array/);
    expect(() => componentsFromMatrix('{"include":[{"image":"relay"}]}')).toThrow(/without a service/);
  });
});

describe('deploy events', () => {
  const sha = '1db0227ed52e2797f4f1d8a7594ade55c56c7369';
  it('is one event per service, each naming the sha, the agent and CC8.1, under distinct graph IRIs', () => {
    const events = eventsFromArgs(parseArgs(['deploy', '--sha', sha, '--matrix', '{"include":[{"service":"relay"},{"service":"css"}]}']), ctx);
    expect(events.map((e) => e.kind)).toEqual(['deploy', 'deploy']);
    expect(new Set(events.map((e) => e.payload.graph_iri)).size).toBe(2);
    for (const e of events) {
      expect(e.payload.controls).toEqual(['soc2:CC8.1']);
      expect(e.payload.compliance_framework).toBe('soc2');
      expect(e.payload.modal_status).toBe('Asserted');
      expect(e.payload.graph_content).toContain(`soc2:commitSha "${sha}"`);
      expect(e.payload.graph_content).toContain(`prov:wasAttributedTo <${DID}>`);
      expect(e.payload.graph_content).toContain('soc2:environment "production"');
      expect(e.payload.graph_content).toContain('soc2:rollbackPlan "deploy-railway.yml restores');
      expect(parse(e.payload.graph_content).length).toBeGreaterThan(5);
    }
    expect(events[0]!.step).toEqual({ verb: 'deployed', objectName: 'relay at 1db0227ed52e' });
  });
  it('needs a sha that looks like one, and at least one service', () => {
    expect(() => eventsFromArgs(parseArgs(['deploy', '--sha', 'main', '--component', 'relay']), ctx)).toThrow(/not a commit sha/);
    expect(() => eventsFromArgs(parseArgs(['deploy', '--sha', sha]), ctx)).toThrow(/--component or --matrix/);
  });
});

describe('incident events', () => {
  const log = '  postgres-volume     on postgres      82%  41000 of 50000 MB at /var/lib/postgresql/data\n\n★ 1 volume(s) at or over 80%: grow them in the Railway dashboard before Postgres runs out of room to write.\n';
  it('reads the summary from the captured log, defaults to open and now, and lists the components', () => {
    const readFile = (path: string): string => (path === 'volume-check.log' ? log : '');
    const [e] = eventsFromArgs(parseArgs(['incident', '--severity', 'sev-2', '--title', 'A volume is over 80%', '--source', 'railway-fleet-audit', '--summary-file', 'volume-check.log', '--component', 'postgres']), { ...ctx, readFile });
    expect(e!.payload.controls).toEqual(['soc2:CC7.3']);
    expect(e!.payload.graph_content).toContain('soc2:incidentStatus "open"');
    expect(e!.payload.graph_content).toContain(`soc2:detectedAt "${NOW.toISOString()}"`);
    expect(e!.payload.graph_content).toContain('soc2:affectedComponent "postgres"');
    expect(e!.payload.graph_content).toContain('82%');
    expect(parse(e!.payload.graph_content).length).toBeGreaterThan(8);
    expect(e!.step).toEqual({ verb: 'reported-incident', objectName: 'A volume is over 80%' });
  });
  it('refuses an empty log, because a summary of nothing is not evidence', () => {
    expect(() => eventsFromArgs(parseArgs(['incident', '--severity', 'sev-2', '--title', 't', '--source', 's', '--summary-file', 'x.log']), { ...ctx, readFile: () => '\n\n' })).toThrow(/x.log is empty/);
  });
  it('a resolved incident cites the recovery controls and derives from what it supersedes', () => {
    const [e] = eventsFromArgs(parseArgs(['incident', '--severity', 'sev-1', '--title', 't', '--source', 's', '--summary', 'fixed', '--status', 'resolved', '--detected-at', '2026-09-20T20:37:00Z', '--supersedes', 'https://gate.example/u/context-graphs/1.ttl']), ctx);
    expect(e!.payload.controls).toEqual(['soc2:CC7.3', 'soc2:CC7.4', 'soc2:CC7.5']);
    expect(e!.payload.graph_iri).toBe('urn:graph:ops:incident:2026-09-20T20%3A37%3A00Z');
    expect(e!.payload.graph_content).toContain('prov:wasDerivedFrom <https://gate.example/u/context-graphs/1.ttl>');
  });
  it('★ a diagnosis is Hypothetical and supersedes the observation; the root cause is Asserted and supersedes the diagnosis', () => {
    const [diagnosis] = eventsFromArgs(parseArgs(['incident', '--severity', 'sev-1', '--title', 'disk full', '--source', 'audit', '--summary', 'suspected: unreferenced history', '--modal', 'Hypothetical', '--supersedes', 'https://gate.example/u/context-graphs/1.ttl']), ctx);
    expect(diagnosis!.modal).toBe('Hypothetical');
    expect(diagnosis!.step.verb).toBe('diagnosed-incident');
    expect(publishArgs(diagnosis!, {})['modal_status'], 'a diagnosis was published as an observed fact').toBe('Hypothetical');
    const [cause] = eventsFromArgs(parseArgs(['incident', '--severity', 'sev-1', '--title', 'disk full', '--source', 'audit', '--summary', 'root cause: 45 GB of history', '--status', 'resolved', '--supersedes', 'https://gate.example/u/context-graphs/2.ttl']), ctx);
    expect(cause!.modal).toBe('Asserted');
    expect(publishArgs(cause!, {})['modal_status']).toBe('Asserted');
  });
  it('refuses a modal outside the two, and any modal on a deploy', () => {
    expect(() => eventsFromArgs(parseArgs(['incident', '--severity', 'sev-3', '--title', 't', '--source', 's', '--summary', 'x', '--modal', 'Counterfactual']), ctx)).toThrow(/--modal must be one of/);
    expect(() => eventsFromArgs(parseArgs(['deploy', '--sha', 'abcdef1234', '--component', 'relay', '--modal', 'Hypothetical']), ctx)).toThrow(/a deploy is a fact/);
  });
  it('refuses a severity or status outside the scale', () => {
    expect(() => eventsFromArgs(parseArgs(['incident', '--severity', 'high', '--title', 't', '--source', 's', '--summary', 'x']), ctx)).toThrow(/--severity must be one of sev-1/);
    expect(() => eventsFromArgs(parseArgs(['incident', '--severity', 'sev-3', '--title', 't', '--source', 's', '--summary', 'x', '--status', 'done']), ctx)).toThrow(/--status must be one of open/);
  });
});

describe('review events', () => {
  it('lands on the quarter of the run, so each week supersedes the last under one graph IRI', () => {
    const [e] = eventsFromArgs(parseArgs(['review', '--kind', 'monitoring', '--summary', 'dry run: 1190058 live keys']), ctx);
    expect(e!.payload.graph_iri).toBe('urn:graph:ops:quarterly-review:2026-Q3:monitoring');
    expect(e!.payload.controls).toEqual(['soc2:CC4.1', 'soc2:CC4.2', 'soc2:CC7.2']);
    expect(e!.payload.graph_content).toContain('soc2:findingCount 0');
    expect(e!.step).toEqual({ verb: 'reviewed', objectName: '2026-Q3 monitoring review' });
  });
  it('counts the findings it is given, or the count it is told', () => {
    const [e] = eventsFromArgs(parseArgs(['review', '--kind', 'change', '--quarter', '2026-Q4', '--summary', 's', '--finding', 'a', '--finding', 'b']), ctx);
    expect(e!.payload.graph_iri).toBe('urn:graph:ops:quarterly-review:2026-Q4:change');
    expect(e!.payload.graph_content).toContain('soc2:findingCount 2');
    expect(e!.payload.graph_content).toContain('soc2:finding "a"');
    const [told] = eventsFromArgs(parseArgs(['review', '--kind', 'risk', '--summary', 's', '--finding-count', '3']), ctx);
    expect(told!.payload.graph_content).toContain('soc2:findingCount 3');
    expect(() => eventsFromArgs(parseArgs(['review', '--kind', 'risk', '--summary', 's', '--finding-count', 'many']), ctx)).toThrow(/whole number/);
  });
});

describe('quarters and logs', () => {
  it('names the calendar quarter', () => {
    expect(quarterOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-Q1');
    expect(quarterOf(new Date('2026-06-30T23:59:59Z'))).toBe('2026-Q2');
    expect(quarterOf(new Date('2026-12-31T00:00:00Z'))).toBe('2026-Q4');
  });
  it('strips colour, normalises line ends, and keeps the tail of a long log, where the verdict is', () => {
    expect(summaryFromLog('\u001b[32mok\u001b[0m\r\nline\n\n\n\nend\n')).toBe('ok\nline\n\nend');
    const s = summaryFromLog(`${'x'.repeat(5000)}\nverdict`, 100);
    expect(s.startsWith('… ')).toBe(true);
    expect(s.endsWith('verdict')).toBe(true);
    expect(s.length).toBe(102);
  });
});

describe('the publish_context call', () => {
  it('opts into compliance, names the framework, and publishes to the owner\'s pod as the agent', () => {
    const [e] = eventsFromArgs(parseArgs(['deploy', '--sha', 'abcdef1', '--component', 'relay']), ctx);
    const args = publishArgs(e!, { podName: 'u-pk-x', agentDid: DID });
    expect(args).toMatchObject({
      compliance: true, compliance_framework: 'soc2', modal_status: 'Asserted', visibility: 'shared',
      auto_supersede_prior: true, sign_authorship: true, pod_name: 'u-pk-x', agent_did: DID,
    });
    expect(args['graph_iri']).toBe(e!.payload.graph_iri);
    expect(args['graph_content']).toBe(e!.payload.graph_content);
    expect(publishArgs(e!, {})).not.toHaveProperty('pod_name');
  });
});
