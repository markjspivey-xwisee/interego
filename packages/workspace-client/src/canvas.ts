/**
 * THE CANVAS, which is not an object on a server.
 *
 * It is ONE graph IRI on a pod with a supersession chain behind it. What makes it a shared
 * document is the PRECONDITION on the write, not a special type: a save against an existing
 * revision sends `if_match`, and the relay refuses to overwrite a revision the writer had not
 * seen.
 *
 * ★ "SAVED" IS SAID ONLY WHEN THE HEAD READS BACK AS *YOUR* DESCRIPTOR.
 * Waiting for "the head CID changed" is satisfied by SOMEBODY ELSE's write: their revision
 * becomes the head, the CID changes, and a panel watching only for movement reports "Saved" for
 * a write that may have been the loser. What is looked for is the descriptor URL the relay
 * returned for THIS write. That distinction is the whole reason this file exists rather than
 * two shells each polling a CID.
 */

import { visibilityFor } from './visibility.js';
import { canvasTurtle } from './documents.js';
import { graphRegion, readLiteral } from './turtle.js';
import { refusal } from './transport.js';
import type { HeadResult, WorkspaceClient } from './substrate.js';

/**
 * What one read of the canvas established. SIX outcomes, and they are not interchangeable.
 *
 * ★ "NOTHING IS HERE" AND "THIS READ DID NOT RESOLVE" USED TO LAND IN THE SAME BRANCH, which
 * then offered an unconditional overwrite — no `if_match`, `auto_supersede_prior` — of a
 * document the client had FAILED to read. Only the relay explicitly saying nothing describes
 * this graph licenses offering to create it.
 */
export type CanvasRead =
  | { readonly kind: 'forked'; readonly heads: readonly unknown[]; readonly message: string }
  /** The relay said nothing is published here. The ONLY state that licenses Create. */
  | { readonly kind: 'absent'; readonly message: string }
  /** The answer carried neither a head nor a reason. Not a statement about the world. */
  | { readonly kind: 'unresolved'; readonly message: string }
  /** A head with a URL, no CID and an error is not a readable revision — and no CID to assert. */
  | { readonly kind: 'head-unreadable'; readonly url: string; readonly headError: string }
  /** Fetched, and the payload block for this IRI was not inside it. Nothing signed was read. */
  | { readonly kind: 'no-region'; readonly url: string; readonly cid: string | null }
  | {
      readonly kind: 'revision';
      readonly url: string;
      readonly cid: string | null;
      /** `null` = the signed region carries no `dct:description`. `''` = it carries an empty one. */
      readonly text: string | null;
    };

/** Read the current revision of a canvas on a pod. */
export async function readCanvas(client: WorkspaceClient, canvasIri: string, podName: string): Promise<CanvasRead> {
  const h: HeadResult = await client.currentHead(canvasIri, podName);
  if (h.forked) return { kind: 'forked', heads: h.heads, message: h.message };
  if (h.url === null) {
    return 'unreadable' in h ? { kind: 'unresolved', message: h.message } : { kind: 'absent', message: h.message };
  }
  if (h.headError) return { kind: 'head-unreadable', url: h.url, headError: h.headError };
  const d = await client.descriptor(h.url);
  const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', canvasIri);
  if (region === null) return { kind: 'no-region', url: h.url, cid: h.cid };
  return { kind: 'revision', url: h.url, cid: h.cid, text: readLiteral(region, 'dct:description') };
}

/** What waiting for a write to become the head found. */
export type HeadWait =
  | { readonly kind: 'mine'; readonly cid: string | null; readonly url: string }
  /** Something became the head and there was no descriptor of ours to match it against. */
  | { readonly kind: 'changed'; readonly cid: string | null; readonly url: string }
  | { readonly kind: 'forked'; readonly heads: readonly unknown[]; readonly message: string }
  /** ★ The head moved and it is NOT yours. Somebody else's revision won. */
  | { readonly kind: 'moved-elsewhere'; readonly cid: string | null; readonly url: string }
  | { readonly kind: 'timed-out' };

/**
 * Wait for a specific descriptor to become the readable head.
 *
 * ★ TAKES A URL AND NOT JUST THE OLD CID — see the file header. `mine` may be absent, in which
 * case this reports what it SAW and the caller says it could not confirm.
 */
export async function awaitHead(
  client: WorkspaceClient,
  args: {
    readonly canvasIri: string;
    readonly podName: string;
    readonly previousCid: string | null;
    readonly mine: string | null;
    readonly tries?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<HeadWait> {
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const tries = args.tries ?? 40;
  let last: { url: string; cid: string | null } | null = null;
  for (let i = 0; i < tries; i++) {
    await sleep(700);
    try {
      const h = await client.currentHead(args.canvasIri, args.podName);
      if (h.forked) return { kind: 'forked', heads: h.heads, message: h.message };
      if (h.url !== null) {
        last = { url: h.url, cid: h.cid };
        if (args.mine && h.url === args.mine) return { kind: 'mine', cid: h.cid, url: h.url };
        if (!args.mine && h.cid && h.cid !== args.previousCid) return { kind: 'changed', cid: h.cid, url: h.url };
      }
    } catch { /* a failed poll is not a verdict; keep the last thing that WAS read */ }
  }
  // Timed out. Report what the head IS, so the caller can say whether somebody else's write is
  // now sitting where theirs was meant to go.
  if (last && args.mine && last.cid !== args.previousCid) return { kind: 'moved-elsewhere', cid: last.cid, url: last.url };
  return { kind: 'timed-out' };
}

/** A 412 body, unpacked — every field named as reported rather than defaulted. */
export interface StaleDetail {
  readonly expectedCid: string | null;
  readonly currentHeadCid: string | null;
  readonly currentHeadDescriptor: string | null;
  readonly retryHint: string | null;
  readonly message: string | null;
}

/** Pull the merge-forward material out of a 412 refusal, saying which fields were absent. */
export function staleDetail(bad: Record<string, unknown>): StaleDetail {
  const expected = bad['expected'] as { cid?: string; supersedes?: string } | undefined;
  const current = bad['currentHead'] as { cid?: string; descriptorUrl?: string } | undefined;
  return {
    expectedCid: expected?.cid ?? expected?.supersedes ?? null,
    currentHeadCid: current?.cid ?? null,
    currentHeadDescriptor: current?.descriptorUrl ?? null,
    retryHint: (bad['retryHint'] as string) ?? null,
    message: (bad['message'] as string) ?? null,
  };
}

export type CanvasSave =
  | { readonly kind: 'error'; readonly error: unknown; readonly relayAnswered: boolean }
  /** 412. The one refusal that carries a next move, so it is its own outcome. */
  | { readonly kind: 'stale'; readonly detail: StaleDetail; readonly body: Record<string, unknown> }
  | { readonly kind: 'refused'; readonly code: number | null; readonly body: Record<string, unknown> }
  | {
      readonly kind: 'accepted';
      readonly descriptorUrl: string | null;
      readonly committed: boolean;
      readonly status: string | null;
      readonly ifMatch: string | null;
      readonly precondition: unknown;
      readonly supersededCount: number | null;
      readonly response: Record<string, unknown>;
      /** The head read back AFTER the write. This is what licenses the word "Saved". */
      readonly settled: HeadWait;
    };

/**
 * Save the canvas, asserting a revision, then CHECK that the head became yours.
 *
 * `ifMatch` is supplied by the caller rather than derived here, because the two controls that
 * call this differ in exactly that argument: Save sends the revision the panel currently holds,
 * and the deliberately-stale control re-sends the revision the panel FIRST LOADED — which is
 * what a client that shows you a revision, takes your edit and writes it with no reference to
 * the revision it showed you would send. That defect is the point of having the second control,
 * so the argument is the caller's.
 */
export async function saveCanvas(
  client: WorkspaceClient,
  args: {
    readonly canvasIri: string;
    readonly podName: string;
    readonly workspace: string;
    readonly slug: string;
    readonly body: string;
    readonly ifMatch: string | null;
    readonly previousCid: string | null;
    /**
     * The workspace's own policy, carried from the verdict that seated this writer.
     *
     * ★ NOT DECIDED HERE AND NOT RE-FETCHED. `GrantVerdict.visibility` is read on the same read
     * that establishes the seat; a writer that looked it up again could answer differently from
     * the seat it is writing under. Defaults to public, like every other reader of this field.
     */
    readonly visibility?: 'public' | 'private';
    /**
     * The other members this canvas must stay readable by. Required when `visibility` is private.
     *
     * ★★ THE CANVAS IS THE WORST PLACE TO GET THIS WRONG. It is ONE document the whole workspace
     * supersedes in turn, so an author who saves it sealed to themselves does not just hide their
     * own revision — they hand the next member a head they cannot read, and the merge-forward path
     * that everyone else depends on has nothing to merge from. Build it with
     * `recipientsFromRoster`.
     */
    readonly shareWith?: readonly string[];
    readonly awaitTries?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<CanvasSave> {
  // Fail closed — see `postEntry`, and see the note above for why the canvas is worse.
  if (args.visibility === 'private' && !(args.shareWith && args.shareWith.length > 0)) {
    return {
      kind: 'refused', code: null,
      body: {
        error: 'no_recipients',
        message: 'This workspace is private, so the canvas would be encrypted — and no other member was '
          + 'named as a recipient, which would seal it to you alone. The next member to open it would '
          + 'find a head they cannot read and nothing to merge forward from. Nothing was written.',
      },
    };
  }
  const publishArgs: Record<string, unknown> = {
    graph_iri: args.canvasIri,
    graph_content: canvasTurtle({ canvas: args.canvasIri, workspace: args.workspace, slug: args.slug, body: args.body }),
    // ★ The workspace's own policy — see `visibilityFor`. Omitting this would silently ENCRYPT.
    visibility: visibilityFor('canvas', args.visibility ?? 'public'),
    // Only under 'shared' — the relay drops it with a warning under 'public'.
    ...(args.visibility === 'private' && args.shareWith?.length ? { share_with: args.shareWith } : {}),
    auto_supersede_prior: true,
    sign_authorship: true,
  };
  if (args.ifMatch) publishArgs['if_match'] = args.ifMatch;

  let res: Record<string, unknown>;
  try { res = await client.tool('publish_context', publishArgs) as Record<string, unknown>; }
  catch (e) {
    // `tool_error` means the relay ANSWERED and reported a failure; only the transport codes
    // mean it did not answer, and only the second licenses "whether this landed is unknown".
    return { kind: 'error', error: e, relayAnswered: (e as { code?: string })?.code === 'tool_error' };
  }
  const bad = refusal(res);
  if (bad) {
    const code = typeof bad['code'] === 'number' ? bad['code'] as number : null;
    if (code === 412) return { kind: 'stale', detail: staleDetail(bad), body: bad };
    return { kind: 'refused', code, body: bad };
  }

  const mine = (res['descriptorUrl'] as string) ?? null;
  const superseded = res['supersedesPriorVersions'];
  const settled = await awaitHead(client, {
    canvasIri: args.canvasIri, podName: args.podName, previousCid: args.previousCid, mine,
    ...(args.awaitTries === undefined ? {} : { tries: args.awaitTries }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep }),
  });
  return {
    kind: 'accepted',
    descriptorUrl: mine,
    committed: res['status'] === 'committed',
    status: (res['status'] as string) ?? null,
    ifMatch: args.ifMatch,
    precondition: res['precondition'],
    supersededCount: Array.isArray(superseded) ? superseded.length : null,
    response: res,
    settled,
  };
}

/**
 * Follow a 412's `retryHint` exactly: one `get_current_head`, then resend against what it
 * returns.
 *
 * The hint is the relay's own instruction and it is followed rather than paraphrased. A chain
 * with no single head has nothing to merge ONTO, so that is refused rather than guessed at.
 */
export async function mergeForward(
  client: WorkspaceClient,
  args: {
    readonly canvasIri: string;
    readonly podName: string;
    readonly workspace: string;
    readonly slug: string;
    readonly body: string;
    /**
     * ── ★★ WITHOUT THESE, MERGING FORWARD DECLASSIFIES THE CANVAS ─────────────
     *
     * This wrapper is a `saveCanvas` like any other, and it was the ONE canvas write path that
     * could not carry the workspace's policy: the argument type did not declare these, so no
     * caller could pass them and `args.visibility` arrived at `saveCanvas` as `undefined`. The
     * fail-closed guard tests `=== 'private'` and never fired; `visibilityFor('canvas', undefined
     * ?? 'public')` computed `'public'`; and `auto_supersede_prior` made the result the HEAD.
     *
     * So one click on "Merge forward" — offered after any 412, which is the ordinary case for a
     * shared document — republished the whole canvas as world-readable plaintext with
     * `acl:Read` for `foaf:Agent`, superseding the sealed revision, and reported success in
     * green. There is no unpublish: that revision stays at its URL permanently, and a later
     * ordinary save re-encrypting the NEXT revision does not retract it.
     */
    readonly visibility?: 'public' | 'private';
    readonly shareWith?: readonly string[];
    readonly awaitTries?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ readonly kind: 'no-head'; readonly why: string } | { readonly kind: 'resent'; readonly onto: string; readonly save: CanvasSave }> {
  const h = await client.currentHead(args.canvasIri, args.podName);
  if (h.forked) return { kind: 'no-head', why: h.message || 'the chain has diverged, so there is no single revision to merge onto' };
  if (h.url === null) return { kind: 'no-head', why: h.message };
  if (!h.cid) return { kind: 'no-head', why: 'the head read reported no CID, so there is no revision to assert against and a resend would be unconditional' };
  const save = await saveCanvas(client, {
    canvasIri: args.canvasIri, podName: args.podName, workspace: args.workspace, slug: args.slug,
    body: args.body, ifMatch: h.cid, previousCid: h.cid,
    // Forwarded, never defaulted: a merge is a save, and it is written under the same policy.
    ...(args.visibility === undefined ? {} : { visibility: args.visibility }),
    ...(args.shareWith === undefined ? {} : { shareWith: args.shareWith }),
    ...(args.awaitTries === undefined ? {} : { awaitTries: args.awaitTries }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep }),
  });
  return { kind: 'resent', onto: h.cid, save };
}
