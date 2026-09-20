/**
 * This vertical's affordance declaration type: the monorepo's shared `Affordance` (so the
 * bridge derives MCP tool schemas and the manifest exactly as every other vertical does) plus
 * one field of its own — the SHACL input shape a follower validates a payload against
 * before acting.
 */

import type { Affordance as SharedAffordance, AffordanceInput, AffordanceOutput, McpToolAnnotations, AffordanceEvidenceSource } from '../../_shared/affordance-mcp/index.js';
import type { IRI } from '@interego/core';

export type { AffordanceInput, AffordanceOutput, McpToolAnnotations, AffordanceEvidenceSource };

export type Affordance = SharedAffordance & {
  /** The SHACL input shape a caller validates against (emitted as iep:inputShape). */
  readonly inputShape?: string;
};

/** Brand a canonical action IRI for the shared declaration type. */
export function actionIri(value: string): IRI {
  return value as IRI;
}
