/**
 * REST resource model — Richardson Level 2 URIs + identifier opacity.
 *
 * Resource design rules followed:
 *
 *  1. Every URI identifies a noun. No verbs in the path. Collections are
 *     pluralized; items hang off the collection by opaque id:
 *       /profiles         /profiles/<id>
 *       /courses          /courses/<id>
 *       /policies         /policies/<id>
 *       /groups           /groups/<id>
 *       /audit-records    /audit-records/<id>
 *       /integrations     /integrations/<id>
 *       /statements       /statements/<id>
 *
 *  2. Identifiers are opaque. No `u-joshua` slug leakage. For users the
 *     id is a UUID v5 derived from the wallet address (the substrate's
 *     crypto-rooted system identifier). For other resources the id is
 *     opaqueId(kind, slug) — a sha256-derived UUID that the dashboard
 *     internally maps back to the underlying record. Anyone reading the
 *     URL learns nothing about the tenant's naming convention.
 *
 *  3. "Self" is not a separate resource — it's just the current user's
 *     item URL. The collection is pluralized. There is no /profile (no
 *     id) endpoint; the canonical URL is /profiles/<your-id>, identical
 *     in shape to anyone else's. Per Amundsen / RESTful Web APIs §5,
 *     `/me` and similar are convenience redirects, not resources.
 *
 *  4. Legacy URLs (/users/<slug>, /admin/<tab>, /learner, /profile) are
 *     preserved as redirects-only so prior bookmarks don't 404, but the
 *     canonical form is the only one rendered.
 *
 *  5. Level-3 HATEOAS (hypermedia controls in API responses driving
 *     client navigation) lives on the bridge side via the Hydra
 *     affordance manifest at GET /affordances. The dashboard's
 *     server-side response shapes carry self/next links where natural
 *     (e.g. xAPI pagination's `more` cursor); fuller client-side link
 *     traversal is a planned follow-up rather than a hardcoded part of
 *     this router.
 */
import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import { Login } from './components/Login.js';
import { LearnerShell } from './components/LearnerShell.js';
import { CatalogTab, PoliciesTab, CoverageTab, AccessTab, IntegrationsTab, AuditTab } from './components/AdminShell.js';
import { LrsAdminPanel } from './components/LrsAdminPanel.js';
import { ReportsPanel } from './components/ReportsPanel.js';
import { LmsContentPanel } from './components/LmsContentPanel.js';
import { MyActivityPanel } from './components/MyActivityPanel.js';
import { MyForwardingPanel } from './components/MyForwardingPanel.js';
import { AgentPerformancePanel } from './components/AgentPerformancePanel.js';
import { PerformanceDemoSuitePanel } from './components/PerformanceDemoSuitePanel.js';
import { AgentCoursesCard } from './components/AgentCoursesCard.js';
import { Header, Card } from './components/common.js';
import { loadSession, saveSession, clearSession, type FoxxiSession } from './auth/session.js';
import { getTransport, resetTransportProbe } from './interego/client.js';
import { SAMPLE_ADMIN_PAYLOAD } from './sample/data.js';
import {
  userIdToUuid, uuidToUserId,
  courseSlugToOpaque, courseOpaqueToSlug,
  policyOpaqueToSlug, groupOpaqueToSlug, auditOpaqueToSlug, integrationOpaqueToSlug,
} from './identifiers.js';
import { HypermediaProvider, useHypermedia } from './hypermedia.js';

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

function AppRoutes() {
  const [session, setSession] = useState<FoxxiSession | null>(loadSession());
  const [transport, setTransport] = useState<'bridge' | 'sample' | 'probing'>('probing');
  const navigate = useNavigate();

  useEffect(() => {
    getTransport().then(setTransport).catch(() => setTransport('sample'));
  }, []);

  function onSignIn(s: FoxxiSession) {
    saveSession(s);
    setSession(s);
    // Land on the user's canonical profile item URL — no shortcut, no
    // session-implicit magic resource. Just the same /profiles/<id>
    // anyone else would use to view this profile.
    navigate(`/profiles/${userIdToUuid(s.userId)}`, { replace: true });
  }
  function onLogout() {
    clearSession();
    resetTransportProbe();
    setSession(null);
    navigate('/login', { replace: true });
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login onSignIn={onSignIn} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const isAdmin = session.role === 'admin';
  const isLe = session.audienceTags?.includes('learning-engineering');
  const isPriv = isAdmin || isLe;
  const ownProfileUrl = `/profiles/${userIdToUuid(session.userId)}`;

  return (
    <HypermediaProvider bearer={session.bearerToken}>
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <Header session={session} onLogout={onLogout} transport={transport} />
      <TopNav session={session} />
      <div style={{ flex: 1 }}>
        <Routes>
          {/* Canonical resource routes — collection + item, opaque ids */}
          <Route path="/profiles" element={isPriv ? <ProfilesCollectionPage /> : <Navigate to={ownProfileUrl} replace />} />
          <Route path="/profiles/:profileUuid" element={<ProfilePage session={session} />} />

          <Route path="/courses" element={<CoursesPage session={session} />} />
          <Route path="/courses/:courseId" element={<CourseDetailPage session={session} />} />

          {isPriv && <Route path="/policies" element={<PoliciesPage />} />}
          {isPriv && <Route path="/policies/:policyId" element={<PoliciesPage />} />}
          {isPriv && <Route path="/groups" element={<GroupsPage />} />}
          {isPriv && <Route path="/groups/:groupId" element={<GroupsPage />} />}
          {isPriv && <Route path="/audit-records" element={<AuditPage />} />}
          {isPriv && <Route path="/audit-records/:recordId" element={<AuditPage />} />}
          {isPriv && <Route path="/coverage" element={<CoveragePage session={session} />} />}
          {isPriv && <Route path="/integrations" element={<IntegrationsPage />} />}
          {isPriv && <Route path="/integrations/:integrationId" element={<IntegrationsPage />} />}
          {isPriv && <Route path="/statements" element={<StatementsPage session={session} />} />}
          {isPriv && <Route path="/statements/:statementSub" element={<StatementsPage session={session} />} />}
          {isPriv && <Route path="/lrs-config" element={<StatementsPage session={session} />} />}
          {isPriv && <Route path="/reports" element={<ReportsPage session={session} />} />}
          {isPriv && <Route path="/agent-performance" element={<AgentPerformancePage session={session} />} />}
          {isPriv && <Route path="/content" element={<ContentPage session={session} />} />}
          <Route path="/my-activity" element={<MyActivityPage session={session} />} />
          <Route path="/my-forwarding" element={<MyForwardingPage session={session} />} />
          <Route path="/demo-suite" element={<DemoSuitePage />} />

          {/* Convenience redirects — `/me` and `/profile` resolve to the
              caller's canonical profile item URL. They're not resources
              in their own right per Amundsen §5; just rel="self" shortcuts. */}
          <Route path="/login" element={<Navigate to={ownProfileUrl} replace />} />
          <Route path="/me" element={<Navigate to={ownProfileUrl} replace />} />
          <Route path="/profile" element={<Navigate to={ownProfileUrl} replace />} />

          {/* Legacy redirects */}
          <Route path="/learner" element={<Navigate to={ownProfileUrl} replace />} />
          <Route path="/learner/courses/:courseId" element={<RedirectCourse />} />
          <Route path="/users" element={<Navigate to="/profiles" replace />} />
          <Route path="/users/u-:rest" element={<LegacyUserRedirect />} />
          <Route path="/users/:legacyId" element={<LegacyUserRedirect />} />
          <Route path="/audit" element={<Navigate to="/audit-records" replace />} />
          <Route path="/audit/:legacyId" element={<RedirectAudit />} />
          <Route path="/admin" element={<Navigate to="/courses" replace />} />
          <Route path="/admin/catalog" element={<Navigate to="/courses" replace />} />
          <Route path="/admin/policies" element={<Navigate to="/policies" replace />} />
          <Route path="/admin/coverage" element={<Navigate to="/coverage" replace />} />
          <Route path="/admin/access" element={<Navigate to="/groups" replace />} />
          <Route path="/admin/integrations" element={<Navigate to="/integrations" replace />} />
          <Route path="/admin/audit" element={<Navigate to="/audit-records" replace />} />
          <Route path="/admin/lrs/statements" element={<Navigate to="/statements" replace />} />
          <Route path="/admin/lrs/aggregates" element={<Navigate to="/statements/aggregates" replace />} />
          <Route path="/admin/lrs/conformance" element={<Navigate to="/statements/conformance" replace />} />
          <Route path="/admin/lrs/config" element={<Navigate to="/lrs-config" replace />} />
          <Route path="/admin/:any" element={<Navigate to="/courses" replace />} />
          <Route path="/admin/lrs/:any" element={<Navigate to="/statements" replace />} />

          <Route path="/" element={<Navigate to={ownProfileUrl} replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
      <Footer session={session} transport={transport} />
    </div>
    </HypermediaProvider>
  );
}

// ── Top navigation ──────────────────────────────────────────────────

function TopNav({ session }: { session: FoxxiSession }) {
  const isAdmin = session.role === 'admin';
  const isLe = session.audienceTags?.includes('learning-engineering');
  const isPriv = isAdmin || isLe;
  const ownProfileUrl = `/profiles/${userIdToUuid(session.userId)}`;
  const location = useLocation();
  const active = (path: string) =>
    location.pathname === path
    || (path !== '/' && location.pathname.startsWith(path + '/'))
    || (path === ownProfileUrl && (location.pathname === '/me' || location.pathname === '/profile'));
  const NavLink = ({ to, label }: { to: string; label: string }) => (
    <a href={to}
      onClick={e => { e.preventDefault(); history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')); }}
      style={{
        padding: '6px 12px', borderRadius: 4,
        background: active(to) ? 'var(--accent)' : 'transparent',
        color: active(to) ? 'white' : 'var(--text)',
        fontSize: 13, fontWeight: 500, textDecoration: 'none',
      }}>{label}</a>
  );
  return (
    <nav style={{
      padding: '8px 24px', background: 'var(--panel)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap',
      position: 'sticky', top: 65, zIndex: 40,
    }}>
      <NavLink to={ownProfileUrl} label="My profile" />
      <NavLink to="/courses" label="Courses" />
      <NavLink to="/my-activity" label="My activity" />
      <NavLink to="/my-forwarding" label="My forwarding" />
      <NavLink to="/demo-suite" label="Demo suite" />
      {isPriv && <span style={{ width: 12 }} />}
      {isPriv && <NavLink to="/profiles" label="Profiles" />}
      {isPriv && <NavLink to="/policies" label="Policies" />}
      {isPriv && <NavLink to="/groups" label="Groups" />}
      {isPriv && <NavLink to="/audit-records" label="Audit records" />}
      {isPriv && <NavLink to="/coverage" label="Coverage" />}
      {isPriv && <NavLink to="/content" label="Content" />}
      {isPriv && <NavLink to="/integrations" label="Integrations" />}
      {isPriv && <NavLink to="/statements" label="xAPI / LRS" />}
      {isPriv && <NavLink to="/reports" label="Reports" />}
      {isPriv && <NavLink to="/agent-performance" label="Agent performance" />}
    </nav>
  );
}

// ── Pages ───────────────────────────────────────────────────────────

function ProfilePage({ session }: { session: FoxxiSession }) {
  const { profileUuid } = useParams();
  const targetUserId = profileUuid ? uuidToUserId(profileUuid) : null;
  // Future: if targetUserId !== session.userId AND caller isn't admin/LE,
  // show a 403. For now render LearnerShell with the signed-in identity
  // (it only shows the caller's own enrollments anyway).
  void targetUserId;
  return <LearnerShell session={session} />;
}

function ProfilesCollectionPage() {
  // Future: list all profiles in the tenant (admin/LE only). The AccessTab
  // currently covers this conceptually but is keyed on /groups; we'll add a
  // dedicated profiles table here next.
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><AccessTab /></div>;
}

function CoursesPage({ session }: { session: FoxxiSession }) {
  void session;
  return (
    <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20, display: 'grid', gap: 18 }}>
      <CatalogTab />
      <AgentCoursesCard />
    </div>
  );
}

function CourseDetailPage({ session }: { session: FoxxiSession }) {
  // The :courseId param is now an opaque UUID. LearnerShell resolves it
  // back to the underlying slug for getCourseContent lookups.
  return <LearnerShell session={session} />;
}

function RedirectCourse() {
  // Legacy /learner/courses/<slug> → /courses/<opaque>
  const { courseId } = useParams();
  if (!courseId) return <Navigate to="/courses" replace />;
  // courseId here is the legacy slug; map to opaque
  return <Navigate to={`/courses/${courseSlugToOpaque(courseId)}`} replace />;
}

function RedirectAudit() {
  const { legacyId } = useParams();
  return <Navigate to={legacyId ? `/audit-records/${legacyId}` : '/audit-records'} replace />;
}

function LegacyUserRedirect() {
  // Old /users/u-joshua → /profiles/<their-uuid>. Best-effort: if the
  // path matches a known slug, resolve to opaque; otherwise drop to
  // the /profiles collection.
  const params = useParams();
  const legacySlug = params.legacyId
    ?? (params.rest ? `u-${params.rest}` : null);
  if (!legacySlug) return <Navigate to="/profiles" replace />;
  return <Navigate to={`/profiles/${userIdToUuid(legacySlug)}`} replace />;
}

function PoliciesPage() {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><PoliciesTab /></div>;
}
function GroupsPage() {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><AccessTab /></div>;
}
function AuditPage() {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><AuditTab /></div>;
}
function CoveragePage({ session }: { session: FoxxiSession }) {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><CoverageTab tenantPodUrl={session.tenantPodUrl} /></div>;
}
function IntegrationsPage() {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><IntegrationsTab /></div>;
}
function StatementsPage({ session }: { session: FoxxiSession }) {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><LrsAdminPanel bearer={session.bearerToken} isAdmin={session.role === 'admin'} /></div>;
}
function ContentPage({ session }: { session: FoxxiSession }) {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><LmsContentPanel session={session} /></div>;
}
function ReportsPage({ session }: { session: FoxxiSession }) {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><ReportsPanel bearer={session.bearerToken} /></div>;
}
function MyActivityPage({ session }: { session: FoxxiSession }) {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><MyActivityPanel session={session} /></div>;
}
function MyForwardingPage({ session }: { session: FoxxiSession }) {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><MyForwardingPanel session={session} /></div>;
}
function AgentPerformancePage({ session }: { session: FoxxiSession }) {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><AgentPerformancePanel session={session} /></div>;
}
function DemoSuitePage() {
  return <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}><PerformanceDemoSuitePanel /></div>;
}

function NotFound() {
  return (
    <div style={{ maxWidth: 720, margin: '60px auto', padding: 20 }}>
      <Card title="Not found">
        <div style={{ color: 'var(--text-dim)' }}>
          The URL you're looking at doesn't map to any known resource. Jump back to <a href="/me">your profile</a>.
        </div>
      </Card>
    </div>
  );
}

function Footer({ session, transport }: { session: FoxxiSession; transport: 'bridge' | 'sample' | 'probing' }) {
  const meta = SAMPLE_ADMIN_PAYLOAD.meta;
  return (
    <footer style={{
      marginTop: 24, padding: '14px 20px',
      borderTop: '1px solid var(--border)',
      background: 'var(--panel)',
      fontSize: 11, color: 'var(--text-dim)',
      display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'space-between',
    }}>
      <div>
        Foxxi · Interego-grounded L&amp;D · tenant <strong>{meta.tenant}</strong>
        {' '}<code style={{ marginLeft: 6 }}>{meta.tenant_id}</code>
      </div>
      <div>
        signed in as <strong>{session.name}</strong> ({session.role})
      </div>
      <div>
        transport: <strong>{transport}</strong>
        {' '}· pod: <code style={{ wordBreak: 'break-all' }}>{meta.tenant_pod}</code>
      </div>
    </footer>
  );
}
