/**
 * The tools this vertical has promoted, read through the substrate's neutral extension contract.
 *
 * ★ THIS IS WHERE THE VOCABULARY LIVES (#367). The MCP relay used to carry this reading itself:
 * it scanned a configured pod for `urn:graph:ac:tool:` rows, regexed the DESCRIPTOR for
 * `a ac:AgentTool`, `rdfs:label` and `iep:action`, and registered each hit as a callable
 * `dynamic:<label>` alias outside its declared tool surface. Read against what `promoteTool` and
 * `authorTool` actually write, it matched nothing: promotions describe `urn:graph:ac:tool-attested:`
 * graphs, authored tools are Hypothetical, and the type, label and action are in the graph
 * PAYLOAD, never in the descriptor. So the relay's copy was vocabulary in the substrate that also
 * did not work.
 *
 * Here the vertical states its own reading, as an `ExtensionProfile`, and the substrate's
 * `loadExtensionCatalog` does the parts no vertical should rewrite: the whole manifest, verified
 * candidates, unambiguous action identity, a content digest, and refusal instead of a partial
 * answer.
 *
 *   - A PROMOTION is a row describing a `urn:graph:ac:tool-attested:` graph, Asserted, whose
 *     payload asserts an `ac:AgentTool` attested from an authored tool.
 *   - Its OPERATION is that authored tool's affordance: the action it declares, its label as the
 *     title, the affordance's comment as the description, and the authored descriptor as the
 *     place it is defined (its source atom is in that graph). Authored tools carry no
 *     `hydra:target`, so an operation here is something to dereference, not something the relay
 *     can run; the relay never executes a pod's code.
 *   - A promotion that names a tool this pod does not author, or whose payload does not say what
 *     its row claims, refuses the load: the catalog would otherwise lack a tool the pod
 *     promoted, and nothing would say so.
 */

import {
  loadExtensionCatalog,
  ExtensionLoadRefused,
  type ExtensionCatalog,
  type ExtensionOperationDraft,
  type ExtensionProfile,
} from '@interego/solid';

const AC_NS = 'https://markjspivey-xwisee.github.io/interego/applications/agent-collective/ac#';

/** The profile's name: what it recognises is a promoted `ac:AgentTool`. */
export const PROMOTED_TOOL_PROFILE = `${AC_NS}AgentTool`;

const PROMOTED_GRAPH = 'urn:graph:ac:tool-attested:';
const AUTHORED_GRAPH = 'urn:graph:ac:tool:';

/** A Turtle string literal's value, from its escaped body (the escapes `escapeLit` writes). */
function literal(body: string): string {
  return body.replace(/\\(["\\nrt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

const LITERAL = '"((?:[^"\\\\]|\\\\.)*)"';

export const promotedToolProfile: ExtensionProfile = {
  id: PROMOTED_TOOL_PROFILE,
  // A promotion is published Asserted; an authored tool stays Hypothetical until one exists.
  selects: entry => entry.modalStatus === 'Asserted' && entry.describes.some(g => g.startsWith(PROMOTED_GRAPH)),

  async interpret(candidate): Promise<ExtensionOperationDraft> {
    const promotion = await candidate.readPayload(candidate.entry.descriptorUrl);
    const attested = /<([^>]+)>\s+a\s+ac:AgentTool\b[\s\S]*?ac:attestedFrom\s+<([^>]+)>/.exec(promotion);
    if (!attested || !/iep:modalStatus\s+iep:Asserted\b/.test(promotion)) {
      throw new Error('the promotion\'s payload does not assert an ac:AgentTool attested from an authored tool');
    }
    const toolIri = attested[2]!;
    // authorTool names a tool `urn:iep:tool:<name>:<id>` and describes it in `urn:graph:ac:tool:<id>`.
    const toolId = toolIri.split(':').pop() ?? '';
    const authoredRow = candidate.rows.find(r => r.describes.includes(`${AUTHORED_GRAPH}${toolId}`));
    if (!authoredRow) throw new ExtensionLoadRefused('incomplete', `the promotion attests ${toolIri}, which this pod's manifest does not list`);

    const authored = await candidate.readPayload(authoredRow.descriptorUrl);
    const subject = [...authored.matchAll(/<([^>]+)>\s+a\s+ac:AgentTool\b/g)].find(m => m[1] === toolIri);
    if (!subject) throw new Error(`the authored tool's payload does not describe ${toolIri} as an ac:AgentTool`);
    const block = authored.slice(subject.index);
    const label = new RegExp(`rdfs:label\\s+${LITERAL}`).exec(block)?.[1];
    const affordance = /iep:affordance\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? '';
    const action = /iep:action\s+<([^>]+)>/.exec(affordance)?.[1];
    const comment = new RegExp(`rdfs:comment\\s+${LITERAL}`).exec(affordance)?.[1];
    if (label === undefined || action === undefined) {
      throw new Error(`the authored tool ${toolIri} declares no label or no affordance action`);
    }
    return {
      action,
      title: literal(label),
      description: comment !== undefined ? literal(comment) : `A promoted agent tool: ${literal(label)}.`,
      definedBy: authoredRow.descriptorUrl,
    };
  },
};

/** Every tool promoted in `podUrl`, complete and verified, or `ExtensionLoadRefused`. */
export function discoverPromotedTools(
  podUrl: string,
  fetch?: typeof globalThis.fetch,
): Promise<ExtensionCatalog> {
  return loadExtensionCatalog(podUrl, promotedToolProfile, fetch ? { fetch: fetch as never } : {});
}

/** A refusal typed so the bridge's dispatcher answers it with a refusing status. */
export interface PromotedToolsRefusal {
  readonly kind: 'refusal';
  readonly 'iep:refusalStatus': 422 | 502;
  readonly reason: string;
  readonly error: string;
}

/**
 * The bridge's answer: the catalog, or its refusal. A read that failed is not a thing that is
 * missing, so an unreadable pod answers 502; a pod whose promotions cannot form one complete,
 * unambiguous catalog answers 422.
 */
export async function promotedToolsAnswer(
  podUrl: string,
  fetch?: typeof globalThis.fetch,
): Promise<ExtensionCatalog | PromotedToolsRefusal> {
  try {
    return await discoverPromotedTools(podUrl, fetch);
  } catch (e) {
    if (!(e instanceof ExtensionLoadRefused)) throw e;
    return { kind: 'refusal', 'iep:refusalStatus': e.reason === 'incomplete' ? 502 : 422, reason: e.reason, error: e.message };
  }
}
