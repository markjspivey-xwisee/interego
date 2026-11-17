import {
  INTERNAL_QUADS, JsonResourceStorage, NotFoundHttpError, isContainerIdentifier,
  type Representation, type ResourceIdentifier, type ResourceStore,
} from '@solid/community-server';
import { throughPipe } from './LockedStream.js';

/**
 * CSS's JsonResourceStorage, with container listings that CSS 7.3 can read again.
 *
 * The internal value storage (urn:solid-server:default:JsonResourceStorage, rooted at
 * /.internal/) reads from the full ResourceStore. CSS 7.2 found a container's members in its
 * metadata. CSS 7.3 finds them by running `for await` over the container's body, looking for
 * `ldp:contains` quads, and that fails twice on the stock store:
 *  - CSS asks for the container with no type preference. The converting store reads that as
 *    "anything but an internal type" and serializes the listing to Turtle, so the loop meets
 *    bytes, finds no member, and the walk ends at once. Asking for internal quads gets quads.
 *  - The body comes from the locking store, whose stream `for await` cannot read (see
 *    LockedStream.ts): the loop waits out the lock and the process crashes. It is read through
 *    a pipe instead.
 * WrappedExpiringStorage's hourly sweep walks /.internal/ this way, so on an unpatched 7.3 it
 * crashes the process, and with only the pipe it would delete nothing. Documents are still read
 * and written as CSS does.
 *
 * A listing is also read to the end before any member is visited. CSS 7.3 walks each member's
 * sub-tree from inside the loop over its parent's listing, so the parent's read lock stays held,
 * and is renewed only when the listing is read, for as long as that sub-tree takes. On a slow
 * backend that outlasted the lock, which destroyed the listing and failed the sweep. 7.2 never
 * held a listing open across the walk, and neither does this.
 */
export class PipedJsonResourceStorage<T> extends JsonResourceStorage<T> {
  public constructor(source: ResourceStore, baseUrl: string, container: string) {
    super(source, baseUrl, container);
  }

  protected override async safelyGetResource(identifier: ResourceIdentifier): Promise<Representation | undefined> {
    if (!isContainerIdentifier(identifier)) return super.safelyGetResource(identifier);
    try {
      return await this.source.getRepresentation(identifier, { type: { [INTERNAL_QUADS]: 1 } });
    } catch (error: unknown) {
      // As CSS: a container deleted since it was listed is skipped, anything else is thrown.
      if (!NotFoundHttpError.isInstance(error)) throw error;
      return undefined;
    }
  }

  protected override async *getContainedResourceIdentifiers(
    identifier: ResourceIdentifier,
    representation: Representation,
  ): AsyncIterableIterator<ResourceIdentifier> {
    const members: ResourceIdentifier[] = [];
    // isEmpty is a getter on BasicRepresentation's prototype, so the spread alone would drop it.
    for await (const member of super.getContainedResourceIdentifiers(identifier, {
      ...representation, data: throughPipe(representation.data), isEmpty: representation.isEmpty,
    })) members.push(member);
    // The listing has ended, and its lock is released, before the caller visits any member.
    yield* members;
  }
}
