/**
 * Read-time names for one person who has more than one xAPI actor.
 *
 * A provisional guest's statements stay attributed to that guest. When the same person later
 * signs in as an existing owner, a link says the two actors are one reader. Nothing here
 * rewrites a statement. The LRS consults this when it filters by agent, and the admin
 * aggregates consult it when they count actors: both names count as the owner.
 *
 * The source is whatever recorded the link (the course player). With none set, every name
 * is only itself.
 */

export type ActorRecord = { mbox?: string; openid?: string; account?: { name?: string; homePage?: string } };
export interface ActorLink { canonical: string; also: readonly string[] }
type Source = (name: string) => ActorLink | undefined;
let namesFor: Source = () => undefined;

/** Replace the lookup. Tests and a process with no links call this with no argument. */
export function setActorAliasSource(source?: Source): void {
  namesFor = source ?? (() => undefined);
}

function linkOf(name: string | undefined): ActorLink | undefined {
  if (!name) return undefined;
  try { return namesFor(name); } catch { return undefined; }
}

/** Other actors a query for `agent` should also return. Empty when nothing is linked. */
export function actorAliases(agent: ActorRecord): ActorRecord[] {
  const name = agent.account?.name;
  const home = agent.account?.homePage;
  const link = linkOf(name);
  if (!name || !home || !link) return [];
  return link.also.filter(other => other !== name).map(other => ({ account: { homePage: home, name: other } }));
}

/** The owner a count should land on, or `name` when it is not linked. */
export function canonicalActorName(name: string): string {
  return linkOf(name)?.canonical ?? name;
}

/** Whether `name` is `asked`, or the two are linked. */
export function actorNameLinked(name: string | undefined, asked: string): boolean {
  if (!name) return false;
  if (name === asked) return true;
  const link = linkOf(name) ?? linkOf(asked);
  if (!link) return false;
  const all = [link.canonical, ...link.also];
  return all.includes(name) && all.includes(asked);
}
