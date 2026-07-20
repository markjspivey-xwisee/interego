/**
 * Regression guard for the action-identity dual-read (urn ↔ dereferenceable URL).
 *
 * The migration hinges on `sameAction` treating both forms as equal so a caller selecting
 * an affordance by the legacy urn still resolves a URL-form descriptor (and vice versa).
 * If the bijection or the equality breaks, affordance-follow (follow.ts) silently stops
 * matching migrated descriptors. These tests fail before that can ship.
 */
import { describe, it, expect } from 'vitest';
import { actionUrl, actionUrn, actionKey, sameAction, isActionIri } from '@interego/core';

const urn = 'urn:iep:action:foxxi:scorm-launch-signed';
const url = 'https://relay.interego.xwisee.com/ns/iep/action/foxxi/scorm-launch-signed';

describe('action identity — urn ↔ URL dual-read', () => {
  it('mints the URL form from the urn, and back, losslessly', () => {
    expect(actionUrl(urn)).toBe(url);
    expect(actionUrn(url)).toBe(urn);
    expect(actionUrl(actionUrn(url))).toBe(url);
    expect(actionUrn(actionUrl(urn))).toBe(urn);
  });

  it('sameAction treats the two forms of ONE action as equal', () => {
    expect(sameAction(urn, url)).toBe(true);
    expect(sameAction(url, urn)).toBe(true);
    expect(sameAction(urn, urn)).toBe(true);
  });

  it('sameAction distinguishes different actions', () => {
    expect(sameAction(urn, 'urn:iep:action:foxxi:record-performance-signed')).toBe(false);
    expect(sameAction(url, 'https://relay.interego.xwisee.com/ns/iep/action/foxxi/other')).toBe(false);
  });

  it('shares one scheme-independent key across forms', () => {
    expect(actionKey(urn)).toBe('foxxi/scorm-launch-signed');
    expect(actionKey(url)).toBe('foxxi/scorm-launch-signed');
  });

  it('handles kernel verbs the same way', () => {
    const kv = 'urn:iep:action:kernel:dereference';
    expect(sameAction(kv, actionUrl(kv))).toBe(true);
    expect(actionKey(kv)).toBe('kernel/dereference');
  });

  it('recognizes both forms as action IRIs, and rejects unrelated URLs', () => {
    expect(isActionIri(urn)).toBe(true);
    expect(isActionIri(url)).toBe(true);
    expect(isActionIri('https://example.com/not-an-action')).toBe(false);
    expect(isActionIri('urn:foxxi:course:X')).toBe(false);
  });
});
