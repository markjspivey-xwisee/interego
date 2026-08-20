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
  findSubjectsOfType,
  type IRI,
  parseTrig,
  readStringValue,
} from '@interego/core';
import { FRAMEWORK_CONTROLS, loadControlSet } from '@interego/compliance';

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
    expect(out.eventIri).toMatch(/^urn:iep:agent-action:web-browser-fetch:[0-9a-f]{16}$/);
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

  it('attributes the action to the AGENT, and states the principal as a per-act Delegation', () => {
    // ★ THIS TEST PINNED THE DEFECT. It read "attributes to the owner when onBehalfOf is set"
    // and asserted `wasAttributedTo <did:web:owner.example>` over a record of a TOOL CALL — an
    // act no human performed — while the descriptor's own Provenance facet named the agent.
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act' });
    expect(out.graphContent).toMatch(/wasAttributedTo>\s*<did:web:agent\.example>/);
    expect(out.graphContent).toMatch(/wasAssociatedWith>\s*<did:web:agent\.example>/);
    expect(out.graphContent).not.toMatch(/wasAttributedTo>\s*<did:web:owner\.example>/);
    const prov = out.descriptor.facets.find(f => f.type === 'Provenance') as { wasAttributedTo?: IRI };
    expect(prov.wasAttributedTo).toBe(AGENT);

    // ★ AND THE PRINCIPAL SURVIVES AS THE PER-ACT STATEMENT, NOT AS THE AUTHOR. `onBehalfOf` is
    // a field on the EVENT, so PROV's qualified form applies to THIS activity: a Delegation
    // whose `prov:agent` is the human and whose `prov:hadActivity` is this action. Scoped to
    // the event IRI itself, which is typed `prov:Activity`.
    expect(out.graphContent).toContain(`<${AGENT}> <http://www.w3.org/ns/prov#qualifiedDelegation> <${out.eventIri}#delegation>`);
    expect(out.graphContent).toMatch(/a <http:\/\/www\.w3\.org\/ns\/prov#Delegation>/);
    expect(out.graphContent).toContain(`#agent> <${OWNER}>`);
    expect(out.graphContent).toContain(`#hadActivity> <${out.eventIri}>`);
    // The standing fact is still on the Agent facet, and it is a different claim.
    const onBehalf = out.descriptor.facets
      .filter(f => f.type === 'Agent').map(f => (f as { onBehalfOf?: IRI }).onBehalfOf);
    expect(onBehalf).toContain(OWNER);
  });

  /**
   * ★ THIS PASSED IDENTICALLY BEFORE AND AFTER THE BEHAVIOUR IT GUARDS CHANGED.
   *
   * `resolveControls` was switched from the frozen `FRAMEWORK_CONTROLS` array to the framework's
   * published `iep:ControlSet`, so a wide citation now means "every control SOC 2 publishes" (25)
   * rather than "every control this build was compiled with" (16). The assertions here — non-empty,
   * and every IRI mentions `soc2` — held under both, so the call site's change was untested.
   *
   * The count and the named control below are exactly the difference: `soc2:P5.1` is published in
   * docs/ns/soc2.ttl and was absent from the frozen array, so it can only appear if the roster came
   * from the ontology.
   */
  it('defaults to every control the framework PUBLISHES, not the ones compiled in', () => {
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'soc2' });
    expect(out.cited.length).toBe(loadControlSet('soc2').controls.length);
    expect(out.cited.length).toBeGreaterThan(FRAMEWORK_CONTROLS['soc2'].length);
    expect(out.cited.every(c => c.includes('soc2'))).toBe(true);
    expect(
      out.cited.some(c => String(c).endsWith('#P5.1')),
      'soc2:P5.1 is published but was not in the frozen array — its absence means the wide '
        + 'citation is still being built from compiled-in controls',
    ).toBe(true);
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
    // toolName goes via rdfs:label (W3C — composes; no new ieh: term)
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

  /**
   * ★ THE TEST ABOVE GREPS `graphContent` ONLY, AND THAT IS EXACTLY WHY THE MIRROR WAS
   * MISSING FOR SO LONG.
   *
   * `dct:conformsTo` has to appear in TWO places to do anything: in the named graph, which
   * the test above checks, and on the DESCRIPTOR, which nothing checked. The manifest
   * indexer reads it off the descriptor; `discover()` returned `conformsTo: undefined`, the
   * relay mapped that to `evidenceForControls: []`, and `GET /audit/compliance/<framework>`
   * reported every control `missing` with `overallScore 0` for a pod whose descriptors did
   * cite them. The graph half was right the whole time, so the whole-graph grep was green
   * through the entire outage.
   *
   * Removing `.conformsTo(...cited)` from the builder, or passing `...[]` to it, is caught
   * here and nowhere else. The IRIs are compared by VALUE rather than counted, so a mirror
   * that carried the right number of wrong controls also fails.
   */
  it('mirrors every cited control onto the DESCRIPTOR, not only into the graph', () => {
    const c1 = 'https://markjspivey-xwisee.github.io/interego/ns/eu-ai-act#Article15' as IRI;
    const c2 = 'https://markjspivey-xwisee.github.io/interego/ns/eu-ai-act#Article10' as IRI;
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act', controls: [c1, c2] });
    expect(out.descriptor.conformsTo).toEqual([c1, c2]);
  });

  /**
   * The control for the assertion above: the mirror must carry the RESOLVED citation, not a
   * constant. Without this, `.conformsTo(SOME_FIXED_LIST)` satisfies the mirror test while
   * making every descriptor claim controls it has no evidence for — a compliance report that
   * is confidently wrong rather than empty.
   *
   * ★ AND `controls: []` DOES NOT MEAN "cite nothing" — it means "cite every default control
   * for the framework" (`resolveControls`, and `ComplianceCitation.controls`' own docstring).
   * The first version of this test asserted `[]` and failed against a correct implementation
   * with 8 defaulted controls. Pinning the mirror against `out.cited`, the builder's own
   * resolved list, is what states the real contract: the two must not be able to disagree.
   */
  it('the descriptor mirror equals the resolved citation, defaulted or explicit', () => {
    const defaulted = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act', controls: [] });
    expect(defaulted.cited.length).toBeGreaterThan(1); // else the check below is near-vacuous
    expect(defaulted.descriptor.conformsTo).toEqual([...defaulted.cited]);

    const explicit = buildAgentActionDescriptor(
      baseEvent(),
      { framework: 'soc2', controls: ['https://markjspivey-xwisee.github.io/interego/ns/soc2#CC7.2' as IRI] },
    );
    expect(explicit.descriptor.conformsTo).toEqual([...explicit.cited]);
    // Different frameworks must not converge on one hard-coded list.
    expect(explicit.descriptor.conformsTo).not.toEqual(defaulted.descriptor.conformsTo);
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

  it('states NEITHER footing when the runtime named no principal', () => {
    // Absence is a third answer. "The runtime did not say" and "the agent answered for this
    // alone" are different findings, so an unstated principal produces no Delegation AND no
    // `iep:actedOnOwnAccount` — and no self-referential standing delegation either, which is
    // what `onBehalfOf ?? agentDid` used to publish.
    const out = buildAgentActionDescriptor(
      baseEvent({ onBehalfOf: undefined }),
      { framework: 'eu-ai-act' },
    );
    expect(out.graphContent).toMatch(/wasAttributedTo>\s*<did:web:agent\.example>/);
    expect(out.graphContent).not.toContain('qualifiedDelegation');
    expect(out.graphContent).not.toContain('actedOnOwnAccount');
    const onBehalf = out.descriptor.facets
      .filter(f => f.type === 'Agent').map(f => (f as { onBehalfOf?: IRI }).onBehalfOf);
    expect(onBehalf.every(v => v === undefined)).toBe(true);
  });

  it('content-hash is included in the graph for tamper detection', () => {
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act' });
    expect(out.contentHash.length).toBe(64);
    expect(out.graphContent).toContain(out.contentHash);
  });
});

describe('buildAgentActionDescriptor — privacy preflight (onSensitiveArgs)', () => {
  // The compliance overlay is on the most common "secrets leaking into
  // audit logs" path: a runtime forwards tool args / result summary /
  // error message into a descriptor that gets signed + published. The
  // preflight stops the leak before the descriptor exists.

  it('blocks construction when args contain an API key (default policy)', () => {
    expect(() =>
      buildAgentActionDescriptor(
        baseEvent({ args: { authHeader: 'Bearer sk-ant-' + 'PLACEHOLDER_NOT_A_REAL_KEY_XYZ'.padEnd(30, 'X') } }),
        { framework: 'eu-ai-act' },
      ),
    ).toThrow(/sensitive content/i);
  });

  it('blocks construction when resultSummary contains a JWT', () => {
    // Synthetic JWT-shaped placeholder; matches `eyJ.eyJ.X+` but is
    // clearly not a real token (no real claim payload).
    const jwt = 'eyJ' + 'X'.repeat(30) + '.eyJ' + 'X'.repeat(30) + '.' + 'X'.repeat(40);
    expect(() =>
      buildAgentActionDescriptor(
        baseEvent({ resultSummary: `Got token back: ${jwt}` }),
        { framework: 'eu-ai-act' },
      ),
    ).toThrow(/sensitive content/i);
  });

  it('blocks construction when errorMessage contains a private key marker', () => {
    expect(() =>
      buildAgentActionDescriptor(
        baseEvent({ outcome: 'failure', errorMessage: '-----BEGIN PRIVATE KEY-----\nMIIEvQI...\n-----END PRIVATE KEY-----' }),
        { framework: 'eu-ai-act' },
      ),
    ).toThrow(/sensitive content/i);
  });

  it("'warn' policy surfaces flags on the result without throwing", () => {
    const out = buildAgentActionDescriptor(
      baseEvent({ args: { authHeader: 'Bearer sk-ant-' + 'PLACEHOLDER_NOT_A_REAL_KEY_XYZ'.padEnd(30, 'X') } }),
      { framework: 'eu-ai-act' },
      { onSensitiveArgs: 'warn' },
    );
    expect(out.sensitivityFlags).toBeDefined();
    expect(out.sensitivityFlags!.length).toBeGreaterThan(0);
    expect(out.sensitivityFlags!.some(f => f.severity === 'high')).toBe(true);
  });

  it("there is no 'allow' policy — compliance evidence cannot opt out of screening", () => {
    // Compliance evidence is the highest-stakes surface: a runtime
    // forwarding tool args into the audit trail with credentials inside
    // is the most common privacy-leak shape. There must be no escape
    // hatch; pre-screening pipelines should sanitize args BEFORE calling
    // buildAgentActionDescriptor. The default 'block' policy still
    // refuses construction on HIGH severity.
    expect(() =>
      buildAgentActionDescriptor(
        baseEvent({ args: { authHeader: 'Bearer sk-ant-' + 'PLACEHOLDER_NOT_A_REAL_KEY_XYZ'.padEnd(30, 'X') } }),
        { framework: 'eu-ai-act' },
      ),
    ).toThrow(/sensitive content/i);
  });

  it('benign args do not trigger any flags', () => {
    const out = buildAgentActionDescriptor(baseEvent(), { framework: 'eu-ai-act' });
    expect(out.sensitivityFlags).toBeUndefined();
  });

  it('recordArgs: false suppresses screening of args specifically (but still screens result/error)', () => {
    // Args have a secret but won't be recorded → don't screen them
    expect(() =>
      buildAgentActionDescriptor(
        baseEvent({ args: { authHeader: 'Bearer sk-ant-' + 'PLACEHOLDER_NOT_A_REAL_KEY_XYZ'.padEnd(30, 'X') } }),
        { framework: 'eu-ai-act' },
        { recordArgs: false },
      ),
    ).not.toThrow();
  });
});
