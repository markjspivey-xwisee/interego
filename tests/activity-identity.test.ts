/**
 * Guard for the xAPI Activity-identity migration (bare urn → dereferenceable bridge URL).
 * The instrumentation now mints `object.id` as a URL under the bridge that resolves to the
 * Activity Definition. This asserts the mint form, lossless round-trip of an instance that is
 * itself a URL / colon-bearing DID, and that EVERY category the instrumentation emits has a
 * served Definition (mint ⇄ resolver never drift). No `sameActivity` is asserted because
 * competency aggregation keys on object.definition.type, not object.id, and there is no
 * exact-object.id match site — so no match-side dual-read exists to guard.
 */
import { describe, it, expect } from 'vitest';
import { activityIri, isActivityIri, activityRefOf, ACTIVITY_DEFINITIONS } from '../applications/foxxi-content-intelligence/src/activity-identity.js';

const BASE = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi/activity';

describe('xAPI activity identity — urn → dereferenceable URL', () => {
  it('mints a category-only (static) activity URL', () => {
    expect(activityIri('assignments-catalog')).toBe(`${BASE}/assignments-catalog`);
    expect(activityRefOf(`${BASE}/assignments-catalog`)).toEqual({ category: 'assignments-catalog' });
  });

  it('mints a category+instance URL and recovers both, even when the instance is itself a URL', () => {
    const courseUrl = 'https://foxxi-bridge.interego.xwisee.com/agent/scorm/course/abc';
    const id = activityIri('question', courseUrl);
    expect(id).toBe(`${BASE}/question/${encodeURIComponent(courseUrl)}`);
    expect(activityRefOf(id)).toEqual({ category: 'question', instance: courseUrl });
  });

  it('losslessly round-trips a colon-bearing DID instance', () => {
    const did = 'did:ethr:0x8f3b';
    const id = activityIri('wallet-clr', did);
    expect(activityRefOf(id)).toEqual({ category: 'wallet-clr', instance: did });
  });

  it('recognizes the URL form and rejects the legacy urn / unrelated ids', () => {
    expect(isActivityIri(`${BASE}/retrieval/x`)).toBe(true);
    expect(isActivityIri('urn:foxxi:retrieval:x')).toBe(false);
    expect(isActivityIri('https://example.com/x')).toBe(false);
  });

  it('every emitted category has a served Definition (mint ⇄ resolver coherence)', () => {
    for (const category of ['assignments-catalog', 'question', 'question-agentic', 'retrieval', 'credential', 'wallet-clr', 'framework-alignment', 'task']) {
      expect(ACTIVITY_DEFINITIONS[category]).toBeDefined();
      expect(ACTIVITY_DEFINITIONS[category]!.type).toMatch(/^https?:\/\//);
    }
  });
});
