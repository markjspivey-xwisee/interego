/**
 * App shell with proper REST-like routing.
 *
 *   /login                                                  Login screen
 *   /learner                                                Learner shell — assigned courses
 *   /learner/courses/:courseId                              Course detail (concept network + slides + chat)
 *   /admin                                                  Admin shell (defaults to /admin/catalog)
 *   /admin/catalog | /policies | /coverage | /access
 *        | /integrations | /audit | /lrs                    Admin tabs (each their own URL)
 *   /admin/lrs/statements | /aggregates | /conformance | /config
 *                                                           LRS-admin sub-tabs
 *
 * Browser back / forward navigates within the app. Every view is
 * bookmarkable + shareable. nginx falls back to index.html for any
 * unknown path (configured in deploy/Dockerfile.foxxi-dashboard) so
 * the SPA owns the full path space.
 */
import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Login } from './components/Login.js';
import { LearnerShell } from './components/LearnerShell.js';
import { AdminShell } from './components/AdminShell.js';
import { Header } from './components/common.js';
import { loadSession, saveSession, clearSession, type FoxxiSession } from './auth/session.js';
import { getTransport, resetTransportProbe } from './interego/client.js';
import { SAMPLE_ADMIN_PAYLOAD } from './sample/data.js';

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
    // Land the user on the right shell for their role.
    navigate(s.role === 'admin' ? '/admin/catalog' : '/learner', { replace: true });
  }
  function onLogout() {
    clearSession();
    resetTransportProbe();
    setSession(null);
    navigate('/login', { replace: true });
  }

  // Unauthenticated → /login (preserve attempted path for post-login redirect)
  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login onSignIn={onSignIn} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      <Header session={session} onLogout={onLogout} transport={transport} />
      <div style={{ flex: 1 }}>
        <Routes>
          <Route path="/login" element={<Navigate to={session.role === 'admin' ? '/admin/catalog' : '/learner'} replace />} />
          <Route path="/learner" element={<LearnerShell session={session} />} />
          <Route path="/learner/courses/:courseId" element={<LearnerShell session={session} />} />
          <Route path="/admin" element={<Navigate to="/admin/catalog" replace />} />
          <Route path="/admin/:tab" element={<AdminShell session={session} />} />
          <Route path="/admin/lrs/:lrsTab" element={<AdminShell session={session} />} />
          <Route path="/admin/lrs/statements/:statementId" element={<AdminShell session={session} />} />
          <Route path="/" element={<Navigate to={session.role === 'admin' ? '/admin/catalog' : '/learner'} replace />} />
          <Route path="*" element={<Navigate to={session.role === 'admin' ? '/admin/catalog' : '/learner'} replace />} />
        </Routes>
      </div>
      <Footer session={session} transport={transport} />
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
        signed in as <strong>{session.name}</strong> ({session.role}){' '}
        · <code style={{ wordBreak: 'break-all' }}>{session.webId}</code>
      </div>
      <div>
        transport: <strong>{transport}</strong>
        {' '}· pod: <code style={{ wordBreak: 'break-all' }}>{meta.tenant_pod}</code>
      </div>
    </footer>
  );
}
