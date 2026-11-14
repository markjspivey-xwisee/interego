/**
 * Where mission statements go. The world keeps its own copy (origin `world`)
 * and can read statements it did not write (origin `external`) — that is how a
 * cmi5 `passed` or `completed` arrives, from the course, never from here.
 */
import type { XapiStatement } from './statements.js';

export type StatementOrigin = 'world' | 'external';

export class StatementLog {
  readonly entries: Array<{ statement: XapiStatement; origin: StatementOrigin }> = [];

  add(statements: readonly XapiStatement[], origin: StatementOrigin): void {
    for (const statement of statements) this.entries.push({ statement, origin });
  }

  has(id: string): boolean {
    return this.entries.some(entry => entry.statement.id === id);
  }

  /** An external statement: this actor, this object, this verb, not one this world wrote. */
  sawExternal(actorDid: string, objectId: string, verbId: string): boolean {
    return this.entries.some(entry => entry.origin === 'external'
      && entry.statement.actor.account.name === actorDid
      && entry.statement.object.id === objectId
      && entry.statement.verb.id === verbId);
  }
}

export interface LrsReader {
  fetchActor(actorDid: string): Promise<XapiStatement[]>;
}

/** GET an LRS statement list for one actor. Foxxi's `/xapi/statements` speaks this. */
export class HttpLrs implements LrsReader {
  constructor(
    private readonly statementsUrl: string,
    private readonly authorization: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchActor(actorDid: string): Promise<XapiStatement[]> {
    const endpoint = new URL(this.statementsUrl);
    endpoint.searchParams.set('agent', JSON.stringify({ objectType: 'Agent', account: { name: actorDid } }));
    const headers: Record<string, string> = { 'X-Experience-API-Version': '2.0.0', Accept: 'application/json' };
    if (this.authorization) headers['Authorization'] = this.authorization;
    const response = await this.fetchImpl(endpoint, { headers });
    if (!response.ok) throw new Error(`lrs ${response.status}`);
    const body = await response.json() as { statements?: XapiStatement[] };
    return Array.isArray(body.statements) ? body.statements : [];
  }
}
