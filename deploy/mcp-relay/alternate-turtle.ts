/**
 * Following a page's own advertised Turtle representation — re-exported, not redefined.
 *
 * ★ WHY THE PREDICATES LEFT THIS FILE. They were written here because our ontology IRIs do not
 * content-negotiate: GitHub Pages ignores Accept and serves `text/html` for
 * `https://…/ns/iep`, and that bit the publish path three separate times — a good shape looked
 * unreachable, an `owl:imports` of one corrupted the graph it was glued into, and
 * last-known-good had to distrust any body that did not parse.
 *
 * Then it bit a SECOND reader. `docs/applications/shared-workspace/wsp-roles-default.html`
 * shipped so the workspace vocabulary's extensionless IRIs would finally dereference, and
 * `dereferenceRoleProfile` in `applications/shared-workspace/src/membership.ts` — which fetches
 * the role-profile IRI a workspace declares and parses the body as Turtle — started answering
 * `unreadable: … unknown bareword "Default"` for the only role profile in existence.
 *
 * The reflex fix there was a second regex over untrusted markup, which is exactly the
 * duplication this module was carved out of `server.ts` to prevent: two copies of a predicate
 * over HTML drift in the way that is invisible until a page is written the other way round. So
 * the implementation moved to `@interego/core`, which both the relay and `applications/`
 * already depend on, and this file re-exports it so the relay's import surface is unchanged.
 *
 * Same move, same reason, and the same shape of file as
 * `deploy/mcp-relay/authorship-content-binding.ts`, which re-exports
 * `graphIriFromDescriptorTurtle` after it left the relay for @interego/solid when a reader
 * outside the relay turned out to need it.
 *
 * ★ THE HOP IS RE-EXPORTED TOO, AND THAT IS NEW. This file used to carry only the two
 * predicates, because `fetchShapeBody` in `server.ts` still followed the alternate with an
 * inline copy of the hop — entangled with the shape cache's last-known-good fallback and with
 * `guardedInvokeFetch`, the SSRF guard every caller-URL fetch in that file goes through. The
 * note that stood here said a later round should record that the shared follower refuses a
 * cross-origin alternate and `fetchShapeBody` did not. It did not, and a shape whose HTML page
 * advertised a FOREIGN ORIGIN's Turtle had that document fetched and used as the publish gate.
 *
 * `deploy/mcp-relay/shape-body.ts` is that entanglement lifted out of the listener-starting
 * module and composed onto `followAlternateTurtle`, so the relay now has ONE follower rather
 * than a second one that had quietly lost a guard. Everything the relay needs to follow a page
 * to its Turtle comes through this file, which keeps the relay's import surface for the whole
 * concern in one place.
 */
export {
  alternateTurtleHref,
  alternateTurtleUrl,
  followAlternateTurtle,
  looksLikeHtml,
  type FetchedRepresentation,
} from '@interego/core';
