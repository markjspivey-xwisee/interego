/**
 * One shared world. Territories, factions, pacts and agent memory are Interego
 * graphs. Mission settlement is `settle`, which reads only the pack. Two
 * consultants in one process see one feed, one map and one leaderboard.
 */
import { Wallet } from 'ethers';
import { WorldError } from './errors.js';
import { MAX_AGENT_LESSONS, MAX_AGENT_SCORES, MAX_CONSULTANTS, MAX_PUBLISHED_GRAPHS, trim } from './bounded.js';
import {
  agentGraph, factionGraph, interventionGraph, observationGraph, pactGraph, territoryGraph,
  type GraphBundle,
} from './graphs.js';
import { StatementLog, SATISFIED, type LrsReader } from './lrs.js';
import type { CourseLauncher, CourseLaunchResult } from './course-launch.js';
import {
  byId, fill, formatClock, holderOf, publicPack, type CauseDef, type PublicPack, type WorldPack,
} from './pack.js';
import { hashSeed, mulberry, pick } from './rng.js';
import { baseline, drawCause, openingSymptoms, settle } from './settle.js';
import { buildMissionStatements, type XapiStatement } from './statements.js';
import { buildProfile, type ProfileDocument } from './profile.js';

export interface GuestPrincipal {
  readonly ownerDid: string;
  readonly userId: string;
  readonly podUrl: string;
  readonly agentDid: string;
}

export interface Published {
  readonly id: string;
  readonly kind: string;
  readonly version: number;
  readonly turtle: string;
  readonly graph: string;
  readonly canonical: string;
  readonly signature: string;
  readonly supersedes?: string;
}

interface Lesson { readonly text: string; readonly causeId: string; readonly matched: boolean }
interface AgentState {
  id: string; name: string; role: string; did: string; podUrl: string;
  controllerDid?: string; consultantId?: string; factionId?: string;
  hist: number[]; memory: Lesson[]; version: number;
  /** Every cause this agent has a matched lesson for. `memory` keeps only the newest lessons; this keeps what they taught. */
  learned: Set<string>;
}
interface TerritoryState { id: string; name: string; q: number; r: number; control: Record<string, number>; version: number }
interface BotState { id: string; name: string; factionId: string; tier: number; roi: number; growth: number; agents: number }
interface Consultant {
  id: string; ownerDid: string; userId: string; podUrl: string; agentDid: string;
  name: string; factionId: string | null; tier: number; influence: number;
  successes: number; diagTotal: number; diagCorrect: number; roiSum: number; roiCount: number; growth: number;
  roster: string[]; gate: 'none' | 'eligible'; runs: number;
}
interface LiveMission {
  id: string; consultantId: string; missionId: string; agentId: string; territoryId: string;
  cause: CauseDef; before: number; allies: number; rivals: number;
  co: Array<{ name: string; factionId: string; agent: string }>;
  statements: readonly XapiStatement[]; registration: string;
}
interface FeedItem { id: number; t: string; text: string; factionId: string; kind: string; mine: boolean }

type Signer = { readonly address: string; signMessage(message: string): Promise<string> };

export class CoachedWorld {
  readonly log: StatementLog;
  readonly operatorAddress: string;
  private readonly pack: WorldPack;
  private readonly rng: () => number;
  private readonly base: string;
  private readonly didHost: string;
  private readonly now: () => string;
  private readonly wallet: Signer;
  private readonly lrs: LrsReader | undefined;
  private readonly actorHomePage: string | undefined;
  private readonly launcher: CourseLauncher | undefined;
  /** The newest published graphs, oldest first, at most MAX_PUBLISHED_GRAPHS. */
  private readonly published: Published[] = [];
  private droppedGraphs = 0;
  /** The current descriptor of each versioned thing. Not history: one entry per territory, pact, faction and agent. */
  private readonly heads = new Map<string, string>();
  private readonly consultants = new Map<string, Consultant>();
  private readonly byOwner = new Map<string, string>();
  private readonly agents = new Map<string, AgentState>();
  private readonly territories: TerritoryState[];
  private readonly bots: BotState[];
  private readonly pacts = new Set<string>();
  private readonly pactVersion = new Map<string, number>();
  private readonly missions = new Map<string, LiveMission>();
  private readonly feed: FeedItem[] = [];
  private minutes: number;
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private agentSerial = 0;

  private constructor(opts: {
    pack: WorldPack; base: string; didHost: string; now: () => string; wallet: Signer;
    log: StatementLog; lrs?: LrsReader; actorHomePage?: string; launcher?: CourseLauncher; seed: number;
  }) {
    this.pack = opts.pack;
    this.base = opts.base.endsWith('/') ? opts.base : `${opts.base}/`;
    this.didHost = opts.didHost;
    this.now = opts.now;
    this.wallet = opts.wallet;
    this.log = opts.log;
    this.lrs = opts.lrs;
    this.actorHomePage = opts.actorHomePage;
    this.launcher = opts.launcher;
    this.rng = mulberry(opts.seed);
    this.operatorAddress = opts.wallet.address;
    this.minutes = opts.pack.season.startMinutes;
    this.territories = opts.pack.territories.map(t => ({ ...t, control: { ...t.control }, version: 1 }));
    this.bots = Array.from({ length: opts.pack.botCount }, (_, i) => {
      const tierRoll = this.rng();
      const tier = tierRoll < 0.5 ? 0 : tierRoll < 0.75 ? 1 : tierRoll < 0.9 ? 2 : Math.min(3, opts.pack.tiers.length - 1);
      const cap = opts.pack.tiers[tier]?.rosterCap ?? 1;
      return {
        id: `bot-${i}`, name: `${pick(opts.pack.givenNames, this.rng)} ${pick(opts.pack.familyNames, this.rng)}`,
        factionId: opts.pack.factions[i % opts.pack.factions.length]?.id ?? opts.pack.factions[0]!.id,
        tier, roi: 0.6 + this.rng() * 2 + tier * 0.3, growth: Math.round(20 + this.rng() * 80), agents: cap,
      };
    });
  }

  static async create(opts: {
    readonly pack: WorldPack; readonly base: string; readonly didHost: string;
    readonly seed?: number; readonly now?: () => string; readonly wallet?: Signer;
    readonly log?: StatementLog; readonly lrs?: LrsReader; readonly actorHomePage?: string; readonly launcher?: CourseLauncher;
  }): Promise<CoachedWorld> {
    const world = new CoachedWorld({
      pack: opts.pack, base: opts.base, didHost: opts.didHost,
      now: opts.now ?? (() => new Date().toISOString()),
      wallet: opts.wallet ?? Wallet.createRandom(),
      log: opts.log ?? new StatementLog(), lrs: opts.lrs, actorHomePage: opts.actorHomePage, launcher: opts.launcher,
      seed: opts.seed ?? hashSeed(opts.pack.id),
    });
    await world.publishOpening();
    return world;
  }

  /** Run mutations one at a time. Snapshotting takes the same turn, so a reader never sees a half-applied mission. */
  exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => fn());
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  get profile(): ProfileDocument { return buildProfile(this.pack); }
  get shownPack(): PublicPack { return publicPack(this.pack); }

  private did(id: string): string { return `did:web:${this.didHost}:agents:${id}`; }
  private factionOrder(): string[] { return this.pack.factions.map(f => f.id); }
  private clock() { return formatClock(this.pack, this.minutes); }
  private factionName(id: string): string { return byId(this.pack.factions, id)?.name ?? id; }
  private pactKey(a: string, b: string): string { return [a, b].sort().join('|'); }
  private allied(a: string, b: string): boolean { return a === b || this.pacts.has(this.pactKey(a, b)); }

  private pushFeed(text: string, factionId: string, kind: string, mine = false): FeedItem {
    this.seq += 1;
    const item: FeedItem = { id: this.seq, t: this.clock().short, text, factionId, kind, mine };
    this.feed.unshift(item);
    if (this.feed.length > 60) this.feed.length = 60;
    return item;
  }

  private async publish(bundle: GraphBundle, kind: string): Promise<void> {
    const signature = await this.wallet.signMessage(bundle.canonical);
    const row: Published = {
      id: bundle.id, kind, version: bundle.data.version ?? 1, turtle: bundle.turtle, graph: bundle.graph,
      canonical: bundle.canonical, signature, ...(bundle.data.supersedes?.[0] ? { supersedes: bundle.data.supersedes[0] } : {}),
    };
    this.published.push(row);
    this.droppedGraphs += trim(this.published, MAX_PUBLISHED_GRAPHS);
    // Only a versioned descriptor has a head. An observation or an intervention is written once.
    const cut = bundle.id.lastIndexOf('/v/');
    if (cut >= 0) this.heads.set(bundle.id.slice(0, cut), bundle.id);
  }

  /** The descriptor that currently stands for this thing, whether or not it is still in the retained list. */
  private head(kind: 'agent' | 'pact' | 'territory', key: string): string | undefined {
    return this.heads.get(`${this.base}descriptors/${kind}/${key}`);
  }

  private async publishOpening(): Promise<void> {
    const at = this.now();
    for (const faction of this.pack.factions) {
      await this.publish(factionGraph({
        pack: this.pack, base: this.base, factionId: faction.id, name: faction.name, at,
        podUrl: `${this.base}factions/${faction.id}/`, did: this.did(`faction-${faction.id}`),
      }), 'faction');
    }
    for (const territory of this.territories) {
      await this.publish(territoryGraph({
        pack: this.pack, base: this.base, territoryId: territory.id, name: territory.name,
        control: territory.control, version: 1, at, writerDid: this.did('world'),
      }), 'territory');
    }
    for (const [a, b] of this.pack.initialPacts) {
      this.pacts.add(this.pactKey(a, b));
      this.pactVersion.set(this.pactKey(a, b), 1);
      await this.publish(pactGraph({ base: this.base, a, b, version: 1, at, writerDid: this.did('world') }), 'pact');
    }
    for (let i = 0; i < this.pack.marketCount; i++) await this.mintMarketAgent();
  }

  private async mintMarketAgent(): Promise<AgentState> {
    const id = `m${this.agentSerial++}`;
    const attached = this.rng() > 0.34;
    const factionId = attached ? pick(this.pack.factions, this.rng).id : undefined;
    const completion = Math.round(55 + this.rng() * 40);
    const agent = await this.putAgent({
      id, name: `${pick(this.pack.agentNames, this.rng)}-${1 + Math.floor(this.rng() * 40)}`,
      role: pick(this.pack.roles, this.rng), factionId, hist: [completion], memory: [],
    });
    return agent;
  }

  private async putAgent(input: {
    id: string; name: string; role: string; factionId?: string; consultantId?: string; controllerDid?: string;
    hist: number[]; memory: Lesson[]; learned?: Set<string>;
  }): Promise<AgentState> {
    const previous = this.agents.get(input.id);
    const version = (previous?.version ?? 0) + 1;
    const agent: AgentState = {
      id: input.id, name: input.name, role: input.role, did: this.did(input.id),
      podUrl: `${this.base}pods/${input.id}/`, hist: input.hist, memory: input.memory, version,
      learned: input.learned ?? previous?.learned ?? new Set<string>(),
      ...(input.factionId ? { factionId: input.factionId } : {}),
      ...(input.consultantId ? { consultantId: input.consultantId } : {}),
      ...(input.controllerDid ? { controllerDid: input.controllerDid } : {}),
    };
    const head = previous ? this.head('agent', input.id) : undefined;
    await this.publish(agentGraph({
      base: this.base, agentId: agent.id, name: agent.name, did: agent.did, podUrl: agent.podUrl,
      controllerDid: agent.controllerDid, version, at: this.now(), lessons: agent.memory,
      ...(head ? { supersedes: head } : {}),
    }), 'agent');
    this.agents.set(agent.id, agent);
    return agent;
  }

  admit(principal: GuestPrincipal): Consultant {
    const existing = this.byOwner.get(principal.ownerDid);
    if (existing) {
      const found = this.consultants.get(existing);
      if (!found) throw new WorldError(500, 'missing-consultant');
      return found;
    }
    if (this.consultants.size >= MAX_CONSULTANTS) throw new WorldError(503, 'world-full');
    const consultant: Consultant = {
      id: `c-${this.consultants.size + 1}`, ownerDid: principal.ownerDid, userId: principal.userId,
      podUrl: principal.podUrl, agentDid: principal.agentDid,
      name: `Guest ${principal.userId.slice(-6)}`, factionId: null, tier: 0,
      influence: this.pack.influence, successes: 0, diagTotal: 0, diagCorrect: 0, roiSum: 0, roiCount: 0, growth: 0,
      roster: [], gate: 'none', runs: 0,
    };
    this.consultants.set(consultant.id, consultant);
    this.byOwner.set(principal.ownerDid, consultant.id);
    return consultant;
  }

  private require(id: string): Consultant {
    const consultant = this.consultants.get(id);
    if (!consultant) throw new WorldError(404, 'unknown-consultant');
    return consultant;
  }

  async joinFaction(consultantId: string, factionId: string): Promise<Consultant> {
    const consultant = this.require(consultantId);
    const faction = byId(this.pack.factions, factionId);
    if (!faction) throw new WorldError(400, 'unknown-faction');
    if (consultant.factionId) throw new WorldError(409, 'already-joined');
    consultant.factionId = factionId;
    const agent = await this.putAgent({
      id: `a${this.agentSerial++}`, name: this.pack.starter.name, role: this.pack.starter.role,
      factionId, consultantId, controllerDid: consultant.ownerDid, hist: [this.pack.starter.baseline], memory: [],
    });
    consultant.roster.push(agent.id);
    this.pushFeed(fill(this.pack.templates.feedJoin, { who: consultant.name, faction: faction.name }), factionId, 'join', true);
    return consultant;
  }

  async startMission(consultantId: string): Promise<Record<string, unknown>> {
    const consultant = this.require(consultantId);
    if (!consultant.factionId) throw new WorldError(409, 'pick-a-faction');
    if (this.missions.has(consultantId)) throw new WorldError(409, 'mission-open');
    const factionId = consultant.factionId;
    const open = this.pack.missions.filter(m => m.minTier <= consultant.tier);
    const pool = consultant.tier >= 1 && consultant.runs % 2 === 1 ? open.filter(m => m.minTier >= 1) : open;
    const mission = pool.length > 0 ? pool[consultant.runs % pool.length] : open[0];
    if (!mission) throw new WorldError(409, 'no-mission');
    const agentId = consultant.roster[consultant.runs % consultant.roster.length];
    const agent = agentId ? this.agents.get(agentId) : undefined;
    if (!agent) throw new WorldError(409, 'no-agent');
    const territory = pick(this.territories, this.rng);
    const cause = drawCause(this.pack, mission, consultant.tier, this.rng);
    const remembered = agent.learned.has(cause.id);
    const before = baseline(this.pack, mission, consultant.tier, remembered, this.rng);
    const { symptoms, herring } = openingSymptoms(this.pack, cause, this.rng);
    const co: LiveMission['co'] = [];
    const sample = Math.min(3, this.bots.length);
    for (let i = 0; i < sample; i++) {
      const bot = pick(this.bots, this.rng);
      co.push({ name: bot.name, factionId: bot.factionId, agent: `${pick(this.pack.agentNames, this.rng)}-${i + 1}` });
    }
    const built = buildMissionStatements({
      pack: this.pack, homePage: this.base, actorDid: agent.did, missionId: mission.id,
      missionTitle: mission.title, missionObject: mission.object, symptoms, herring, progressed: 2,
      measured: undefined, timestamp: this.now(),
    });
    this.log.add(built.statements, 'world');
    const allies = co.filter(c => this.allied(factionId, c.factionId)).length;
    const live: LiveMission = {
      id: built.registration, consultantId, missionId: mission.id, agentId: agent.id, territoryId: territory.id,
      cause, before, allies, rivals: co.length - allies, co, statements: built.statements, registration: built.registration,
    };
    this.missions.set(consultantId, live);
    return this.missionView(live, agent.name, territory.name, mission);
  }

  private missionView(live: LiveMission, agentName: string, territoryName: string, mission: { type: string; title: string; kpi: string }): Record<string, unknown> {
    const factionId = this.require(live.consultantId).factionId ?? '';
    return {
      id: live.id, type: mission.type, title: mission.title, kpi: mission.kpi, before: live.before,
      agent: agentName, territory: territoryName,
      co: live.co.map(c => ({ ...c, ally: this.allied(factionId, c.factionId) })),
      statements: live.statements,
    };
  }

  async intervene(consultantId: string, diagnosisId: string, interventionId: string): Promise<Record<string, unknown>> {
    const consultant = this.require(consultantId);
    const live = this.missions.get(consultantId);
    if (!live || !consultant.factionId) throw new WorldError(409, 'no-mission');
    const mission = byId(this.pack.missions, live.missionId);
    const territory = this.territories.find(t => t.id === live.territoryId);
    const agent = this.agents.get(live.agentId);
    if (!mission || !territory || !agent) throw new WorldError(500, 'mission-broken');
    const intervention = byId(this.pack.interventions, interventionId);
    if (!intervention) throw new WorldError(400, 'unknown-intervention');
    if (consultant.influence < intervention.cost) throw new WorldError(402, 'not-enough-influence');
    const result = settle({
      pack: this.pack, mission, tier: consultant.tier, cause: live.cause, before: live.before,
      diagnosisId, interventionId, allies: live.allies, rivals: live.rivals, factionId: consultant.factionId,
      factionOrder: this.factionOrder(), control: territory.control, rng: this.rng,
    });
    consultant.influence = consultant.influence - intervention.cost + result.gain;
    consultant.successes += result.matched ? 1 : 0;
    consultant.diagTotal += 1;
    consultant.diagCorrect += result.diagnosed ? 1 : 0;
    consultant.roiSum += result.roi;
    consultant.roiCount += 1;
    consultant.growth += Math.max(0, result.delta);
    consultant.runs += 1;
    const tier = this.pack.tiers[consultant.tier];
    if (tier?.gateAfterSuccesses !== undefined && consultant.successes >= tier.gateAfterSuccesses && consultant.gate === 'none' && consultant.tier < this.pack.tiers.length - 1) {
      consultant.gate = 'eligible';
    }
    territory.control = result.control;
    territory.version += 1;
    agent.hist.push(result.after);
    trim(agent.hist, MAX_AGENT_SCORES);
    agent.memory.unshift({ text: result.lesson, causeId: live.cause.id, matched: result.matched });
    if (agent.memory.length > MAX_AGENT_LESSONS) agent.memory.length = MAX_AGENT_LESSONS;
    if (result.matched) agent.learned.add(live.cause.id);
    const at = this.now();
    const measured = buildMissionStatements({
      pack: this.pack, homePage: this.base, actorDid: agent.did, missionId: mission.id,
      missionTitle: mission.title, missionObject: mission.object, symptoms: [], herring: undefined,
      progressed: result.matched ? 2 : 0, measured: { raw: result.after, success: result.matched },
      timestamp: at, registration: live.registration,
    });
    this.log.add(measured.statements, 'world');
    const observation = observationGraph({ base: this.base, registration: live.registration, agentDid: agent.did, at });
    await this.publish(observation, 'observation');
    await this.publish(interventionGraph({
      base: this.base, missionId: live.id, observationId: observation.id, causeId: live.cause.id,
      interventionId: intervention.id, agentDid: agent.did, consultantDid: consultant.ownerDid, at, delta: result.delta,
    }), 'intervention');
    await this.publishTerritory(territory);
    await this.putAgent({ ...agent, controllerDid: agent.controllerDid, consultantId: agent.consultantId, factionId: agent.factionId });
    const sign = result.delta >= 0 ? `+${result.delta}` : String(result.delta);
    this.pushFeed(fill(this.pack.templates.feedIntervene, {
      who: consultant.name, intervention: intervention.label, agent: agent.name, territory: territory.name, delta: sign, kpi: mission.kpi,
    }), consultant.factionId, 'intervene', true);
    if (result.flippedTo) {
      this.pushFeed(fill(this.pack.templates.feedFlip, {
        faction: this.factionName(result.flippedTo), territory: territory.name, previous: '',
      }), result.flippedTo, 'flip', true);
    }
    this.missions.delete(consultantId);
    return {
      matched: result.matched, diagnosed: result.diagnosed, before: result.before, after: result.after,
      delta: result.delta, roi: result.roi, gain: result.gain, flipped: Boolean(result.flippedTo),
      cause: { id: live.cause.id, label: live.cause.label }, lesson: result.lesson,
      statements: measured.statements, influence: consultant.influence, gate: consultant.gate,
    };
  }

  async transfer(consultantId: string, agentId: string): Promise<Record<string, unknown>> {
    const consultant = this.require(consultantId);
    if (!consultant.factionId) throw new WorldError(409, 'pick-a-faction');
    const cap = this.pack.tiers[consultant.tier]?.rosterCap ?? 1;
    if (consultant.roster.length >= cap) throw new WorldError(409, 'roster-full');
    const agent = this.agents.get(agentId);
    if (!agent || agent.consultantId) throw new WorldError(404, 'not-on-market');
    const poach = Boolean(agent.factionId && agent.factionId !== consultant.factionId);
    const completion = agent.hist.at(-1) ?? 0;
    const price = Math.round((this.pack.scoring.marketPriceBase + completion * this.pack.scoring.marketPricePerPoint) * (poach ? this.pack.scoring.poachPriceMultiplier : 1));
    if (consultant.influence < price) throw new WorldError(402, 'not-enough-influence');
    const broke = poach && agent.factionId ? this.pacts.delete(this.pactKey(consultant.factionId, agent.factionId)) : false;
    if (broke && agent.factionId) await this.writePact(consultant.factionId, agent.factionId, true);
    consultant.influence -= price;
    const from = agent.factionId;
    agent.consultantId = consultant.id;
    agent.controllerDid = consultant.ownerDid;
    agent.factionId = consultant.factionId;
    consultant.roster.push(agent.id);
    await this.putAgent({ ...agent, factionId: agent.factionId, consultantId: agent.consultantId, controllerDid: agent.controllerDid });
    const text = poach && from
      ? fill(this.pack.templates.feedPoach, { who: consultant.name, agent: agent.name, faction: this.factionName(from) })
      : fill(this.pack.templates.feedTransfer, { who: consultant.name, agent: agent.name });
    this.pushFeed(text, consultant.factionId, poach ? 'poach' : 'recruit', true);
    return { agent: agent.name, price, broke, influence: consultant.influence };
  }

  async proposePact(consultantId: string, factionId: string): Promise<Record<string, unknown>> {
    const consultant = this.require(consultantId);
    if (!consultant.factionId) throw new WorldError(409, 'pick-a-faction');
    if (factionId === consultant.factionId || !byId(this.pack.factions, factionId)) throw new WorldError(400, 'unknown-faction');
    if (this.pacts.has(this.pactKey(consultant.factionId, factionId))) throw new WorldError(409, 'pact-exists');
    if (consultant.influence < this.pack.pactProposalCost) throw new WorldError(402, 'not-enough-influence');
    consultant.influence -= this.pack.pactProposalCost;
    const accepted = this.rng() < this.pack.scoring.pactAccept;
    if (accepted) {
      this.pacts.add(this.pactKey(consultant.factionId, factionId));
      await this.writePact(consultant.factionId, factionId, false);
      this.pushFeed(fill(this.pack.templates.feedPact, { a: this.factionName(consultant.factionId), b: this.factionName(factionId) }), consultant.factionId, 'pact', true);
    }
    return { accepted, influence: consultant.influence };
  }

  async dissolvePact(consultantId: string, factionId: string): Promise<Record<string, unknown>> {
    const consultant = this.require(consultantId);
    if (!consultant.factionId) throw new WorldError(409, 'pick-a-faction');
    const key = this.pactKey(consultant.factionId, factionId);
    if (!this.pacts.delete(key)) throw new WorldError(404, 'no-pact');
    await this.writePact(consultant.factionId, factionId, true);
    this.pushFeed(fill(this.pack.templates.feedDissolve, { a: this.factionName(consultant.factionId), b: this.factionName(factionId) }), consultant.factionId, 'pact', true);
    return { dissolved: true };
  }

  private async writePact(a: string, b: string, ended: boolean): Promise<void> {
    const key = this.pactKey(a, b);
    const version = (this.pactVersion.get(key) ?? 0) + 1;
    this.pactVersion.set(key, version);
    const head = this.head('pact', [a, b].sort().join('--'));
    await this.publish(pactGraph({
      base: this.base, a, b, version, at: this.now(), writerDid: this.did('world'), ended,
      ...(head ? { supersedes: head } : {}),
    }), 'pact');
  }

  async tick(): Promise<FeedItem> {
    this.minutes += this.pack.season.tickMinutes;
    const bot = pick(this.bots, this.rng);
    bot.roi = Math.max(0.2, bot.roi + (this.rng() - 0.45) * 0.12);
    bot.growth += Math.round(this.rng() * 6);
    const open = this.pack.missions.filter(m => m.minTier <= bot.tier);
    const mission = open.length > 0 ? pick(open, this.rng) : undefined;
    if (!mission) return this.pushFeed(fill(this.pack.templates.feedJoin, { who: bot.name, faction: this.factionName(bot.factionId) }), bot.factionId, 'bot');
    const territory = pick(this.territories, this.rng);
    const cause = drawCause(this.pack, mission, bot.tier, this.rng);
    const before = baseline(this.pack, mission, bot.tier, false, this.rng);
    const matching = this.pack.interventions.find(i => i.addresses === cause.id && i.minTier <= bot.tier);
    const others = this.pack.interventions.filter(i => i.addresses !== cause.id && i.minTier <= bot.tier);
    const intervention = matching && (others.length === 0 || this.rng() < this.pack.scoring.botAccuracy) ? matching : (others[0] ?? matching);
    if (!intervention) throw new WorldError(409, 'no-intervention');
    const result = settle({
      pack: this.pack, mission, tier: bot.tier, cause, before, diagnosisId: cause.id, interventionId: intervention.id,
      allies: 0, rivals: 0, factionId: bot.factionId, factionOrder: this.factionOrder(), control: territory.control, rng: this.rng,
    });
    territory.control = result.control;
    territory.version += 1;
    await this.publishTerritory(territory);
    const actor = this.did(bot.id);
    const built = buildMissionStatements({
      pack: this.pack, homePage: this.base, actorDid: actor, missionId: mission.id, missionTitle: mission.title,
      missionObject: mission.object, symptoms: [], herring: undefined, progressed: 0,
      measured: { raw: result.after, success: result.matched }, timestamp: this.now(),
    });
    this.log.add(built.statements, 'world');
    const sign = result.delta >= 0 ? `+${result.delta}` : String(result.delta);
    const item = this.pushFeed(fill(this.pack.templates.feedIntervene, {
      who: bot.name, intervention: intervention.label, agent: this.did(bot.id).split(':').at(-1) ?? bot.id,
      territory: territory.name, delta: sign, kpi: mission.kpi,
    }), bot.factionId, 'intervene');
    if (result.flippedTo) {
      this.pushFeed(fill(this.pack.templates.feedFlip, { faction: this.factionName(result.flippedTo), territory: territory.name, previous: '' }), result.flippedTo, 'flip');
    }
    return item;
  }

  recordExternal(statements: readonly XapiStatement[]): void {
    this.log.add(statements, 'external');
  }

  /** Ask Foxxi to launch this tier's course for this consultant's DID. No second guest is minted. */
  async launchGate(consultantId: string): Promise<CourseLaunchResult> {
    const consultant = this.require(consultantId);
    const course = this.pack.tiers[consultant.tier]?.courseIri;
    if (!course) throw new WorldError(409, 'no-gate', 'this tier has no course');
    if (!consultant.factionId) throw new WorldError(409, 'pick-a-faction');
    if (!this.launcher) throw new WorldError(503, 'course-launch-unconfigured');
    try {
      return await this.launcher.launch({ learnerDid: consultant.ownerDid, courseId: course, returnUrl: this.base });
    } catch {
      throw new WorldError(502, 'course-launch-failed');
    }
  }

  async refreshGate(consultantId: string): Promise<Record<string, unknown>> {
    const consultant = this.require(consultantId);
    const tier = this.pack.tiers[consultant.tier];
    const course = tier?.courseIri;
    if (!course) throw new WorldError(409, 'no-gate', 'this tier has no course');
    if (consultant.gate !== 'eligible') throw new WorldError(409, 'gate-not-open');
    const homePage = this.actorHomePage ?? this.base;
    let lrs: 'unconfigured' | 'ok' | 'unreachable' | 'actor-home-unset' = 'unconfigured';
    if (this.lrs && this.actorHomePage) {
      try {
        const remote = await this.lrs.fetchActor(consultant.ownerDid, this.actorHomePage, { verb: SATISFIED, activity: course });
        const fresh = remote.filter(statement => !this.log.has(statement.id));
        this.log.add(fresh, 'external');
        lrs = 'ok';
      } catch {
        lrs = 'unreachable';
        return { promoted: false, lrs, satisfied: false, courseIri: course, gate: consultant.gate };
      }
    } else if (this.lrs) {
      lrs = 'actor-home-unset';
      return { promoted: false, lrs, satisfied: false, courseIri: course, gate: consultant.gate };
    }
    const satisfied = this.log.sawExternal({ name: consultant.ownerDid, homePage }, course, SATISFIED);
    if (!satisfied) {
      return { promoted: false, lrs, satisfied, courseIri: course, gate: consultant.gate };
    }
    await this.promote(consultant);
    return { promoted: true, lrs, satisfied, courseIri: course, tier: consultant.tier, gate: consultant.gate };
  }

  private async publishTerritory(territory: TerritoryState): Promise<void> {
    const head = this.head('territory', territory.id);
    await this.publish(territoryGraph({
      pack: this.pack, base: this.base, territoryId: territory.id, name: territory.name, control: territory.control,
      version: territory.version, at: this.now(), writerDid: this.did('world'), ...(head ? { supersedes: head } : {}),
    }), 'territory');
  }

  private async promote(consultant: Consultant): Promise<void> {
    const next = consultant.tier + 1;
    const tier = this.pack.tiers[next];
    if (!tier || !consultant.factionId) throw new WorldError(409, 'no-gate');
    consultant.tier = next;
    consultant.gate = 'none';
    consultant.influence += this.pack.scoring.promoteInfluence;
    // One seat stays open so a transfer can still land. The starter already occupies a seat.
    const seats = Math.max(consultant.roster.length, tier.rosterCap - 1);
    while (consultant.roster.length < seats && consultant.roster.length < tier.rosterCap) {
      const agent = await this.putAgent({
        id: `a${this.agentSerial++}`, name: `${pick(this.pack.agentNames, this.rng)}-${consultant.roster.length + 1}`,
        role: pick(this.pack.roles, this.rng), factionId: consultant.factionId, consultantId: consultant.id,
        controllerDid: consultant.ownerDid, hist: [this.pack.starter.baseline], memory: [],
      });
      consultant.roster.push(agent.id);
    }
    this.pushFeed(fill(this.pack.templates.feedPromote, { who: consultant.name, tier: tier.label }), consultant.factionId, 'promote', true);
  }

  view(consultantId?: string): Record<string, unknown> {
    const you = consultantId ? this.consultants.get(consultantId) : undefined;
    const order = this.factionOrder();
    const clock = this.clock();
    const rows = this.leaderboard(you);
    return {
      pack: this.shownPack,
      clock, minutes: this.minutes, operator: this.operatorAddress,
      territories: this.territories.map(t => ({
        id: t.id, name: t.name, q: t.q, r: t.r, control: t.control, heldBy: holderOf(t.control, order),
      })),
      pacts: [...this.pacts],
      feed: this.feed.slice(0, 24),
      standings: order.map(id => {
        const bots = this.bots.filter(b => b.factionId === id);
        const humans = [...this.consultants.values()].filter(c => c.factionId === id);
        const terr = this.territories.filter(t => holderOf(t.control, order) === id).length;
        const agents = bots.reduce((sum, b) => sum + b.agents, 0) + humans.reduce((sum, c) => sum + c.roster.length, 0);
        const roi = bots.length ? bots.reduce((sum, b) => sum + b.roi, 0) / bots.length : 0;
        return { id, name: this.factionName(id), territories: terr, consultants: bots.length + humans.length, agents, roi };
      }).sort((a, b) => b.territories - a.territories || b.roi - a.roi),
      leaderboard: rows.slice(0, 10),
      market: [...this.agents.values()].filter(a => !a.consultantId).map(a => ({
        id: a.id, name: a.name, role: a.role, factionId: a.factionId ?? null,
        statements: a.hist.length, completion: a.hist.at(-1) ?? 0,
        price: Math.round(this.pack.scoring.marketPriceBase + (a.hist.at(-1) ?? 0) * this.pack.scoring.marketPricePerPoint),
      })),
      online: this.bots.length + this.consultants.size,
      ...(you ? { you: this.you(you, rows) } : {}),
    };
  }

  private score(roi: number, growth: number): number {
    return roi * this.pack.scoring.rankRoiWeight + growth;
  }

  private leaderboard(you: Consultant | undefined): Array<{ name: string; factionId: string; tier: number; roi: number; growth: number; you: boolean }> {
    const rows = this.bots.map(b => ({ name: b.name, factionId: b.factionId, tier: b.tier, roi: b.roi, growth: b.growth, you: false }));
    for (const consultant of this.consultants.values()) {
      if (!consultant.factionId) continue;
      const roi = consultant.roiCount ? consultant.roiSum / consultant.roiCount : 0;
      rows.push({ name: consultant.name, factionId: consultant.factionId, tier: consultant.tier, roi, growth: consultant.growth, you: consultant.id === you?.id });
    }
    return rows.sort((a, b) => this.score(b.roi, b.growth) - this.score(a.roi, a.growth));
  }

  private you(consultant: Consultant, rows: Array<{ you: boolean }>): Record<string, unknown> {
    const rank = rows.findIndex(row => row.you) + 1;
    const tier = this.pack.tiers[consultant.tier];
    const live = this.missions.get(consultant.id);
    const mission = live ? byId(this.pack.missions, live.missionId) : undefined;
    const territory = live ? this.territories.find(t => t.id === live.territoryId) : undefined;
    const agent = live ? this.agents.get(live.agentId) : undefined;
    return {
      id: consultant.id, name: consultant.name, ownerDid: consultant.ownerDid, factionId: consultant.factionId,
      tier: consultant.tier, tierLabel: tier?.label, influence: consultant.influence, successes: consultant.successes,
      diagTotal: consultant.diagTotal, diagCorrect: consultant.diagCorrect, growth: consultant.growth,
      gate: consultant.gate, rank, rosterCap: tier?.rosterCap,
      courseIri: tier?.courseIri ?? null, gateAfter: tier?.gateAfterSuccesses ?? null,
      roster: consultant.roster.map(id => this.agents.get(id)).filter((a): a is AgentState => a !== undefined).map(a => ({
        id: a.id, name: a.name, role: a.role, did: a.did, podUrl: a.podUrl, hist: a.hist, memory: a.memory,
      })),
      ...(live && mission && territory && agent ? { mission: this.missionView(live, agent.name, territory.name, mission) } : {}),
    };
  }

  /** The graphs still retained, oldest first. `graphStats` says how many older ones were dropped. */
  graphs(): readonly Published[] { return this.published; }
  graphStats(): { readonly retained: number; readonly dropped: number } {
    return { retained: this.published.length, dropped: this.droppedGraphs };
  }
  get consultantCount(): number { return this.consultants.size; }
}
