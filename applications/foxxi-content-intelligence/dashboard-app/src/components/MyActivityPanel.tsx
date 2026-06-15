/**
 * My xAPI activity — the learner-facing LRS view. Reads the conformant
 * xAPI Statements resource (GET {base}/xapi/statements) with the learner's
 * own session token (a Bearer the LRS accepts), then shows the learning
 * record the LRS holds. By default it filters to statements where the
 * learner is the actor ("only mine"); a toggle reveals the full tenant
 * stream for context. Read-only — this is the user's window onto the LRS,
 * not an operator console (that's the admin LRS panel).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useHypermedia } from '../hypermedia.js';
import { Card, Button, Pill } from './common.js';
import type { FoxxiSession } from '../auth/session.js';

interface Statement {
  id?: string;
  actor?: { name?: string; mbox?: string; account?: { name?: string } };
  verb?: { id: string; display?: Record<string, string> };
  object?: { id?: string; definition?: { name?: Record<string, string>; type?: string } };
  result?: { success?: boolean; completion?: boolean; score?: { scaled?: number } };
  timestamp?: string;
  stored?: string;
}

function bridgeOrigin(entry: { '@id'?: string; _links?: Record<string, { href: string }> } | null): string {
  const candidate = entry?.['@id'] ?? entry?._links?.['self']?.href ?? entry?._links?.['courses']?.href;
  if (!candidate) return '';
  try { return new URL(candidate).origin; } catch { return ''; }
}

function isMine(s: Statement, session: FoxxiSession): boolean {
  const a = s.actor;
  if (!a) return false;
  const name = session.name?.toLowerCase();
  const uid = session.userId?.toLowerCase();
  const acct = a.account?.name?.toLowerCase();
  const an = a.name?.toLowerCase();
  return (!!name && an === name) || (!!uid && (acct === uid || an === uid)) || (!!name && acct === name);
}

export function MyActivityPanel({ session }: { session: FoxxiSession }) {
  const { entry } = useHypermedia();
  const origin = bridgeOrigin(entry);
  const [statements, setStatements] = useState<Statement[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(true);

  useEffect(() => {
    if (!origin) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${origin}/xapi/statements?limit=200`, {
          headers: { Authorization: `Bearer ${session.bearerToken}`, 'X-Experience-API-Version': '2.0.0' },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as { statements?: Statement[] };
        if (!cancelled) { setStatements(j.statements ?? []); setErr(null); }
      } catch (e) { if (!cancelled) setErr((e as Error).message); }
    })();
    return () => { cancelled = true; };
  }, [origin, session.bearerToken]);

  const mineCount = useMemo(() => (statements ?? []).filter(s => isMine(s, session)).length, [statements, session]);
  const shown = useMemo(() => {
    const all = statements ?? [];
    return onlyMine ? all.filter(s => isMine(s, session)) : all;
  }, [statements, onlyMine, session]);

  return (
    <Card title="My learning activity"
      right={<Pill tone="accent">xAPI / LRS</Pill>}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} /> only mine
        </label>
        {statements && (
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {mineCount} of {statements.length} statements are yours
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>signed in as {session.name}</span>
      </div>

      {err && <div style={{ color: 'var(--bad)', fontSize: 12 }}>✗ {err}</div>}
      {!statements && !err && <div style={{ color: 'var(--text-dim)' }}>Loading…</div>}
      {statements && shown.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: 12 }}>
          {onlyMine
            ? 'No xAPI statements recorded for you yet. Launch a course or complete a lesson — every interaction lands here as an xAPI statement.'
            : 'No statements in the LRS yet.'}
        </div>
      )}
      {statements && shown.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          {shown.map((s, i) => (
            <div key={s.id ?? i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600, minWidth: 110 }}>
                {s.verb?.display?.en ?? s.verb?.id.split(/[#/]/).pop() ?? 'did'}
              </span>
              <span style={{ flex: 1 }}>
                {s.object?.definition?.name?.en ?? s.object?.id ?? '—'}
              </span>
              {s.result?.success !== undefined && (
                <Pill tone={s.result.success ? 'good' : 'bad'}>{s.result.success ? 'passed' : 'failed'}</Pill>
              )}
              {s.result?.score?.scaled !== undefined && (
                <span style={{ color: 'var(--text-dim)' }}>{Math.round((s.result.score.scaled) * 100)}%</span>
              )}
              <span style={{ color: 'var(--text-dim)', fontSize: 11, minWidth: 140, textAlign: 'right' }}>
                {(s.timestamp ?? s.stored ?? '').slice(0, 19).replace('T', ' ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
