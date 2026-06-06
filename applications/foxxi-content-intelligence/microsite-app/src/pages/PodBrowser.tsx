/**
 * Pod browser — render the substrate as linked data.
 *
 * The Foxxi bridge now publishes every work product as a real
 * cg:ContextDescriptor on the tenant pod. This page is the natural
 * companion: it walks the pod's manifest, lists the descriptors by
 * type, dereferences any one you click, renders the Turtle as it
 * actually lives on the wire, and turns every cg:Affordance into a
 * clickable link so you can navigate the substrate by following
 * affordances.
 *
 * From the outside this looks like a familiar object browser. From
 * the inside it's a linked-data client over the standard Interego
 * descriptor + manifest format — no special API. Pointing it at a
 * different pod's manifest URL (e.g. the federation peer) browses
 * that pod just as well.
 */

import React, { useEffect, useState } from 'react';

// ── styles (matching the rest of the microsite) ────────────────────
const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";

const card: React.CSSProperties = {
  background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
  padding: 18, boxShadow: 'var(--shadow)',
};
const label: React.CSSProperties = {
  fontFamily: mono, fontSize: 10, textTransform: 'uppercase',
  letterSpacing: '0.07em', color: 'var(--text-dim)',
};

// Default pod URLs. Two sources: the tenant pod and the federation
// peer pod. The dropdown lets the user swap between them; any pod URL
// can be typed in to browse arbitrary Interego pods.
// CSS itself is internal-only; browser code reaches the pod through the
// public css-gate. Override at build time via VITE_CSS_POD_URL.
const CSS_BASE = (import.meta.env.VITE_CSS_POD_URL as string | undefined)
  ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TENANT_POD = `${CSS_BASE}/foxxi/`;
const PEER_POD = `${CSS_BASE}/foxxi/federation-peer/`;

interface ManifestEntry {
  descriptorUrl: string;
  describes: string;
  conformsTo: string[];
  modalStatus: string;
  trustLevel: string;
  facetTypes: string[];
}

interface DescriptorDetail {
  descriptorTurtle: string;
  graphTurtle: string | null;
  graphUrl: string | null;
  affordances: Affordance[];
  bundleJson: unknown | null;
}

interface Affordance {
  method: string;
  target: string;
  title?: string;
  mediaType?: string;
  encrypted?: boolean;
}

/** Tiny Turtle-ish parser for manifest entries — regex-driven, no deps. */
function parseManifest(turtle: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  // Each entry starts at a `<url> a cg:ManifestEntry` and ends at the next `.` at column 0
  const re = /<([^>]+)>\s+a\s+cg:ManifestEntry\s*;([\s\S]*?)\s\./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(turtle)) !== null) {
    const descriptorUrl = m[1];
    const body = m[2];
    const describes = (body.match(/cg:describes\s+<([^>]+)>/) ?? [, ''])[1];
    const modalStatus = ((body.match(/cg:modalStatus\s+cg:(\w+)/) ?? [, 'Unknown'])[1]);
    const trustLevel = ((body.match(/cg:trustLevel\s+cg:(\w+)/) ?? [, 'Unknown'])[1]);
    const conformsTo: string[] = [];
    for (const c of body.matchAll(/dct:conformsTo\s+<([^>]+)>/g)) conformsTo.push(c[1]);
    const facetTypes: string[] = [];
    for (const f of body.matchAll(/cg:hasFacetType\s+cg:(\w+)/g)) facetTypes.push(f[1]);
    entries.push({ descriptorUrl, describes, conformsTo, modalStatus, trustLevel, facetTypes });
  }
  return entries;
}

/** Pull foxxi:bundleJson literal out of a graph TriG. Same shape the bridge writes. */
function decodeBundleJson(graphTurtle: string): unknown | null {
  const m = graphTurtle.match(/foxxi:bundleJson\s+"([^"]+)"\^\^xsd:base64Binary/);
  if (!m) return null;
  try {
    const json = atob(m[1]);
    return JSON.parse(json);
  } catch { return null; }
}

/** Parse cg:Affordance blocks out of a descriptor Turtle — present them as clickable Hydra ops. */
function parseAffordances(descriptorTurtle: string): Affordance[] {
  const out: Affordance[] = [];
  // Find affordance blanks: cg:affordance [ ... ]
  const re = /cg:affordance\s+\[([\s\S]*?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(descriptorTurtle)) !== null) {
    const block = m[1];
    const method = (block.match(/hydra:method\s+"(\w+)"/) ?? [, 'GET'])[1];
    const target = (block.match(/hydra:target\s+<([^>]+)>/) ?? [, ''])[1];
    const title = (block.match(/hydra:title\s+"([^"]+)"/) ?? [, ''])[1] || undefined;
    const mediaType = (block.match(/dcat:mediaType\s+"([^"]+)"/) ?? [, ''])[1] || undefined;
    const encrypted = /cg:encrypted\s+true/.test(block);
    if (target) out.push({ method, target, title, mediaType, encrypted });
  }
  return out;
}

/** Find graph URL by following the affordance: hydra:method "GET" + dcat:mediaType "application/trig". */
function findGraphUrl(affs: Affordance[]): string | null {
  return affs.find(a => (a.mediaType ?? '').includes('trig'))?.target
    ?? affs.find(a => a.method === 'GET' && a.target.endsWith('-graph.trig'))?.target
    ?? null;
}

const typeShortName = (iri: string): string => {
  const last = iri.split(/[#/:]/).pop() ?? iri;
  return last;
};
const typeColor = (iri: string): string => {
  // Stable per-type accent
  let h = 0;
  for (let i = 0; i < iri.length; i++) h = (h * 31 + iri.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360}, 35%, 45%)`;
};

// Trust badge — Interego's Option D bet visible in the UI. CSS is
// allow-all so anonymous PUTs can still land on the pod; readers
// distinguish what the bridge signed (or what an agent signed,
// verified) from junk that arrived without a verifying signature.
// Verified = real cryptographic provenance. Self-asserted = a DID is
// claimed but no signature backs it. Unknown = neither facet visible
// (likely a pre-Option-D legacy descriptor).
function TrustBadge({ level }: { level: string }) {
  const config = (() => {
    switch (level) {
      case 'CryptographicallyVerified':
        return { label: 'signed ✓', bg: 'rgba(46,160,67,0.14)', fg: '#3fa84c', title: 'cryptographically verified — ECDSA signature checked against the author DID' };
      case 'SelfAsserted':
        return { label: 'self-asserted', bg: 'rgba(218,165,32,0.14)', fg: '#caa028', title: 'DID claimed but no verifying signature — readers downgrade' };
      case 'ThirdPartyAttested':
        return { label: 'attested', bg: 'rgba(82,139,219,0.14)', fg: '#5290da', title: 'third-party attestation present' };
      default:
        return { label: 'unsigned', bg: 'rgba(193,67,42,0.14)', fg: '#c1432a', title: 'no signature visible — calibration loop and federation reader will ignore' };
    }
  })();
  return (
    <span title={config.title} style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 3,
      background: config.bg, color: config.fg, fontFamily: mono, fontSize: 9,
      letterSpacing: '0.04em', textTransform: 'lowercase',
      border: `1px solid ${config.fg}33`,
    }}>{config.label}</span>
  );
}

export function PodBrowser({ onHome }: { onHome: () => void }) {
  const [podUrl, setPodUrl] = useState(TENANT_POD);
  const [entries, setEntries] = useState<ManifestEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ManifestEntry | null>(null);
  const [detail, setDetail] = useState<DescriptorDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [view, setView] = useState<'turtle' | 'json' | 'graph'>('turtle');

  async function loadManifest(url: string) {
    setLoading(true); setError(null); setEntries([]); setSelected(null); setDetail(null);
    try {
      const norm = url.endsWith('/') ? url : `${url}/`;
      const r = await fetch(`${norm}.well-known/context-graphs`, { headers: { Accept: 'text/turtle' } });
      if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
      const ttl = await r.text();
      setEntries(parseManifest(ttl));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(entry: ManifestEntry) {
    setSelected(entry); setDetail(null); setDetailLoading(true); setView('turtle');
    try {
      const dr = await fetch(entry.descriptorUrl, { headers: { Accept: 'text/turtle' } });
      const descriptorTurtle = await dr.text();
      const affs = parseAffordances(descriptorTurtle);
      const graphUrl = findGraphUrl(affs);
      let graphTurtle: string | null = null;
      let bundleJson: unknown | null = null;
      if (graphUrl) {
        try {
          const gr = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
          if (gr.ok) {
            graphTurtle = await gr.text();
            bundleJson = decodeBundleJson(graphTurtle);
          }
        } catch { /* graph optional */ }
      }
      setDetail({ descriptorTurtle, graphTurtle, graphUrl, affordances: affs, bundleJson });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => { void loadManifest(podUrl); }, []); // initial load

  const types = Array.from(new Set(entries.flatMap(e => e.conformsTo)));
  const filtered = filter ? entries.filter(e => e.conformsTo.includes(filter)) : entries;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '40px 24px' }}>
      <div style={{ ...label, marginBottom: 6 }}>Foxxi × Interego · pod browser</div>
      <h1 style={{ fontFamily: serif, fontWeight: 500, fontSize: 38, lineHeight: 1.1, margin: '4px 0 12px' }}>
        Linked-data browser
      </h1>
      <p style={{ fontSize: 15, lineHeight: 1.6, maxWidth: 820, margin: '0 0 18px' }}>
        Every Foxxi work product — outcomes, situations, plans, calibration profiles,
        teaching packages, xAPI statements, LMS snapshots — is a real <code>cg:ContextDescriptor</code> on the tenant
        pod. This page walks the pod's manifest, dereferences any descriptor you click as Turtle, and follows
        its <code>cg:Affordance</code> links. Point it at the federation peer pod to browse that one the same way.
      </p>

      {/* Pod URL bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' }}>
        <input type="text" value={podUrl} onChange={e => setPodUrl(e.target.value)}
          style={{ flex: '1 1 460px', minWidth: 320, padding: '8px 10px', borderRadius: 4,
            border: '1px solid var(--border)', fontFamily: mono, fontSize: 12 }} />
        <button onClick={() => loadManifest(podUrl)} style={{
          padding: '8px 16px', background: 'var(--text)', color: 'var(--panel)', border: 'none',
          borderRadius: 4, fontFamily: mono, fontSize: 12, fontWeight: 600, letterSpacing: '0.06em',
          textTransform: 'uppercase', cursor: 'pointer',
        }}>Load</button>
        <button onClick={() => { setPodUrl(TENANT_POD); void loadManifest(TENANT_POD); }} style={{
          padding: '8px 12px', background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border)',
          borderRadius: 4, fontFamily: mono, fontSize: 11, cursor: 'pointer',
        }}>tenant</button>
        <button onClick={() => { setPodUrl(PEER_POD); void loadManifest(PEER_POD); }} style={{
          padding: '8px 12px', background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border)',
          borderRadius: 4, fontFamily: mono, fontSize: 11, cursor: 'pointer',
        }}>federation peer</button>
        <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-dim)' }}>
          {loading ? 'loading…' : entries.length > 0 ? `${entries.length} descriptors` : ''}
        </span>
      </div>

      {error && <div style={{ ...card, borderLeft: '3px solid var(--bad)', marginBottom: 18, fontFamily: mono, fontSize: 12 }}>
        {error}
      </div>}

      {/* Filter chips */}
      {types.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          <button onClick={() => setFilter(null)} style={chipStyle(filter === null)}>all · {entries.length}</button>
          {types.map(t => (
            <button key={t} onClick={() => setFilter(t)} style={chipStyle(filter === t)}
              title={t}>
              {typeShortName(t)} · {entries.filter(e => e.conformsTo.includes(t)).length}
            </button>
          ))}
        </div>
      )}

      {/* Two-pane layout: list + detail */}
      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, minHeight: 540 }}>
        {/* List */}
        <div style={{ ...card, padding: 0, maxHeight: 700, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <header style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', ...label }}>
            descriptors
          </header>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.map(e => {
              const primaryType = e.conformsTo[0] ?? 'unknown';
              const isSelected = selected?.descriptorUrl === e.descriptorUrl;
              return (
                <div key={e.descriptorUrl} onClick={() => void loadDetail(e)} style={{
                  padding: '9px 14px', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                  background: isSelected ? 'rgba(193,67,42,0.06)' : 'transparent',
                  borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                  paddingLeft: isSelected ? 11 : 14,
                }}>
                  <div style={{ fontFamily: mono, fontSize: 10, color: typeColor(primaryType), textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {typeShortName(primaryType)}
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--text)', wordBreak: 'break-all', marginTop: 2 }}>
                    {typeShortName(e.describes)}
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 9, color: 'var(--text-dim)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <TrustBadge level={e.trustLevel} />
                    <span>{e.modalStatus} · {e.facetTypes.length} facets</span>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && !loading && (
              <div style={{ padding: 14, fontFamily: mono, fontSize: 11, color: 'var(--text-dim)' }}>
                no descriptors match
              </div>
            )}
          </div>
        </div>

        {/* Detail */}
        <div style={{ ...card, padding: 0, maxHeight: 700, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {!selected && (
            <div style={{ padding: 20, fontFamily: mono, fontSize: 12, color: 'var(--text-dim)' }}>
              click any descriptor on the left to dereference its Turtle.
            </div>
          )}
          {selected && (
            <>
              <header style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--text)', wordBreak: 'break-all' }}>
                  {selected.describes}
                </div>
                <div style={{ ...label, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <TrustBadge level={selected.trustLevel} />
                  <span>{selected.conformsTo.map(typeShortName).join(' · ')} · {selected.modalStatus}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  <button onClick={() => setView('turtle')} style={tabStyle(view === 'turtle')}>descriptor (Turtle)</button>
                  <button onClick={() => setView('graph')} style={tabStyle(view === 'graph')}>graph (TriG)</button>
                  <button onClick={() => setView('json')} style={tabStyle(view === 'json')}>payload (JSON)</button>
                  <a href={selected.descriptorUrl} target="_blank" rel="noreferrer" style={{
                    marginLeft: 'auto', fontFamily: mono, fontSize: 10, color: 'var(--accent)',
                    textDecoration: 'none', alignSelf: 'center',
                  }}>open on pod ↗</a>
                </div>
              </header>
              <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
                {detailLoading && (
                  <div style={{ padding: 16, fontFamily: mono, fontSize: 11, color: 'var(--text-dim)' }}>
                    fetching from pod…
                  </div>
                )}
                {!detailLoading && detail && view === 'turtle' && (
                  <pre style={preStyle}>{detail.descriptorTurtle}</pre>
                )}
                {!detailLoading && detail && view === 'graph' && (
                  <pre style={preStyle}>{detail.graphTurtle ?? '(no graph URL found in the descriptor)'}</pre>
                )}
                {!detailLoading && detail && view === 'json' && (
                  <pre style={preStyle}>{detail.bundleJson === null
                    ? '(no foxxi:bundleJson literal in the graph)'
                    : JSON.stringify(detail.bundleJson, null, 2)}</pre>
                )}
                {!detailLoading && detail && detail.affordances.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px', background: 'var(--panel-2)' }}>
                    <div style={{ ...label, marginBottom: 6 }}>cg:affordance · clickable hydra:Operation links</div>
                    {detail.affordances.map((a, i) => (
                      <div key={i} style={{ fontFamily: mono, fontSize: 11, padding: '2px 0' }}>
                        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{a.method}</span>{' '}
                        <a href={a.target} target="_blank" rel="noreferrer" style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{a.target}</a>
                        {a.title && <span style={{ color: 'var(--text-dim)' }}> · {a.title}</span>}
                        {a.mediaType && <span style={{ color: 'var(--text-dim)' }}> · {a.mediaType}</span>}
                        {a.encrypted && <span style={{ color: 'var(--warn)' }}> · encrypted</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ ...card, marginTop: 22, background: 'var(--panel-2)' }}>
        <div style={{ fontFamily: serif, fontStyle: 'italic', fontSize: 18, marginBottom: 6 }}>
          What you're looking at
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.62, margin: 0 }}>
          This is the substrate as it really lives — not a dashboard reading the bridge's API. Every entry on
          the left came from a single <code>GET .well-known/context-graphs</code> on the pod; every click on the
          right dereferences the descriptor's Turtle URL. The bridge isn't in the loop; this page talks to the pod
          directly, and would work the same against any Interego pod anywhere on the federation.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 14, marginTop: 20, fontSize: 12, fontFamily: mono, color: 'var(--text-dim)' }}>
        <button onClick={onHome} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontFamily: mono, fontSize: 12, padding: 0 }}>
          ← back to the site
        </button>
      </div>
    </div>
  );
}

const chipStyle = (on: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border)',
  background: on ? 'var(--text)' : 'transparent', color: on ? 'var(--panel)' : 'var(--text-dim)',
  fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer',
});
const tabStyle = (on: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)',
  background: on ? 'var(--text)' : 'transparent', color: on ? 'var(--panel)' : 'var(--text-dim)',
  fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer',
});
const preStyle: React.CSSProperties = {
  margin: 0, padding: '14px 16px', fontFamily: mono, fontSize: 11, lineHeight: 1.5,
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)', background: 'var(--panel)',
};
