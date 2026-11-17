import { PassThrough, type Readable } from 'node:stream';
import { pipeSafely, type Guarded } from '@solid/community-server';

/**
 * The same data as `stream`, in a stream that `for await` can read.
 *
 * CSS 7.3's LockingResourceStore hands every read and every write a stream made with
 * `Object.create` over the real one, whose `read()` renews the lock. `for await` cannot read
 * that object: Node's async iterator wakes only on a 'readable' event emitted by the object it
 * was given, and the real stream emits them on itself. The iterator waits until the lock
 * expires and the stream is destroyed, then calls an undefined callback ("callback is not a
 * function"), which throws outside any handler and ends the process.
 *
 * A pipe reads through the derived `read()`, at the start and again each time the PassThrough
 * drains, so the lock is still renewed while the data is read. pipeSafely is CSS's own pipe:
 * when `stream` is an HTTP request body it leaves the request open on error, as CSS does,
 * instead of destroying it and the response with it. The PassThrough keeps the source's mode.
 */
export function throughPipe(stream: Readable): Guarded<PassThrough> {
  return pipeSafely(stream, new PassThrough({ objectMode: stream.readableObjectMode }));
}
