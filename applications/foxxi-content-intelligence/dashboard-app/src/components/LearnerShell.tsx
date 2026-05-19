import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Pill, Button, Stat } from './common.js';
import { ChatPanel } from './ChatPanel.js';
import { SlideNavigator } from './SlideNavigator.js';
import { ConceptNetwork } from './ConceptNetwork.js';
import { LrsAdminPanel } from './LrsAdminPanel.js';
import { discoverAssignedCourses, getCourseContent, type DiscoverAssignedCoursesResult } from '../interego/client.js';
import type { CourseContent, EnrolledCourse } from '../types.js';
import type { FoxxiSession } from '../auth/session.js';

export function LearnerShell({ session }: { session: FoxxiSession }) {
  const params = useParams();
  const navigate = useNavigate();
  const openCourseId = (params.courseId as string | undefined) ?? null;
  const setOpenCourseId = (id: string | null) => navigate(id ? `/learner/courses/${id}` : '/learner');
  const [enrollments, setEnrollments] = useState<DiscoverAssignedCoursesResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await discoverAssignedCourses({
          learnerWebId: session.webId,
          tenantPodUrl: session.tenantPodUrl,
        });
        if (!cancelled) setEnrollments(r);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [session.webId, session.tenantPodUrl]);

  const courseContent: CourseContent | undefined =
    openCourseId ? getCourseContent(openCourseId) : undefined;
  const [navConceptId, setNavConceptId] = useState<string | null>(null);
  const [navSlideId, setNavSlideId] = useState<string | null>(null);

  return (
    <div style={{ maxWidth: 980, margin: '24px auto', padding: 20 }}>
      <Card title={`Welcome, ${session.name}`}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Audience tags: {session.audienceTags.map(t => (
            <span key={t} style={{ marginRight: 6 }}><Pill>{t}</Pill></span>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
          Identity: <code>{session.webId}</code>
        </div>
      </Card>

      <Card title="Your assigned courses" right={<Pill tone="accent">foxxi.discover_assigned_courses</Pill>}>
        {error && <div style={{ color: 'var(--bad)' }}>✗ {error}</div>}
        {!enrollments && !error && <div style={{ color: 'var(--text-dim)' }}>Loading…</div>}
        {enrollments && enrollments.enrollments.length === 0 && (
          <div style={{ color: 'var(--text-dim)' }}>
            No assignments matched your audience tags. (The L&D admin assigns courses via policy descriptors
            that target audience groups — your tags determine which apply.)
          </div>
        )}
        {enrollments && enrollments.enrollments.length > 0 && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
              Substrate matched {enrollments.enrollments.length} policy assignment{enrollments.enrollments.length === 1 ? '' : 's'} for your audience tags
              {' '}across {new Set(enrollments.enrollments.map(e => e.courseId)).size} course{new Set(enrollments.enrollments.map(e => e.courseId)).size === 1 ? '' : 's'}.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {groupByCourse(enrollments.enrollments).map(group => (
                <CourseRow key={group.courseId} group={group} canOpen={!!getCourseContent(group.courseId)} onOpen={() => setOpenCourseId(group.courseId)} session={session} />
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Learning engineers get the same LRS-admin view as L&D admins — cohort
          analytics + xAPI conformance + statement browsing is the LE's core
          surface (the ICICLE "data-informed decision making" leg). */}
      {session.audienceTags?.includes('learning-engineering') && (
        <LrsAdminPanel bearer={session.bearerToken} />
      )}

      {openCourseId && (
        <div>
          {!courseContent ? (
            <Card title={`Course content unavailable for ${openCourseId}`}>
              <div style={{ color: 'var(--text-dim)' }}>
                The dashboard ships sample course content only for lessons that the parser has fully
                processed (golf-explained by default). In a production deployment the substrate fetches the
                parsed course via <code>discover_context</code> against the tenant pod's published
                fxs/fxk descriptors.
              </div>
              <Button onClick={() => setOpenCourseId(null)} style={{ marginTop: 12 }}>Back</Button>
            </Card>
          ) : (
            <>
              <Card title={courseContent.title}
                right={<Button small onClick={() => setOpenCourseId(null)}>← Course list</Button>}>
                <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                  Authoritative source: <code>{courseContent.authoritativeSource}</code>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4 }}>
                  Course IRI: <code>{courseContent.courseIri}</code>
                </div>
                {courseContent.packageMeta && (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>
                    {courseContent.packageMeta.authoring_tool}
                    {courseContent.packageMeta.standard && <> · {courseContent.packageMeta.standard}</>}
                    {courseContent.packageMeta.authoring_version && <> · v{courseContent.packageMeta.authoring_version}</>}
                    {courseContent.packageMeta.parser_version && <> · parser {courseContent.packageMeta.parser_version}</>}
                  </div>
                )}
                {/* Stat strip — mirrors the originals' SCENES / SLIDES / CONCEPTS / EDGES / MOD-OF strip */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                  gap: 12, marginTop: 16,
                }}>
                  <Stat label="Scenes" value={courseContent.scenes?.length ?? '—'} />
                  <Stat label="Slides" value={courseContent.slides?.length ?? '—'} />
                  <Stat label="Concepts" value={courseContent.concepts.length} tone="accent" />
                  <Stat label="Prereq edges" value={courseContent.prereqEdges?.length ?? '—'} />
                  <Stat label="Transcripts" value={Object.keys(courseContent.transcripts).length} />
                </div>
              </Card>
              <ConceptNetwork
                concepts={courseContent.concepts}
                prereqEdges={courseContent.prereqEdges ?? []}
                slides={courseContent.slides ?? []}
                selectedSlideId={navSlideId}
                selectedConceptId={navConceptId}
                onSelectConcept={setNavConceptId}
                onJumpToSlide={sid => setNavSlideId(sid)}
              />
              <SlideNavigator
                course={courseContent}
                externalSelectedSlideId={navSlideId}
                externalSelectedConceptId={navConceptId}
                onSlideChange={setNavSlideId}
                onConceptChange={setNavConceptId}
              />
              <ChatPanel learnerDid={session.webId} course={courseContent} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

const SCORM_PLAYER_BASE = 'https://interego-foxxi-scorm-player.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const BRIDGE_BASE_FOR_PLAYER = import.meta.env.VITE_FOXXI_BRIDGE_URL ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';

function buildPlayerUrl(courseId: string, session: { webId: string; name: string; bearerToken: string }): string {
  const u = new URL(SCORM_PLAYER_BASE);
  u.searchParams.set('bridge', BRIDGE_BASE_FOR_PLAYER);
  u.searchParams.set('bearer', session.bearerToken);
  u.searchParams.set('learner_did', session.webId);
  u.searchParams.set('learner_name', session.name);
  u.searchParams.set('course_id', courseId);
  return u.toString();
}

interface CourseGroup {
  courseId: string;
  courseTitle: string;
  category: string;
  policies: EnrolledCourse[];
  /** Strongest requirement across all matching policies — drives headline status. */
  headlineRequirement: 'required' | 'recommended' | 'optional';
  /** Worst lifecycle state across all matching policies (overdue > pending > completed). */
  headlineStatus: 'overdue' | 'pending' | 'completed';
}

function groupByCourse(enrollments: readonly EnrolledCourse[]): CourseGroup[] {
  const byId = new Map<string, EnrolledCourse[]>();
  for (const e of enrollments) {
    const list = byId.get(e.courseId) ?? [];
    list.push(e);
    byId.set(e.courseId, list);
  }
  const requirementRank: Record<string, number> = { required: 3, recommended: 2, optional: 1 };
  const statusRank: Record<string, number> = { overdue: 3, pending: 2, completed: 1 };
  return [...byId.entries()].map(([courseId, policies]) => {
    const first = policies[0]!;
    const headlineRequirement = policies
      .map(p => p.requirementType)
      .sort((a, b) => (requirementRank[b] ?? 0) - (requirementRank[a] ?? 0))[0] as CourseGroup['headlineRequirement'];
    const headlineStatus = policies
      .map(p => p.status)
      .sort((a, b) => (statusRank[b] ?? 0) - (statusRank[a] ?? 0))[0] as CourseGroup['headlineStatus'];
    return { courseId, courseTitle: first.courseTitle, category: first.category, policies, headlineRequirement, headlineStatus };
  });
}

function CourseRow({ group, canOpen, onOpen, session }: { group: CourseGroup; canOpen: boolean; onOpen: () => void; session?: FoxxiSession }) {
  const playable = group.courseId === 'golf-explained';
  const headlineTone = group.headlineStatus === 'completed' ? 'good'
    : group.headlineStatus === 'overdue' ? 'bad'
    : group.headlineRequirement === 'required' ? 'bad' : 'neutral';
  const headlineLabel = group.headlineRequirement === 'required' ? 'Required' : group.headlineRequirement === 'recommended' ? 'Recommended' : 'Optional';
  return (
    <div style={{
      padding: 12, background: 'var(--panel-2)',
      borderRadius: 6, border: '1px solid var(--border)',
    }}>
      {/* Headline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>{group.courseTitle}</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{group.category}</div>
        </div>
        <Pill tone={headlineTone}>{headlineLabel}{group.policies.length > 1 ? ` + ${group.policies.length - 1}` : ''}</Pill>
        {playable && session && (
          <Button
            primary
            onClick={() => window.open(buildPlayerUrl(group.courseId, session), '_blank', 'noopener')}
            title="Open the course in a new tab. The player emits live xAPI 2.0 statements to Foxxi-as-LRS."
          >
            ▶ Launch
          </Button>
        )}
        <Button onClick={onOpen} disabled={!canOpen} primary={!playable && canOpen}>
          {canOpen ? 'Open & ask' : 'Open'}
        </Button>
      </div>
      {/* Per-policy detail — each line is one matching assignment */}
      <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {group.policies.map(p => <PolicyLine key={p.policyId} p={p} />)}
      </div>
    </div>
  );
}

function PolicyLine({ p }: { p: EnrolledCourse }) {
  const isOverdue = p.status === 'overdue';
  const isCompleted = p.status === 'completed';
  const reqColor = p.requirementType === 'required' ? 'var(--bad)'
    : p.requirementType === 'recommended' ? 'var(--warn)' : 'var(--text-dim)';
  const statusColor = isCompleted ? 'var(--good)'
    : isOverdue ? 'var(--bad)' : 'var(--text-dim)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
      <span style={{ color: reqColor, fontWeight: 600, minWidth: 100 }}>{p.requirementType}</span>
      <span style={{ color: 'var(--text-dim)', flex: 1 }}>
        assigned {p.assignedAt}{p.dueAt ? ' · due ' + p.dueAt : ''}
      </span>
      <span style={{ color: statusColor, fontWeight: 500 }}>
        {p.status}{p.completedAt ? ' ' + p.completedAt : ''}
      </span>
    </div>
  );
}
