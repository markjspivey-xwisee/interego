/**
 * THE ACTIONS THIS VERTICAL DEFINES — what an agent can be asked to do IN A WORKSPACE.
 *
 * ★ WHY THE CONSTANT IS HERE AND NOT BESIDE THE AFFORDANCE MANIFEST. Four things now name this
 * action: the bridge's affordance manifest, the capability document an agent publishes about
 * itself, the desktop shell that publishes one, and any caller invoking it. Three of those are
 * bundled for a browser or an Electron renderer and cannot reach `applications/…/affordances.ts`
 * without crossing a `rootDir` — so the constant lived in the one place two of its readers could
 * not import, and the alternative on offer was a second spelling of it. A second spelling of an
 * action IRI is an affordance published at an id nobody selects.
 *
 * ★ AND IT IS A URL, MINTED RATHER THAN TYPED. It was `urn:iep:action:wsp:respond-as-member`, and
 * `capabilitiesFromAffordances` drops any action that is not `http(s)` — correctly, because an
 * unfollowable capability advertised on a card is a promise the substrate cannot keep, but it
 * drops it with a bare `continue`. So the one thing a workspace agent can be asked to do vanished
 * from every per-agent card with no error anywhere, and A2A peers reading that card concluded the
 * agent could do nothing at all. `actionUrl` mints the URL form from the legacy one, so this string
 * and the resolver's idea of it cannot disagree, and `sameAction` still selects it by the urn — so
 * nothing that already invokes it stops working.
 */

// The NARROW subpath. `@interego/core` reaches SPARQL, SHACL and `node:crypto`; this module is
// bundled into a browser page and an Electron renderer, so the barrel is not importable here.
import { actionUrl } from '@interego/core/action';

export { actionUrl, actionUrn, actionKey, sameAction } from '@interego/core/action';

/**
 * Ask an agent to read a workspace channel and, if it judges there is something to add, append one
 * entry to its OWN log on its own pod.
 *
 * The input is deliberately thin — the workspace, and nothing else. A caller who could pass text
 * would be the author, and the agent would be a signature on somebody else's sentence.
 */
export const RESPOND_AS_MEMBER = actionUrl('urn:iep:action:wsp:respond-as-member');
