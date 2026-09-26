/**
 * Who is in the demo and what state they are in: the services, the cast, the facts, the
 * chapters. One object the page renders, rebuilt and pushed whenever anything changes.
 */
export type ChapterId = 'signin' | 'author' | 'discover' | 'learn' | 'claim' | 'verify' | 'forgery' | 'teach' | 'agentLearns' | 'work' | 'records' | 'next' | 'cmi5' | 'lti' | 'after';
export type ChapterStatus = 'locked' | 'active' | 'done';

export interface Service { id: string; label: string; status: 'ok' | 'warn' | 'err' | 'busy' | ''; detail?: string }
export interface CastMember {
  id: 'you' | 'claude' | 'verifier' | 'jev' | 'bridge';
  name: string;
  initials: string;
  role: string;
  identity?: string;
  identityHref?: string;
  pod?: string;
  status?: 'ok' | 'warn' | 'err' | 'busy' | '';
  statusText?: string;
  note?: string;
}
export interface Fact { label: string; value: string; href?: string }

export interface DemoState {
  services: Service[];
  cast: CastMember[];
  facts: Fact[];
  chapters: Record<ChapterId, { status: ChapterStatus; data: Record<string, unknown> }>;
}

export const CHAPTER_ORDER: readonly ChapterId[] = ['signin', 'author', 'discover', 'learn', 'claim', 'verify', 'forgery', 'teach', 'agentLearns', 'work', 'records', 'next', 'cmi5', 'lti', 'after'];

/** You sign in and the agent writes its course at the same time; the rest opens as they finish. */
export function freshChapters(): DemoState['chapters'] {
  const out = {} as DemoState['chapters'];
  for (const id of CHAPTER_ORDER) out[id] = { status: 'locked', data: {} };
  out.signin.status = 'active';
  out.author.status = 'active';
  return out;
}
