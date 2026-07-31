/**
 * The Editor Witness — a transparent stdio tee for Agent Client Protocol.
 *
 * ★ WHAT THIS IS. ACP puts a code editor (client) and a coding agent on either end of a
 * JSON-RPC 2.0 stream. Uniquely among the protocols this project touches, that stream
 * carries the HUMAN'S CONSENT as structured data: `session/request_permission` asks, and
 * the reply names an option whose kind is one of allow_once / allow_always / reject_once /
 * reject_always. Nothing else we integrate with emits an authorization decision at all.
 *
 * This module is the part that watches. It sits in the middle, forwards every frame
 * BYTE-FOR-BYTE, and reports what it saw. It is deliberately the least clever file in the
 * adapter.
 *
 * ★ THE ONE INVARIANT: THE TEE IS INVISIBLE.
 *
 * A witness that changes what it witnesses is not a witness. Every frame is written out
 * exactly as it arrived — the original bytes, not a re-serialisation of a parsed object.
 * Re-encoding would be a subtle disaster: JSON key order, number formatting and unicode
 * escapes would all shift, and ACP's `_meta` passthrough plus any future field this build
 * does not know about would be silently dropped. Observation is a side effect on a copy.
 *
 * Consequences that follow from that invariant, and are tested:
 *   - A frame that fails to parse is still forwarded. Malformed to us may be fine to them;
 *     we are not a validator and must never become a filter.
 *   - An observer that throws must not break the stream. Observers are wrapped.
 *   - Backpressure is respected in both directions, so a slow peer cannot make us buffer
 *     a session's worth of frames.
 *
 * ★ WHAT THIS FILE IS NOT. It contains no ACP method name, no tool-call kind, and no
 * option-kind string. Framing is code; MEANING is data. Interpreting a frame is
 * `map.ts`'s job, driven by a published mapping graph, and the spec-blindness guard greps
 * that file, not this one. The line is drawn where the house rule draws it: a wire binding
 * is code by nature, a vocabulary mapping is not.
 *
 * ★ PRIVACY, IN INCREMENT 0. This build publishes NOTHING. It counts, in memory, and
 * prints a summary at exit. It exists to answer one empirical question before any
 * vocabulary is designed around the answer: in a real day of work, how many permission
 * decisions actually occur, and how many of them are `*_always`? If that number is zero,
 * the standing-constraint thesis is dead and the honest outcome is a log.
 */
import type { Readable, Writable } from 'node:stream';

/** A parsed JSON-RPC frame, as far as the tee cares. It does not model the protocol. */
export interface Frame {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly [k: string]: unknown;
}

/** Which way a frame was travelling. The tee names the ends, not the roles. */
export type Direction = 'editor->agent' | 'agent->editor';

export interface Observation {
  readonly direction: Direction;
  /** Parsed frame, or null when the line was not JSON — forwarded regardless. */
  readonly frame: Frame | null;
  /** The exact line as it crossed, for observers that need to be sure. */
  readonly raw: string;
  /** Monotonic milliseconds since the tee started. Not wall-clock: a witness should not
   *  make claims about when something happened that it cannot substantiate. */
  readonly atMs: number;
}

export type Observer = (o: Observation) => void;

export interface TeeOptions {
  /** Frames arriving from the editor, destined for the agent. */
  readonly fromEditor: Readable;
  readonly toAgent: Writable;
  /** Frames arriving from the agent, destined for the editor. */
  readonly fromAgent: Readable;
  readonly toEditor: Writable;
  readonly observers: readonly Observer[];
  /** Called when an observer throws. Default: ignore. An observer fault must never
   *  surface to either peer, but it must not vanish silently either. */
  readonly onObserverError?: (err: unknown, o: Observation) => void;
  /** Injectable clock, so tests are deterministic and nothing here calls Date.now(). */
  readonly now?: () => number;
}

/**
 * Split a byte stream into newline-delimited frames without ever holding a partial line
 * across a write.
 *
 * ACP's stdio transport is newline-delimited JSON. A naïve `data.toString().split('\n')`
 * corrupts any frame that straddles a chunk boundary — which happens constantly once a
 * tool call carries a real diff — so the remainder is carried explicitly.
 */
class LineSplitter {
  private buf = '';
  /** Feed a chunk; returns complete lines, retaining any partial tail. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';       // the tail is incomplete by construction
    return parts;
  }
  /** Whatever is left at end-of-stream. A final frame need not be newline-terminated. */
  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    return rest.length > 0 ? [rest] : [];
  }
}

/** Parse, or null. Never throws — a frame we cannot read still has to be forwarded. */
function tryParse(line: string): Frame | null {
  const t = line.trim();
  if (t.length === 0) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === 'object' ? (v as Frame) : null;
  } catch {
    return null;
  }
}

/**
 * Start the tee. Resolves when both directions have closed.
 *
 * Forwarding uses the ORIGINAL line text plus a newline — never `JSON.stringify(parsed)`.
 * See the invariant in the module header; this is the line of code it is about.
 */
export function startTee(opts: TeeOptions): Promise<void> {
  const now = opts.now ?? (() => Math.round(performance.now()));

  const notify = (o: Observation): void => {
    for (const obs of opts.observers) {
      try {
        obs(o);
      } catch (err) {
        // An observer is a passive listener. Its failure is ours, not the session's.
        opts.onObserverError?.(err, o);
      }
    }
  };

  const pump = (
    src: Readable, dst: Writable, direction: Direction,
  ): Promise<void> => new Promise((resolve, reject) => {
    const splitter = new LineSplitter();

    const forward = (line: string): void => {
      notify({ direction, frame: tryParse(line), raw: line, atMs: now() });
      // Original bytes. Not a re-serialisation.
      const ok = dst.write(line + '\n');
      // Respect backpressure: a slow peer must slow the stream, not grow the heap.
      if (!ok) {
        src.pause();
        dst.once('drain', () => src.resume());
      }
    };

    src.setEncoding('utf8');
    src.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) forward(line);
    });
    src.on('end', () => {
      for (const line of splitter.flush()) forward(line);
      dst.end();
      resolve();
    });
    src.on('error', reject);
    // A destination that dies is the peer hanging up, not a fault of ours.
    dst.on('error', reject);
  });

  return Promise.all([
    pump(opts.fromEditor, opts.toAgent, 'editor->agent'),
    pump(opts.fromAgent, opts.toEditor, 'agent->editor'),
  ]).then(() => undefined);
}
