/**
 * Reports panel (operator dashboard) — LMS + LRS reports built on the SHARED
 * report views (reports-ui/, also used by the microsite). Fetches via the
 * operator session bearer + the hypermedia-advertised admin URLs. Adds the LMS
 * completions report + the GAP-4 actorKind/contextKind splits the legacy
 * AggregatesView didn't surface.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Card, Button } from './common.js';
import { useHypermedia, linkOf, fetchHypermedia } from '../hypermedia.js';
import { normalizeLrs, lmsFromStatements, type LrsAnalytics, type LmsCompletions } from '../../../reports-ui/report-model.js';
import { LrsAnalyticsView, LmsCompletionsView } from '../../../reports-ui/report-views.js';

export function ReportsPanel({ bearer }: { bearer: string }) {
  const { entry } = useHypermedia();
  const aggUrl = linkOf(entry, 'statements-aggregates');
  const confUrl = linkOf(entry, 'statements-conformance');
  const stmtUrl = linkOf(entry, 'statements-admin');
  const [tab, setTab] = useState<'lrs' | 'lms'>('lrs');
  const [lrs, setLrs] = useState<LrsAnalytics | null>(null);
  const [lms, setLms] = useState<LmsCompletions | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [agg, conf, stmts] = await Promise.all([
        aggUrl ? fetchHypermedia<Record<string, unknown>>(aggUrl, bearer) : Promise.resolve(null),
        confUrl ? fetchHypermedia<Record<string, unknown>>(confUrl, bearer).catch(() => null) : Promise.resolve(null),
        stmtUrl ? fetchHypermedia<{ page?: unknown[] }>(`${stmtUrl}?limit=200`, bearer).catch(() => ({ page: [] })) : Promise.resolve({ page: [] }),
      ]);
      if (agg) setLrs(normalizeLrs(agg, conf));
      setLms(lmsFromStatements((stmts?.page ?? []) as []));
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [aggUrl, confUrl, stmtUrl, bearer]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Card title="Reports — LMS + LRS"
      right={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button small primary={tab === 'lrs'} onClick={() => setTab('lrs')}>LRS analytics</Button>
          <Button small primary={tab === 'lms'} onClick={() => setTab('lms')}>LMS completions</Button>
          <Button small onClick={() => void load()}>{loading ? '…' : 'Refresh'}</Button>
        </div>
      }>
      {err && <div style={{ color: 'var(--bad)', fontSize: 12, marginBottom: 10 }}>✗ {err}</div>}
      {tab === 'lrs' && (lrs ? <LrsAnalyticsView data={lrs} /> : !err && <div style={{ color: 'var(--text-dim)' }}>Loading LRS analytics…</div>)}
      {tab === 'lms' && (lms ? <LmsCompletionsView data={lms} /> : !err && <div style={{ color: 'var(--text-dim)' }}>Loading LMS completions…</div>)}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 12 }}>
        Per-learner competencies + credential wallets are on <a href="/my-activity">My activity</a> and the agent-performance / learner-record views.
      </div>
    </Card>
  );
}
