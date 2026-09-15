/** Shared by the AGP authority and its FOXXI compatibility surface. */
import type { Affordance } from '../_shared/affordance-mcp/index.js';
import type { IRI } from '@interego/core';

export const interventionMethodAffordances: readonly Affordance[] = [
  {
    action: 'urn:iep:action:agp:read-intervention-methods' as IRI,
    toolName: 'agp.read_intervention_methods',
    title: 'Read performance consulting and intervention methods',
    description: 'Discover the versioned consulting and management cycle and the implementation method for each intervention. Profiles carry steps, revision links, required work products and evidence criteria. Contextualize and diagnose before choosing a method; gap analysis is Knowable-only.',
    method: 'GET', targetTemplate: '{base}/performance/methods', externallyRouted: true,
    mediaType: 'application/ld+json',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputs: [
      { name: 'method', type: 'string', required: false, description: 'Optional profile token or canonical IRI; omit for the catalogue. consulting is the full performance consulting and management cycle.' },
      { name: 'format', type: 'string', required: false, description: 'Representation to read.', enum: ['jsonld', 'markdown', 'turtle'] },
    ],
  },
  {
    action: 'urn:iep:action:agp:review-method-evidence' as IRI,
    toolName: 'agp.review_method_evidence',
    title: 'Check intervention method evidence coverage',
    description: 'Check supplied artifact pointers and notes against the selected method criteria. Returns missing-evidence or documented-unverified, coverage percent and missing work products. Does not inspect linked contents, approve quality, verify authorship, select an intervention or claim performance effects. No records are written.',
    method: 'POST', targetTemplate: '{base}/performance/methods/review', externallyRouted: true,
    mediaType: 'application/json',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputs: [
      { name: 'method', type: 'string', required: true, description: 'Method token or canonical IRI from the catalogue.' },
      { name: 'evidence', type: 'array', itemType: 'object', required: false, description: 'Up to 200 objects, each {criterion: exact criterion IRI from the profile, artifact: absolute http/https/urn IRI, note: non-empty explanation (max 2000 characters)}. Omit or send [] to see all missing evidence. Caller approval or verification flags are rejected.' },
    ],
  },
];
