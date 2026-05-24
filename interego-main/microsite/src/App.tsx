import React, { useState } from 'react';
import { Home } from './pages/Home.js';
import { Substrate } from './pages/Substrate.js';
import { Verticals } from './pages/Verticals.js';
import { Demos } from './pages/Demos.js';
import { Architecture } from './pages/Architecture.js';
import { About } from './pages/About.js';
import { PodBrowser } from './pages/PodBrowser.js';

export type Route =
  | 'home' | 'substrate' | 'verticals' | 'demos' | 'architecture' | 'about' | 'pod';

export function App() {
  const [route, setRoute] = useState<Route>(initialRoute());

  function navigate(r: Route) {
    setRoute(r);
    const url = new URL(window.location.href);
    url.pathname = r === 'home' ? '/' : `/${r}`;
    window.history.pushState({}, '', url.toString());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  React.useEffect(() => {
    function onPop() { setRoute(initialRoute()); }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopNav active={route} onNavigate={navigate} />
      <main style={{ flex: 1 }}>
        {route === 'home' && <Home onNavigate={navigate} />}
        {route === 'substrate' && <Substrate onNavigate={navigate} />}
        {route === 'verticals' && <Verticals onNavigate={navigate} />}
        {route === 'demos' && <Demos onNavigate={navigate} />}
        {route === 'architecture' && <Architecture onNavigate={navigate} />}
        {route === 'about' && <About onNavigate={navigate} />}
        {route === 'pod' && <PodBrowser onHome={() => navigate('home')} />}
      </main>
      <SiteFooter />
    </div>
  );
}

function initialRoute(): Route {
  const p = window.location.pathname;
  if (p.startsWith('/substrate')) return 'substrate';
  if (p.startsWith('/verticals')) return 'verticals';
  if (p.startsWith('/demos')) return 'demos';
  if (p.startsWith('/architecture')) return 'architecture';
  if (p.startsWith('/about')) return 'about';
  if (p.startsWith('/pod')) return 'pod';
  return 'home';
}

function TopNav({ active, onNavigate }: { active: Route; onNavigate: (r: Route) => void }) {
  return (
    <header style={{
      padding: '14px 24px',
      background: 'var(--text)',
      color: 'var(--panel)',
      borderBottom: '3px solid var(--accent)',
      display: 'flex', alignItems: 'center', gap: 18,
      position: 'sticky', top: 0, zIndex: 50,
    }}>
      <button onClick={() => onNavigate('home')} style={{
        background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer',
        fontFamily: "'JetBrains Mono', monospace", fontSize: 14, letterSpacing: '0.18em',
        textTransform: 'uppercase', padding: 0, fontWeight: 600,
      }}>Interego</button>
      <span style={{ fontFamily: "'EB Garamond', serif", fontStyle: 'italic', color: 'var(--panel)', fontSize: 17 }}>
        composable, verifiable, federated context infrastructure
      </span>
      <nav style={{ marginLeft: 'auto', display: 'flex', gap: 18, alignItems: 'center' }}>
        <NavLink active={active === 'substrate'} onClick={() => onNavigate('substrate')}>Substrate</NavLink>
        <NavLink active={active === 'verticals'} onClick={() => onNavigate('verticals')}>Verticals</NavLink>
        <NavLink active={active === 'demos'} onClick={() => onNavigate('demos')}>Demos</NavLink>
        <NavLink active={active === 'pod'} onClick={() => onNavigate('pod')}>Pod</NavLink>
        <NavLink active={active === 'architecture'} onClick={() => onNavigate('architecture')}>Architecture</NavLink>
        <NavLink active={active === 'about'} onClick={() => onNavigate('about')}>About</NavLink>
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
          Interego — open-source substrate for AI-agent context, identity, and coordination
        </div>
        <div style={{ marginTop: 4 }}>
          Context Graphs 1.0 (L1 protocol) · capability passports · attestation registries · ABAC · constitutional layer · federated saga transactions · MIT
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href="https://github.com/markjspivey-xwisee/interego">Source</a>
        <a href="https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html">L1 spec</a>
      </div>
    </footer>
  );
}
