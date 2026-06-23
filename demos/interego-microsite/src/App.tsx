import React, { useState } from 'react';
import { Quorum } from './pages/Quorum.js';
import { Constitution } from './pages/Constitution.js';
import { Babel } from './pages/Babel.js';
import { RedTeam } from './pages/RedTeam.js';
import { BRIDGE_URL } from './lib/bridge.js';
import { card, lbl, codeS, mono, serif } from './styles.js';

type Route = 'home' | 'quorum' | 'constitution' | 'babel' | 'redteam';

function initial(): Route {
  const p = window.location.pathname;
  if (p.startsWith('/quorum')) return 'quorum';
  if (p.startsWith('/constitution')) return 'constitution';
  if (p.startsWith('/babel')) return 'babel';
  if (p.startsWith('/red')) return 'redteam';
  return 'home';
}

export function App() {
  const [route, setRoute] = useState<Route>(initial());
  function nav(r: Route) {
    setRoute(r);
    const path = r === 'home' ? '/' : r === 'redteam' ? '/red-team' : `/${r}`;
    window.history.pushState({}, '', path);
    window.scrollTo({ top: 0 });
  }
  React.useEffect(() => { const f = () => setRoute(initial()); window.addEventListener('popstate', f); return () => window.removeEventListener('popstate', f); }, []);

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={{ padding: '14px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 18, position: 'sticky', top: 0, background: 'rgba(13,17,23,0.85)', backdropFilter: 'blur(8px)', zIndex: 50 }}>
        <button onClick={() => nav('home')} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontFamily: mono, fontSize: 14, letterSpacing: '0.18em', textTransform: 'uppercase', padding: 0 }}>Interego</button>
        <span style={{ fontFamily: serif, fontStyle: 'italic', color: 'var(--text-dim)', fontSize: 16 }}>the substrate, demonstrated</span>
        <nav style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'center' }}>
          {(['quorum', 'constitution', 'babel', 'redteam'] as Route[]).map(r => (
            <button key={r} onClick={() => nav(r)} style={{ background: 'transparent', border: 'none', color: route === r ? 'var(--accent)' : 'var(--text-dim)', cursor: 'pointer', fontFamily: mono, fontSize: 12.5, textTransform: 'capitalize', padding: 0 }}>{r === 'redteam' ? 'Red-Team' : r}</button>
          ))}
        </nav>
      </header>
      <main>
        {route === 'home' && <Landing nav={nav} />}
        {route === 'quorum' && <Quorum onHome={() => nav('home')} />}
        {route === 'constitution' && <Constitution onHome={() => nav('home')} />}
        {route === 'babel' && <Babel onHome={() => nav('home')} />}
        {route === 'redteam' && <RedTeam onHome={() => nav('home')} />}
      </main>
    </div>
  );
}

function Landing({ nav }: { nav: (r: Route) => void }) {
  const demos = [
    { r: 'quorum' as Route, t: 'The Quorum', d: 'LLM agents debate + sign votes; the substrate ratifies and forks on dissensus. Signed, distinct-signer governance.' },
    { r: 'constitution' as Route, t: '/constitution', d: 'Reflexive self-amendment — agents amend the rule that governs them, under that rule; it binds the next vote.' },
    { r: 'babel' as Route, t: 'Babel', d: 'Two agents converge on a shared content-addressed atom. Meaning-as-use, measured as sha256 fusion.' },
    { r: 'redteam' as Route, t: 'Red-Team', d: 'An adversarial LLM forges / tampers / replays; the L1 integrity primitive bounces each. Security as a spectator sport.' },
  ];
  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '56px 24px 80px' }}>
      <div className="label" style={{ marginBottom: 14 }}>substrate · emergent affordances · signature-bound · content-addressed</div>
      <h1 style={{ fontFamily: serif, fontStyle: 'italic', fontSize: 52, lineHeight: 1.08, margin: 0, letterSpacing: '-0.02em' }}>Interego, demonstrated as itself.</h1>
      <p style={{ fontSize: 19, lineHeight: 1.55, maxWidth: 760, marginTop: 20, color: 'var(--text-dim)' }}>
        These are <strong>substrate</strong> demos — not a vertical. Every capability is an <strong>emergent affordance</strong>:
        real LLM agents <strong>discover</strong> it from the bridge&rsquo;s published manifest and <strong>invoke</strong> it
        (discover→act), composing existing protocol primitives. Nothing is a hardcoded API path; the cryptography and the
        modal/ratification math stay deterministic, and the <em>judgment</em> is the agents&rsquo;.
      </p>
      <p style={{ fontSize: 14, lineHeight: 1.6, maxWidth: 760, marginTop: 14, color: 'var(--text-dim)' }}>
        Bring an Anthropic key (it stays in your tab). Substrate surface: <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginTop: 36 }}>
        {demos.map(d => (
          <button key={d.r} onClick={() => nav(d.r)} style={{ ...card, textAlign: 'left', cursor: 'pointer', boxShadow: 'var(--shadow)' }}>
            <div style={{ fontFamily: serif, fontStyle: 'italic', fontSize: 22, color: 'var(--text)' }}>{d.t}</div>
            <div style={{ fontSize: 14.5, color: 'var(--text-dim)', lineHeight: 1.5, marginTop: 8 }}>{d.d}</div>
            <div style={{ ...lbl, color: 'var(--accent)', marginTop: 12 }}>open →</div>
          </button>
        ))}
      </div>
    </div>
  );
}
