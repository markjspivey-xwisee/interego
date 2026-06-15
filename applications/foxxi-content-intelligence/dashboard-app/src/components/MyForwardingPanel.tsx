/**
 * My forwarding — the tenant/user-facing, self-sovereign forwarding console.
 *
 * The signed-in user manages THEIR OWN xAPI forwarding, as themselves, via
 * the signature-authed /agent/forwarding/targets + /agent/credentials
 * affordances (the bridge binds the owner to the verified signer, so a user
 * can only see/set their own — never another user's). Distinct from the
 * admin LRS "Forwarding" tabs, which are the operator/tenant-level view.
 *
 *   Out: downstream LRS endpoints YOUR statements forward to.
 *   In:  Basic-auth credentials an upstream uses to forward INTO your lens.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useHypermedia } from '../hypermedia.js';
import { Card, Button, Pill } from './common.js';
import type { FoxxiSession } from '../auth/session.js';
import { callSignedAffordance } from '../auth/signed-request.js';

interface TargetView {
  id: string; label: string; endpoint: string; version: string; enabled: boolean;
  principal: string; secretHint: string;
  metrics: { delivered: number; failed: number; deadLetterDepth: number; avgLatencyMs: number | null; lastError: string | null };
}
interface CredView { id: string; principal: string; secretHint: string; tenant: string; label: string; createdAt: string; }

function bridgeOrigin(entry: { '@id'?: string; _links?: Record<string, { href: string }> } | null): string {
  const c = entry?.['@id'] ?? entry?._links?.['self']?.href ?? entry?._links?.['courses']?.href;
  if (!c) return '';
  try { return new URL(c).origin; } catch { return ''; }
}

const inputStyle: React.CSSProperties = {
  padding: 6, borderRadius: 4, border: '1px solid var(--border)', fontSize: 12,
  background: 'var(--panel)', color: 'var(--text)', minWidth: 150,
};

export function MyForwardingPanel({ session }: { session: FoxxiSession }) {
  const { entry } = useHypermedia();
  const origin = bridgeOrigin(entry);
  const uid = session.userId;
  // When this is a "connect wallet" session, sign with the REAL connected key
  // (so forwarding keys to the real identity's lens); else the demo derivation.
  const signOpts = session.connectedPrivateKey ? { privateKey: session.connectedPrivateKey } : undefined;
  const [targets, setTargets] = useState<TargetView[] | null>(null);
  const [creds, setCreds] = useState<CredView[] | null>(null);
  const [ownerTenant, setOwnerTenant] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tForm, setTForm] = useState({ endpoint: '', credentials: '', label: '', version: '2.0.0' });
  const [cForm, setCForm] = useState({ principal: '', secret: '', label: '' });

  const load = useCallback(async () => {
    if (!origin) return;
    try {
      const [t, c] = await Promise.all([
        callSignedAffordance<{ targets: TargetView[]; ownerTenant: string }>(origin, 'forwarding/targets', uid, {}, signOpts),
        callSignedAffordance<{ credentials: CredView[] }>(origin, 'credentials', uid, {}, signOpts),
      ]);
      setTargets(t.targets ?? []); setOwnerTenant(t.ownerTenant ?? ''); setCreds(c.credentials ?? []); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, [origin, uid]);

  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await load(); setErr(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Card title="My forwarding"
      right={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {ownerTenant && <Pill>{ownerTenant}</Pill>}<Pill tone="accent">self-sovereign</Pill>
      </div>}>
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 14 }}>
        Manage your own xAPI forwarding, signed as <strong>{session.name}</strong>. Only you can see or change these —
        the bridge binds ownership to your verified signature. (The admin LRS tabs are the separate operator-level view.)
      </div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 12, marginBottom: 10 }}>✗ {err}</div>}

      {/* ── Outbound ── */}
      <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Forwarding out — my downstream LRS targets</div>
      {!targets && !err && <div style={{ color: 'var(--text-dim)' }}>Loading…</div>}
      {targets && targets.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 8 }}>No targets — your statements stay in Foxxi-as-LRS.</div>}
      {targets && targets.map(t => (
        <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 4, fontSize: 12, flexWrap: 'wrap' }}>
          <strong>{t.label}</strong>
          <Pill tone={t.enabled ? 'good' : 'neutral'}>{t.enabled ? 'on' : 'off'}</Pill>
          <code style={{ color: 'var(--text-dim)' }}>{t.endpoint}/statements</code>
          <span style={{ color: 'var(--text-dim)' }}>· {t.principal} {t.secretHint} · xAPI {t.version}</span>
          <span style={{ color: 'var(--text-dim)' }}>· ✓{t.metrics.delivered} ✗{t.metrics.failed}{t.metrics.deadLetterDepth ? ` · dead-letter ${t.metrics.deadLetterDepth}` : ''}</span>
          <span style={{ flex: 1 }} />
          <Button small danger disabled={busy} onClick={() => act(() => callSignedAffordance(origin, 'forwarding/targets', uid, { delete: [t.id] }, signOpts))}>Remove</Button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={inputStyle} placeholder="endpoint https://lrs/xapi" value={tForm.endpoint} onChange={e => setTForm({ ...tForm, endpoint: e.target.value })} />
        <input style={inputStyle} placeholder="credentials user:pass" value={tForm.credentials} onChange={e => setTForm({ ...tForm, credentials: e.target.value })} />
        <input style={inputStyle} placeholder="label (optional)" value={tForm.label} onChange={e => setTForm({ ...tForm, label: e.target.value })} />
        <input style={{ ...inputStyle, minWidth: 80 }} placeholder="xAPI ver" value={tForm.version} onChange={e => setTForm({ ...tForm, version: e.target.value })} />
        <Button small primary disabled={busy || !tForm.endpoint || !tForm.credentials.includes(':')}
          onClick={() => act(async () => { await callSignedAffordance(origin, 'forwarding/targets', uid, { targets: [tForm] }, signOpts); setTForm({ endpoint: '', credentials: '', label: '', version: '2.0.0' }); })}>
          Add target
        </Button>
      </div>

      {/* ── Inbound ── */}
      <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Forwarding in — credentials an upstream uses to forward into my lens</div>
      {creds && creds.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 8 }}>No inbound credentials.</div>}
      {creds && creds.map(c => (
        <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 4, fontSize: 12 }}>
          <code>{c.principal}</code><span style={{ color: 'var(--text-dim)' }}>{c.secretHint}</span>
          <span style={{ color: 'var(--text-dim)' }}>{c.label}</span>
          <span style={{ flex: 1 }} />
          <Button small danger disabled={busy} onClick={() => act(() => callSignedAffordance(origin, 'credentials', uid, { revoke: [c.id] }, signOpts))}>Revoke</Button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={inputStyle} placeholder="principal (user)" value={cForm.principal} onChange={e => setCForm({ ...cForm, principal: e.target.value })} />
        <input style={inputStyle} placeholder="secret (pass)" value={cForm.secret} onChange={e => setCForm({ ...cForm, secret: e.target.value })} />
        <input style={inputStyle} placeholder="label (optional)" value={cForm.label} onChange={e => setCForm({ ...cForm, label: e.target.value })} />
        <Button small primary disabled={busy || !cForm.principal || !cForm.secret}
          onClick={() => act(async () => { await callSignedAffordance(origin, 'credentials', uid, { credentials: [cForm] }, signOpts); setCForm({ principal: '', secret: '', label: '' }); })}>
          Add credential
        </Button>
      </div>
    </Card>
  );
}
