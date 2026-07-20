/**
 * Guard for the competency-identity dual-read (urn ↔ dereferenceable URL). A credential
 * issued / an alignment written before the swap carries the legacy urn; sameCompetency
 * must treat both forms as one, or CLR matching + alignment lookups silently break after
 * the migration (the failure mode the audit caught in the course-id pass).
 */
import { describe, it, expect } from 'vitest';
import { competencyIri, competencyIdOf, sameCompetency, isCompetencyIri } from '../applications/foxxi-content-intelligence/src/competency-identity.js';

const urn = 'urn:foxxi:competency:content-authoring';
const url = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi/competency/content-authoring';

describe('competency identity — urn ↔ URL dual-read', () => {
  it('mints the URL and recovers the slug from either form', () => {
    expect(competencyIri('content-authoring')).toBe(url);
    expect(competencyIdOf(urn)).toBe('content-authoring');
    expect(competencyIdOf(url)).toBe('content-authoring');
  });
  it('sameCompetency treats the two forms as equal, distinguishes different competencies', () => {
    expect(sameCompetency(urn, url)).toBe(true);
    expect(sameCompetency(url, urn)).toBe(true);
    expect(sameCompetency(urn, 'urn:foxxi:competency:incident-containment')).toBe(false);
  });
  it('recognizes both forms and rejects unrelated ids', () => {
    expect(isCompetencyIri(urn)).toBe(true);
    expect(isCompetencyIri(url)).toBe(true);
    expect(isCompetencyIri('urn:foxxi:course:X')).toBe(false);
    expect(isCompetencyIri('https://example.com/x')).toBe(false);
  });
});
