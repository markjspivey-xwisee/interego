/**
 * The bridge's grading tag: computed over the fields that make a result what it is, carried on
 * the statement, and recognised only when the result is as graded.
 */
import { describe, expect, it } from 'vitest';
import { GRADED_TAG_EXT, gradedFields, gradedTag, isGradedBy, withGradedTag } from '../src/graded-evidence.js';

const KEY = 'a-secret-only-the-bridge-holds';
const passed = {
  id: 'urn:uuid:1', version: '2.0.0',
  actor: { objectType: 'Agent', account: { homePage: 'did:web:foxxi.example', name: 'https://gate.example/u-eth-1/profile/card#me' } },
  verb: { id: 'http://adlnet.gov/expapi/verbs/passed' },
  object: { objectType: 'Activity', id: 'https://bridge.example/agent/scorm/course/golf-explained' },
  result: { success: true, completion: true, score: { scaled: 0.85 } },
  context: { extensions: { 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#contextKind': 'training' } },
  timestamp: '2026-09-24T10:00:00.000Z',
};

describe('the grading tag', () => {
  it('is recognised on the statement it was computed for, and keeps the other extensions', () => {
    const tagged = withGradedTag(passed, KEY);
    expect(isGradedBy(tagged, KEY)).toBe(true);
    const ext = (tagged.context as { extensions: Record<string, string> }).extensions;
    expect(ext['https://foxxi-bridge.interego.xwisee.com/ns/foxxi#contextKind']).toBe('training');
    expect(ext[GRADED_TAG_EXT]).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is not recognised when the result, the subject or the key differs, nor when it is absent or made up', () => {
    const tagged = withGradedTag(passed, KEY);
    expect(isGradedBy({ ...tagged, result: { success: true, score: { scaled: 0.95 } } }, KEY)).toBe(false);
    expect(isGradedBy({ ...tagged, actor: { account: { homePage: 'did:web:foxxi.example', name: 'someone-else' } } }, KEY)).toBe(false);
    expect(isGradedBy(tagged, 'another key')).toBe(false);
    expect(isGradedBy(passed, KEY)).toBe(false);
    expect(isGradedBy({ ...passed, context: { extensions: { [GRADED_TAG_EXT]: 'deadbeef' } } }, KEY)).toBe(false);
    expect(isGradedBy({ ...passed, context: { extensions: { [GRADED_TAG_EXT]: gradedTag(passed, KEY).replace(/^./, 'f') } } }, KEY)).toBe(false);
  });
  it('covers who, the verb, the activity, the score, the success and the time', () => {
    expect(gradedFields(passed).split('\n')).toEqual(['urn:uuid:1', 'did:web:foxxi.example|https://gate.example/u-eth-1/profile/card#me', 'http://adlnet.gov/expapi/verbs/passed', 'https://bridge.example/agent/scorm/course/golf-explained', '0.85', 'true', '2026-09-24T10:00:00.000Z']);
  });
});
