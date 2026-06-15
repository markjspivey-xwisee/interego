/**
 * LRS-admin panel — the operator view for Foxxi-as-LRS.
 *
 * Three subviews tabbed inside one panel:
 *   Statements   live + paginated browser, filterable by verb / actor / time
 *   Aggregates   top verbs / activities / actors + hourly volume sparkline
 *   Conformance  Foxxi xAPI Profile id, statement count, in-profile rate
 *   Config       basic-auth keys, forwarding targets, retention, supported versions
 *
 * Backed by /xapi/admin/* on the bridge. Gated to admin + learning-engineer
 * roles (the bridge handler enforces).
 */

import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Card, Pill, Button } from './common.js';
import { useHypermedia, linkOf, fetchHypermedia } from '../hypermedia.js';

interface StatementRow {
  id: string;
  stored: string;
  voided: boolean;
  actor: { name?: string; account?: { name?: string } };
  verb: { id: string; display?: Record<string, string> };
  object: { id?: string; definition?: { name?: Record<string, string>; type?: string } };
  result?: { success?: boolean; completion?: boolean; score?: { scaled?: number } };
  context?: { extensions?: Record<string, unknown> };
}

interface AggregateRow {
  id: string;
  display?: string;
  name?: string;
  count: number;
}

type LrsTab = 'statements' | 'aggregates' | 'conformance' | 'forwarding' | 'inbound' | 'config';
const LRS_TAB_VALUES = new Set<LrsTab>(['statements', 'aggregates', 'conformance', 'forwarding', 'inbound', 'config']);

// ── Shared admin-API helpers ────────────────────────────────────────

/** The `/xapi/admin` base, derived from the advertised statements-admin link. */
function adminBaseOf(entry: Parameters<typeof linkOf>[0]): string | null {
  const s = linkOf(entry, 'statements-admin');
  if (!s) return null;
  return s.replace(/\/statements(\?.*)?$/, '');
}

/** Bearer-authed mutation (POST/PUT/DELETE) returning JSON (or undefined on 204). */
async function adminMutate<T>(url: string, bearer: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json() as { error?: string }; if (j?.error) msg = j.error; } catch { /* keep status */ }
    throw new Error(msg);
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

/** Trigger a client-side file download. */
function downloadFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** Dereferenceable URL for a verb IRI. A foxxi verb resolves to its own
 *  term resource (`/ns/foxxi/term/<name>`); any other verb resolves to
 *  its own IRI. Every verb in the statement browser is a live link. */
function verbHref(verbId: string): string {
  const m = verbId.match(/^(.*\/ns\/foxxi)#(.+)$/);
  return m ? `${m[1]}/term/${m[2]}` : verbId;
}

export function LrsAdminPanel({ bearer, isAdmin = false }: { bearer: string; isAdmin?: boolean }) {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Admins may browse any tenant's LRS (incl. the isolated `agent-mesh` tenant
  // the agent-activity projector lands in); '' = the default tenant.
  const [tenant, setTenant] = useState<string>('');
  // /statements                    → statements (default)
  // /statements/aggregates         → aggregates
  // /statements/conformance        → conformance
  // /lrs-config                    → config
  // /statements/<uuid>             → statements (with deep-link, not implemented here yet)
  const onLrsConfig = location.pathname === '/lrs-config';
  const sub = params.statementSub as string | undefined;
  let tab: LrsTab = 'statements';
  if (onLrsConfig) tab = 'config';
  else if (sub === 'aggregates' || sub === 'conformance' || sub === 'forwarding' || sub === 'inbound') tab = sub;
  // Note: any other :statementSub value is treated as a statement-id deep link;
  // for now we render the statements view (deep-link selection wiring to follow).
  const setTab = (v: LrsTab) => {
    if (v === 'config') navigate('/lrs-config');
    else if (v === 'statements') navigate('/statements');
    else navigate(`/statements/${v}`);
  };
  return (
    <Card title="xAPI / LRS administration"
      right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {isAdmin && tab !== 'config' && <TenantPicker bearer={bearer} tenant={tenant} setTenant={setTenant} />}
          <Pill tone="accent">Foxxi-as-LRS</Pill>
        </div>
      }>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        {(['statements', 'aggregates', 'conformance', 'forwarding', 'inbound', 'config'] as const).map(t => (
          <Button key={t} primary={tab === t} onClick={() => setTab(t)} small>
            {t === 'statements' ? 'Statement browser' :
             t === 'aggregates' ? 'Aggregates' :
             t === 'conformance' ? 'Profile conformance' :
             t === 'forwarding' ? 'Forwarding out' :
             t === 'inbound' ? 'Forwarding in' : 'LRS config'}
          </Button>
        ))}
      </div>
      {tab === 'statements' && <StatementsView bearer={bearer} tenant={tenant} />}
      {tab === 'aggregates' && <AggregatesView bearer={bearer} tenant={tenant} />}
      {tab === 'conformance' && <ConformanceView bearer={bearer} tenant={tenant} />}
      {tab === 'forwarding' && <ForwardingView bearer={bearer} tenant={tenant} isAdmin={isAdmin} />}
      {tab === 'inbound' && <InboundView bearer={bearer} tenant={tenant} isAdmin={isAdmin} />}
      {tab === 'config' && <ConfigView bearer={bearer} />}
    </Card>
  );
}

/** Append ?tenant= (or &tenant=) to an admin URL when a non-default tenant is picked. */
function withTenant(url: string, tenant: string): string {
  if (!tenant) return url;
  return url + (url.includes('?') ? '&' : '?') + 'tenant=' + encodeURIComponent(tenant);
}

/** Admin-only tenant selector — lists every tenant holding statements (with
 *  counts), derived from the statements-admin link's sibling /tenants endpoint.
 *  Hidden when there is no non-default tenant to choose. */
function TenantPicker({ bearer, tenant, setTenant }: { bearer: string; tenant: string; setTenant: (t: string) => void }) {
  const { entry } = useHypermedia();
  const base = linkOf(entry, 'statements-admin');
  const [tenants, setTenants] = useState<{ tenant: string; count: number }[] | null>(null);
  useEffect(() => {
    if (!base) return;
    const url = base.replace(/\/statements(\?.*)?$/, '/tenants');
    let cancelled = false;
    fetchHypermedia<{ tenants: { tenant: string; count: number }[] }>(url, bearer)
      .then(r => { if (!cancelled) setTenants(r.tenants ?? []); })
      .catch(() => { if (!cancelled) setTenants([]); });
    return () => { cancelled = true; };
  }, [bearer, base]);
  if (!tenants || tenants.filter(t => t.tenant !== 'default').length === 0) return null;
  const def = tenants.find(t => t.tenant === 'default');
  return (
    <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
      tenant
      <select value={tenant} onChange={e => setTenant(e.target.value)}
        style={{ padding: '4px 6px', borderRadius: 4, border: '1px solid var(--border)', fontSize: 12, background: 'var(--panel)', color: 'var(--text)' }}>
        <option value="">default{def ? ` (${def.count})` : ''}</option>
        {tenants.filter(t => t.tenant !== 'default').map(t => (
          <option key={t.tenant} value={t.tenant}>{t.tenant} ({t.count})</option>
        ))}
      </select>
    </label>
  );
}

// ── Statement browser ───────────────────────────────────────────────

function StatementsView({ bearer, tenant }: { bearer: string; tenant: string }) {
  const { entry } = useHypermedia();
  const baseUrl = linkOf(entry, 'statements-admin');
  const [data, setData] = useState<{ total: number; page: StatementRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [verb, setVerb] = useState<string>('');
  const [actor, setActor] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selected, setSelected] = useState<StatementRow | null>(null);

  useEffect(() => {
    if (!baseUrl) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const q = new URLSearchParams();
      q.set('limit', '50');
      q.set('offset', String(offset));
      if (verb) q.set('verb', verb);
      if (actor) q.set('actor', actor);
      if (tenant) q.set('tenant', tenant);
      try {
        const r = await fetchHypermedia<{ total: number; page: StatementRow[] }>(`${baseUrl}?${q}`, bearer);
        if (!cancelled) { setData(r); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
      if (autoRefresh && !cancelled) timer = setTimeout(load, 5000);
    }
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [bearer, baseUrl, verb, actor, offset, autoRefresh, tenant]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          placeholder="filter by verb IRI" value={verb} onChange={e => { setVerb(e.target.value); setOffset(0); }}
          style={{ padding: 6, borderRadius: 4, border: '1px solid var(--border)', minWidth: 240, fontSize: 12 }}
        />
        <input
          placeholder="filter by actor name / mbox" value={actor} onChange={e => { setActor(e.target.value); setOffset(0); }}
          style={{ padding: 6, borderRadius: 4, border: '1px solid var(--border)', minWidth: 200, fontSize: 12 }}
        />
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} /> auto-refresh
        </label>
        <span style={{ flex: 1 }} />
        {data && data.page.length > 0 && (
          <>
            <Button small onClick={() => downloadFile(`xapi-statements-${Date.now()}.json`, JSON.stringify(data.page, null, 2), 'application/json')}>Export JSON</Button>
            <Button small onClick={() => downloadFile(`xapi-statements-${Date.now()}.csv`, statementsToCsv(data.page), 'text/csv')}>Export CSV</Button>
          </>
        )}
        {data && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{data.total} total statements</span>}
      </div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 12, marginBottom: 8 }}>✗ {err}</div>}
      {!data && !err && <div style={{ color: 'var(--text-dim)' }}>Loading…</div>}
      {data && data.page.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: 12 }}>
          No statements match the current filter. (Trigger a course launch, an ask-question call, or any
          affordance to populate the stream — every bridge call lands as one xAPI statement.)
        </div>
      )}
      {data && data.page.length > 0 && (
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, maxHeight: 460, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
            {data.page.map(r => (
              <div key={r.id}
                onClick={() => setSelected(r)}
                style={{
                  padding: '8px 10px', borderBottom: '1px solid var(--border)',
                  cursor: 'pointer', fontSize: 12,
                  background: selected?.id === r.id ? 'var(--panel-2)' : 'transparent',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <a
                    href={verbHref(r.verb.id)}
                    target="_blank" rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    title={`Dereference this verb — ${r.verb.id}`}
                    style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
                  >{r.verb.display?.en ?? r.verb.id.split(/[#/]/).pop()}</a>
                  <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{r.stored.slice(11, 19)}</span>
                </div>
                <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>
                  {r.actor.name ?? r.actor.account?.name ?? 'unknown'} → {r.object?.definition?.name?.en ?? r.object?.id ?? '—'}
                </div>
              </div>
            ))}
          </div>
          <div style={{ flex: 1.4, padding: 12, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel-2)' }}>
            {!selected && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Click a statement to see the full xAPI envelope.</div>}
            {selected && (
              <pre style={{ margin: 0, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.4, overflow: 'auto', maxHeight: 440 }}>
{JSON.stringify(selected, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
      {data && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <Button small onClick={() => setOffset(Math.max(0, offset - 50))} disabled={offset === 0}>← Prev 50</Button>
          <Button small onClick={() => setOffset(offset + 50)} disabled={offset + 50 >= data.total}>Next 50 →</Button>
        </div>
      )}
    </div>
  );
}

// ── Aggregates ──────────────────────────────────────────────────────

function AggregatesView({ bearer, tenant }: { bearer: string; tenant: string }) {
  const { entry } = useHypermedia();
  const url = linkOf(entry, 'statements-aggregates');
  const [data, setData] = useState<null | {
    total: number;
    errors: number;
    successRate: number;
    topVerbs: AggregateRow[];
    topActivities: AggregateRow[];
    topActors: AggregateRow[];
    hourlyVolume: [string, number][];
  }>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const u = withTenant(url, tenant);
    const fetcher = () => fetchHypermedia<NonNullable<typeof data>>(u, bearer)
      .then(r => { if (!cancelled) { setData(r); setErr(null); } })
      .catch(e => !cancelled && setErr((e as Error).message));
    void fetcher();
    const t = setInterval(fetcher, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [bearer, url, tenant]);

  const maxHourly = useMemo(() => data?.hourlyVolume.reduce((m, [, n]) => Math.max(m, n), 0) ?? 0, [data]);

  if (err) return <div style={{ color: 'var(--bad)' }}>✗ {err}</div>;
  if (!data) return <div style={{ color: 'var(--text-dim)' }}>Loading…</div>;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Stat label="Total statements" value={data.total} />
        <Stat label="Errors (success=false)" value={data.errors} tone={data.errors > 0 ? 'warn' : 'good'} />
        <Stat label="Success rate" value={`${(data.successRate * 100).toFixed(1)}%`} tone="accent" />
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Hourly volume (last 24h)</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 80, padding: '6px 8px', background: 'var(--panel-2)', borderRadius: 4, border: '1px solid var(--border)' }}>
          {data.hourlyVolume.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12, alignSelf: 'center' }}>no data yet</div>}
          {data.hourlyVolume.map(([h, n]) => (
            <div key={h} title={`${h}: ${n}`} style={{ flex: 1, background: 'var(--accent)', height: `${(n / maxHourly) * 100}%`, minHeight: 2 }} />
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <TopList title="Top verbs" rows={data.topVerbs} />
        <TopList title="Top activities" rows={data.topActivities} />
        <TopList title="Top actors" rows={data.topActors} />
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'good' | 'warn' | 'accent' }) {
  const color = tone === 'good' ? 'var(--good)' : tone === 'warn' ? 'var(--warn)' : tone === 'accent' ? 'var(--accent)' : 'var(--text)';
  return (
    <div style={{ padding: '10px 14px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function TopList({ title, rows }: { title: string; rows: AggregateRow[] }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{title}</div>
      <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4 }}>
        {rows.length === 0 && <div style={{ padding: 10, color: 'var(--text-dim)', fontSize: 12 }}>—</div>}
        {rows.map(r => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginRight: 6 }}
              title={r.id}>{r.display ?? r.name ?? r.id.split(/[#:/]/).pop()}</span>
            <strong>{r.count}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Conformance ─────────────────────────────────────────────────────

function ConformanceView({ bearer, tenant }: { bearer: string; tenant: string }) {
  const { entry } = useHypermedia();
  const url = linkOf(entry, 'statements-conformance');
  const [data, setData] = useState<null | {
    profileId: string;
    profileUrl: string;
    vocabularyUrl?: string;
    vocabularyDereferenced?: boolean;
    totalStatements: number;
    inProfile: number;
    outOfProfile: number;
    outOfProfileVerbs: string[];
    profileConformanceRate: number;
    declaredVerbs: number;
  }>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    fetchHypermedia<NonNullable<typeof data>>(withTenant(url, tenant), bearer).then(setData).catch(e => setErr((e as Error).message));
  }, [bearer, url, tenant]);

  if (err) return <div style={{ color: 'var(--bad)' }}>✗ {err}</div>;
  if (!data) return <div style={{ color: 'var(--text-dim)' }}>Loading…</div>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Stat label="In-profile statements" value={data.inProfile} tone="good" />
        <Stat label="Out-of-profile statements" value={data.outOfProfile} tone={data.outOfProfile > 0 ? 'warn' : 'good'} />
        <Stat label="Conformance rate" value={`${(data.profileConformanceRate * 100).toFixed(1)}%`} tone="accent" />
      </div>
      <div style={{ padding: 12, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4 }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Foxxi xAPI Profile</div>
        <div style={{ fontSize: 12, marginTop: 4, fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-all' }}>
          {data.profileId}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
          {data.declaredVerbs} verbs declared · <a href={data.profileUrl} target="_blank" rel="noreferrer">view JSON-LD profile →</a>
        </div>
        {data.vocabularyUrl && (
          <div style={{ fontSize: 11, marginTop: 6 }}>
            <span style={{
              display: 'inline-block', padding: '1px 6px', borderRadius: 3, marginRight: 6,
              background: data.vocabularyDereferenced ? 'rgba(47,106,58,0.16)' : 'rgba(168,51,31,0.16)',
              color: data.vocabularyDereferenced ? 'var(--good)' : 'var(--bad)',
            }}>
              {data.vocabularyDereferenced ? '✓ vocabulary dereferenced' : '✗ vocabulary did not dereference'}
            </span>
            this conformance check performed a live GET of the foxxi vocabulary — not a hardcoded list ·{' '}
            <a href={data.vocabularyUrl} target="_blank" rel="noreferrer">{data.vocabularyUrl} →</a>
          </div>
        )}
      </div>
      {data.outOfProfileVerbs.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            Verbs not declared in the profile
          </div>
          {data.outOfProfileVerbs.map(v => (
            <div key={v} style={{ padding: '4px 10px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-all', marginBottom: 4 }}>{v}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Config ──────────────────────────────────────────────────────────

function ConfigView({ bearer }: { bearer: string }) {
  const { entry } = useHypermedia();
  const url = linkOf(entry, 'lrs-config');
  const [data, setData] = useState<null | {
    selfBaseUrl: string;
    profileId: string;
    profileUrl: string;
    aboutUrl: string;
    statementsUrl: string;
    basicAuthKeys: { principal: string; hint: string }[];
    forwardingTargets: { endpoint: string; version: string }[];
    retention: string;
    versionsSupported: string[];
  }>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    fetchHypermedia<NonNullable<typeof data>>(url, bearer).then(setData).catch(e => setErr((e as Error).message));
  }, [bearer, url]);
  if (err) return <div style={{ color: 'var(--bad)' }}>✗ {err}</div>;
  if (!data) return <div style={{ color: 'var(--text-dim)' }}>Loading…</div>;
  return (
    <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
      <Row label="LRS endpoint" value={data.statementsUrl} />
      <Row label="About endpoint" value={data.aboutUrl} />
      <Row label="xAPI versions supported" value={data.versionsSupported.join(', ')} />
      <Row label="Profile" value={data.profileUrl} link />
      <Row label="Retention" value={data.retention} />
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
          Basic-auth credentials accepted
        </div>
        {data.basicAuthKeys.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>none — only Bearer session tokens accepted</div>}
        {data.basicAuthKeys.map((k, i) => (
          <div key={i} style={{ padding: '6px 10px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12, marginBottom: 4 }}>
            <code>{k.principal}</code> <span style={{ color: 'var(--text-dim)' }}>{k.hint}</span>
          </div>
        ))}
      </div>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
          Statement-forwarding targets
        </div>
        {data.forwardingTargets.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>none — statements stay in Foxxi-as-LRS</div>}
        {data.forwardingTargets.map((t, i) => (
          <div key={i} style={{ padding: '6px 10px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12, marginBottom: 4 }}>
            <code>{t.endpoint}</code> <Pill>xAPI {t.version}</Pill>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value, link }: { label: string; value: string; link?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'baseline' }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-all' }}>
        {link ? <a href={value} target="_blank" rel="noreferrer">{value}</a> : value}
      </div>
    </div>
  );
}

// ── Outbound forwarding ─────────────────────────────────────────────

interface ForwardingTargetView {
  id: string; label: string; endpoint: string; version: string; enabled: boolean; createdAt: string;
  principal: string; secretHint: string;
  metrics: {
    delivered: number; failed: number; lastStatus: number | null; lastError: string | null;
    lastAttemptAt: string | null; lastDeliveredAt: string | null; deadLetterDepth: number; avgLatencyMs: number | null;
  };
}

function statementsToCsv(rows: StatementRow[]): string {
  const head = ['id', 'stored', 'voided', 'actor', 'verb', 'object', 'success', 'score'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map(r => [
    r.id, r.stored, r.voided,
    r.actor?.name ?? r.actor?.account?.name ?? '',
    r.verb?.id ?? '',
    r.object?.definition?.name?.en ?? r.object?.id ?? '',
    r.result?.success ?? '',
    r.result?.score?.scaled ?? '',
  ].map(esc).join(','));
  return [head.join(','), ...lines].join('\n');
}

function ForwardingView({ bearer, tenant, isAdmin }: { bearer: string; tenant: string; isAdmin: boolean }) {
  const { entry } = useHypermedia();
  const base = adminBaseOf(entry);
  const [targets, setTargets] = useState<ForwardingTargetView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ label: '', endpoint: '', credentials: '', version: '2.0.0' });

  const load = React.useCallback(async () => {
    if (!base) return;
    try {
      const r = await fetchHypermedia<{ targets: ForwardingTargetView[] }>(withTenant(`${base}/forwarding/targets`, tenant), bearer);
      setTargets(r.targets ?? []); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, [base, bearer, tenant]);

  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await load(); setErr(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const add = () => act(async () => {
    if (!base) return;
    await adminMutate(`${withTenant(`${base}/forwarding/targets`, tenant)}`, bearer, 'POST', form);
    setForm({ label: '', endpoint: '', credentials: '', version: '2.0.0' });
  });

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
        Every Statement this LRS accepts is forwarded to each enabled downstream LRS below
        (xAPI Statement Forwarding). Failures land in a per-target dead-letter queue you can retry.
      </div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 12 }}>✗ {err}</div>}
      {!targets && !err && <div style={{ color: 'var(--text-dim)' }}>Loading…</div>}
      {targets && targets.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: 12, border: '1px dashed var(--border)', borderRadius: 4 }}>
          No downstream targets. Statements stay in Foxxi-as-LRS. {isAdmin ? 'Add a target below.' : ''}
        </div>
      )}
      {targets && targets.map(t => (
        <div key={t.id} style={{ padding: 12, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>{t.label}</strong>
            <Pill tone={t.enabled ? 'good' : 'neutral'}>{t.enabled ? 'enabled' : 'disabled'}</Pill>
            <Pill>xAPI {t.version}</Pill>
            <code style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t.principal} {t.secretHint}</code>
            <span style={{ flex: 1 }} />
            {isAdmin && (
              <>
                <Button small disabled={busy} onClick={() => act(() => adminMutate(`${base}/forwarding/targets/${t.id}`, bearer, 'PUT', { enabled: !t.enabled }))}>
                  {t.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button small disabled={busy || t.metrics.deadLetterDepth === 0} onClick={() => act(() => adminMutate(`${base}/forwarding/retry`, bearer, 'POST', { id: t.id }))}>
                  Retry ({t.metrics.deadLetterDepth})
                </Button>
                <Button small danger disabled={busy} onClick={() => act(() => adminMutate(`${base}/forwarding/targets/${t.id}`, bearer, 'DELETE'))}>Delete</Button>
              </>
            )}
          </div>
          <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-all', marginTop: 6 }}>{t.endpoint}/statements</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 10 }}>
            <Stat label="Delivered" value={t.metrics.delivered} tone="good" />
            <Stat label="Failed" value={t.metrics.failed} tone={t.metrics.failed > 0 ? 'warn' : 'good'} />
            <Stat label="Dead-letter" value={t.metrics.deadLetterDepth} tone={t.metrics.deadLetterDepth > 0 ? 'warn' : 'good'} />
            <Stat label="Avg latency" value={t.metrics.avgLatencyMs != null ? `${t.metrics.avgLatencyMs} ms` : '—'} tone="accent" />
          </div>
          {t.metrics.lastError && (
            <div style={{ fontSize: 11, color: 'var(--bad)', marginTop: 6 }}>last error: {t.metrics.lastError}</div>
          )}
        </div>
      ))}
      {isAdmin && (
        <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 4 }}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Add downstream target</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input placeholder="label (optional)" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} style={inputStyle} />
            <input placeholder="endpoint e.g. https://lrs.example/xapi" value={form.endpoint} onChange={e => setForm({ ...form, endpoint: e.target.value })} style={inputStyle} />
            <input placeholder="credentials user:pass" value={form.credentials} onChange={e => setForm({ ...form, credentials: e.target.value })} style={inputStyle} />
            <input placeholder="xAPI version" value={form.version} onChange={e => setForm({ ...form, version: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ marginTop: 8 }}>
            <Button small primary disabled={busy || !form.endpoint || !form.credentials.includes(':')} onClick={add}>Add target</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inbound forwarding (credentials + receipts) ─────────────────────

interface InboundCredentialView { id: string; principal: string; secretHint: string; tenant: string; label: string; createdAt: string; }
interface InboundReceipt { statementId: string; principal: string; verb: string | null; actor: string | null; at: string; }

function InboundView({ bearer, tenant, isAdmin }: { bearer: string; tenant: string; isAdmin: boolean }) {
  const { entry } = useHypermedia();
  const base = adminBaseOf(entry);
  const [creds, setCreds] = useState<InboundCredentialView[] | null>(null);
  const [feed, setFeed] = useState<{ total: number; receipts: InboundReceipt[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ principal: '', secret: '', label: '', tenant: '' });

  const load = React.useCallback(async () => {
    if (!base) return;
    try {
      const [c, f] = await Promise.all([
        fetchHypermedia<{ credentials: InboundCredentialView[] }>(`${base}/credentials`, bearer),
        fetchHypermedia<{ total: number; receipts: InboundReceipt[] }>(withTenant(`${base}/forwarding/inbound`, tenant), bearer),
      ]);
      setCreds(c.credentials ?? []); setFeed(f); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, [base, bearer, tenant]);

  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await load(); setErr(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const add = () => act(async () => {
    if (!base) return;
    await adminMutate(`${base}/credentials`, bearer, 'POST', form);
    setForm({ principal: '', secret: '', label: '', tenant: '' });
  });

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
        Upstream systems forward Statements INTO this LRS by POSTing to <code>/xapi/statements</code> with one of the
        Basic-auth credentials below. Each accepted Statement is recorded in the receipt feed.
      </div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 12 }}>✗ {err}</div>}

      <div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Inbound credentials</div>
        {!creds && <div style={{ color: 'var(--text-dim)' }}>Loading…</div>}
        {creds && creds.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>none configured — only Bearer session tokens accepted</div>}
        {creds && creds.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 4, fontSize: 12 }}>
            <code>{c.principal}</code>
            <span style={{ color: 'var(--text-dim)' }}>{c.secretHint}</span>
            <Pill>{c.tenant}</Pill>
            <span style={{ color: 'var(--text-dim)' }}>{c.label}</span>
            <span style={{ flex: 1 }} />
            {isAdmin && <Button small danger disabled={busy} onClick={() => act(() => adminMutate(`${base}/credentials/${c.id}`, bearer, 'DELETE'))}>Revoke</Button>}
          </div>
        ))}
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input placeholder="principal (user)" value={form.principal} onChange={e => setForm({ ...form, principal: e.target.value })} style={inputStyle} />
            <input placeholder="secret (pass)" value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} style={inputStyle} />
            <input placeholder="tenant (optional)" value={form.tenant} onChange={e => setForm({ ...form, tenant: e.target.value })} style={inputStyle} />
            <input placeholder="label (optional)" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} style={inputStyle} />
            <Button small primary disabled={busy || !form.principal || !form.secret} onClick={add}>Add credential</Button>
          </div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Recently received via forwarding {feed && `(${feed.total})`}
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 4, maxHeight: 320, overflowY: 'auto' }}>
          {feed && feed.receipts.length === 0 && <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>No statements received via an inbound credential yet.</div>}
          {feed && feed.receipts.map((r, i) => (
            <div key={`${r.statementId}-${i}`} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <code style={{ color: 'var(--accent)' }}>{r.principal}</code>
              <span style={{ color: 'var(--text-dim)' }}>{r.verb?.split(/[#/]/).pop() ?? '—'}</span>
              <span>{r.actor ?? 'unknown'}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{r.at.slice(11, 19)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: 6, borderRadius: 4, border: '1px solid var(--border)', fontSize: 12,
  background: 'var(--panel)', color: 'var(--text)', minWidth: 160,
};
