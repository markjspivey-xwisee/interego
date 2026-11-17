import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateAgainstSuppliedProfile } from '../../foxxi-content-intelligence/src/xapi-profile-supplied.js';
import { PackError } from '../src/errors.js';
import { loadPack, loadPackFile, publicPack } from '../src/pack.js';
import { follows, validates, type Json } from '../../foxxi-content-intelligence/src/xapi-profile-server/processor.js';
import { buildProfile, profileVersion } from '../src/profile.js';
import { baseline, drawCause, openingSymptoms, settle } from '../src/settle.js';
import { buildMissionStatements, buildWorkStatement } from '../src/statements.js';
import { MAX_BRIEF_CHARS, MAX_BRIEF_INTERVENTIONS, MAX_BRIEF_LESSONS, MAX_WORK_CHARS, briefMessages, workProduct } from '../src/agent-work.js';

const here = dirname(fileURLToPath(import.meta.url));
const orchard = loadPackFile(join(here, '../packs/orchard.json'));
const mandate = loadPackFile(join(here, '../packs/mandate.json'));
const zero = () => 0;

describe('a world pack is the policy', () => {
  it('loads two packs and does not hand the browser the cause map', () => {
    expect(orchard.title).toBe('Orchard');
    expect(mandate.factions).toHaveLength(4);
    expect(mandate.territories.length).toBeGreaterThan(10);
    const shown = publicPack(mandate);
    expect(JSON.stringify(shown)).not.toContain('addresses');
    expect(JSON.stringify(shown)).not.toContain('wrong procedure');
    expect(shown.causes.map(c => c.id)).toContain('skill');
  });

  it('refuses a pack that would have the world emit a cmi5 result verb', () => {
    const raw = JSON.parse(readFileSync(join(here, '../packs/orchard.json'), 'utf8')) as { verbs: { measured: string } };
    raw.verbs.measured = 'passed';
    expect(() => loadPack(raw)).toThrow(PackError);
    raw.verbs.measured = 'completed';
    expect(() => loadPack(raw)).toThrow(/passed, completed/);
  });

  it('publishes cpw at the IRI the code cites, as the same bytes', () => {
    const source = readFileSync(join(here, '../ontology/cpw.ttl'), 'utf8');
    const published = readFileSync(join(here, '../../../docs/applications/coached-world/cpw.ttl'), 'utf8');
    expect(published).toBe(source);
    expect(published).toContain('https://markjspivey-xwisee.github.io/interego/applications/coached-world/cpw#');
  });

  it('keeps Mandate, and every faction name, out of the engine', () => {
    for (const file of ['settle.ts', 'statements.ts', 'profile.ts', 'world.ts', 'graphs.ts', 'server.ts', 'bounded.ts', 'rate-limit.ts', 'agent-work.ts', 'agent-link.ts', 'agent-verifier.ts']) {
      const source = readFileSync(join(here, '../src', file), 'utf8');
      expect(source, file).not.toMatch(/Mandate|meridian|Juno-7|Gilbert/);
    }
  });
});

describe('settlement', () => {
  const mission = orchard.missions[0]!;
  const timing = orchard.causes[0]!;
  const press = orchard.causes[1]!;

  it('moves the score only when the intervention addresses the drawn cause', () => {
    const hit = settle({
      pack: orchard, mission, tier: 0, cause: timing, before: 50, diagnosisId: 'timing', interventionId: 'calendar',
      allies: 0, rivals: 0, factionId: 'north', factionOrder: ['north', 'south'],
      control: { north: 50, south: 50 }, rng: zero,
    });
    expect(hit.matched).toBe(true);
    expect(hit.delta).toBeGreaterThan(0);
    expect(hit.after).toBe(hit.before + hit.delta);
    const miss = settle({
      pack: orchard, mission, tier: 0, cause: timing, before: 50, diagnosisId: 'press', interventionId: 'repair',
      allies: 0, rivals: 0, factionId: 'north', factionOrder: ['north', 'south'],
      control: { north: 50, south: 50 }, rng: zero,
    });
    expect(miss.matched).toBe(false);
    expect(miss.delta).toBe(0);
    expect(miss.after).toBe(50);
    expect(miss.diagnosed).toBe(false);
    expect(miss.gain).toBe(0);
    expect(press.id).toBe('press');
  });

  it('draws the cause from the mission weights and remembers a matching lesson in the baseline', () => {
    expect(drawCause(orchard, mission, 0, zero).id).toBe('timing');
    const plain = baseline(orchard, mission, 0, false, zero);
    const remembered = baseline(orchard, mission, 0, true, zero);
    expect(remembered - plain).toBe(orchard.scoring.memoryBaselineLift);
  });

  it('hides the cause id in the opening statements and checks them against the pack profile', () => {
    const cause = drawCause(orchard, mission, 0, zero);
    const { symptoms, herring } = openingSymptoms(orchard, cause, zero);
    const built = buildMissionStatements({
      pack: orchard, homePage: 'http://127.0.0.1:9/', actorDid: 'did:web:example:agents:pip',
      missionId: mission.id, missionTitle: mission.title, missionObject: mission.object,
      symptoms, herring, progressed: 1, measured: { raw: 60, success: true }, timestamp: '2026-11-14T00:00:00.000Z',
    });
    const profile = buildProfile(orchard);
    expect(built.profile.id).toBe(orchard.profileId);
    for (const statement of built.statements) {
      expect(statement.verb.id).not.toMatch(/\/passed$|adlnet\.gov\/expapi\/verbs\/(passed|completed|failed)/);
      expect(JSON.stringify(statement)).not.toContain('"cause"');
      expect(validateAgainstSuppliedProfile(statement as unknown as Record<string, unknown>, profile as unknown as Record<string, unknown>).matchedTemplates.length).toBeGreaterThan(0);
    }
    const mandateBuilt = buildMissionStatements({
      pack: mandate, homePage: 'http://127.0.0.1:9/', actorDid: 'did:web:example:agents:juno',
      missionId: mandate.missions[0]!.id, missionTitle: mandate.missions[0]!.title, missionObject: 'convoy',
      symptoms: mandate.causes[0]!.symptoms, herring: undefined, progressed: 0, measured: undefined,
      timestamp: '2026-11-14T00:00:00.000Z',
    });
    expect(mandateBuilt.profile.id).not.toBe(built.profile.id);
  });
});

// The profile is a contract only where something holds the world to it. These read the document
// the world serves with the specification's own two algorithms, over what the builders emit.
describe.each([['orchard', orchard], ['mandate', mandate]] as const)('the %s profile is a whole document its own statements follow', (_name, pack) => {
  const profile = buildProfile(pack) as unknown as { [k: string]: unknown; concepts: Json[]; templates: Json[]; patterns: Json[]; versions: Json[] };
  const mission = pack.missions[0]!;
  const cause = pack.causes.find(c => c.symptoms.length > 0)!;
  const build = (more: Partial<Parameters<typeof buildMissionStatements>[0]>) => buildMissionStatements({
    pack, homePage: 'http://127.0.0.1:9/', actorDid: 'did:web:example:agents:pip', missionId: mission.id, missionTitle: mission.title,
    missionObject: mission.object, symptoms: cause.symptoms.slice(0, 3), herring: undefined, progressed: 2, measured: undefined,
    timestamp: '2026-11-14T00:00:00.000Z', ...more,
  });
  const json = (s: unknown): Json => JSON.parse(JSON.stringify(s)) as Json;

  it('says what it is, which version it is, and defines every term it names', () => {
    expect(profile).toMatchObject({ '@context': 'https://w3id.org/xapi/profiles/context', type: 'Profile', conformsTo: 'https://w3id.org/xapi/profiles#1.0', id: pack.profileId });
    expect(profile.versions).toEqual([{ id: profileVersion(pack), generatedAtTime: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:]+Z$/) }]);
    expect(buildProfile(pack)).toEqual(buildProfile(pack));
    for (const part of [...profile.concepts, ...profile.templates, ...profile.patterns]) {
      expect(part['inScheme']).toBe(profileVersion(pack));
      expect((part['prefLabel'] as { en: string }).en.length).toBeGreaterThan(0);
      expect((part['definition'] as { en: string }).en.length).toBeGreaterThan(10);
    }
    const declared = new Set(profile.concepts.map(c => c['id']));
    const named = profile.templates.flatMap(t => [t['verb'], t['objectActivityType'], ...((t['contextParentActivityType'] as string[] | undefined) ?? []),
      ...(t['rules'] as Array<{ location: string }>).map(r => /extensions\['([^']+)'\]/.exec(r.location)?.[1])]).filter(Boolean);
    expect(named.filter(id => !declared.has(id))).toEqual([]);
    expect(profile.concepts.filter(c => String(c['type']).endsWith('Extension')).every(c => typeof c['inlineSchema'] === 'string')).toBe(true);
  });

  it('gives no two templates the same determining properties, so a statement answers to one', () => {
    const key = (t: Json) => JSON.stringify([t['verb'], t['objectActivityType'], t['contextParentActivityType'] ?? null]);
    expect(new Set(profile.templates.map(key)).size).toBe(profile.templates.length);
  });

  it('has every template followed by a statement the world builds, and by that template only', () => {
    const opened = build({});
    const settled = build({ symptoms: [], progressed: 0, measured: { raw: 61, success: true }, registration: opened.registration });
    const seen = new Set<string>();
    for (const statement of [...opened.statements, ...settled.statements]) {
      const result = validates(json(statement), profile.templates);
      expect(result).toMatchObject({ outcome: 'success', findings: [] });
      expect(result.templates).toHaveLength(1);
      seen.add(result.templates[0]!);
    }
    expect([...seen].sort()).toEqual(profile.templates.map(t => String(t['id'])).sort());
  });

  it('refuses a statement that names the profile and not the version, or that states the cause', () => {
    const [first] = build({}).statements;
    const unversioned = json({ ...first, context: { ...first!.context, contextActivities: { category: [{ id: pack.profileId }] } } });
    expect(validates(unversioned, profile.templates).outcome).toBe('invalid');
    const telling = json({ ...first, result: { extensions: { [`${pack.profileId}/ext/cause`]: cause.id } } });
    expect(validates(telling, profile.templates).outcome).toBe('invalid');
  });

  it('reads each registration the world writes as one of its primary patterns', () => {
    const opened = build({});
    const at = (statements: readonly unknown[], timestamp: string) => statements.map(s => json({ ...(s as object), timestamp }));
    const work = buildWorkStatement({
      pack, homePage: 'http://127.0.0.1:9/', actorDid: 'did:web:example:agents:pip', missionId: mission.id, missionTitle: mission.title,
      response: 'Counted the made-up crates.', timestamp: '2026-11-14T00:01:00.000Z', registration: opened.registration,
    });
    const settle = (matched: boolean) => at(build({ symptoms: [], progressed: matched ? 2 : 0, measured: { raw: 61, success: matched }, registration: opened.registration }).statements, '2026-11-14T00:02:00.000Z');
    const missionPattern = `${pack.profileId}/patterns/mission`;
    const start = opened.statements.map(json);
    // Opened and never settled; settled with a match; settled without one; with an agent's work between.
    for (const stream of [start, [...start, ...settle(true)], [...start, ...settle(false)], [...start, json(work), ...settle(true)]]) {
      expect(follows(stream, profile.templates, profile.patterns)).toEqual({ follows: true, pattern: missionPattern, reasons: [] });
    }
    // What the world's own interventions write: a mission taken up and measured, with nothing observed, under a registration of its own.
    const standing = build({ symptoms: [], progressed: 0, measured: { raw: 40, success: false } }).statements.map(json);
    expect(follows(standing, profile.templates, profile.patterns)).toEqual({ follows: true, pattern: `${pack.profileId}/patterns/standing-measure`, reasons: [] });
    // And what it never writes: a measure before the mission is opened, or two measures.
    expect(follows([...settle(true), ...at(start, '2026-11-14T00:03:00.000Z')], profile.templates, profile.patterns).follows).toBe(false);
    expect(follows([...start, ...settle(true), ...at(settle(false), '2026-11-14T00:04:00.000Z')], profile.templates, profile.patterns).follows).toBe(false);
  });
});

describe('work a connected agent wrote', () => {
  const mission = orchard.missions[0]!;
  const brief = {
    registration: '00000000-0000-4000-8000-000000000003', agentName: 'Pip-3', role: 'picker',
    missionType: mission.type, missionTitle: mission.title, missionObject: mission.object, kpi: mission.kpi, territory: 'Made-up Rise',
    conditions: ['skipped the east rows: two made-up crates short'],
    lessons: Array.from({ length: 30 }, (_, i) => `fictional lesson ${i}`),
    interventions: Array.from({ length: 30 }, (_, i) => `fictional card ${i}`),
  };

  it('is asked for with the mission, its conditions and a bounded slice of memory, and nothing that names the cause', () => {
    const messages = briefMessages(brief);
    expect(messages.map(m => m.role)).toEqual(['system', 'user']);
    expect(messages[0]!.content).toContain('You are Pip-3');
    const user = messages[1]!.content;
    expect(user).toContain(mission.title);
    expect(user).toContain('- skipped the east rows: two made-up crates short');
    expect(user).toContain(`- fictional lesson ${MAX_BRIEF_LESSONS - 1}`);
    expect(user).not.toContain(`fictional lesson ${MAX_BRIEF_LESSONS}`);
    expect(user).not.toContain(`fictional card ${MAX_BRIEF_INTERVENTIONS}`);
    expect(user.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(briefMessages({ ...brief, conditions: ['x'.repeat(50_000)] })[1]!.content.length).toBe(MAX_BRIEF_CHARS);
    for (const cause of orchard.causes) expect(messages.map(m => m.content).join('\n')).not.toContain(cause.id === 'timing' ? '"timing"' : cause.label);
  });

  it('is kept bounded and printable', () => {
    expect(workProduct('  Counted the crates.\u0000\u0007\n\n\n\nThen stopped.  ')).toBe('Counted the crates.  \n\nThen stopped.');
    const long = workProduct('a'.repeat(MAX_WORK_CHARS * 3));
    expect(long.length).toBe(MAX_WORK_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(workProduct(' \n\t ')).toBe('');
  });

  it('becomes one statement by the agent, in the pack profile, under the mission registration', () => {
    const statement = buildWorkStatement({
      pack: orchard, homePage: 'http://127.0.0.1:9/', actorDid: 'did:web:example:agents:pip', missionId: mission.id,
      missionTitle: mission.title, response: 'Counted the made-up crates.', timestamp: '2026-11-14T00:00:00.000Z', registration: brief.registration,
    });
    expect(statement.actor.account.name).toBe('did:web:example:agents:pip');
    expect(statement.verb.id).toBe(`${orchard.profileId}/verbs/${orchard.verbs.progressed}`);
    expect(statement.result).toEqual({ response: 'Counted the made-up crates.' });
    expect(statement.context.registration).toBe(brief.registration);
    const profile = buildProfile(orchard);
    expect(validateAgainstSuppliedProfile(statement as unknown as Record<string, unknown>, profile as unknown as Record<string, unknown>).matchedTemplates).toEqual([`${orchard.profileId}/templates/progressed`]);
    expect(JSON.stringify(statement)).not.toMatch(/adlnet\.gov\/expapi\/verbs\/(passed|completed|failed|satisfied)/);
  });
});

// xapi-x, section 6: who stands behind the order of a registration's statements. Every statement
// of an opening carries one timestamp, so without the chain only the array says which came first.
describe('the order of a registration is chained, and the world signs the list', async () => {
  const { Wallet } = await import('ethers');
  const { orderBasis, statementDigest } = await import('../../foxxi-content-intelligence/src/xapix/statement.js');
  const { lintXapixStatements } = await import('../../foxxi-content-intelligence/src/xapix/lint.js');
  const { buildXapixProfileDoc } = await import('../../foxxi-content-intelligence/src/xapix/profile.js');
  const { xapix } = await import('../../foxxi-content-intelligence/src/xapix/namespace.js');
  const { orderAttestationGraph, orderAttestationIri } = await import('../src/graphs.js');
  const { orderOf, readOrderAttestation } = await import('../src/order.js');
  const base = 'http://127.0.0.1:9/';
  const mission = orchard.missions[0]!;
  const cause = orchard.causes.find(c => c.symptoms.length > 0)!;
  const common = { pack: orchard, homePage: base, actorDid: 'did:web:example:agents:pip', missionId: mission.id, missionTitle: mission.title, missionObject: mission.object };
  const opened = buildMissionStatements({ ...common, symptoms: cause.symptoms.slice(0, 3), herring: undefined, progressed: 2, measured: undefined, timestamp: '2026-11-14T00:00:00.000Z' });
  const work = buildWorkStatement({ ...common, response: 'A made-up note from a fictional agent.', timestamp: '2026-11-14T00:01:00.000Z', registration: opened.registration, after: opened.statements.at(-1) });
  const attestation = orderAttestationIri(base, opened.registration);
  const closed = buildMissionStatements({ ...common, symptoms: [], herring: undefined, progressed: 1, measured: { raw: 60, success: true }, timestamp: '2026-11-14T00:02:00.000Z', registration: opened.registration, after: work, orderAttestation: attestation });
  const run = [...opened.statements, work, ...closed.statements].map(s => JSON.parse(JSON.stringify(s)) as Json);
  const wallet = Wallet.createRandom();
  const bundle = orderAttestationGraph({ base, registration: opened.registration, writerDid: 'did:web:example:world', at: '2026-11-14T00:02:00.000Z', digests: run.map(statementDigest) });
  const published = { canonical: bundle.canonical, signature: await wallet.signMessage(bundle.canonical) };

  it('gives every statement a UUID, and each after the first the one before it and its digest', () => {
    expect(run.length).toBeGreaterThan(5);
    for (const [i, s] of run.entries()) {
      expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const ext = ((s.context as Json).extensions ?? {}) as Json;
      if (i === 0) { expect(ext[xapix('previous')]).toBeUndefined(); continue; }
      expect(ext[xapix('previous')]).toBe(run[i - 1]!.id);
      expect(ext[xapix('previousDigest')]).toBe(statementDigest(run[i - 1]!));
    }
    expect(orderBasis(run).basis).toBe('Chained');
    // The same statements in another order, or with one changed, are not a chain.
    expect(orderBasis([run[1]!, run[0]!, ...run.slice(2)]).basis).toBe('ProviderClaimed');
    expect(orderBasis(run.map((s, i) => i === 1 ? { ...s, timestamp: '2026-11-14T00:00:01.000Z' } : s)).basis).toBe('ProviderClaimed');
  });

  it('still follows the pack profile, and passes the xapi-x statement rules', () => {
    const profile = buildProfile(orchard) as unknown as Json;
    for (const s of run) expect(validateAgainstSuppliedProfile(s, profile).matchedTemplates.length).toBeGreaterThan(0);
    expect(follows(run, profile.templates as Json[], profile.patterns as Json[]).follows).toBe(true);
    expect(lintXapixStatements(run, [buildXapixProfileDoc() as Json, profile])).toEqual([]);
  });

  it('names the signed list on the statements that close the registration, and only there', () => {
    const named = run.map(s => ((s.context as Json).extensions as Json | undefined)?.[xapix('orderAttestation')]);
    expect(named.slice(0, opened.statements.length + 1).every(v => v === undefined)).toBe(true);
    expect(named.slice(opened.statements.length + 1).every(v => v === attestation)).toBe(true);
    expect(bundle.id).toBe(attestation);
    expect(bundle.graph).toContain('cpw:StatementOrder');
  });

  it('is Attested when the signature verifies and the digests are these statements in this order', () => {
    const read = readOrderAttestation(published, wallet.address);
    expect(read).toMatchObject({ signatureVerified: true, signer: wallet.address, registration: opened.registration });
    expect(orderOf(run, published, wallet.address)).toMatchObject({ basis: 'Attested', signer: wallet.address });
  });

  it('is not Attested for a list that was changed, a signer that is not the one named, or other statements', () => {
    const changed = { ...published, canonical: published.canonical.replace(/sha256:[0-9a-f]{4}/, 'sha256:0000') };
    expect(readOrderAttestation(changed, wallet.address).signatureVerified).toBe(false);
    const other = Wallet.createRandom();
    expect(readOrderAttestation(published, other.address)).toMatchObject({ signatureVerified: false, signer: wallet.address });
    expect(readOrderAttestation({ canonical: 'not json', signature: published.signature }).signatureVerified).toBe(false);
    expect(readOrderAttestation({ canonical: published.canonical, signature: '0x00' }).signatureVerified).toBe(false);
    // A run with its last statement left off is still a chain, and is not what was attested.
    expect(orderOf(run.slice(0, -1), published, wallet.address).basis).toBe('Chained');
    expect(orderOf(run, changed, wallet.address).basis).toBe('Chained');
  });
});
