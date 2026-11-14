/**
 * Where mission statements go. The world keeps its own copy (origin `world`)
 * and can read statements it did not write (origin `external`). A tier gate
 * reads the course-level cmi5 `satisfied` statement Foxxi's LMS writes for the
 * course IRI. The world does not write that verb.
 */
import type { XapiStatement } from './statements.js';

export type StatementOrigin = 'world' | 'external';

/** What Foxxi's LMS writes for the course once every assignable unit has met moveOn. */
export const SATISFIED = 'https://w3id.org/xapi/adl/verbs/satisfied';
/** The cmi5 category a course statement carries. A statement without it is not the LMS record. */
export const CMI5_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';

function categoryIds(statement: XapiStatement): string[] {
  const list = statement.context.contextActivities.category;
  return list.map(item => item.id);
}

export class StatementLog {
  readonly entries: Array<{ statement: XapiStatement; origin: StatementOrigin }> = [];

  add(statements: readonly XapiStatement[], origin: StatementOrigin): void {
    for (const statement of statements) this.entries.push({ statement, origin });
  }

  has(id: string): boolean {
    return this.entries.some(entry => entry.statement.id === id);
  }

  /**
   * An external statement for this actor (name and home page), this activity,
   * and this verb, carrying the cmi5 category. The world did not write it.
   */
  sawExternal(actor: { readonly name: string; readonly homePage: string }, objectId: string, verbId: string): boolean {
    return this.entries.some(entry => entry.origin === 'external'
      && entry.statement.actor.account.name === actor.name
      && entry.statement.actor.account.homePage === actor.homePage
      && entry.statement.object.id === objectId
      && entry.statement.verb.id === verbId
      && categoryIds(entry.statement).some(id => id === CMI5_CATEGORY));
  }
}

export interface LrsQuery {
  readonly verb: string;
  readonly activity: string;
}

export interface LrsReader {
  /** `homePage` is the course actor's account home page. Foxxi matches name and home page together. */
  fetchActor(actorDid: string, homePage: string, query: LrsQuery): Promise<XapiStatement[]>;
}

interface StatementPage { statements?: XapiStatement[]; more?: string }

/** GET an LRS statement list. Foxxi's `/xapi/statements` speaks this, including `more`. */
export class HttpLrs implements LrsReader {
  constructor(
    private readonly statementsUrl: string,
    private readonly authorization: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchActor(actorDid: string, homePage: string, query: LrsQuery): Promise<XapiStatement[]> {
    const first = new URL(this.statementsUrl);
    first.searchParams.set('agent', JSON.stringify({ objectType: 'Agent', account: { homePage, name: actorDid } }));
    first.searchParams.set('verb', query.verb);
    first.searchParams.set('activity', query.activity);
    const headers: Record<string, string> = { 'X-Experience-API-Version': '2.0.0', Accept: 'application/json' };
    if (this.authorization) headers['Authorization'] = this.authorization;
    const statements: XapiStatement[] = [];
    const seen = new Set<string>();
    let next: string | undefined = first.href;
    while (next && !seen.has(next) && seen.size < 20) {
      seen.add(next);
      const response = await this.fetchImpl(next, { headers });
      if (!response.ok) throw new Error(`lrs ${response.status}`);
      const body = await response.json() as StatementPage;
      if (Array.isArray(body.statements)) statements.push(...body.statements);
      next = typeof body.more === 'string' && body.more.length > 0 ? new URL(body.more, next).href : undefined;
    }
    return statements;
  }
}
