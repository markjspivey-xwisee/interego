import React, { useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Card, Pill, Button, Modal, Row } from './common.js';
import { coverageQuery, type CoverageQueryResult } from '../interego/client.js';
import { SAMPLE_ADMIN_PAYLOAD } from '../sample/data.js';
import { LrsAdminPanel } from './LrsAdminPanel.js';
import { useHypermediaCollection, useAffordance, useHypermedia, invokeAffordance } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import type { CatalogEntry, AdminConnection } from '../types.js';

// Hypermedia item shapes — match the server's _links-bearing member shape.
interface HmCourse {
  id: string;
  title: string;
  category: string;
  audience_tags: readonly string[];
  standard?: string;
  concept_count?: number;
  slide_count?: number;
  _links?: { self?: { href: string } };
}
interface HmPolicy {
  id: string;
  course_id: string;
  course_title?: string;
  requirement_type: string;
  enabled: boolean;
  _links?: { self?: { href: string }; course?: { href: string }; group?: { href: string } };
}
interface HmGroup {
  id: string;
  name: string;
  kind: string;
  member_count?: number;
  _links?: { self?: { href: string } };
}
interface HmAuditRecord {
  id: string;
  timestamp: string;
  actor: { user_id: string; '@id'?: string };
  action: string;
  target_type: string;
  target_id: string;
  result: string;
  reason?: string | null;
  _links?: { self?: { href: string }; actor?: { href: string } };
}
interface HmIntegration {
  id: string;
  kind: string;
  product: string;
  instance: string;
  status: string;
  auth_method: string;
  last_sync: string;
  _links?: { self?: { href: string } };
}

type Tab = 'catalog' | 'policies' | 'coverage' | 'access' | 'integrations' | 'audit' | 'lrs';
const TAB_VALUES = new Set<Tab>(['catalog', 'policies', 'coverage', 'access', 'integrations', 'audit', 'lrs']);

export function AdminShell({ session }: { session: FoxxiSession }) {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const a = SAMPLE_ADMIN_PAYLOAD;

  // Tab is driven by the URL path — /admin/<tab> or /admin/lrs/<sub>
  const isLrsPath = location.pathname.startsWith('/admin/lrs');
  const urlTab = isLrsPath ? 'lrs' : (params.tab as string | undefined);
  const tab: Tab = (urlTab && TAB_VALUES.has(urlTab as Tab)) ? (urlTab as Tab) : 'catalog';
  const setTab = (v: Tab) => navigate(v === 'lrs' ? '/admin/lrs/statements' : `/admin/${v}`);

  return (
    <div style={{ maxWidth: 1180, margin: '24px auto', padding: 20 }}>
      <Card title={`L&D Admin · ${a.meta.tenant}`}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Signed in as <strong>{session.name}</strong> ({a.meta.admin_user_role}) · tenant pod: <code>{a.meta.tenant_pod}</code>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          <TabBtn t={tab} v="catalog" onClick={setTab}>Catalog ({a.catalog.length})</TabBtn>
          <TabBtn t={tab} v="policies" onClick={setTab}>Policies ({a.policies.length})</TabBtn>
          <TabBtn t={tab} v="coverage" onClick={setTab}>Coverage ({a.coverage.length} concepts)</TabBtn>
          <TabBtn t={tab} v="access" onClick={setTab}>Access ({a.users.length} users · {a.groups.length} groups)</TabBtn>
          <TabBtn t={tab} v="integrations" onClick={setTab}>Integrations ({a.connections.length})</TabBtn>
          <TabBtn t={tab} v="audit" onClick={setTab}>Audit log ({a.audit.length})</TabBtn>
          <TabBtn t={tab} v="lrs" onClick={setTab}>xAPI / LRS</TabBtn>
        </div>
      </Card>

      {tab === 'catalog' && <CatalogTab />}
      {tab === 'policies' && <PoliciesTab />}
      {tab === 'coverage' && <CoverageTab tenantPodUrl={session.tenantPodUrl} />}
      {tab === 'access' && <AccessTab />}
      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'lrs' && <LrsAdminPanel bearer={session.bearerToken} isAdmin={session.role === 'admin'} />}
    </div>
  );
}

function TabBtn({ t, v, onClick, children }: { t: Tab; v: Tab; onClick: (v: Tab) => void; children: React.ReactNode }) {
  return <Button primary={t === v} onClick={() => onClick(v)}>{children}</Button>;
}

export function CatalogTab() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'parsed' | 'stub'>('all');
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  // Data source: hypermedia GET /api/foxxi/v1/courses (followed via the
  // entry-point's `courses` link). The collection's items include the
  // full underlying CatalogEntry fields plus the opaque uuid + _links.
  const { items: hmCourses, loading, error } = useHypermediaCollection<HmCourse & CatalogEntry>('courses');
  // Offline fallback for dev / pre-bridge-up state.
  const all: ReadonlyArray<CatalogEntry> = hmCourses.length > 0 ? hmCourses as CatalogEntry[] : SAMPLE_ADMIN_PAYLOAD.catalog;
  const real = all.filter(c => c.is_real);
  const stub = all.filter(c => !c.is_real);
  const selectedCourse = selectedCourseId ? all.find(c => c.course_id === selectedCourseId) ?? null : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(c => {
      if (filter === 'parsed' && !c.is_real) return false;
      if (filter === 'stub' && c.is_real) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        c.owner.toLowerCase().includes(q) ||
        c.audience_tags.some(t => t.toLowerCase().includes(q)) ||
        (c.lms_source ?? '').toLowerCase().includes(q)
      );
    });
  }, [query, filter, all]);

  return (
    <Card title="Tenant catalog" right={<Pill tone="accent">foxxi.ingest_content_package</Pill>}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
        Real Foxxi-parsed courses (full transcripts + extracted concept maps): <strong>{real.length}</strong>.
        Stub catalog entries representing courses synced from connected LMSes: <strong>{stub.length}</strong>.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search title, category, owner, audience tag, LMS source…"
          style={{
            flex: 1, minWidth: 240,
            padding: '8px 12px', background: 'var(--panel-2)',
            color: 'var(--text)', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 13,
          }}
        />
        <Button primary={filter === 'all'} onClick={() => setFilter('all')}>All ({all.length})</Button>
        <Button primary={filter === 'parsed'} onClick={() => setFilter('parsed')}>Parsed ({real.length})</Button>
        <Button primary={filter === 'stub'} onClick={() => setFilter('stub')}>LMS-synced stubs ({stub.length})</Button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>
        Showing {filtered.length} of {all.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.map(c => (
          <button key={c.course_id}
            onClick={() => setSelectedCourseId(c.course_id)}
            style={{
              textAlign: 'left', cursor: 'pointer',
              padding: 12, background: 'var(--panel-2)',
              borderRadius: 4, border: '1px solid var(--border)',
              color: 'var(--text)', fontFamily: 'inherit',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Pill tone={c.is_real ? 'good' : 'neutral'}>{c.is_real ? 'parsed' : 'lms-stub'}</Pill>
              <div style={{
                fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
                fontSize: 17, fontWeight: 500,
              }}>{c.title}</div>
              <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>{c.category}</div>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', monospace" }}>
              {c.authoring_tool} · {c.standard} · {c.slide_count} slides · {c.concept_count} concepts · {Math.round(c.audio_seconds)}s audio
              {c.lms_source && <> · source: {c.lms_source}</>}
              {c.last_parsed && <> · parsed {c.last_parsed}</>}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>
              Owner: {c.owner} · Audience tags: {c.audience_tags.join(', ') || '(none)'}
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 12, fontStyle: 'italic' }}>
            No catalog entries match this filter.
          </div>
        )}
      </div>
      {selectedCourse && (
        <CourseModal course={selectedCourse} onClose={() => setSelectedCourseId(null)} />
      )}
    </Card>
  );
}

function CourseModal({ course, onClose }: { course: CatalogEntry; onClose: () => void }) {
  const a = SAMPLE_ADMIN_PAYLOAD;
  const policies = a.policies.filter(p => p.course_id === course.course_id);
  const events = a.events.filter(e => e.course_id === course.course_id);
  const completed = events.filter(e => e.status === 'completed').length;
  const overdue = events.filter(e => e.status === 'overdue').length;
  const pending = events.filter(e => e.status === 'pending' || e.status === 'in_progress').length;
  const total = events.length || 1;
  return (
    <Modal title={course.title} onClose={onClose} width={760}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Row label="Status" value={
          <span style={{ display: 'flex', gap: 6 }}>
            <Pill tone={course.is_real ? 'good' : 'neutral'}>{course.is_real ? 'parsed' : 'lms-stub'}</Pill>
            {course.parse_status && <Pill tone={course.parse_status === 'clean' ? 'good' : 'warn'}>{course.parse_status}</Pill>}
            {course.shacl_violations !== undefined && (
              <Pill tone={course.shacl_violations === 0 ? 'good' : 'bad'}>
                {course.shacl_violations === 0 ? '✓' : '⚠'} SHACL {course.shacl_violations}
              </Pill>
            )}
          </span>
        } />
        <Row label="Course ID" value={<code>{course.course_id}</code>} />
        <Row label="Category" value={course.category} />
        <Row label="Owner" value={course.owner} />
        <Row label="Authoring" value={`${course.authoring_tool} · ${course.standard}`} />
        {course.lms_source && <Row label="Source" value={course.lms_source} />}
        {course.last_modified && <Row label="Last modified" value={course.last_modified} />}
        {course.last_parsed && <Row label="Last parsed" value={course.last_parsed} />}
        <Row label="Audience tags" value={
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {course.audience_tags.map(t => <Pill key={t}>{t}</Pill>)}
            {course.audience_tags.length === 0 && <span style={{ color: 'var(--text-dim)' }}>(none)</span>}
          </div>
        } />
      </div>

      <div className="label" style={{ marginTop: 18, marginBottom: 8 }}>Graph stats</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <MiniStat label="Slides" value={course.slide_count} />
        <MiniStat label="Concepts" value={course.concept_count} />
        <MiniStat label="Audio" value={`${Math.round(course.audio_seconds)}s`} />
        <MiniStat label="Policies" value={policies.length} />
      </div>

      <div className="label" style={{ marginTop: 18, marginBottom: 8 }}>Assignment completion ({events.length} enrolments)</div>
      <CompletionBar completed={completed} overdue={overdue} pending={pending} total={total} />
      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-dim)' }}>
        <span><span style={{ color: 'var(--good)' }}>■</span> completed {completed}</span>
        <span><span style={{ color: 'var(--bad)' }}>■</span> overdue {overdue}</span>
        <span><span style={{ color: 'var(--warn)' }}>■</span> pending {pending}</span>
      </div>

      {policies.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 18, marginBottom: 8 }}>Policies binding this course</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {policies.map(p => (
              <div key={p.policy_id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: 8, background: 'var(--panel-2)',
                border: '1px solid var(--border)', borderRadius: 4,
                fontSize: 13,
              }}>
                <Pill tone={p.enabled ? 'good' : 'neutral'}>{p.enabled ? 'on' : 'off'}</Pill>
                <Pill tone={p.requirement_type === 'required' ? 'bad' : 'neutral'}>{p.requirement_type}</Pill>
                <div style={{ flex: 1 }}>{p.audience_label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', monospace" }}>
                  {p.trigger} · {p.due_relative_days}d · {p.audience_member_count ?? '?'} members
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 22, flexWrap: 'wrap' }}>
        <Button small onClick={() => alert('Demo: would publish view-graph affordance descriptor.')}>View graph</Button>
        <Button small onClick={() => alert('Demo: would emit Turtle bundle from fxs:Package + fxk:Concept descriptors.')}>Download Turtle (.ttl)</Button>
        {course.is_real && (
          <Button small onClick={() => alert('Demo: would invoke foxxi.ingest_content_package against the connector source.')}>Reparse from source</Button>
        )}
      </div>
    </Modal>
  );
}

function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{
      padding: '10px 12px', background: 'var(--panel-2)',
      border: '1px solid var(--border)', borderRadius: 4,
    }}>
      <div className="label" style={{ marginBottom: 2 }}>{label}</div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 18, fontWeight: 600, color: 'var(--accent)',
      }}>{value}</div>
    </div>
  );
}

function CompletionBar({ completed, overdue, pending, total }: { completed: number; overdue: number; pending: number; total: number }) {
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div style={{
      display: 'flex', height: 14, borderRadius: 999, overflow: 'hidden',
      border: '1px solid var(--border)',
    }}>
      <div style={{ width: pct(completed), background: 'var(--good)' }} title={`completed ${completed}`} />
      <div style={{ width: pct(overdue), background: 'var(--bad)' }} title={`overdue ${overdue}`} />
      <div style={{ width: pct(pending), background: 'var(--warn)' }} title={`pending ${pending}`} />
    </div>
  );
}

export function PoliciesTab() {
  // Hypermedia-driven — follow entry.policies link.
  const { items: hmPolicies } = useHypermediaCollection<HmPolicy & typeof SAMPLE_ADMIN_PAYLOAD.policies[number]>('policies');
  const policies = hmPolicies.length > 0
    ? (hmPolicies as unknown as typeof SAMPLE_ADMIN_PAYLOAD.policies)
    : SAMPLE_ADMIN_PAYLOAD.policies;
  const a = { ...SAMPLE_ADMIN_PAYLOAD, policies };
  return (
    <Card title="Assignment policies" right={<Pill tone="accent">foxxi.assign_audience + foxxi.publish_authoring_policy</Pill>}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
        Each policy binds a course to an audience group via a Foxxi assignment descriptor. The substrate
        resolves a learner's enrollments by walking these + matching audience-group membership.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        {a.policies.slice(0, 14).map(p => (
          <div key={p.policy_id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: 8, background: 'var(--panel-2)', borderRadius: 4,
            border: '1px solid var(--border)',
          }}>
            <Pill tone={p.enabled ? 'good' : 'neutral'}>{p.enabled ? 'on' : 'off'}</Pill>
            <div style={{ flex: 1 }}>{p.course_title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{p.audience_label}</div>
            <Pill tone={p.requirement_type === 'required' ? 'bad' : 'neutral'}>{p.requirement_type}</Pill>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{p.trigger} · {p.due_relative_days}d</div>
          </div>
        ))}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
          + {a.policies.length - 14} more policies (truncated for display)
        </div>
      </div>
    </Card>
  );
}

export function CoverageTab({ tenantPodUrl }: { tenantPodUrl: string }) {
  const a = SAMPLE_ADMIN_PAYLOAD;
  const coverage = useMemo(() => a.coverage.slice(0, 30).map(c => ({
    concept: c.concept_label,
    taughtIn: c.taught_in_courses,
    mentionedIn: c.mentioned_in_courses,
  })), [a.coverage]);

  const [mode, setMode] = useState<'abac' | 'merkle-attested-opt-in' | 'zk-distribution'>('merkle-attested-opt-in');
  const [epsilon, setEpsilon] = useState(1.0);
  const [bucketEdges, setBucketEdges] = useState('0, 2, 5, 10');
  const [maxValue, setMaxValue] = useState('100');
  const [result, setResult] = useState<CoverageQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const affordance = useAffordance('foxxi.coverage_query');
  const { bearer } = useHypermedia();

  async function run() {
    setLoading(true); setErr(null);
    try {
      const edges = bucketEdges.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const r = affordance
        ? (await invokeAffordance({
            affordance,
            bearer,
            args: {
              tenant_pod_url: tenantPodUrl,
              coverage,
              privacy_mode: mode,
              epsilon: mode === 'zk-distribution' ? epsilon : undefined,
              distribution_edges: mode === 'zk-distribution' ? edges : undefined,
              distribution_max_value: mode === 'zk-distribution' ? maxValue : undefined,
            },
          })) as CoverageQueryResult
        : await coverageQuery({
            tenantPodUrl,
            coverage,
            privacyMode: mode,
            epsilon: mode === 'zk-distribution' ? epsilon : undefined,
            distributionEdges: mode === 'zk-distribution' ? edges : undefined,
            distributionMaxValue: mode === 'zk-distribution' ? maxValue : undefined,
          });
      setResult(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card title="Catalog concept coverage" right={<Pill tone="accent">{affordance ? `affordance: ${affordance.rel}` : 'foxxi.coverage_query (sample)'}</Pill>}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
        Privacy-respecting coverage analysis — composes the substrate's aggregate-privacy ladder.
        v2 merkle-attested-opt-in gives a tamper-evident count + per-leaf inclusion proofs.
        v3 zk-distribution gives a DP-noised histogram of "concepts taught in 1 course / 2-4 / 5-9 / 10+".
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Button primary={mode === 'abac'} onClick={() => setMode('abac')}>abac (plain count)</Button>
        <Button primary={mode === 'merkle-attested-opt-in'} onClick={() => setMode('merkle-attested-opt-in')}>merkle-attested-opt-in (v2)</Button>
        <Button primary={mode === 'zk-distribution'} onClick={() => setMode('zk-distribution')}>zk-distribution (v3)</Button>
        <div style={{ flex: 1 }} />
        <Button primary onClick={run} disabled={loading}>{loading ? 'Querying…' : 'Run query'}</Button>
      </div>

      {mode === 'zk-distribution' && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10,
          padding: 12, marginBottom: 12,
          background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4,
        }}>
          <label style={{ fontSize: 12 }}>
            <div className="label" style={{ marginBottom: 4 }}>ε (privacy budget): {epsilon.toFixed(2)}</div>
            <input type="range" min={0.1} max={5} step={0.1}
              value={epsilon} onChange={e => setEpsilon(parseFloat(e.target.value))}
              style={{ width: '100%' }} />
          </label>
          <label style={{ fontSize: 12 }}>
            <div className="label" style={{ marginBottom: 4 }}>Bucket edges (comma-sep)</div>
            <input value={bucketEdges} onChange={e => setBucketEdges(e.target.value)}
              style={{
                width: '100%', padding: '6px 8px', background: 'var(--panel)',
                border: '1px solid var(--border)', borderRadius: 4, fontSize: 12,
              }} />
          </label>
          <label style={{ fontSize: 12 }}>
            <div className="label" style={{ marginBottom: 4 }}>Max value</div>
            <input value={maxValue} onChange={e => setMaxValue(e.target.value)}
              style={{
                width: '100%', padding: '6px 8px', background: 'var(--panel)',
                border: '1px solid var(--border)', borderRadius: 4, fontSize: 12,
              }} />
          </label>
        </div>
      )}
      {err && <div style={{ color: 'var(--bad)' }}>✗ {err}</div>}
      {result && (
        <div style={{
          padding: 12, background: 'var(--panel-2)', borderRadius: 6,
          border: '1px solid var(--border)', fontSize: 12,
        }}>
          <div style={{ marginBottom: 8 }}>
            <Pill tone="good">privacyMode: {result.mode}</Pill>
            {result.coverageCount !== undefined && (
              <span style={{ marginLeft: 12 }}>count: <strong>{result.coverageCount}</strong></span>
            )}
            {result.bundle?.count !== undefined && (
              <span style={{ marginLeft: 12 }}>count: <strong>{result.bundle.count}</strong></span>
            )}
            {result.bundle?.bucketSumCommitments && (
              <span style={{ marginLeft: 12 }}>histogram buckets: <strong>{result.bundle.bucketSumCommitments.length}</strong></span>
            )}
          </div>
          {result.bundle?.merkleRoot && (
            <div style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all', color: 'var(--text-dim)' }}>
              merkleRoot: {result.bundle.merkleRoot}
            </div>
          )}
        </div>
      )}
      <details style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12 }}>
          Coverage records sent to query ({coverage.length})
        </summary>
        <div style={{ marginTop: 8, maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
          {coverage.map(c => (
            <div key={c.concept} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <strong>{c.concept}</strong> — taught in {c.taughtIn.length}, mentioned in {c.mentionedIn.length}
            </div>
          ))}
        </div>
      </details>
    </Card>
  );
}

export function AuditTab() {
  // Hypermedia: follow entry.audit-records link
  const { items: hmAudit } = useHypermediaCollection<HmAuditRecord & typeof SAMPLE_ADMIN_PAYLOAD.audit[number]>('audit-records');
  const audit = hmAudit.length > 0
    ? (hmAudit as unknown as typeof SAMPLE_ADMIN_PAYLOAD.audit)
    : SAMPLE_ADMIN_PAYLOAD.audit;
  const a = { ...SAMPLE_ADMIN_PAYLOAD, audit };
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [resultFilter, setResultFilter] = useState<'all' | 'allowed' | 'denied'>('all');
  const [actorQuery, setActorQuery] = useState('');

  const actions = useMemo(() => {
    const s = new Set<string>();
    for (const e of a.audit) s.add(e.action);
    return Array.from(s).sort();
  }, [a.audit]);

  const userById = useMemo(() => new Map(a.users.map(u => [u.user_id, u])), [a.users]);

  const filtered = useMemo(() => {
    const q = actorQuery.trim().toLowerCase();
    return a.audit.filter(e => {
      if (actionFilter !== 'all' && e.action !== actionFilter) return false;
      if (resultFilter !== 'all' && e.result !== resultFilter) return false;
      if (!q) return true;
      const u = userById.get(e.actor_user_id);
      return (
        e.actor_user_id.toLowerCase().includes(q) ||
        (e.actor_web_id ?? '').toLowerCase().includes(q) ||
        (u?.name ?? '').toLowerCase().includes(q) ||
        (u?.department ?? '').toLowerCase().includes(q)
      );
    });
  }, [a.audit, actionFilter, resultFilter, actorQuery, userById]);

  function exportCsv() {
    const headers = ['audit_id', 'timestamp', 'actor_user_id', 'actor_web_id', 'actor_name', 'action', 'target_type', 'target_id', 'result', 'reason'];
    const rows = filtered.map(e => {
      const u = userById.get(e.actor_user_id);
      return [e.audit_id, e.timestamp, e.actor_user_id, e.actor_web_id ?? '', u?.name ?? '', e.action, e.target_type, e.target_id, e.result, e.reason ?? ''];
    });
    const escape = (v: string | number) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `foxxi-audit-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function frameworkCitations(action: string): { label: string; tone: 'accent' | 'good' | 'warn' }[] {
    const cites: { label: string; tone: 'accent' | 'good' | 'warn' }[] = [];
    if (action.startsWith('policy.') || action.startsWith('audience.') || action.startsWith('access.')) {
      cites.push({ label: 'SOC2:CC6.1', tone: 'accent' });
    }
    if (action.startsWith('course.') || action.startsWith('coverage.') || action.includes('answer')) {
      cites.push({ label: 'EU-AI-Act:Art.12', tone: 'warn' });
    }
    if (action.includes('publish') || action.includes('compliance')) {
      cites.push({ label: 'NIST-RMF:Govern', tone: 'good' });
    }
    return cites;
  }

  return (
    <Card title="Audit log" right={<Pill tone="accent">foxxi.publish_compliance_evidence</Pill>}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
        Every admin + learner action becomes a framework-cited compliance descriptor via the
        compliance-overlay (SOC 2 / EU AI Act / NIST RMF). Audit entries chain
        actor → action → target → result → reason.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={actorQuery}
          onChange={e => setActorQuery(e.target.value)}
          placeholder="Filter by actor (id, web_id, name, department)…"
          style={{
            flex: 1, minWidth: 220,
            padding: '6px 10px', background: 'var(--panel-2)',
            color: 'var(--text)', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 12,
          }}
        />
        <select
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          style={{
            padding: '6px 10px', background: 'var(--panel-2)',
            color: 'var(--text)', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 12,
          }}
        >
          <option value="all">All actions ({a.audit.length})</option>
          {actions.map(act => <option key={act} value={act}>{act}</option>)}
        </select>
        <Button primary={resultFilter === 'all'} onClick={() => setResultFilter('all')}>All</Button>
        <Button primary={resultFilter === 'allowed'} onClick={() => setResultFilter('allowed')}>Allowed</Button>
        <Button primary={resultFilter === 'denied'} onClick={() => setResultFilter('denied')}>Denied</Button>
        <Button onClick={exportCsv} title={`Export ${filtered.length} entries as CSV`}>Export CSV ({filtered.length})</Button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>
        Showing {filtered.length} of {a.audit.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, maxHeight: 480, overflow: 'auto' }}>
        {filtered.slice(0, 200).map(e => {
          const u = userById.get(e.actor_user_id);
          const cites = frameworkCitations(e.action);
          return (
            <div key={e.audit_id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
              borderBottom: '1px solid var(--border)',
              fontFamily: 'monospace', flexWrap: 'wrap',
            }}>
              <div style={{ color: 'var(--text-dim)', minWidth: 130 }}>{e.timestamp}</div>
              <Pill tone={e.result === 'allowed' ? 'good' : 'bad'}>{e.result}</Pill>
              <div style={{ minWidth: 130 }}>{u?.name ?? e.actor_user_id}</div>
              <div style={{ color: 'var(--accent)' }}>{e.action}</div>
              <div>{e.target_type}/{e.target_id}</div>
              {e.reason && <div style={{ color: 'var(--text-dim)' }}>· {e.reason}</div>}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                {cites.map(c => <Pill key={c.label} tone={c.tone}>{c.label}</Pill>)}
              </div>
            </div>
          );
        })}
        {filtered.length > 200 && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '8px 0' }}>
            + {filtered.length - 200} more entries (capped at 200 for display)
          </div>
        )}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
//  Access tab — users + groups (audience membership for policy resolution)
// ──────────────────────────────────────────────────────────────────────

export function AccessTab() {
  // Two hypermedia collections compose this view: profiles + groups.
  const { items: hmUsers } = useHypermediaCollection<typeof SAMPLE_ADMIN_PAYLOAD.users[number]>('profiles');
  const { items: hmGroups } = useHypermediaCollection<HmGroup & typeof SAMPLE_ADMIN_PAYLOAD.groups[number]>('groups');
  const users = hmUsers.length > 0 ? (hmUsers as unknown as typeof SAMPLE_ADMIN_PAYLOAD.users) : SAMPLE_ADMIN_PAYLOAD.users;
  const groups = hmGroups.length > 0 ? (hmGroups as unknown as typeof SAMPLE_ADMIN_PAYLOAD.groups) : SAMPLE_ADMIN_PAYLOAD.groups;
  const a = { ...SAMPLE_ADMIN_PAYLOAD, users, groups };
  const [sub, setSub] = useState<'users' | 'groups'>('users');
  const [query, setQuery] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return a.users;
    return a.users.filter(u =>
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      u.department.toLowerCase().includes(q) ||
      u.job_title.toLowerCase().includes(q) ||
      u.user_id.toLowerCase().includes(q) ||
      u.audience_tags.some(t => t.toLowerCase().includes(q))
    );
  }, [a.users, query]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return a.groups;
    return a.groups.filter(g =>
      g.name.toLowerCase().includes(q) ||
      g.kind.toLowerCase().includes(q) ||
      g.group_id.toLowerCase().includes(q) ||
      (g.description ?? '').toLowerCase().includes(q)
    );
  }, [a.groups, query]);

  const selectedUser = selectedUserId ? a.users.find(u => u.user_id === selectedUserId) : null;
  const selectedGroup = selectedGroupId ? a.groups.find(g => g.group_id === selectedGroupId) : null;

  return (
    <Card title="Access" right={<Pill tone="accent">foxxi.assign_audience</Pill>}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
        Users + groups in the tenant identity registry. Audience tags on a user determine which
        policies apply to them — the substrate walks <code>foxxi.assign_audience</code> descriptors
        + <code>foxxi.discover_assigned_courses</code> to resolve enrollments.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Button primary={sub === 'users'} onClick={() => setSub('users')}>Users ({a.users.length})</Button>
        <Button primary={sub === 'groups'} onClick={() => setSub('groups')}>Groups ({a.groups.length})</Button>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={sub === 'users' ? 'Search name, email, dept, title, audience tag…' : 'Search group name, kind, description…'}
          style={{
            flex: 1, minWidth: 220,
            padding: '6px 10px', background: 'var(--panel-2)',
            color: 'var(--text)', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 13,
          }}
        />
      </div>

      {sub === 'users' && (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>
            Showing {filteredUsers.length} of {a.users.length}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8, maxHeight: 520, overflow: 'auto' }}>
            {filteredUsers.slice(0, 60).map(u => (
              <button key={u.user_id} onClick={() => setSelectedUserId(u.user_id)} style={{
                textAlign: 'left', cursor: 'pointer',
                padding: 10, background: 'var(--panel-2)',
                borderRadius: 6, border: '1px solid var(--border)',
                color: 'var(--text)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Pill tone={u.status === 'active' ? 'good' : 'neutral'}>{u.status}</Pill>
                  <div style={{ fontWeight: 500 }}>{u.name}</div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                  {u.job_title} · {u.department}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, wordBreak: 'break-all' }}>
                  <code>{u.web_id}</code>
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {u.audience_tags.map(t => <Pill key={t}>{t}</Pill>)}
                </div>
              </button>
            ))}
          </div>
          {filteredUsers.length > 60 && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10 }}>
              + {filteredUsers.length - 60} more users (capped at 60 for display)
            </div>
          )}
        </>
      )}

      {sub === 'groups' && (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>
            Showing {filteredGroups.length} of {a.groups.length}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
            {filteredGroups.map(g => (
              <button key={g.group_id} onClick={() => setSelectedGroupId(g.group_id)} style={{
                textAlign: 'left', cursor: 'pointer',
                padding: 10, background: 'var(--panel-2)',
                borderRadius: 6, border: '1px solid var(--border)',
                color: 'var(--text)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Pill tone="accent">{g.kind}</Pill>
                  <div style={{ fontWeight: 500 }}>{g.name}</div>
                  <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
                    {g.member_count} members
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                  <code>{g.group_id}</code>
                </div>
                {g.description && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
                    {g.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      {selectedUser && (
        <Modal title={`User · ${selectedUser.name}`} onClose={() => setSelectedUserId(null)}>
          <Row label="WebID" value={<code style={{ wordBreak: 'break-all' }}>{selectedUser.web_id}</code>} />
          <Row label="User ID" value={<code>{selectedUser.user_id}</code>} />
          <Row label="Email" value={selectedUser.email} />
          <Row label="Status" value={<Pill tone={selectedUser.status === 'active' ? 'good' : 'neutral'}>{selectedUser.status}</Pill>} />
          <Row label="Department" value={selectedUser.department} />
          <Row label="Job title" value={selectedUser.job_title} />
          {selectedUser.location && <Row label="Location" value={selectedUser.location} />}
          {selectedUser.employee_id && <Row label="Employee ID" value={selectedUser.employee_id} />}
          <Row label="Hire date" value={selectedUser.hire_date} />
          {selectedUser.manager_user_id && (
            <Row
              label="Manager"
              value={a.users.find(u => u.user_id === selectedUser.manager_user_id)?.name ?? selectedUser.manager_user_id}
            />
          )}
          <Row label="Audience tags" value={
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {selectedUser.audience_tags.map(t => <Pill key={t}>{t}</Pill>)}
            </div>
          } />
          <Row label="Group memberships" value={
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {a.groups.filter(g => g.member_ids.includes(selectedUser.user_id)).map(g => (
                <Pill key={g.group_id} tone="accent">{g.name}</Pill>
              ))}
            </div>
          } />
        </Modal>
      )}

      {selectedGroup && (
        <Modal title={`Group · ${selectedGroup.name}`} onClose={() => setSelectedGroupId(null)}>
          <Row label="Group ID" value={<code>{selectedGroup.group_id}</code>} />
          <Row label="Kind" value={<Pill tone="accent">{selectedGroup.kind}</Pill>} />
          <Row label="Member count" value={String(selectedGroup.member_count)} />
          {selectedGroup.description && <Row label="Description" value={selectedGroup.description} />}
          <Row label="Members" value={
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxHeight: 240, overflow: 'auto' }}>
              {selectedGroup.member_ids.slice(0, 40).map(uid => {
                const u = a.users.find(x => x.user_id === uid);
                return <Pill key={uid}>{u?.name ?? uid}</Pill>;
              })}
              {selectedGroup.member_ids.length > 40 && (
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  + {selectedGroup.member_ids.length - 40} more
                </span>
              )}
            </div>
          } />
          <Row label="Policies targeting this group" value={
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {a.policies.filter(p => p.audience_group_id === selectedGroup.group_id).map(p => (
                <Pill key={p.policy_id} tone={p.requirement_type === 'required' ? 'bad' : 'neutral'}>
                  {p.course_title} ({p.requirement_type})
                </Pill>
              )) || <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>(none)</span>}
            </div>
          } />
        </Modal>
      )}
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
//  Integrations tab — LMS + downstream connector status cards
// ──────────────────────────────────────────────────────────────────────

export function IntegrationsTab() {
  // Hypermedia: follow entry.integrations link
  const { items: hmConnections } = useHypermediaCollection<HmIntegration & AdminConnection>('integrations');
  const connections: ReadonlyArray<AdminConnection> = hmConnections.length > 0
    ? (hmConnections as unknown as ReadonlyArray<AdminConnection>)
    : SAMPLE_ADMIN_PAYLOAD.connections;
  const a = { ...SAMPLE_ADMIN_PAYLOAD, connections };
  // Group connections by kind for the section-by-kind layout the originals had.
  const byKind = useMemo(() => {
    const order = ['LMS', 'IDP', 'HRIS', 'LRS', 'Pod Federation', 'Manual'];
    const g = new Map<string, AdminConnection[]>();
    for (const c of a.connections) {
      if (!g.has(c.kind)) g.set(c.kind, []);
      g.get(c.kind)!.push(c);
    }
    const kinds = Array.from(g.keys()).sort((x, y) => {
      const i = order.indexOf(x), j = order.indexOf(y);
      return (i === -1 ? 99 : i) - (j === -1 ? 99 : j);
    });
    return kinds.map(k => ({ kind: k, items: g.get(k)! }));
  }, [a.connections]);

  return (
    <Card title="Integrations" right={<Pill tone="accent">foxxi.connect_lms</Pill>}>
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 14 }}>
        Connected systems whose course catalogs sync into the tenant. Each connection's status,
        last sync time, and content contribution count are shown. Auth warnings flag
        credentials about to expire or missing scopes.
      </div>
      {byKind.map(group => (
        <div key={group.kind} style={{ marginBottom: 20 }}>
          <div className="label" style={{ marginBottom: 8 }}>── {group.kind} ──</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
            {group.items.map(c => <IntegrationCard key={c.id} c={c} />)}
          </div>
        </div>
      ))}
      <button onClick={() => alert('Demo: would launch the connector chooser + OAuth flow for the selected system.')}
        style={{
          width: '100%', padding: '18px 14px',
          background: 'transparent',
          border: '2px dashed var(--border)',
          borderRadius: 4, cursor: 'pointer',
          color: 'var(--text-dim)',
          fontFamily: "'JetBrains Mono', monospace",
          textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 12,
        }}
      >+ Add integration</button>
    </Card>
  );
}

function IntegrationCard({ c }: { c: AdminConnection }) {
  const tone: 'good' | 'warn' | 'bad' | 'neutral' =
    c.status === 'connected' ? 'good'
    : c.status === 'degraded' ? 'warn'
    : c.status === 'auth-expired' ? 'bad'
    : c.status === 'available' ? 'neutral'
    : 'neutral';

  const actions: { label: string; onClick: () => void; primary?: boolean }[] = [];
  if (c.status === 'auth-expired') {
    actions.push({ label: 'Reauthorize', onClick: () => alert(`Demo: would relaunch ${c.auth_method} flow for ${c.product}`), primary: true });
  } else if (c.status === 'available') {
    actions.push({ label: 'Connect', onClick: () => alert(`Demo: would initiate ${c.auth_method} for ${c.product}`), primary: true });
  } else if (c.status === 'connected' || c.status === 'degraded') {
    actions.push({ label: 'Sync now', onClick: () => alert(`Demo: would trigger out-of-band sync against ${c.instance}`), primary: c.status === 'connected' });
    actions.push({ label: 'Configure', onClick: () => alert(`Demo: would open ${c.product} configuration drawer`) });
  }

  return (
    <div style={{
      padding: 12, background: 'var(--panel-2)',
      borderRadius: 4, border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Pill tone={tone}>{c.status}</Pill>
        <Pill tone="accent">{c.kind}</Pill>
        <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
          <code>{c.id}</code>
        </div>
      </div>
      <div style={{
        marginTop: 8,
        fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
        fontSize: 17, fontWeight: 500,
      }}>{c.product}</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2, fontFamily: "'JetBrains Mono', monospace" }}>{c.instance}</div>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.7 }}>
        auth: {c.auth_method}<br />
        last sync: {c.last_sync}<br />
        frequency: {c.sync_frequency}<br />
        courses contributed: <strong style={{ color: 'var(--accent)' }}>{c.courses_contributed}</strong>
      </div>
      {c.auth_warning && (
        <div style={{
          marginTop: 10, padding: 8,
          background: 'rgba(184,114,17,0.12)',
          border: '1px solid rgba(184,114,17,0.4)',
          borderRadius: 4, fontSize: 11, color: 'var(--warn)',
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          ⚠ {c.auth_warning}
        </div>
      )}
      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          {actions.map(a => (
            <Button key={a.label} small primary={a.primary} onClick={a.onClick}>{a.label}</Button>
          ))}
        </div>
      )}
    </div>
  );
}

