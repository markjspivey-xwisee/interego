/**
 * End-to-end learner flow — exercises the actual user-facing claim of
 * the vertical against the imported sample Acme Training Co tenant data.
 *
 * The user-level scenario:
 *   1. Acme Training Co's L&D admin (Jordan Doe) ingested Golf Explained
 *      into the catalog + published a policy assigning the
 *      course to the "engineering" audience group.
 *   2. A learner enrolled in that audience (we use Joshua Liu, u-joshua)
 *      logs in and asks: "what are my assigned courses?"
 *      Expectation: the substrate walks the admin payload + returns
 *      Golf Explained as an enrollment.
 *   3. The learner asks a content question: "what is handicap?"
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
import type { IRI } from '@interego/core';

const IMPORTED = join(import.meta.dirname ?? '', '..', 'imported');

const ADMIN: FoxxiAdminPayload = JSON.parse(readFileSync(join(IMPORTED, 'admin_payload.json'), 'utf8'));
const TRANSCRIPTS: Record<string, { duration: number; language: string; text: string }> = JSON.parse(
  readFileSync(join(IMPORTED, 'transcripts.json'), 'utf8'),
);
const DASHBOARD: { concepts: ReadonlyArray<{ id: string; label: string; confidence: number; tier: number; taught_in_slides?: readonly string[] }> } =
  JSON.parse(readFileSync(join(IMPORTED, 'dashboard_data.json'), 'utf8'));

// Joshua Liu (u-joshua) is in the engineering audience group per
// the imported admin_payload.json — he should see Golf Explained as an enrollment.
const LEARNER_WEB_ID = 'https://id.acme-training.example/jliu/profile#me';
const LEARNER_USER_ID = 'u-joshua';

const COURSE_IRI = 'https://acme-training.example/courses/golf-explained#package' as IRI;
const COURSE_TITLE = 'Golf Explained';
const ACME_TENANT_DID = 'did:web:acme-training.example' as IRI;

describe('Foxxi learner flow: Acme Training Co tenant, Joshua Liu (engineering)', () => {
  it('admin payload sanity: Joshua Liu IS a member of tag-engineering group', () => {
    const engineerGroup = ADMIN.groups.find(g => g.group_id === 'tag-engineering');
    expect(engineerGroup).toBeDefined();
    expect(engineerGroup!.member_ids).toContain(LEARNER_USER_ID);
  });

  it('admin payload sanity: golf-explained has an enabled policy targeting tag-engineering', () => {
    const policy = ADMIN.policies.find(p =>
      p.course_id === 'golf-explained' && p.audience_group_id === 'tag-engineering' && p.enabled,
    );
    expect(policy).toBeDefined();
    expect(policy!.requirement_type).toBe('required');
  });

  it('discoverAssignedCourses: Joshua Liu sees Golf Explained as a REQUIRED assignment', () => {
    const r = discoverAssignedCourses({
      admin: ADMIN,
      learnerWebId: LEARNER_WEB_ID,
    });
    expect(r.learnerWebId).toBe(LEARNER_WEB_ID);
    expect(r.learnerName).toBeDefined();
    expect(r.audienceTags).toContain('engineering');
    expect(r.enrollments.length).toBeGreaterThan(0);
    const golf = r.enrollments.find(e => e.courseId === 'golf-explained');
    expect(golf).toBeDefined();
    expect(golf!.courseTitle).toBe(COURSE_TITLE);
    expect(golf!.requirementType).toBe('required');
    expect(golf!.category).toMatch(/Onboarding/);
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
      audienceTagsOverride: ['engineering'],
    });
    const golf = r.enrollments.find(e => e.courseId === 'golf-explained');
    expect(golf).toBeDefined();
  });

  // ── Content Q&A: the actual user-facing claim ──────────────────────

  const courseContent: FoxxiCourseContent = {
    courseIri: COURSE_IRI,
    title: COURSE_TITLE,
    authoritativeSource: ACME_TENANT_DID,
    transcripts: TRANSCRIPTS,
    concepts: DASHBOARD.concepts,
  };

  it('askCourseQuestion: "what is handicap?" returns a grounded answer with verbatim transcript citations', () => {
    const r = askCourseQuestion({
      learnerDid: 'did:web:acme-training.example:jliu' as IRI,
      course: courseContent,
      question: 'what is handicap?',
    });
    expect(r.grounded).toBe(true);
    expect(r.answer).not.toBeNull();
    expect(r.answer!.citations.length).toBeGreaterThan(0);

    // At least one citation must come from a transcript segment that
    // mentions handicap verbatim (the substrate's honesty
    // discipline: cite verbatim, never paraphrase).
    const transcriptCitation = r.answer!.citations.find(c =>
      c.atomIri.includes('#transcript:') && c.verbatimQuote.toLowerCase().includes('handicap'),
    );
    expect(transcriptCitation).toBeDefined();
    // Cross-link: the citation must report the course it came from.
    expect(transcriptCitation!.fromTrainingContent).toBe(COURSE_IRI);
    expect(transcriptCitation!.fromTrainingContentName).toBe(COURSE_TITLE);
  });

  it('askCourseQuestion: "what is photosynthesis?" returns HONEST null (no grounding for off-topic question)', () => {
    const r = askCourseQuestion({
      learnerDid: 'did:web:acme-training.example:jliu' as IRI,
      course: courseContent,
      question: 'what is photosynthesis?',
    });
    expect(r.grounded).toBe(false);
    expect(r.answer).toBeNull();
  });

  it('askCourseQuestion: concept questions resolve to concept-atom citations when transcripts do not directly match', () => {
    // Try a concept-shaped question whose label appears in the
    // dashboard concepts. The course's concepts include things like
    // "handicap", "golf", "course par" — the substrate
    // returns concept atoms (label + slide-count) when overlap is high
    // enough.
    const r = askCourseQuestion({
      learnerDid: 'did:web:acme-training.example:jliu' as IRI,
      course: courseContent,
      question: 'tell me about course par',
    });
    expect(r.grounded).toBe(true);
    expect(r.answer!.citations.length).toBeGreaterThan(0);
  });

  it('end-to-end: enrollment discovery → content Q&A pipes cleanly together', () => {
    const enrollments = discoverAssignedCourses({ admin: ADMIN, learnerWebId: LEARNER_WEB_ID });
    expect(enrollments.enrollments.find(e => e.courseId === 'golf-explained')).toBeDefined();

    // Now the learner asks a question about the course they're enrolled in.
    const r = askCourseQuestion({
      learnerDid: 'did:web:acme-training.example:jliu' as IRI,
      course: courseContent,
      question: 'how is a handicap calculated?',
    });
    expect(r.grounded).toBe(true);
    expect(r.answer!.citations.length).toBeGreaterThan(0);
    // The first citation should be a transcript segment from the lesson.
    const firstCitation = r.answer!.citations[0]!;
    expect(firstCitation.atomIri.startsWith(COURSE_IRI)).toBe(true);
  });
});
