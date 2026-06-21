import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { courseSlugToOpaque, courseOpaqueToSlug, userIdToUuid } from '../identifiers.js';
import { useHypermedia, fetchHypermedia, expandTemplatedLink, type HypermediaItem } from '../hypermedia.js';
import { Card, Pill, Button, Stat } from './common.js';
import { ChatPanel } from './ChatPanel.js';
import { SlideNavigator } from './SlideNavigator.js';
import { ConceptNetwork } from './ConceptNetwork.js';
import { LrsAdminPanel } from './LrsAdminPanel.js';
import { LearnerRecordPanel } from './LearnerRecordPanel.js';
import { getCourseContent } from '../interego/client.js';
import type { CourseContent, EnrolledCourse } from '../types.js';

// Hypermedia-driven enrollments — the LearnerShell no longer calls an
// MCP tool by name. It traverses the affordance graph: entry-point →
// profile-resource → _embedded.enrollments. Per the Amundsen / RESTful
// Web APIs Ch. 5 pattern, the client follows links the server emits
// rather than constructing URLs itself.
interface HypermediaEnrollments {
  learnerWebId: string;
  learnerName?: string;
  audienceTags: string[];
  enrollments: EnrolledCourse[];
}
import type { FoxxiSession } from '../auth/session.js';

export function LearnerShell({ session }: { session: FoxxiSession }) {
  const params = useParams();
  const navigate = useNavigate();
  // URL carries the opaque course id (UUID). Resolve to the underlying
  // slug for data lookups (getCourseContent etc.).
  const opaqueFromUrl = (params.courseId as string | undefined) ?? null;
  const openCourseId = opaqueFromUrl ? (courseOpaqueToSlug(opaqueFromUrl) ?? opaqueFromUrl) : null;
  const setOpenCourseId = (slug: string | null) =>
    navigate(slug ? `/courses/${courseSlugToOpaque(slug)}` : `/profiles/${userIdToUuid(session.userId)}`);
  const [enrollments, setEnrollments] = useState<HypermediaEnrollments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { entry, error: entryError } = useHypermedia();

  useEffect(() => {
    let cancelled = false;
    if (entryError) { setError(`hypermedia entry-point: ${entryError}`); return; }
    if (!entry) return; // wait for /api/foxxi/v1 to land
    (async () => {
      try {
        // Discover the profiles collection URL from the entry point —
        // not hardcoded. Append the caller's wallet-derived UUID; the
        // server resolves it to the underlying user record.
        const profilesUrl = entry._links.profiles?.href;
        if (!profilesUrl) throw new Error('entry-point lacks profiles _link');
        const profileUrl = `${profilesUrl}/${userIdToUuid(session.userId)}`;
        const profile = await fetchHypermedia<HypermediaItem<unknown> & {
          name?: string;
          web_id?: string;
          _embedded?: {
            enrollments?: EnrolledCourse[];
            enrollmentsCount?: number;
            audienceTags?: string[];
          };
        }>(profileUrl, session.bearerToken);
        if (!cancelled) {
          setEnrollments({
            learnerWebId: (profile.web_id ?? session.webId) as string,
            learnerName: profile.name as string | undefined,
            audienceTags: profile._embedded?.audienceTags ?? session.audienceTags,
            enrollments: profile._embedded?.enrollments ?? [],
          });
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [entry, entryError, session.userId, session.bearerToken, session.webId, session.audienceTags]);

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

      {/* The learner's IEEE P2997 Enterprise Learner Record — experiences,
          competencies, credentials, provenance — assembled via hypermedia. */}
      <LearnerRecordPanel session={session} />

      {/* Learning engineers get the same LRS-admin view as L&D admins — cohort
          analytics + xAPI conformance + statement browsing is the LE's core
          surface (the ICICLE "data-informed decision making" leg). */}
      {session.audienceTags?.includes('learning-engineering') && (
        <LrsAdminPanel bearer={session.bearerToken} isAdmin={session.role === 'admin'} />
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

// Sample-mode fallback only — production uses the server-supplied `launch`
// Hydra IriTemplate discovered on each enrollment via the hypermedia
// profile fetch. The dashboard never constructs player URLs from scratch
// when the bridge is reachable.
const SCORM_PLAYER_BASE_FALLBACK = 'https://interego-foxxi-scorm-player.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const BRIDGE_BASE_FALLBACK = import.meta.env.VITE_FOXXI_BRIDGE_URL ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';

async function buildPlayerUrlFromGroup(group: CourseGroup, session: { webId: string; name: string; bearerToken: string }): Promise<string> {
  // Prefer the server-emitted `launch` Hydra IriTemplate on the first
  // matching policy (HATEOAS — the dashboard expands the template the
  // server gave it, iterating its declared variable mapping rather than
  // reconstructing the player URL by string concatenation). The template
  // declares `code` as `fromExchange`, so expansion mints a one-time
  // launch code — the long-lived bearer never enters the URL.
  const launch = group.policies.find(p => p._links?.launch)?._links?.launch;
  if (launch) {
    return expandTemplatedLink(launch, {
      bearerToken: session.bearerToken,
      actorDid: session.webId,
      actorName: session.name,
    });
  }
  // Offline-sample fallback: synthesize locally so the dashboard stays
  // demonstrable without the bridge.
  const u = new URL(SCORM_PLAYER_BASE_FALLBACK);
  u.searchParams.set('bridge', BRIDGE_BASE_FALLBACK);
  u.searchParams.set('bearer', session.bearerToken);
  u.searchParams.set('learner_did', session.webId);
  u.searchParams.set('learner_name', session.name);
  u.searchParams.set('course_id', group.courseId);
  return u.toString();
}

/**
 * Launch a course in a new tab. The player URL is resolved
 * asynchronously (the launch template mints a one-time code), so the
 * popup is opened *synchronously first* — inside the click gesture, to
 * survive popup blockers — and navigated once the URL is ready.
 */
async function launchCourse(group: CourseGroup, session: { webId: string; name: string; bearerToken: string }): Promise<void> {
  const popup = window.open('about:blank', '_blank');
  if (popup) {
    popup.document.write('<!doctype html><meta charset="utf-8"><title>Preparing course…</title><body style="font-family:system-ui,sans-serif;padding:2rem;color:#444">Preparing your course…</body>');
  }
  try {
    const url = await buildPlayerUrlFromGroup(group, session);
    if (popup) popup.location.href = url;
    else window.open(url, '_blank', 'noopener'); // popup was blocked — best-effort retry
  } catch (err) {
    const msg = (err as Error).message;
    if (popup) {
      popup.document.body.innerHTML =
        `<p style="color:#b00">Could not start the course.</p><pre style="white-space:pre-wrap">${msg}</pre>`;
    }
    // eslint-disable-next-line no-console
    console.error('[launch] failed:', msg);
  }
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
  /** iep:modalStatus of the group: 'Asserted' if any constituent enrollment
   *  is backed by a real event, 'Hypothetical' if every one is merely
   *  policy-inferred. */
  modalStatus: 'Asserted' | 'Hypothetical';
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
    // Asserted if any constituent enrollment is event-backed; Hypothetical
    // only when every one is purely policy-inferred. Missing modalStatus
    // (offline-sample mode) is treated as Asserted.
    const modalStatus: CourseGroup['modalStatus'] =
      policies.some(p => (p.modalStatus ?? 'Asserted') === 'Asserted') ? 'Asserted' : 'Hypothetical';
    return { courseId, courseTitle: first.courseTitle, category: first.category, policies, headlineRequirement, headlineStatus, modalStatus };
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
        {group.modalStatus === 'Hypothetical' && (
          <Pill tone="neutral"
            title="iep:modalStatus = Hypothetical — this assignment is inferred from your audience-group membership. No enrolment event has been recorded yet, so it is a prediction rather than an observed fact.">
            inferred
          </Pill>
        )}
        {playable && session && (
          <Button
            primary
            onClick={() => { void launchCourse(group, session); }}
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
