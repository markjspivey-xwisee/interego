'use strict';

/**
 * A ResourceStore for CSS's internal value storage, so that its hourly expired-entry sweep can
 * list /.internal/ again on Community Solid Server 7.3.0.
 *
 * WrappedExpiringStorage sweeps once an hour by walking the internal value storage
 * (urn:solid-server:default:JsonResourceStorage) under /.internal/. CSS 7.3.0's JsonResourceStorage
 * lists a container there by running `for await` over the container's body, and on the full
 * ResourceStore that fails twice:
 *  - It asks for the container with no type preference. The converting store reads that as
 *    "anything but an internal type" and serializes the listing to Turtle, so the loop meets
 *    bytes and finds no member.
 *  - The body comes from the locking store, which hands out a stream made with `Object.create`
 *    over the real one, whose read() renews the lock. Node's async iterator wakes only on a
 *    'readable' event emitted on the object it was given, and the real stream emits them on
 *    itself, so the loop never wakes. When the lock expires and the stream is destroyed, the
 *    iterator calls an undefined callback ("callback is not a function"), outside any handler,
 *    and the process ends.
 *
 * This store sits between JsonResourceStorage and the full ResourceStore. A container is asked
 * for as internal quads, and its listing is read to the end through a pipe, which reads through
 * the derived read() and so keeps the lock while it reads. The quads then go to JsonResourceStorage
 * in a plain stream that `for await` can read. Because the listing has ended, and its read lock is
 * released, before JsonResourceStorage visits any member, the walk never holds a parent's lock
 * across a member's sub-tree, as CSS 7.2 never did. Every other call is passed through, so
 * documents are read and written as CSS does, and every read and write still takes the resource
 * lock. That lock is why the full ResourceStore stays underneath: the account and OIDC routes
 * these configs serve write the same documents.
 *
 * It requires nothing but Node's own stream module. npx installs this folder as a link beside CSS
 * (`npx -p <this folder>`), and Node resolves a linked module's own imports from where its files
 * really are, in this repository, not from the npx install. Importing CSS from here would load a
 * second copy, or none.
 */

const { PassThrough, Readable } = require('node:stream');

/** CSS's INTERNAL_QUADS: the content type of a representation that is a stream of quads. */
const INTERNAL_QUADS = 'internal/quads';

/** Solid, §3.1, as CSS's isContainerIdentifier: a path ending with a slash denotes a container. */
const isContainer = (identifier) => identifier.path.endsWith('/');

/** Every item of `stream`, read through a pipe, which reads a locked stream as CSS's own pipes do. */
function readToEnd(stream) {
  return new Promise((resolve, reject) => {
    const items = [];
    const pipe = new PassThrough({ objectMode: stream.readableObjectMode });
    stream.once('error', (error) => {
      pipe.destroy();
      reject(error);
    });
    pipe.once('error', reject);
    pipe.on('data', (item) => items.push(item));
    pipe.once('end', () => resolve(items));
    stream.pipe(pipe);
  });
}

class BufferedListingStore {
  /** @param source - The full ResourceStore, urn:solid-server:default:ResourceStore. */
  constructor(source) {
    this.source = source;
  }

  hasResource(identifier) {
    return this.source.hasResource(identifier);
  }

  async getRepresentation(identifier, preferences, conditions) {
    if (!isContainer(identifier)) return this.source.getRepresentation(identifier, preferences, conditions);
    const representation = await this.source.getRepresentation(identifier, { type: { [INTERNAL_QUADS]: 1 } }, conditions);
    const quads = await readToEnd(representation.data);
    return {
      metadata: representation.metadata,
      data: Readable.from(quads),
      binary: false,
      isEmpty: quads.length === 0,
    };
  }

  setRepresentation(identifier, representation, conditions) {
    return this.source.setRepresentation(identifier, representation, conditions);
  }

  addResource(container, representation, conditions) {
    return this.source.addResource(container, representation, conditions);
  }

  deleteResource(identifier, conditions) {
    return this.source.deleteResource(identifier, conditions);
  }

  modifyResource(identifier, patch, conditions) {
    return this.source.modifyResource(identifier, patch, conditions);
  }
}

module.exports = { BufferedListingStore };
