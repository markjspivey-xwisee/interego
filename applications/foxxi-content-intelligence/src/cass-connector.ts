/**
 * ADL CaSS (Competency and Skills System) REST connector.
 *
 * CaSS is an open-source competency runtime. This connector pushes the
 * tenant's competency framework + assertions to a CaSS server, so
 * downstream CaSS-integrated tooling can query learner competencies
 * without re-implementing the Foxxi vocab.
 *
 * Two endpoints used (per CaSS REST API v1.4):
 *   - POST /api/framework  — create/replace a competency framework
 *                            from a CASE 1.0 JSON-LD CFDocument
 *   - POST /api/assertion  — assert a learner has competency C at
 *                            proficiency P with evidence E
 *
 * CaSS accepts CASE 1.0 framework imports natively, so the bridge can
 * compose the existing case-exporter output directly. No new
 * vocab; pure adapter.
 *
 * Standards reference:
 *   - CaSS REST API (https://www.cassproject.org/docs/api)
 *   - 1EdTech CASE 1.0
 */

import type { CaseDocument } from './case-exporter.js';
import { safeFetch } from './ssrf-guard.js';

export interface CassConfig {
  /** CaSS server base URL (e.g. https://cass.example.org). */
  endpoint: string;
  /** Bearer token for authenticated calls. */
  bearer?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CassFrameworkPushResult {
  status: 'created' | 'updated' | 'failed';
  frameworkUrl?: string;
  error?: string;
}

export async function pushFrameworkToCass(framework: CaseDocument, config: CassConfig): Promise<CassFrameworkPushResult> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.bearer) headers['Authorization'] = `Bearer ${config.bearer}`;
  try {
    // safeFetch guards the caller-supplied CaSS endpoint (no allowlist) + refuses a
    // redirect on this POST (round-28 SSRF hardening; admin-gated but still caller-URL).
    const r = await safeFetch(`${config.endpoint.replace(/\/$/, '')}/api/framework`, {
      method: 'POST', headers,
      body: JSON.stringify(framework),
    }, fetchFn as never);
    if (!r.ok) return { status: 'failed', error: `CaSS POST /api/framework: ${r.status} ${r.statusText}` };
    const body = await r.json().catch(() => ({})) as { id?: string; uri?: string };
    return { status: 'created', frameworkUrl: body.uri ?? body.id ?? `${config.endpoint}/api/framework/${framework.identifier}` };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}

export interface CassAssertion {
  /** Learner DID / WebID. */
  subject: string;
  /** Competency CFItem URI from the framework. */
  competency: string;
  /** Proficiency level label (matches a CASE CFRubricCriterionLevel.quality). */
  level: 'Novice' | 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
  /** Optional confidence score (0..1). */
  confidence?: number;
  /** Evidence URI (e.g. a Foxxi xAPI Statement IRI or pod descriptor IRI). */
  evidence?: string;
  /** Issuer DID (institutional issuer that made the assertion). */
  issuer: string;
  /** ISO 8601 timestamp of the assertion. */
  asserted: string;
}

export interface CassAssertionPushResult {
  status: 'asserted' | 'failed';
  assertionUrl?: string;
  error?: string;
}

export async function pushAssertionToCass(assertion: CassAssertion, config: CassConfig): Promise<CassAssertionPushResult> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.bearer) headers['Authorization'] = `Bearer ${config.bearer}`;
  try {
    const r = await safeFetch(`${config.endpoint.replace(/\/$/, '')}/api/assertion`, {
      method: 'POST', headers,
      body: JSON.stringify(assertion),
    }, fetchFn as never);
    if (!r.ok) return { status: 'failed', error: `CaSS POST /api/assertion: ${r.status} ${r.statusText}` };
    const body = await r.json().catch(() => ({})) as { id?: string; uri?: string };
    return { status: 'asserted', assertionUrl: body.uri ?? body.id };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}
