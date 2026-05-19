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
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Pill, Button } from './common.js';

const BRIDGE = (import.meta.env.VITE_FOXXI_BRIDGE_URL as string | undefined) ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';

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

async function api<T>(bearer: string, path: string): Promise<T> {
  const r = await fetch(`${BRIDGE}${path}`, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

type LrsTab = 'statements' | 'aggregates' | 'conformance' | 'config';
const LRS_TAB_VALUES = new Set<LrsTab>(['statements', 'aggregates', 'conformance', 'config']);

export function LrsAdminPanel({ bearer }: { bearer: string }) {
  const params = useParams();
  const navigate = useNavigate();
  const urlTab = params.lrsTab as string | undefined;
  const tab: LrsTab = (urlTab && LRS_TAB_VALUES.has(urlTab as LrsTab)) ? (urlTab as LrsTab) : 'statements';
  const setTab = (v: LrsTab) => navigate(`/admin/lrs/${v}`);
  return (
    <Card title="xAPI / LRS administration"
      right={<Pill tone="accent">Foxxi-as-LRS</Pill>}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        {(['statements', 'aggregates', 'conformance', 'config'] as const).map(t => (
          <Button key={t} primary={tab === t} onClick={() => setTab(t)} small>
            {t === 'statements' ? 'Statement browser' :
             t === 'aggregates' ? 'Aggregates' :
             t === 'conformance' ? 'Profile conformance' : 'LRS config'}
          </Button>
        ))}
      </div>
      {tab === 'statements' && <StatementsView bearer={bearer} />}
      {tab === 'aggregates' && <AggregatesView bearer={bearer} />}
      {tab === 'conformance' && <ConformanceView bearer={bearer} />}
      {tab === 'config' && <ConfigView bearer={bearer} />}
    </Card>
  );
}

// ── Statement browser ───────────────────────────────────────────────

function StatementsView({ bearer }: { bearer: string }) {
  const [data, setData] = useState<{ total: number; page: StatementRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [verb, setVerb] = useState<string>('');
  const [actor, setActor] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selected, setSelected] = useState<StatementRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const q = new URLSearchParams();
      q.set('limit', '50');
      q.set('offset', String(offset));
      if (verb) q.set('verb', verb);
      if (actor) q.set('actor', actor);
      try {
        const r = await api<{ total: number; page: StatementRow[] }>(bearer, `/xapi/admin/statements?${q}`);
        if (!cancelled) { setData(r); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
      if (autoRefresh && !cancelled) timer = setTimeout(load, 5000);
    }
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [bearer, verb, actor, offset, autoRefresh]);

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
                  <strong style={{ color: 'var(--accent)' }}>{r.verb.display?.en ?? r.verb.id.split('/').pop()}</strong>
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

function AggregatesView({ bearer }: { bearer: string }) {
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
    let cancelled = false;
    const t = setInterval(() => {
      api<typeof data>(bearer, '/xapi/admin/aggregates').then(r => { if (!cancelled) { setData(r); setErr(null); } }).catch(e => !cancelled && setErr((e as Error).message));
    }, 5000);
    api<typeof data>(bearer, '/xapi/admin/aggregates').then(r => { if (!cancelled) { setData(r); setErr(null); } }).catch(e => !cancelled && setErr((e as Error).message));
    return () => { cancelled = true; clearInterval(t); };
  }, [bearer]);

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

function ConformanceView({ bearer }: { bearer: string }) {
  const [data, setData] = useState<null | {
    profileId: string;
    profileUrl: string;
    totalStatements: number;
    inProfile: number;
    outOfProfile: number;
    outOfProfileVerbs: string[];
    profileConformanceRate: number;
    declaredVerbs: number;
  }>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<typeof data>(bearer, '/xapi/admin/conformance').then(setData).catch(e => setErr((e as Error).message));
  }, [bearer]);

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
    api<typeof data>(bearer, '/xapi/admin/config').then(setData).catch(e => setErr((e as Error).message));
  }, [bearer]);
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
