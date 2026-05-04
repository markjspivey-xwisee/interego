/**
 * Compliance overlay — substrate-pure construction tests.
 *
 * Locks the descriptor + graph shape so a regression in modal-status
 * mapping, control-IRI defaulting, or framework citation surfaces
 * immediately.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAgentActionDescriptor,
  type AgentActionEvent,
} from '../src/index.js';
import {
  parseTrig,
  findSubjectsOfType,
  readStringValue,
  type IRI,
} from '../../../src/index.js';

const AGENT = 'did:web:agent.example' as IRI;
const OWNER = 'did:web:owner.example' as IRI;

const ACTION_TYPE = 'https://markjspivey-xwisee.github.io/interego/ns/harness#AgentAction' as IRI;

function baseEvent(overrides: Partial<AgentActionEvent> = {}): AgentActionEvent {
  return {
    toolName: 'web_browser.fetch',
    args: { url: 'https://example.com', timeout: 5000 },
    resultSummary: 'Fetched 12kb of HTML',
    outcome: 'success',
    durationMs: 421,
    agentDid: AGENT,
    onBehalfOf: OWNER,
    sessionId: 'sess-abc',
    ...overrides,
  };
}

describe('buildAgentActionDescriptor — substrate construction', () => {
  it('produces a typed descriptor with the canonical facet stack', () => {
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act' });
    // Slug normalization: underscores and dots in the tool name become hyphens
    // for URN-segment safety. So "web_browser.fetch" → "web-browser-fetch".
    expect(out.eventIri).toMatch(/^urn:cg:agent-action:web-browser-fetch:[0-9a-f]{16}$/);
    const facetTypes = out.descriptor.facets.map(f => f.type).sort();
    expect(facetTypes).toContain('Agent');
    expect(facetTypes).toContain('Trust');
    expect(facetTypes).toContain('Provenance');
    expect(facetTypes).toContain('Temporal');
    expect(facetTypes).toContain('Semiotic');
  });

  it('maps outcome to modal status correctly', () => {
    const success = buildAgentActionDescriptor(baseEvent({ outcome: 'success' }), { framework: 'eu-ai-act' });
    const failure = buildAgentActionDescriptor(baseEvent({ outcome: 'failure', errorMessage: 'timeout' }), { framework: 'eu-ai-act' });
    const partial = buildAgentActionDescriptor(baseEvent({ outcome: 'partial' }), { framework: 'eu-ai-act' });

    function modal(b: ReturnType<typeof buildAgentActionDescriptor>): string {
      const s = b.descriptor.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
      return s.modalStatus ?? '';
    }
    expect(modal(success)).toBe('Asserted');
    expect(modal(failure)).toBe('Counterfactual');
    expect(modal(partial)).toBe('Hypothetical');
  });

  it('attributes to the owner when onBehalfOf is set, agent appears as wasAssociatedWith', () => {
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act' });
    expect(out.graphContent).toMatch(/wasAttributedTo>\s*<did:web:owner\.example>/);
    expect(out.graphContent).toMatch(/wasAssociatedWith>\s*<did:web:agent\.example>/);
  });

  it('defaults controls to the full framework table when none specified', () => {
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'soc2' });
    expect(out.cited.length).toBeGreaterThan(0);
    // Every cited control IRI is in the soc2 namespace
    expect(out.cited.every(c => c.includes('soc2'))).toBe(true);
  });

  it('honors explicit control overrides', () => {
    const customControl = 'https://markjspivey-xwisee.github.io/interego/ns/soc2#CC8.1' as IRI;
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'soc2', controls: [customControl] });
    expect(out.cited).toEqual([customControl]);
    expect(out.graphContent).toContain(customControl);
  });

  it('emits parseable RDF', () => {
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act' });
    const doc = parseTrig(out.graphContent);
    const subjects = findSubjectsOfType(doc, ACTION_TYPE);
    expect(subjects).toHaveLength(1);
    const subj = subjects[0]!;
    // toolName goes via rdfs:label (W3C — composes; no new cgh: term)
    expect(readStringValue(subj, 'http://www.w3.org/2000/01/rdf-schema#label' as IRI)).toBe('web_browser.fetch');
    expect(readStringValue(subj, 'https://markjspivey-xwisee.github.io/interego/ns/harness#outcome' as IRI)).toBe('success');
  });

  it('content-addresses by event fingerprint — same input → same IRI', () => {
    const a = buildAgentActionDescriptor(baseEvent({ startedAt: '2026-05-04T10:00:00Z', endedAt: '2026-05-04T10:00:01Z' }), { framework: 'eu-ai-act' });
    const b = buildAgentActionDescriptor(baseEvent({ startedAt: '2026-05-04T10:00:00Z', endedAt: '2026-05-04T10:00:01Z' }), { framework: 'eu-ai-act' });
    expect(a.eventIri).toBe(b.eventIri);
  });

  it('different outcome → different IRI even with the same args', () => {
    const ts = { startedAt: '2026-05-04T10:00:00Z', endedAt: '2026-05-04T10:00:01Z' };
    const success = buildAgentActionDescriptor(baseEvent({ outcome: 'success', ...ts }), { framework: 'eu-ai-act' });
    const failure = buildAgentActionDescriptor(baseEvent({ outcome: 'failure', ...ts }), { framework: 'eu-ai-act' });
    expect(success.eventIri).not.toBe(failure.eventIri);
  });

  it('records args by default, redacts when recordArgs:false', () => {
    const recorded = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act' }, { recordArgs: true });
    const redacted = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act' }, { recordArgs: false });
    expect(recorded.graphContent).toContain('toolArgs');
    expect(redacted.graphContent).not.toContain('toolArgs');
    // Hash differs because the fingerprint differs
    expect(recorded.eventIri).not.toBe(redacted.eventIri);
  });

  it('emits dct:conformsTo for every cited control', () => {
    const c1 = 'https://markjspivey-xwisee.github.io/interego/ns/eu-ai-act#Article15' as IRI;
    const c2 = 'https://markjspivey-xwisee.github.io/interego/ns/eu-ai-act#Article10' as IRI;
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act', controls: [c1, c2] });
    const conformsCount = (out.graphContent.match(/conformsTo>/g) ?? []).length;
    expect(conformsCount).toBe(2);
  });

  it('records error message on failure (carried via dct:description; modal=Counterfactual disambiguates)', () => {
    const out = buildAgentActionDescriptor(
      baseEvent({ outcome: 'failure', errorMessage: 'connection refused on port 443' }),
      { framework: 'soc2' },
    );
    expect(out.graphContent).toContain('connection refused on port 443');
    expect(out.graphContent).toContain('description');
    // Modal status tells the auditor it's an error, not a result summary
    const semiotic = out.descriptor.facets.find(f => f.type === 'Semiotic') as { modalStatus?: string };
    expect(semiotic.modalStatus).toBe('Counterfactual');
  });

  it('emits PROV start/end timestamps', () => {
    const out = buildAgentActionDescriptor(
      baseEvent({ startedAt: '2026-05-04T10:00:00Z', endedAt: '2026-05-04T10:00:01Z' }),
      { framework: 'eu-ai-act' },
    );
    expect(out.graphContent).toContain('startedAtTime');
    expect(out.graphContent).toContain('endedAtTime');
    expect(out.graphContent).toContain('2026-05-04T10:00:00Z');
  });

  it('falls back to agent DID as owner when onBehalfOf is not set', () => {
    const out = buildAgentActionDescriptor(
      baseEvent({ onBehalfOf: undefined }),
      { framework: 'eu-ai-act' },
    );
    expect(out.graphContent).toMatch(/wasAttributedTo>\s*<did:web:agent\.example>/);
  });

  it('content-hash is included in the graph for tamper detection', () => {
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act' });
    expect(out.contentHash.length).toBe(64);
    expect(out.graphContent).toContain(out.contentHash);
  });
});
