/**
 * A descriptor @type the bridge emits must be an absolute URL that dereferences.
 *
 * ★ WHY. foxxi.register_tutor_agent returned `{'@type': ['fxa:TutorAgentProfile']}`. `fxa:`
 * named vocab.foxximediums.com — retired by cd143e9, deleted by eea4b9d. That consolidation
 * repointed 44 occurrences of the BASE URL across 17 files; a hardcoded prefixed name carries
 * no base, so a search-and-replace over the base could not see this one. Every sibling type
 * (TenantMetadata / AdaptiveSequencingPolicy / PackageUpload) was written as
 * `${FOXXI_NS}<Name>` and migrated for free.
 *
 * It never failed loudly. Measured with the repo's jsonld processor, that descriptor expands
 * to `?s rdf:type <fxa:TutorAgentProfile>` — an IRI under an invented scheme. The handler's
 * own note tells the caller to publish the descriptor to their pod, so the dangling identifier
 * gets written into a pod graph and stays there.
 *
 * server.ts exports nothing and calls app.listen at module scope, so it cannot be imported —
 * these assert over its source, the same way declared-but-unimplemented.test.ts does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOXXI_NS, lookupTerm, renderTermJsonLd } from '../src/foxxi-vocab.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8');

describe('an emitted descriptor @type is a declared, dereferenceable term', () => {
  it('no handler emits a RETIRED fx*: prefixed name as a JSON-LD @type', () => {
    // Scoped to the retired prefixes on purpose. The one other CURIE @type in server.ts
    // (skos:Concept / ler:CompetencyDefinition) ships a sibling @context that maps both
    // prefixes, so it is honest linked data and is deliberately not flagged.
    // Comment lines are dropped first. The comment ABOVE the fixed emission quotes the
    // defect verbatim (`'@type':['fxa:TutorAgentProfile']`) so a reader knows what was
    // wrong — and without this the guard scored its own explanation as a live emission
    // and stayed red over correct code. A guard a comment can trip is a guard that gets
    // deleted.
    const code = SERVER.split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const retired = [...code.matchAll(/'@type':\s*\[([^\]]*)\]/g)]
      .flatMap(m => [...m[1]!.matchAll(/'(fx[a-z]+:[^']+)'/g)].map(x => x[1]!));
    expect(retired, 'emit `${FOXXI_NS}<Term>` — an absolute URL — never a prefixed name')
      .toEqual([]);
  });

  it('register_tutor_agent emits a type IRI that resolves to a real definition', () => {
    expect(SERVER, 'the tutor profile type must be composed from FOXXI_NS')
      .toContain("'@type': [`${FOXXI_NS}TutorAgentProfile`]");
    // Emitting the URL is only half of it: the URL has to answer for itself. Both projections
    // are driven by FOXXI_TERMS, so this is what makes GET /ns/foxxi/term/TutorAgentProfile
    // stop being a 404.
    expect(lookupTerm('TutorAgentProfile'), 'declare it in FOXXI_TERMS or the IRI 404s')
      .toBeTruthy();
    expect(renderTermJsonLd('TutorAgentProfile'), 'the term resource must render, not 404')
      .not.toBeNull();
    expect(FOXXI_NS.startsWith('https://')).toBe(true);
  });
});
