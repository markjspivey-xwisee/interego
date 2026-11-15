/**
 * A world pack is the whole policy of one world: factions, causes, interventions,
 * missions, tiers, scoring, and the sentences the feed uses. The engine reads it
 * and contains none of those choices.
 */
import { readFileSync } from 'node:fs';
import { PackError } from './errors.js';
import { hashSeed, mulberry } from './rng.js';

export const CPW = 'https://markjspivey-xwisee.github.io/interego/applications/coached-world/cpw#';

/** cmi5 result verbs. A pack may not name them: the world never emits them. */
export const GATE_VERBS = [
  'http://adlnet.gov/expapi/verbs/passed',
  'http://adlnet.gov/expapi/verbs/completed',
  'http://adlnet.gov/expapi/verbs/failed',
  'http://adlnet.gov/expapi/verbs/waived',
  'http://adlnet.gov/expapi/verbs/satisfied',
] as const;

const GATE_NAMES = new Set(['passed', 'completed', 'failed', 'waived', 'satisfied']);

export interface Symptom { readonly verb: string; readonly result: string; readonly tone: 'bad' | 'meh' }
export interface CauseDef {
  readonly id: string; readonly label: string; readonly bem: string;
  readonly minTier: number; readonly allyLift: number; readonly symptoms: readonly Symptom[];
}
export interface InterventionDef {
  readonly id: string; readonly label: string; readonly addresses: string;
  readonly cost: number; readonly minTier: number; readonly composes: string;
}
export interface MissionDef {
  readonly id: string; readonly type: string; readonly title: string; readonly object: string;
  readonly kpi: string; readonly base: number; readonly minTier: number;
  readonly weights: Readonly<Record<string, number>>;
}
export interface TierDef {
  readonly id: string; readonly label: string; readonly rosterCap: number;
  readonly gateAfterSuccesses?: number; readonly courseIri?: string;
}
export interface FactionDef { readonly id: string; readonly name: string; readonly motto: string; readonly doctrine: string }
export interface TerritoryDef {
  readonly id: string; readonly name: string; readonly q: number; readonly r: number;
  readonly control: Readonly<Record<string, number>>;
}
export interface Scoring {
  readonly matchLiftBase: number; readonly matchLiftSpan: number; readonly memoryBaselineLift: number;
  readonly tierBaseline: number; readonly baselineJitter: number; readonly scoreFloor: number; readonly scoreCeil: number;
  readonly roiScale: number; readonly gainScale: number; readonly matchGainBonus: number;
  readonly rivalBlunt: number; readonly territoryScale: number;
  readonly rankRoiWeight: number; readonly poachPriceMultiplier: number; readonly promoteInfluence: number;
  readonly botAccuracy: number; readonly marketPriceBase: number; readonly marketPricePerPoint: number;
  readonly pactAccept: number;
}
export interface Templates {
  readonly lessonMatched: string; readonly lessonMissed: string; readonly feedIntervene: string;
  readonly feedJoin: string; readonly feedFlip: string; readonly feedPact: string; readonly feedDissolve: string;
  readonly feedTransfer: string; readonly feedPoach: string; readonly feedPromote: string;
}
export interface WorldPack {
  readonly id: string; readonly title: string; readonly tagline: string; readonly profileId: string;
  readonly verbs: { readonly initialized: string; readonly observed: string; readonly progressed: string; readonly measured: string };
  readonly season: { readonly name: string; readonly startDay: number; readonly lengthDays: number; readonly startMinutes: number; readonly tickMinutes: number };
  readonly factions: readonly FactionDef[];
  readonly territories: readonly TerritoryDef[];
  readonly causes: readonly CauseDef[];
  readonly interventions: readonly InterventionDef[];
  readonly missions: readonly MissionDef[];
  readonly tiers: readonly TierDef[];
  readonly roles: readonly string[];
  readonly agentNames: readonly string[];
  readonly givenNames: readonly string[];
  readonly familyNames: readonly string[];
  readonly starter: { readonly name: string; readonly role: string; readonly baseline: number };
  readonly influence: number;
  readonly botCount: number;
  readonly marketCount: number;
  readonly pactProposalCost: number;
  readonly initialPacts: readonly (readonly [string, string])[];
  readonly scoring: Scoring;
  readonly templates: Templates;
}

export interface PublicPack {
  readonly id: string; readonly title: string; readonly tagline: string; readonly profileId: string;
  readonly factions: readonly FactionDef[];
  readonly causes: ReadonlyArray<Pick<CauseDef, 'id' | 'label' | 'bem' | 'minTier'>>;
  readonly interventions: ReadonlyArray<Pick<InterventionDef, 'id' | 'label' | 'cost' | 'minTier' | 'composes'>>;
  readonly tiers: readonly TierDef[];
  readonly season: { readonly name: string; readonly lengthDays: number };
  readonly pactProposalCost: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, path: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new PackError(`${path} must be a non-empty string`);
  return v;
};
const num = (v: unknown, path: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new PackError(`${path} must be a finite number`);
  return v;
};
const int = (v: unknown, path: string): number => {
  const n = num(v, path);
  if (!Number.isInteger(n) || n < 0) throw new PackError(`${path} must be a non-negative integer`);
  return n;
};
const arr = (v: unknown, path: string): unknown[] => {
  if (!Array.isArray(v) || v.length === 0) throw new PackError(`${path} must be a non-empty array`);
  return v;
};

function toneOf(value: unknown, path: string): 'bad' | 'meh' {
  if (value === 'bad' || value === 'meh') return value;
  throw new PackError(`${path} must be bad or meh`);
}

function slug(v: unknown, path: string): string {
  const s = str(v, path);
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(s)) throw new PackError(`${path} must be a lowercase slug`);
  return s;
}

function unique(ids: readonly string[], path: string): void {
  if (new Set(ids).size !== ids.length) throw new PackError(`${path} has a duplicate id`);
}

/** Axial disk of hexes, radius inclusive. Generic; a pack chooses the radius. */
export function axialDisk(radius: number): Array<{ q: number; r: number }> {
  const out: Array<{ q: number; r: number }> = [];
  for (let q = -radius; q <= radius; q++) {
    const lo = Math.max(-radius, -q - radius);
    const hi = Math.min(radius, -q + radius);
    for (let r = lo; r <= hi; r++) out.push({ q, r });
  }
  return out;
}

function verbIri(profileId: string, name: string): string {
  return `${profileId}/verbs/${name}`;
}

function checkVerbs(profileId: string, verbs: WorldPack['verbs']): void {
  for (const name of Object.values(verbs)) {
    if (GATE_NAMES.has(name) || (GATE_VERBS as readonly string[]).includes(verbIri(profileId, name))) {
      throw new PackError(`verb "${name}" is a cmi5 result verb; the world does not emit passed, completed, failed, waived or satisfied`);
    }
  }
}

/**
 * Read a pack document. Territories may be listed, or generated from `hexRadius`,
 * `territoryNames` and `homeBias` (a sector bonus, not a faction named in code).
 */
export function loadPack(raw: unknown): WorldPack {
  if (!isObj(raw)) throw new PackError('pack must be an object');
  const id = str(raw['id'], 'id');
  if (!/^https?:\/\//.test(id)) throw new PackError('id must be an IRI');
  const profileId = str(raw['profileId'], 'profileId').replace(/\/$/, '');
  const verbRaw = isObj(raw['verbs']) ? raw['verbs'] : {};
  const verbs = {
    initialized: slug(verbRaw['initialized'], 'verbs.initialized'),
    observed: slug(verbRaw['observed'], 'verbs.observed'),
    progressed: slug(verbRaw['progressed'], 'verbs.progressed'),
    measured: slug(verbRaw['measured'], 'verbs.measured'),
  };
  checkVerbs(profileId, verbs);
  const seasonRaw = isObj(raw['season']) ? raw['season'] : {};
  const season = {
    name: str(seasonRaw['name'], 'season.name'),
    startDay: int(seasonRaw['startDay'], 'season.startDay'),
    lengthDays: int(seasonRaw['lengthDays'], 'season.lengthDays'),
    startMinutes: int(seasonRaw['startMinutes'], 'season.startMinutes'),
    tickMinutes: int(seasonRaw['tickMinutes'], 'season.tickMinutes'),
  };
  if (season.lengthDays < 1 || season.tickMinutes < 1) throw new PackError('season length and tick must be positive');

  const factions = arr(raw['factions'], 'factions').map((f, i) => {
    if (!isObj(f)) throw new PackError(`factions[${i}] must be an object`);
    return { id: slug(f['id'], `factions[${i}].id`), name: str(f['name'], `factions[${i}].name`), motto: str(f['motto'], `factions[${i}].motto`), doctrine: str(f['doctrine'], `factions[${i}].doctrine`) };
  });
  if (factions.length < 2) throw new PackError('a world needs at least two factions');
  unique(factions.map(f => f.id), 'factions');
  const factionIds = new Set(factions.map(f => f.id));

  const causes = arr(raw['causes'], 'causes').map((c, i) => {
    if (!isObj(c)) throw new PackError(`causes[${i}] must be an object`);
    const symptoms = arr(c['symptoms'], `causes[${i}].symptoms`).map((s, j) => {
      if (!isObj(s)) throw new PackError(`causes[${i}].symptoms[${j}] must be an object`);
      return { verb: str(s['verb'], `symptom.verb`), result: str(s['result'], `symptom.result`), tone: toneOf(s['tone'], `causes[${i}].symptoms[${j}].tone`) };
    });
    return {
      id: slug(c['id'], `causes[${i}].id`), label: str(c['label'], `causes[${i}].label`),
      bem: str(c['bem'], `causes[${i}].bem`), minTier: int(c['minTier'], `causes[${i}].minTier`),
      allyLift: num(c['allyLift'], `causes[${i}].allyLift`), symptoms,
    };
  });
  unique(causes.map(c => c.id), 'causes');
  const causeIds = new Set(causes.map(c => c.id));

  const interventions = arr(raw['interventions'], 'interventions').map((item, i) => {
    if (!isObj(item)) throw new PackError(`interventions[${i}] must be an object`);
    const addresses = slug(item['addresses'], `interventions[${i}].addresses`);
    if (!causeIds.has(addresses)) throw new PackError(`interventions[${i}] addresses an unknown cause`);
    return {
      id: slug(item['id'], `interventions[${i}].id`), label: str(item['label'], `interventions[${i}].label`),
      addresses, cost: int(item['cost'], `interventions[${i}].cost`), minTier: int(item['minTier'], `interventions[${i}].minTier`),
      composes: str(item['composes'], `interventions[${i}].composes`),
    };
  });
  unique(interventions.map(item => item.id), 'interventions');

  const missions = arr(raw['missions'], 'missions').map((m, i) => {
    if (!isObj(m)) throw new PackError(`missions[${i}] must be an object`);
    const weightsRaw = isObj(m['weights']) ? m['weights'] : {};
    const weights: Record<string, number> = {};
    for (const [key, value] of Object.entries(weightsRaw)) {
      if (!causeIds.has(key)) throw new PackError(`missions[${i}] weights an unknown cause`);
      const w = num(value, `missions[${i}].weights.${key}`);
      if (w <= 0) throw new PackError(`missions[${i}].weights.${key} must be positive`);
      weights[key] = w;
    }
    if (Object.keys(weights).length === 0) throw new PackError(`missions[${i}] needs a cause weight`);
    return {
      id: slug(m['id'], `missions[${i}].id`), type: str(m['type'], `missions[${i}].type`),
      title: str(m['title'], `missions[${i}].title`), object: str(m['object'], `missions[${i}].object`),
      kpi: str(m['kpi'], `missions[${i}].kpi`), base: num(m['base'], `missions[${i}].base`),
      minTier: int(m['minTier'], `missions[${i}].minTier`), weights,
    };
  });
  unique(missions.map(m => m.id), 'missions');

  const tiers = arr(raw['tiers'], 'tiers').map((t, i) => {
    if (!isObj(t)) throw new PackError(`tiers[${i}] must be an object`);
    const gate = t['gateAfterSuccesses'];
    const course = t['courseIri'];
    if (gate !== undefined && course === undefined) throw new PackError(`tiers[${i}] names a gate with no course IRI`);
    if (course !== undefined && (typeof course !== 'string' || !/^https?:\/\//.test(course))) throw new PackError(`tiers[${i}].courseIri must be an IRI`);
    return {
      id: slug(t['id'], `tiers[${i}].id`), label: str(t['label'], `tiers[${i}].label`),
      rosterCap: int(t['rosterCap'], `tiers[${i}].rosterCap`) || (() => { throw new PackError('roster cap'); })(),
      ...(gate !== undefined ? { gateAfterSuccesses: int(gate, `tiers[${i}].gateAfterSuccesses`) } : {}),
      ...(typeof course === 'string' ? { courseIri: course } : {}),
    };
  });
  if (tiers.some(t => t.rosterCap < 1)) throw new PackError('roster cap must be at least 1');
  unique(tiers.map(t => t.id), 'tiers');

  const scoringRaw = isObj(raw['scoring']) ? raw['scoring'] : {};
  const scoringKey = (k: string) => num(scoringRaw[k], `scoring.${k}`);
  const scoring: Scoring = {
    matchLiftBase: scoringKey('matchLiftBase'), matchLiftSpan: scoringKey('matchLiftSpan'),
    memoryBaselineLift: scoringKey('memoryBaselineLift'), tierBaseline: scoringKey('tierBaseline'),
    baselineJitter: scoringKey('baselineJitter'), scoreFloor: scoringKey('scoreFloor'), scoreCeil: scoringKey('scoreCeil'),
    roiScale: scoringKey('roiScale'), gainScale: scoringKey('gainScale'), matchGainBonus: scoringKey('matchGainBonus'),
    rivalBlunt: scoringKey('rivalBlunt'),
    territoryScale: scoringKey('territoryScale'), rankRoiWeight: scoringKey('rankRoiWeight'),
    poachPriceMultiplier: scoringKey('poachPriceMultiplier'), promoteInfluence: scoringKey('promoteInfluence'),
    botAccuracy: scoringKey('botAccuracy'), marketPriceBase: scoringKey('marketPriceBase'),
    marketPricePerPoint: scoringKey('marketPricePerPoint'), pactAccept: scoringKey('pactAccept'),
  };
  if (scoring.scoreCeil <= scoring.scoreFloor) throw new PackError('scoreCeil must exceed scoreFloor');
  if (scoring.botAccuracy < 0 || scoring.botAccuracy > 1 || scoring.pactAccept < 0 || scoring.pactAccept > 1) {
    throw new PackError('botAccuracy and pactAccept are fractions from 0 to 1');
  }

  const templateRaw = isObj(raw['templates']) ? raw['templates'] : {};
  const templates = {
    lessonMatched: str(templateRaw['lessonMatched'], 'templates.lessonMatched'),
    lessonMissed: str(templateRaw['lessonMissed'], 'templates.lessonMissed'),
    feedIntervene: str(templateRaw['feedIntervene'], 'templates.feedIntervene'),
    feedJoin: str(templateRaw['feedJoin'], 'templates.feedJoin'),
    feedFlip: str(templateRaw['feedFlip'], 'templates.feedFlip'),
    feedPact: str(templateRaw['feedPact'], 'templates.feedPact'),
    feedDissolve: str(templateRaw['feedDissolve'], 'templates.feedDissolve'),
    feedTransfer: str(templateRaw['feedTransfer'], 'templates.feedTransfer'),
    feedPoach: str(templateRaw['feedPoach'], 'templates.feedPoach'),
    feedPromote: str(templateRaw['feedPromote'], 'templates.feedPromote'),
  };

  const roles = arr(raw['roles'], 'roles').map((r, i) => str(r, `roles[${i}]`));
  const agentNames = arr(raw['agentNames'], 'agentNames').map((r, i) => str(r, `agentNames[${i}]`));
  const givenNames = arr(raw['givenNames'], 'givenNames').map((r, i) => str(r, `givenNames[${i}]`));
  const familyNames = arr(raw['familyNames'], 'familyNames').map((r, i) => str(r, `familyNames[${i}]`));
  const starterRaw = isObj(raw['starter']) ? raw['starter'] : {};
  const starter = { name: str(starterRaw['name'], 'starter.name'), role: str(starterRaw['role'], 'starter.role'), baseline: num(starterRaw['baseline'], 'starter.baseline') };

  const territories = territoriesOf(raw, factions, id);
  for (const t of territories) {
    for (const key of Object.keys(t.control)) if (!factionIds.has(key)) throw new PackError(`territory ${t.id} names an unknown faction`);
  }

  return {
    id, title: str(raw['title'], 'title'), tagline: str(raw['tagline'], 'tagline'), profileId, verbs, season,
    factions, territories, causes, interventions, missions, tiers, roles, agentNames, givenNames, familyNames,
    starter, influence: int(raw['influence'], 'influence'), botCount: int(raw['botCount'], 'botCount'),
    marketCount: int(raw['marketCount'], 'marketCount'), pactProposalCost: int(raw['pactProposalCost'], 'pactProposalCost'),
    initialPacts: pactsOf(raw, factionIds),
    scoring, templates,
  };
}

function pactsOf(raw: Record<string, unknown>, factionIds: ReadonlySet<string>): Array<[string, string]> {
  if (raw['initialPacts'] === undefined) return [];
  if (!Array.isArray(raw['initialPacts'])) throw new PackError('initialPacts must be an array');
  return raw['initialPacts'].map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new PackError(`initialPacts[${i}] must be a pair`);
    const a = slug(pair[0], `initialPacts[${i}][0]`);
    const b = slug(pair[1], `initialPacts[${i}][1]`);
    if (a === b || !factionIds.has(a) || !factionIds.has(b)) throw new PackError(`initialPacts[${i}] must name two factions`);
    return [a, b] as [string, string];
  });
}

function territoriesOf(raw: Record<string, unknown>, factions: readonly FactionDef[], packId: string): TerritoryDef[] {
  if (Array.isArray(raw['territories'])) {
    return raw['territories'].map((t, i) => {
      if (!isObj(t)) throw new PackError(`territories[${i}] must be an object`);
      const controlRaw = isObj(t['control']) ? t['control'] : {};
      const control: Record<string, number> = {};
      for (const [key, value] of Object.entries(controlRaw)) control[key] = num(value, `territories[${i}].control.${key}`);
      return {
        id: slug(t['id'], `territories[${i}].id`), name: str(t['name'], `territories[${i}].name`),
        q: num(t['q'], `territories[${i}].q`), r: num(t['r'], `territories[${i}].r`), control: normalise(control),
      };
    });
  }
  const radius = int(raw['hexRadius'], 'hexRadius');
  const names = arr(raw['territoryNames'], 'territoryNames').map((n, i) => str(n, `territoryNames[${i}]`));
  const centerName = typeof raw['centerName'] === 'string' ? raw['centerName'] : undefined;
  const homeBias = num(raw['homeBias'], 'homeBias');
  const disk = axialDisk(radius);
  const rng = mulberry(hashSeed(packId));
  return disk.map((cell, i) => {
    const control: Record<string, number> = {};
    for (const f of factions) control[f.id] = 8 + rng() * 10;
    if (!(cell.q === 0 && cell.r === 0)) {
      const x = Math.sqrt(3) * (cell.q + cell.r / 2);
      const y = 1.5 * cell.r;
      const sector = Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * factions.length) % factions.length;
      const home = factions[sector];
      if (!home) throw new PackError('faction sector');
      control[home.id] = (control[home.id] ?? 0) + homeBias + rng() * homeBias;
    }
    const name = cell.q === 0 && cell.r === 0 && centerName ? centerName : (names[i % names.length] ?? `territory-${i}`);
    return { id: `t${i}`, name, q: cell.q, r: cell.r, control: normalise(control) };
  });
}

export function normalise(control: Readonly<Record<string, number>>): Record<string, number> {
  const keys = Object.keys(control);
  const sum = keys.reduce((a, k) => a + Math.max(0, control[k] ?? 0), 0) || 1;
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = Math.round(((Math.max(0, control[k] ?? 0) * 100) / sum) * 100) / 100;
  return out;
}

export function holderOf(control: Readonly<Record<string, number>>, order: readonly string[]): string {
  let best = order[0];
  if (best === undefined) throw new PackError('no factions');
  for (const id of order) if ((control[id] ?? 0) > (control[best] ?? 0)) best = id;
  return best;
}

export function loadPackFile(path: string): WorldPack {
  return loadPack(JSON.parse(readFileSync(path, 'utf8')));
}

/** What a browser may see. Cause weights, symptom catalogues and which intervention addresses which cause stay on the server. */
export function publicPack(pack: WorldPack): PublicPack {
  return {
    id: pack.id, title: pack.title, tagline: pack.tagline, profileId: pack.profileId,
    factions: pack.factions,
    causes: pack.causes.map(c => ({ id: c.id, label: c.label, bem: c.bem, minTier: c.minTier })),
    interventions: pack.interventions.map(i => ({ id: i.id, label: i.label, cost: i.cost, minTier: i.minTier, composes: i.composes })),
    tiers: pack.tiers,
    season: { name: pack.season.name, lengthDays: pack.season.lengthDays },
    pactProposalCost: pack.pactProposalCost,
  };
}

export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_m, key: string) => {
    const value = vars[key];
    return value === undefined ? '' : String(value);
  });
}

export function formatClock(pack: WorldPack, minutes: number): { long: string; short: string; day: number; daysLeft: number } {
  const day = pack.season.startDay + Math.floor(minutes / 1440);
  const hh = Math.floor((minutes % 1440) / 60);
  const mm = minutes % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return {
    day, daysLeft: pack.season.lengthDays - day,
    long: `Day ${day} of ${pack.season.lengthDays} · ${pad(hh)}:${pad(mm)}`,
    short: `D${day} ${pad(hh)}:${pad(mm)}`,
  };
}

export function verbId(pack: WorldPack, name: keyof WorldPack['verbs']): string {
  return `${pack.profileId}/verbs/${pack.verbs[name]}`;
}

export function byId<T extends { id: string }>(items: readonly T[], id: string): T | undefined {
  return items.find(item => item.id === id);
}
