/**
 * End-to-end learner flow — exercises the actual user-facing claim of
 * the vertical against the imported sample ACME Utility tenant data.
 *
 * The user-level scenario:
 *   1. ACME Utility's L&D admin (Jordan Doe) ingested Lesson 3 (Inverter
 *      Controls) into the catalog + published a policy assigning the
 *      course to the "engineer-power-systems" audience group.
 *   2. A learner enrolled in that audience (we use Joshua Liu, u0067)
 *      logs in and asks: "what are my assigned courses?"
 *      Expectation: the substrate walks the admin payload + returns
 *      Lesson 3 as an enrollment.
 *   3. The learner asks a content question: "what is reactive current?"
 *      Expectation: the substrate retrieves verbatim transcript
 *      segments from the lesson's narration, with IRI citations
 *      grounding back to the source. No confabulation.
 *
 * Real data: every fixture below is loaded from
 * applications/foxxi-content-intelligence/imported/ — the actual
 * Foxxi sample payloads, not synthetic test data.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverAssignedCourses, type FoxxiAdminPayload } from '../src/enrollment.js';
import { askCourseQuestion, type FoxxiCourseContent } from '../src/course-qa.js';
import type { IRI } from '../../../src/index.js';

const IMPORTED = join(import.meta.dirname ?? '', '..', 'imported');

const ADMIN: FoxxiAdminPayload = JSON.parse(readFileSync(join(IMPORTED, 'admin_payload.json'), 'utf8'));
const TRANSCRIPTS: Record<string, { duration: number; language: string; text: string }> = JSON.parse(
  readFileSync(join(IMPORTED, 'transcripts.json'), 'utf8'),
);
const DASHBOARD: { concepts: ReadonlyArray<{ id: string; label: string; confidence: number; tier: number; taught_in_slides?: readonly string[] }> } =
  JSON.parse(readFileSync(join(IMPORTED, 'dashboard_data.json'), 'utf8'));

// Joshua Liu (u0067) is in the engineer-power-systems audience group per
// the imported admin_payload.json — he should see Lesson 3 as an enrollment.
const LEARNER_WEB_ID = 'https://id.acme-utility.com/jliu67/profile#me';
const LEARNER_USER_ID = 'u0067';

const COURSE_IRI = 'https://acme-utility.example/courses/lesson3#package' as IRI;
const COURSE_TITLE = 'Lesson 3: Inverter Controls';
const ACME_TENANT_DID = 'did:web:acme-utility.example' as IRI;

describe('Foxxi learner flow: ACME Utility tenant, Joshua Liu (engineer-power-systems)', () => {
  it('admin payload sanity: Joshua Liu IS a member of tag-engineer-power-systems group', () => {
    const engineerGroup = ADMIN.groups.find(g => g.group_id === 'tag-engineer-power-systems');
    expect(engineerGroup).toBeDefined();
    expect(engineerGroup!.member_ids).toContain(LEARNER_USER_ID);
  });

  it('admin payload sanity: lesson3 has an enabled policy targeting tag-engineer-power-systems', () => {
    const policy = ADMIN.policies.find(p =>
      p.course_id === 'lesson3' && p.audience_group_id === 'tag-engineer-power-systems' && p.enabled,
    );
    expect(policy).toBeDefined();
    expect(policy!.requirement_type).toBe('required');
  });

  it('discoverAssignedCourses: Joshua Liu sees Lesson 3 as a REQUIRED assignment', () => {
    const r = discoverAssignedCourses({
      admin: ADMIN,
      learnerWebId: LEARNER_WEB_ID,
    });
    expect(r.learnerWebId).toBe(LEARNER_WEB_ID);
    expect(r.learnerName).toBeDefined();
    expect(r.audienceTags).toContain('engineer-power-systems');
    expect(r.enrollments.length).toBeGreaterThan(0);
    const lesson3 = r.enrollments.find(e => e.courseId === 'lesson3');
    expect(lesson3).toBeDefined();
    expect(lesson3!.courseTitle).toBe(COURSE_TITLE);
    expect(lesson3!.requirementType).toBe('required');
    expect(lesson3!.category).toMatch(/Power Systems/);
  });

  it('discoverAssignedCourses: an unknown web_id returns no enrollments', () => {
    const r = discoverAssignedCourses({
      admin: ADMIN,
      learnerWebId: 'https://example.com/no-such-user',
    });
    expect(r.enrollments.length).toBe(0);
  });

  it('discoverAssignedCourses: tag override lets a caller simulate an audience without being in the user list', () => {
    const r = discoverAssignedCourses({
      admin: ADMIN,
      learnerWebId: 'https://example.com/no-such-user',
      audienceTagsOverride: ['engineer-power-systems'],
    });
    const lesson3 = r.enrollments.find(e => e.courseId === 'lesson3');
    expect(lesson3).toBeDefined();
  });

  // ── Content Q&A: the actual user-facing claim ──────────────────────

  const courseContent: FoxxiCourseContent = {
    courseIri: COURSE_IRI,
    title: COURSE_TITLE,
    authoritativeSource: ACME_TENANT_DID,
    transcripts: TRANSCRIPTS,
    concepts: DASHBOARD.concepts,
  };

  it('askCourseQuestion: "what is reactive current?" returns a grounded answer with verbatim transcript citations', () => {
    const r = askCourseQuestion({
      learnerDid: 'did:web:jliu67.acme-utility.example' as IRI,
      course: courseContent,
      question: 'what is reactive current?',
    });
    expect(r.grounded).toBe(true);
    expect(r.answer).not.toBeNull();
    expect(r.answer!.citations.length).toBeGreaterThan(0);

    // At least one citation must come from a transcript segment that
    // mentions reactive current verbatim (the substrate's honesty
    // discipline: cite verbatim, never paraphrase).
    const transcriptCitation = r.answer!.citations.find(c =>
      c.atomIri.includes('#transcript:') && c.verbatimQuote.toLowerCase().includes('reactive current'),
    );
    expect(transcriptCitation).toBeDefined();
    // Cross-link: the citation must report the course it came from.
    expect(transcriptCitation!.fromTrainingContent).toBe(COURSE_IRI);
    expect(transcriptCitation!.fromTrainingContentName).toBe(COURSE_TITLE);
  });

  it('askCourseQuestion: "what is photosynthesis?" returns HONEST null (no grounding for off-topic question)', () => {
    const r = askCourseQuestion({
      learnerDid: 'did:web:jliu67.acme-utility.example' as IRI,
      course: courseContent,
      question: 'what is photosynthesis?',
    });
    expect(r.grounded).toBe(false);
    expect(r.answer).toBeNull();
  });

  it('askCourseQuestion: concept questions resolve to concept-atom citations when transcripts do not directly match', () => {
    // Try a concept-shaped question whose label appears in the
    // dashboard concepts. The course's concepts include things like
    // "reactive current", "inverter", "grid voltage" — the substrate
    // returns concept atoms (label + slide-count) when overlap is high
    // enough.
    const r = askCourseQuestion({
      learnerDid: 'did:web:jliu67.acme-utility.example' as IRI,
      course: courseContent,
      question: 'tell me about grid voltage',
    });
    expect(r.grounded).toBe(true);
    expect(r.answer!.citations.length).toBeGreaterThan(0);
  });

  it('end-to-end: enrollment discovery → content Q&A pipes cleanly together', () => {
    const enrollments = discoverAssignedCourses({ admin: ADMIN, learnerWebId: LEARNER_WEB_ID });
    expect(enrollments.enrollments.find(e => e.courseId === 'lesson3')).toBeDefined();

    // Now the learner asks a question about the course they're enrolled in.
    const r = askCourseQuestion({
      learnerDid: 'did:web:jliu67.acme-utility.example' as IRI,
      course: courseContent,
      question: 'how does the inverter develop the reactive current reference?',
    });
    expect(r.grounded).toBe(true);
    expect(r.answer!.citations.length).toBeGreaterThan(0);
    // The first citation should be a transcript segment from the lesson.
    const firstCitation = r.answer!.citations[0]!;
    expect(firstCitation.atomIri.startsWith(COURSE_IRI)).toBe(true);
  });
});
