/**
 * The SSE / webhook notification frame the relay emits — and the context that makes it mean
 * anything.
 *
 * ── ★★ THE DEFECT: A FRAME THAT WAS NOT AN INSTANCE OF THE SHAPE IT NAMED ────────────────────
 *
 * `iep:NotificationShape` is published, targets `iep:Notification`, and requires `iep:podUrl`,
 * `iep:descriptorUrl` and `iep:eventType`, with optional `dct:created` and
 * `prov:wasAttributedTo`. The relay emitted `{ type, eventType, timestamp, podUrl, descriptorUrl,
 * graphUrl, author }` under
 *
 *     "@context": "https://markjspivey-xwisee.github.io/interego/ns/iep#"
 *
 * — the TURTLE NAMESPACE IRI, not the published JSON-LD context document at `/ns/iep/v1.json`.
 * A namespace IRI is not a context: it defines no terms. So every key in the frame was an
 * undefined term, `timestamp` and `author` expanded to nothing rather than to `dct:created` and
 * `prov:wasAttributedTo`, `type` was not aliased to `@type`, and the frame expanded to an
 * anonymous node with no type and no properties. Validating it against the shape it advertises
 * would have found an empty graph, which conforms vacuously.
 *
 * ★★ AND THE ONTOLOGY DESCRIBED THAT INSTEAD OF CLOSING IT. `iep:NotificationShape`'s own comment
 * carried a paragraph beginning "AND THE RELAY'S SSE PAYLOAD IS NOT THIS DOCUMENT", ending
 * "Recorded here rather than fixed silently: changing either the emitted keys or the published
 * context is a wire-format change for every existing consumer, and belongs to whoever owns that
 * decision." The reasoning is sound about the keys and wrong about the remedy, because there was
 * a third option it did not consider:
 *
 *   ★ THE EMITTED KEYS DO NOT CHANGE. The published context GAINS the term definitions, and this
 *   frame points at it. A consumer reading raw JSON keys sees byte-identical frames — same keys,
 *   same values, only `@context` differs. A consumer that JSON-LD-expands goes from silently
 *   losing every field to getting the properties the shape requires. Nobody's parse breaks and
 *   the silent data loss ends, so no wire-format decision was actually blocked on anyone.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────────────────────
 *
 * `server.ts` calls `app.listen()` at module scope, so importing it to check a frame binds a
 * port. The builder lives here so the gate can construct a frame with the REAL builder, expand
 * it with the REAL published context and validate it against the REAL shape — rather than a test
 * hand-writing the frame it hopes the relay emits, which is the mistake that produced the
 * un-noticed mismatch in the first place.
 */

/**
 * The published JSON-LD context document.
 *
 * ★ A DOCUMENT, NOT A NAMESPACE. The value this replaced — the `…/ns/iep#` Turtle namespace IRI —
 * is not retrievable as a context and defines no terms, which is precisely why every key in the
 * frame expanded to nothing. `docs/ns/iep/v1.json` is served at this URL and defines them.
 */
export const NOTIFICATION_CONTEXT_URL =
  'https://markjspivey-xwisee.github.io/interego/ns/iep/v1.json';

/** One descriptor-lifecycle event, as it goes on the wire. */
export interface NotificationEvent {
  readonly '@context': string;
  readonly type: 'iep:Notification';
  readonly eventType: 'created' | 'updated' | 'superseded';
  readonly timestamp: string;
  readonly podUrl: string;
  readonly descriptorUrl: string;
  readonly graphUrl?: string;
  readonly author?: string;
}

/** Everything the caller supplies; the rest is derived. */
export type NotificationEventInput =
  Omit<NotificationEvent, '@context' | 'type' | 'timestamp' | 'podUrl'> & { timestamp?: string };

/**
 * Build the frame for one event.
 *
 * `graphUrl` and `author` are spread only when present rather than emitted as null: the shape
 * gives both `sh:minCount 0`, and a null would expand to a literal `null`, which is an assertion
 * that the value IS nothing rather than that none was observed.
 */
export function buildNotificationEvent(
  podUrl: string,
  partial: NotificationEventInput,
  now: () => string = () => new Date().toISOString(),
): NotificationEvent {
  return {
    '@context': NOTIFICATION_CONTEXT_URL,
    type: 'iep:Notification',
    timestamp: partial.timestamp ?? now(),
    podUrl,
    eventType: partial.eventType,
    descriptorUrl: partial.descriptorUrl,
    ...(partial.graphUrl !== undefined ? { graphUrl: partial.graphUrl } : {}),
    ...(partial.author !== undefined ? { author: partial.author } : {}),
  };
}
