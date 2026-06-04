/**
 * Cross-tenant competency-framework alignment (demo #2).
 *
 * A tenant declares that one of its own fxk:Skill or rcd:Competency
 * items is equivalent to (or implies / is implied by) an item in
 * another tenant's framework. The alignment is published as a normal
 * descriptor on the tenant's pod with a foxxi-side conformsTo tag
 * (fxa:CASEAlignment); cross-tenant resolution walks the discover()
 * graph filtered on that tag.
 *
 * 1EdTech CASE 1.0 already supports cross-framework `CFAssociation`
 * entries (associationType=isAlignedTo); this module emits them as
 * pod descriptors so an audit trail captures who declared the
 * equivalence + when. The CASE serializer (case-exporter.ts) then
 * lifts these into the exported CFDocument.
 */

import type {
  IRI,
} from '@interego/core';

export type AlignmentRelation =
  | 'isAlignedTo'
  | 'isEquivalentTo'
  | 'precedes'
  | 'isPrerequisiteOf'
  | 'broadens'
  | 'narrows';

export interface FrameworkAlignment {
  /** This tenant's competency / skill IRI. */
  ownItemIri: string;
  ownItemLabel: string;
  /** Other tenant's competency IRI. */
  otherItemIri: string;
  otherFrameworkIri: string;
  otherTenantDid?: string;
  relation: AlignmentRelation;
  /** Optional narrative explaining the equivalence. */
  rationale?: string;
  /** ISO 8601 — when this declaration takes effect. */
  declaredAt?: string;
}

export const ALIGNMENT_TYPE_IRI = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#CASEAlignment' as IRI;

export interface SerializedAlignment {
  '@type': 'CFAssociation';
  identifier: string;
  associationType: AlignmentRelation;
  originNode: { uri: string; label: string };
  destinationNode: { uri: string; frameworkUri: string; tenantDid?: string };
  rationale?: string;
  declaredAt: string;
}

export function serializeAlignment(a: FrameworkAlignment): SerializedAlignment {
  return {
    '@type': 'CFAssociation',
    identifier: 'align-' + hash(`${a.ownItemIri}|${a.otherItemIri}|${a.relation}`),
    associationType: a.relation,
    originNode: { uri: a.ownItemIri, label: a.ownItemLabel },
    destinationNode: {
      uri: a.otherItemIri,
      frameworkUri: a.otherFrameworkIri,
      ...(a.otherTenantDid ? { tenantDid: a.otherTenantDid } : {}),
    },
    ...(a.rationale ? { rationale: a.rationale } : {}),
    declaredAt: a.declaredAt ?? new Date().toISOString(),
  };
}

/**
 * Given the verifier's "I have completed THIS competency at THIS pod"
 * + the requirement "needs THIS other-framework competency", walk the
 * alignment graph + decide whether the held credential satisfies the
 * requirement transitively.
 */
export interface AlignmentResolution {
  satisfied: boolean;
  via: 'direct' | 'aligned' | 'unknown';
  /** Chain of alignments that connected the held credential to the requirement. */
  chain: SerializedAlignment[];
  rationale: string;
}

export function resolveAlignment(args: {
  heldCompetencyIri: string;
  requiredCompetencyIri: string;
  alignments: readonly SerializedAlignment[];
}): AlignmentResolution {
  if (args.heldCompetencyIri === args.requiredCompetencyIri) {
    return {
      satisfied: true,
      via: 'direct',
      chain: [],
      rationale: 'held competency IRI matches requirement directly',
    };
  }
  // BFS over the alignment graph (treat isAlignedTo / isEquivalentTo as bidirectional).
  type Edge = SerializedAlignment;
  const visited = new Set<string>();
  const queue: Array<{ node: string; chain: Edge[] }> = [{ node: args.heldCompetencyIri, chain: [] }];
  while (queue.length > 0) {
    const { node, chain } = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node === args.requiredCompetencyIri) {
      return {
        satisfied: true,
        via: 'aligned',
        chain,
        rationale: `held competency reached requirement via ${chain.length} alignment hop${chain.length === 1 ? '' : 's'}`,
      };
    }
    for (const edge of args.alignments) {
      if (edge.originNode.uri === node) {
        queue.push({ node: edge.destinationNode.uri, chain: [...chain, edge] });
      } else if (edge.destinationNode.uri === node && (edge.associationType === 'isAlignedTo' || edge.associationType === 'isEquivalentTo')) {
        // Symmetric edges allow backward traversal.
        queue.push({ node: edge.originNode.uri, chain: [...chain, edge] });
      }
    }
  }
  return {
    satisfied: false,
    via: 'unknown',
    chain: [],
    rationale: 'no alignment chain found from held competency to required competency',
  };
}

function hash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).padStart(8, '0');
}
