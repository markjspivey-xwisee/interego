import React, { useState } from 'react';
import { Landing } from './pages/Landing.js';
import { TryNow } from './pages/TryNow.js';
import { About } from './pages/About.js';
import { Verify } from './pages/Verify.js';
import { Dpia } from './pages/Dpia.js';
import { Demos } from './pages/Demos.js';
import { EmergentCollective } from './pages/EmergentCollective.js';
import { PodBrowser } from './pages/PodBrowser.js';
import { AgenticDemo } from './pages/AgenticDemo.js';
import { ReportsPage } from './pages/ReportsPage.js';
import { Compliance } from './pages/Compliance.js';
import { CourseIntel } from './pages/CourseIntel.js';
import { Portfolio } from './pages/Portfolio.js';
import { EvidenceLedger } from './pages/EvidenceLedger.js';
import { FederatedCalibration } from './pages/FederatedCalibration.js';

export type Route = 'landing' | 'try' | 'about' | 'verify' | 'dpia' | 'demos' | 'emergent' | 'pod' | 'agentdemo' | 'reports' | 'compliance' | 'course' | 'hire' | 'ledger' | 'consortium';

export function App() {
  const [route, setRoute] = useState<Route>(initialRoute());
  const [tryRole, setTryRole] = useState<'learner' | 'admin' | 'le' | null>(initialTryRole());

  function navigate(r: Route, role?: 'learner' | 'admin' | 'le') {
    setRoute(r);
    if (role !== undefined) setTryRole(role);
    const url = new URL(window.location.href);
    if (r === 'landing') { url.pathname = '/'; url.searchParams.delete('role'); }
    else if (r === 'try') { url.pathname = '/try'; if (role) url.searchParams.set('role', role); }
    else if (r === 'about') { url.pathname = '/about'; url.searchParams.delete('role'); }
    else if (r === 'verify') { url.pathname = '/verify'; url.searchParams.delete('role'); }
    else if (r === 'dpia') { url.pathname = '/dpia'; url.searchParams.delete('role'); }
    else if (r === 'demos') { url.pathname = '/demos'; url.searchParams.delete('role'); }
    else if (r === 'emergent') { url.pathname = '/emergent'; url.searchParams.delete('role'); }
    else if (r === 'pod') { url.pathname = '/pod'; url.searchParams.delete('role'); }
    else if (r === 'agentdemo') { url.pathname = '/agents'; url.searchParams.delete('role'); }
    else if (r === 'reports') { url.pathname = '/reports'; url.searchParams.delete('role'); }
    else if (r === 'compliance') { url.pathname = '/compliance'; url.searchParams.delete('role'); }
    else if (r === 'course') { url.pathname = '/course'; url.searchParams.delete('role'); }
    else if (r === 'hire') { url.pathname = '/hire'; url.searchParams.delete('role'); }
    else if (r === 'ledger') { url.pathname = '/ledger'; url.searchParams.delete('role'); }
    else if (r === 'consortium') { url.pathname = '/consortium'; url.searchParams.delete('role'); }
    window.history.pushState({}, '', url.toString());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  React.useEffect(() => {
    function onPop() {
      setRoute(initialRoute());
      setTryRole(initialTryRole());
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopNav active={route} onNavigate={navigate} />
      <main style={{ flex: 1 }}>
        {route === 'landing' && <Landing onTry={role => navigate('try', role)} onAbout={() => navigate('about')} />}
        {route === 'try' && <TryNow initialRole={tryRole} onAbout={() => navigate('about')} onHome={() => navigate('landing')} />}
        {route === 'about' && <About onTry={role => navigate('try', role)} onHome={() => navigate('landing')} />}
        {route === 'verify' && <Verify onHome={() => navigate('landing')} />}
        {route === 'dpia' && <Dpia onHome={() => navigate('landing')} />}
        {route === 'demos' && <Demos onHome={() => navigate('landing')} onEmergent={() => navigate('emergent')} />}
        {route === 'emergent' && <EmergentCollective onHome={() => navigate('landing')} onDemos={() => navigate('demos')} />}
        {route === 'pod' && <PodBrowser onHome={() => navigate('landing')} />}
        {route === 'agentdemo' && <AgenticDemo onHome={() => navigate('landing')} onReports={() => navigate('reports')} />}
        {route === 'reports' && <ReportsPage onHome={() => navigate('landing')} onAgents={() => navigate('agentdemo')} />}
        {route === 'compliance' && <Compliance onHome={() => navigate('landing')} />}
        {route === 'course' && <CourseIntel onHome={() => navigate('landing')} />}
        {route === 'hire' && <Portfolio onHome={() => navigate('landing')} />}
        {route === 'ledger' && <EvidenceLedger onHome={() => navigate('landing')} />}
        {route === 'consortium' && <FederatedCalibration onHome={() => navigate('landing')} />}
      </main>
      <SiteFooter />
    </div>
  );
}

function initialRoute(): Route {
  const p = window.location.pathname;
  if (p.startsWith('/try')) return 'try';
  if (p.startsWith('/about')) return 'about';
  if (p.startsWith('/verify')) return 'verify';
  if (p.startsWith('/dpia')) return 'dpia';
  if (p.startsWith('/emergent')) return 'emergent';
  if (p.startsWith('/agents')) return 'agentdemo';
  if (p.startsWith('/reports')) return 'reports';
  if (p.startsWith('/compliance')) return 'compliance';
  if (p.startsWith('/course')) return 'course';
  if (p.startsWith('/hire')) return 'hire';
  if (p.startsWith('/ledger')) return 'ledger';
  if (p.startsWith('/consortium')) return 'consortium';
  if (p.startsWith('/demos')) return 'demos';
  if (p.startsWith('/pod')) return 'pod';
  return 'landing';
}

function initialTryRole(): 'learner' | 'admin' | 'le' | 'le' | null {
  const r = new URL(window.location.href).searchParams.get('role');
  if (r === 'admin') return 'admin';
  if (r === 'learner') return 'learner';
  if (r === 'le' || r === 'learning-engineer') return 'le';
  return null;
}

function TopNav({ active, onNavigate }: { active: Route; onNavigate: (r: Route, role?: 'learner' | 'admin' | 'le') => void }) {
  return (
    <header style={{
      padding: '14px 24px',
      background: 'var(--text)',
      color: 'var(--panel)',
      borderBottom: '3px solid var(--accent)',
      display: 'flex', alignItems: 'center', gap: 18,
      position: 'sticky', top: 0, zIndex: 50,
    }}>
      <button onClick={() => onNavigate('landing')} style={{
        background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer',
        fontFamily: "'JetBrains Mono', monospace", fontSize: 14, letterSpacing: '0.18em',
        textTransform: 'uppercase', padding: 0,
      }}>Foxxi</button>
      <span style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', color: 'var(--panel)', fontSize: 17 }}>
        learning records you actually own
      </span>
      <nav style={{ marginLeft: 'auto', display: 'flex', gap: 18, alignItems: 'center' }}>
        <NavLink active={active === 'landing'} onClick={() => onNavigate('landing')}>What</NavLink>
        <NavLink active={active === 'about'} onClick={() => onNavigate('about')}>How</NavLink>
        <NavLink active={active === 'demos'} onClick={() => onNavigate('demos')}>Demos</NavLink>
        <NavLink active={active === 'agentdemo'} onClick={() => onNavigate('agentdemo')}>Agents ▸</NavLink>
        <NavLink active={active === 'hire'} onClick={() => onNavigate('hire')}>Hire</NavLink>
        <NavLink active={active === 'ledger'} onClick={() => onNavigate('ledger')}>Ledger</NavLink>
        <NavLink active={active === 'consortium'} onClick={() => onNavigate('consortium')}>Consortium</NavLink>
        <NavLink active={active === 'course'} onClick={() => onNavigate('course')}>Course IQ</NavLink>
        <NavLink active={active === 'reports'} onClick={() => onNavigate('reports')}>Reports</NavLink>
        <NavLink active={active === 'compliance'} onClick={() => onNavigate('compliance')}>Compliance</NavLink>
        <NavLink active={active === 'pod'} onClick={() => onNavigate('pod')}>Pod</NavLink>
        <NavLink active={active === 'verify'} onClick={() => onNavigate('verify')}>Verify</NavLink>
        <NavLink active={active === 'dpia'} onClick={() => onNavigate('dpia')}>DPIA</NavLink>
        <button onClick={() => onNavigate('try', 'learner')} style={{
          background: 'var(--accent)', color: 'var(--panel)', border: 'none',
          padding: '8px 16px', borderRadius: 4,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>Try now</button>
      </nav>
    </header>
  );
}

function NavLink({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      background: 'transparent', border: 'none', color: active ? 'var(--accent)' : 'var(--panel)',
      cursor: 'pointer', fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
      textTransform: 'uppercase', letterSpacing: '0.06em', padding: 0,
    }}>{children}</button>
  );
}

function SiteFooter() {
  return (
    <footer style={{
      marginTop: 60, padding: '24px 24px 28px',
      borderTop: '1px solid var(--border)',
      background: 'var(--panel)',
      color: 'var(--text-dim)', fontSize: 12,
      display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'space-between',
    }}>
      <div>
        <div style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', fontSize: 16, color: 'var(--text)' }}>
          Foxxi — a learning vertical on the Interego substrate
        </div>
        <div style={{ marginTop: 4 }}>
          Pod-native learner records · cryptographically verifiable credentials · standards-conformant (ADL TLA / IEEE LERS / 1EdTech)
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href="https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io">Full dashboard</a>
        <a href="https://github.com/markjspivey-xwisee/interego">Source</a>
      </div>
    </footer>
  );
}
