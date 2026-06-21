/**
 * Tests for the static ontology loaders and the canonical .ttl files
 * under docs/ns/.
 *
 * These tests verify three things:
 *   1. Every ontology named in ONTOLOGY_MANIFEST loads successfully.
 *   2. Every .ttl file parses as syntactically valid Turtle.
 *   3. The key concepts mentioned in each ontology are actually present
 *      (prevents silent drift between the TypeScript types and the Turtle).
 *   4. loadFullOntology / loadFullShapes return the concatenation of
 *      their component files.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import {
  getOntologyManifest,
  loadFullOntology,
  loadFullShapes,
  loadOntology,
  ONTOLOGY_MANIFEST,
  type OntologyName,
} from '@interego/pgsl';

/** Parse a Turtle string and return the number of quads, or throw. */
function parseTtl(ttl: string): number {
  const parser = new Parser();
  return parser.parse(ttl).length;
}

describe('static ontology manifest', () => {
  it('lists all nine ontology files', () => {
    const names = ONTOLOGY_MANIFEST.map(e => e.name).sort();
    expect(names).toEqual([
      'alignment',
      'harness',
      'harness-shapes',
      'iep',
      'iep-shapes',
      'interego',
      'interego-shapes',
      'pgsl',
      'pgsl-shapes',
    ]);
  });

  it('assigns a unique namespace to every non-shapes ontology', () => {
    const ontologies = ONTOLOGY_MANIFEST.filter(e => e.kind === 'ontology');
    const namespaces = new Set(ontologies.map(e => e.namespace));
    expect(namespaces.size).toBe(ontologies.length);
  });

  it('getOntologyManifest returns a matching entry', () => {
    const entry = getOntologyManifest('pgsl');
    expect(entry.name).toBe('pgsl');
    expect(entry.prefix).toBe('pgsl');
    expect(entry.namespace).toContain('pgsl#');
  });

  it('getOntologyManifest throws on unknown name', () => {
    expect(() => getOntologyManifest('nonexistent' as OntologyName)).toThrow();
  });
});

describe('static ontology files exist and parse as Turtle', () => {
  for (const entry of ONTOLOGY_MANIFEST) {
    it(`${entry.name}.ttl parses without errors`, () => {
      const ttl = loadOntology(entry.name);
      expect(ttl.length).toBeGreaterThan(100);
      const triples = parseTtl(ttl);
      expect(triples).toBeGreaterThan(0);
    });
  }
});

describe('iep.ttl — key concepts present', () => {
  const ttl = loadOntology('iep');

  it('declares the ContextDescriptor class', () => {
    expect(ttl).toMatch(/iep:ContextDescriptor\s+a\s+owl:Class/);
  });

  it('declares all seven facet types', () => {
    for (const facet of [
      'TemporalFacet',
      'ProvenanceFacet',
      'AgentFacet',
      'AccessControlFacet',
      'SemioticFacet',
      'TrustFacet',
      'FederationFacet',
    ]) {
      expect(ttl).toContain(`iep:${facet}`);
    }
  });

  it('declares the four composition operators', () => {
    for (const op of ['union', 'intersection', 'restriction', 'override']) {
      expect(ttl).toMatch(new RegExp(`iep:${op}\\s+a\\s+iep:CompositionOperator`));
    }
  });
});

describe('pgsl.ttl — key concepts present', () => {
  const ttl = loadOntology('pgsl');

  it('declares Node, Atom, Fragment', () => {
    expect(ttl).toMatch(/pgsl:Node\s+a\s+owl:Class/);
    expect(ttl).toMatch(/pgsl:Atom\s+a\s+owl:Class/);
    expect(ttl).toMatch(/pgsl:Fragment\s+a\s+owl:Class/);
  });

  it('marks Atom and Fragment as disjoint', () => {
    expect(ttl).toContain('owl:disjointWith pgsl:Fragment');
  });

  it('declares the pullback square structure', () => {
    expect(ttl).toContain('pgsl:PullbackSquare');
    for (const prop of ['apex', 'leftConstituent', 'rightConstituent', 'overlap']) {
      expect(ttl).toMatch(new RegExp(`pgsl:${prop}\\s+a`));
    }
  });

  it('aligns atoms with prov:Entity', () => {
    expect(ttl).toContain('prov:Entity');
  });
});

describe('harness.ttl — key concepts present', () => {
  const ttl = loadOntology('harness');

  it('declares the six built-in AATs', () => {
    for (const aat of ['Observer', 'Analyst', 'Executor', 'Arbiter', 'Archivist', 'FullAccess']) {
      expect(ttl).toContain(`ieh:${aat} a ieh:AbstractAgentType`);
    }
  });

  it('declares the deontic SKOS concept scheme', () => {
    expect(ttl).toContain('ieh:DeonticMode');
    for (const mode of ['Permit', 'Deny', 'Duty']) {
      expect(ttl).toContain(`ieh:${mode} a skos:Concept`);
    }
  });

  it('declares the confidence level SKOS concept scheme', () => {
    expect(ttl).toContain('ieh:ConfidenceLevel');
    for (const level of ['HighConfidence', 'MediumConfidence', 'LowConfidence', 'Uncertain']) {
      expect(ttl).toContain(`ieh:${level}`);
    }
  });

  it('declares the four eval actions', () => {
    for (const action of ['Accept', 'Retry', 'Escalate', 'Abstain']) {
      expect(ttl).toContain(`ieh:${action}`);
    }
  });

  it('declares the four decision strategies', () => {
    for (const strat of ['Exploit', 'Explore', 'Delegate']) {
      expect(ttl).toContain(`ieh:${strat}`);
    }
  });

  it('extends PROV-O for ProvTrace', () => {
    expect(ttl).toMatch(/ieh:ProvTrace\s+a\s+owl:Class\s*;\s*rdfs:subClassOf\s+prov:Activity/);
  });

  it('aligns Affordance with Hydra', () => {
    expect(ttl).toContain('hydra:Operation');
  });
});

describe('alignment.ttl — cross-layer axioms present', () => {
  const ttl = loadOntology('alignment');

  it('imports all three layer ontologies', () => {
    expect(ttl).toContain('pgsl#');
    expect(ttl).toContain('/iep#');
    expect(ttl).toContain('harness#');
  });

  it('declares integration patterns as a SKOS concept scheme', () => {
    expect(ttl).toContain('align:IntegrationPattern');
    for (const pattern of [
      'TracedAnswerPattern',
      'TrustedRetrievalPattern',
      'ArbitratedCompositionPattern',
      'AuditedPublicationPattern',
      'FederatedObservationPattern',
    ]) {
      expect(ttl).toContain(`align:${pattern}`);
    }
  });

  it('declares disjointness between context facets and PGSL nodes', () => {
    expect(ttl).toContain('iep:ContextFacet owl:disjointWith pgsl:Node');
  });

  it('declares PROV-O subClassOf relations for harness activities', () => {
    expect(ttl).toContain('ieh:ProvTrace rdfs:subClassOf prov:Activity');
    expect(ttl).toContain('ieh:RuntimeEval rdfs:subClassOf prov:Activity');
  });
});

describe('pgsl-shapes.ttl — key SHACL shapes present', () => {
  const ttl = loadOntology('pgsl-shapes');
  it('targets Atom, Fragment, and PullbackSquare', () => {
    expect(ttl).toContain('sh:targetClass pgsl:Atom');
    expect(ttl).toContain('sh:targetClass pgsl:Fragment');
    expect(ttl).toContain('sh:targetClass pgsl:PullbackSquare');
  });
  it('requires prov:wasAttributedTo on atoms and fragments', () => {
    expect(ttl).toContain('prov:wasAttributedTo');
  });
});

describe('harness-shapes.ttl — key SHACL shapes present', () => {
  const ttl = loadOntology('harness-shapes');
  it('targets AAT, PolicyRule, PolicyDecision, ProvTrace, RuntimeEval', () => {
    expect(ttl).toContain('sh:targetClass ieh:AbstractAgentType');
    expect(ttl).toContain('sh:targetClass ieh:PolicyRule');
    expect(ttl).toContain('sh:targetClass ieh:PolicyDecision');
    expect(ttl).toContain('sh:targetClass ieh:ProvTrace');
    expect(ttl).toContain('sh:targetClass ieh:RuntimeEval');
  });
  it('bounds confidence to [0.0, 1.0]', () => {
    expect(ttl).toContain('sh:minInclusive "0.0"^^xsd:double');
    expect(ttl).toContain('sh:maxInclusive "1.0"^^xsd:double');
  });
});

describe('interego.ttl — interrogatives core', () => {
  const ttl = loadOntology('interego');

  it('declares Interrogative as a SKOS concept scheme', () => {
    expect(ttl).toContain('ie:Interrogative a owl:Class , skos:ConceptScheme');
  });

  it('declares all eleven canonical interrogatives', () => {
    for (const interrogative of [
      'Who',
      'What',
      'Where',
      'When',
      'Why',
      'How',
      'Which',
      'WhatKind',
      'HowMuch',
      'Whose',
      'Whether',
    ]) {
      expect(ttl).toContain(`ie:${interrogative} a skos:Concept`);
    }
  });

  it('declares Act as a subclass of prov:Activity', () => {
    expect(ttl).toMatch(/ie:Act\s+a\s+owl:Class\s*;\s*rdfs:subClassOf\s+prov:Activity/);
  });

  it('declares Response as a subclass of prov:Entity', () => {
    expect(ttl).toMatch(/ie:Response\s+a\s+owl:Class\s*;\s*rdfs:subClassOf\s+prov:Entity/);
  });

  it('declares the Peircean triad (Sign, Object, Interpretant)', () => {
    expect(ttl).toContain('ie:Sign a owl:Class');
    expect(ttl).toContain('ie:Object a owl:Class');
    expect(ttl).toContain('ie:Interpretant a owl:Class');
  });

  it('declares Signification with emergesFrom and improvisesOn', () => {
    expect(ttl).toContain('ie:Signification a owl:Class');
    expect(ttl).toContain('ie:emergesFrom');
    expect(ttl).toContain('ie:improvisesOn');
  });

  it('enforces agent-relativity of Interpretants via functional forAgent', () => {
    expect(ttl).toMatch(/ie:forAgent\s+a\s+owl:ObjectProperty\s*,\s*owl:FunctionalProperty/);
  });
});

describe('interego-shapes.ttl — interrogatives SHACL shapes', () => {
  const ttl = loadOntology('interego-shapes');

  it('targets Act, Response, Sign, Interpretant, Signification', () => {
    expect(ttl).toContain('sh:targetClass ie:Act');
    expect(ttl).toContain('sh:targetClass ie:Response');
    expect(ttl).toContain('sh:targetClass ie:Sign');
    expect(ttl).toContain('sh:targetClass ie:Interpretant');
    expect(ttl).toContain('sh:targetClass ie:Signification');
  });

  it('requires posedBy on every Act', () => {
    expect(ttl).toMatch(/sh:path ie:posedBy\s*;[^.]*sh:minCount 1/);
  });

  it('bounds Response confidence to [0,1]', () => {
    expect(ttl).toContain('sh:path ie:confidence');
    expect(ttl).toContain('sh:minInclusive "0.0"^^xsd:double');
    expect(ttl).toContain('sh:maxInclusive "1.0"^^xsd:double');
  });
});

describe('loadFullOntology and loadFullShapes', () => {
  it('loadFullOntology returns a concatenation of the five ontology files', () => {
    const full = loadFullOntology();
    expect(parseTtl(full)).toBeGreaterThan(1000);
    // Should contain concepts from every layer
    expect(full).toContain('ie:Interrogative');
    expect(full).toContain('iep:ContextDescriptor');
    expect(full).toContain('pgsl:Atom');
    expect(full).toContain('ieh:AbstractAgentType');
    expect(full).toContain('align:IntegrationPattern');
  });

  it('loadFullShapes returns a concatenation of the three shapes files', () => {
    const full = loadFullShapes();
    expect(parseTtl(full)).toBeGreaterThan(400);
    expect(full).toContain('sh:targetClass ie:Act');
    expect(full).toContain('sh:targetClass pgsl:Atom');
    expect(full).toContain('sh:targetClass ieh:ProvTrace');
  });
});
