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
 * ★ WHAT IS NOT RE-EXPORTED HERE, DELIBERATELY. @interego/core also carries
 * `alternateTurtleUrl` (resolve relative, refuse cross-origin) and `followAlternateTurtle` (one
 * bounded hop). `fetchShapeBody` in `server.ts` still does its own hop, because its hop is
 * entangled with the shape cache's last-known-good fallback and its fetch is
 * `guardedInvokeFetch` — the SSRF guard every caller-URL fetch in that file goes through.
 * Rewiring a live publish gate is a change with its own blast radius and its own test surface;
 * what mattered was that the two readers share ONE parser of the markup, which they now do.
 * A round that moves the relay onto the bounded follower should note that the follower refuses
 * a cross-origin alternate and `fetchShapeBody` currently does not.
 */
export {
  alternateTurtleHref,
  looksLikeHtml,
} from '@interego/core';
