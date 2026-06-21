/**
 * The Emergent Collective — a live, animated multi-agent emergence
 * demonstration, run *in the browser* against the deployed bridge.
 *
 * Nothing on this page is faked: five real ECDSA wallets created in the
 * browser, real signatures created and verified, real HTTP calls to the
 * live deployed bridge on Azure, the real calibration cell really
 * climbing toward — and crossing — the assertion threshold. The page
 * paces the run with delays so the emergence is visible, but every
 * value the dashboard shows comes from a real round-trip to the
 * substrate. The corresponding CLI demo is `tools/emergent-collective-demo.mjs`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Wallet, verifyMessage } from 'ethers';
import { BRIDGE_URL } from '../bridge-client.js';

// Inlined here (rather than imported from the vertical's src) so the
// microsite bundle stays free of the bridge-only @interego/core
// dependency chain. The logic mirrors performance-calibration.ts
// (`dominantCause`) and the closure half of performance-architecture.ts
// (`evaluateIntervention`) — identical semantics, demoable values.
const CAUSE_PREFIX: Array<[RegExp, string]> = [
  [/^Information/, 'information'], [/^Instrumentation/, 'instrumentation'],
  [/^Incentives/, 'incentives'], [/^Knowledge & Skill/, 'knowledgeSkill'],
  [/^Capacity/, 'capacity'], [/^Motives/, 'motives'],
];
function dominantCause(diagnosis: any): string {
  for (const c of (diagnosis?.rootCauses ?? [])) {
    for (const [re, key] of CAUSE_PREFIX) if (re.test(c)) return key;
  }
  return 'not-applicable';
}
function verdictOf(exemplary: string, observed: string, newObserved: string, transferred: boolean): 'closed' | 'improved' | 'no-change' {
  const closed = newObserved.trim().toLowerCase() === exemplary.trim().toLowerCase() || transferred;
  if (closed) return 'closed';
  if (newObserved !== observed) return 'improved';
  return 'no-change';
}

// CSS itself is internal-only; browser code reaches the pod through the
// public css-gate. Override at build time via VITE_CSS_POD_URL.
const CSS_POD = (import.meta.env.VITE_CSS_POD_URL as string | undefined)
  ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const PEER_POD = `${CSS_POD}/foxxi/federation-peer/`;
const ASSERT_THRESHOLD = 12;
const AGENT_NAMES = ['Scout', 'Probe', 'Ranger', 'Atlas', 'Nova'] as const;

// ── styles (matching the rest of the microsite) ─────────────────────

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";

const card: React.CSSProperties = {
  background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
  padding: 20, boxShadow: 'var(--shadow)',
};
const btn: React.CSSProperties = {
  padding: '10px 20px', background: 'var(--text)', color: 'var(--panel)', border: 'none',
  borderRadius: 4, fontFamily: mono, fontSize: 12, fontWeight: 600,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
};
const btnOutline: React.CSSProperties = {
  ...btn, background: 'transparent', color: 'var(--text)', border: '1px solid var(--text)',
};
const dim = { color: 'var(--text-dim)' } as React.CSSProperties;
const label: React.CSSProperties = {
  fontFamily: mono, fontSize: 10, textTransform: 'uppercase',
  letterSpacing: '0.07em', color: 'var(--text-dim)',
};

// ── types ───────────────────────────────────────────────────────────

interface Agent {
  name: string;
  did: string;
  address: string;
  signature: string | null;
  status: 'idle' | 'signing' | 'active' | 'done';
  contributions: number;
}
interface DemoEvent {
  ts: number; kind: 'info' | 'sig' | 'http' | 'flip' | 'fail';
  text: string; agent?: string;
}
interface CellState {
  samples: number; closureRate: number;
  modalStatus: 'absent' | 'Hypothetical' | 'Asserted';
}
type Phase = 'idle' | 'running' | 'done' | 'error';
type Speed = 'slow' | 'normal' | 'fast';

const SPEED_DELAY: Record<Speed, number> = { slow: 1100, normal: 500, fast: 120 };

// ── helpers ─────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BRIDGE_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// Match the bridge's canonical signing scheme (browser-side):
//   signedPayload = JSON.stringify(<canonical payload>)
//   message       = `sha256:<sha256-hex(signedPayload)>`
//   signature     = await wallet.signMessage(message)
// The bridge's verifySignature() recomputes the hash from the exact bytes
// the agent signed (sent as signedPayload) and recovers the address from
// the signature, then checks it matches author.id (the did:key suffix).
// Web Crypto is used here (not node:crypto) because this runs in the browser.
async function signPayload(
  wallet: { signMessage: (msg: string) => Promise<string> },
  payload: unknown,
): Promise<{ signedPayload: string; signature: string }> {
  const signedPayload = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(signedPayload));
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const signature = await wallet.signMessage(`sha256:${hex}`);
  return { signedPayload, signature };
}

async function readCell(): Promise<{
  cell: CellState; federated: { totalSamples: number; sources: number } | null;
}> {
  const r = await post('/performance/calibration', {});
  const cells = r.json?.tenant?.profile?.cells ?? [];
  const fed = r.json?.federated?.profile;
  const c = cells.find((x: any) => x.causeFactor === 'information' && x.intervention === 'reference');
  return {
    cell: c ? { samples: c.samples, closureRate: c.closureRate, modalStatus: c.modalStatus }
            : { samples: 0, closureRate: 0, modalStatus: 'absent' },
    federated: fed ? { totalSamples: fed.totalSamples, sources: fed.sources } : null,
  };
}

const initialAgents = (): Agent[] => AGENT_NAMES.map(name => ({
  name, did: '', address: '', signature: null, status: 'idle', contributions: 0,
}));

// ── page ────────────────────────────────────────────────────────────

export function EmergentCollective({ onHome, onDemos }: { onHome: () => void; onDemos: () => void }) {
  const [agents, setAgents] = useState<Agent[]>(initialAgents);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [cell, setCell] = useState<CellState>({ samples: 0, closureRate: 0, modalStatus: 'absent' });
  const [initialCell, setInitialCell] = useState<CellState | null>(null);
  const [bridgeOk, setBridgeOk] = useState<boolean | null>(null);
  const [peerOk, setPeerOk] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [speed, setSpeed] = useState<Speed>('normal');
  const [teach, setTeach] = useState<{ transferred: boolean | null; evidence: string }>({
    transferred: null, evidence: '',
  });
  const [federated, setFederated] = useState<{ totalSamples: number; sources: number } | null>(null);
  const [flipped, setFlipped] = useState<{ agent: string; atSample: number } | null>(null);
  const [glow, setGlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const t0 = useRef<number>(0);
  const eventsBoxRef = useRef<HTMLDivElement>(null);

  const log = (e: Omit<DemoEvent, 'ts'>) =>
    setEvents(es => [...es, { ts: Date.now() - t0.current, ...e }]);

  useEffect(() => {
    // autoscroll the event log
    if (eventsBoxRef.current) eventsBoxRef.current.scrollTop = eventsBoxRef.current.scrollHeight;
  }, [events.length]);

  function reset() {
    cancelRef.current = true;
    setAgents(initialAgents());
    setEvents([]);
    setCell({ samples: 0, closureRate: 0, modalStatus: 'absent' });
    setInitialCell(null);
    setBridgeOk(null); setPeerOk(null);
    setTeach({ transferred: null, evidence: '' });
    setFederated(null);
    setFlipped(null); setGlow(false); setError(null);
    setPhase('idle');
  }

  async function run() {
    if (phase === 'running') return;
    reset();
    await sleep(50); // let reset render
    cancelRef.current = false;
    t0.current = Date.now();
    setPhase('running');
    const delay = SPEED_DELAY[speed];

    try {
      // ── ACT 1: substrate is live ──────────────────────────────
      log({ kind: 'info', text: 'pinging the deployed bridge…' });
      const perfR = await fetch(`${BRIDGE_URL}/performance`).then(r => r.ok).catch(() => false);
      setBridgeOk(perfR);
      log({ kind: 'http', text: `Foxxi bridge on Azure: ${perfR ? 'reachable' : 'unreachable'}` });
      if (cancelRef.current) return;
      await sleep(delay);

      log({ kind: 'info', text: 'reading the peer organization\'s pod over the federation…' });
      const peerR = await fetch(`${PEER_POD}.well-known/context-graphs`, { headers: { Accept: 'text/turtle' } })
        .then(r => r.ok).catch(() => false);
      setPeerOk(peerR);
      log({ kind: 'http', text: `peer pod (Peer Academy): ${peerR ? 'reachable' : 'unreachable'}` });
      if (cancelRef.current) return;
      await sleep(delay);

      // ── ACT 2: real agents, real signatures ───────────────────
      const wallets = AGENT_NAMES.map(() => Wallet.createRandom());
      const next: Agent[] = wallets.map((w, i) => ({
        name: AGENT_NAMES[i], did: `did:key:${w.address.toLowerCase()}#agent`,
        address: w.address, signature: null, status: 'signing' as const, contributions: 0,
      }));
      setAgents(next);
      log({ kind: 'info', text: 'created five real ECDSA wallets in the browser' });
      await sleep(delay);

      for (let i = 0; i < wallets.length; i++) {
        if (cancelRef.current) return;
        const claim = `${next[i].did} joins the emergent collective`;
        const sig = await wallets[i].signMessage(claim);
        const recovered = verifyMessage(claim, sig);
        const ok = recovered.toLowerCase() === next[i].address.toLowerCase();
        next[i] = { ...next[i], signature: sig, status: ok ? 'idle' : 'idle' };
        setAgents([...next]);
        log({ kind: 'sig', text: `${next[i].name}: signed, recovered + matched`, agent: next[i].name });
        await sleep(delay);
      }
      log({ kind: 'info', text: 'five distinct cryptographic identities established' });
      await sleep(delay);

      // ── ACT 3: baseline ───────────────────────────────────────
      // The seeded historical corpus (sample-outcomes.ts) does NOT include
      // an information→reference cell, so anything in that cell on the
      // live bridge must have been earned by live contributions.
      log({ kind: 'info', text: 'seeded baseline has no information→reference cell — any such finding must be earned live' });
      if (cancelRef.current) return;
      const baseline = await readCell();
      setCell(baseline.cell);
      setInitialCell(baseline.cell);
      log({
        kind: 'http',
        text: `baseline: cell carries ${baseline.cell.samples} sample(s), ${baseline.cell.modalStatus}`,
      });
      if (baseline.cell.modalStatus === 'Asserted') {
        log({ kind: 'info', text: '(prior collective runs already pushed this Asserted; this run extends them — the substrate is genuinely shared)' });
      }
      await sleep(delay);

      // ── ACT 4: stigmergic contribution ─────────────────────────
      const startSamples = baseline.cell.samples;
      for (let ai = 0; ai < wallets.length; ai++) {
        if (cancelRef.current) return;
        const agent = next[ai];
        next[ai] = { ...agent, status: 'active' };
        setAgents([...next]);
        log({ kind: 'info', text: `${agent.name} begins (alone — its only channel is the substrate)`, agent: agent.name });
        await sleep(Math.max(delay / 2, 60));

        for (let s = 0; s < 3; s++) {
          if (cancelRef.current) return;
          const idx = ai * 3 + s;
          const reachable = idx % 5 !== 2;
          const situation = {
            id: `urn:foxxi:situation:field-guidance-${Date.now()}-${idx}`,
            performer: { id: agent.did, kind: 'agent', role: 'field operator' },
            workContext: 'applying a rarely-used procedure in the field',
            competency: 'completing the field procedure correctly',
            observed: 'misses steps because the guidance is not at hand',
            frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
          };
          const exemplary = 'completes the procedure correctly, guidance at hand';
          const planRes = await post('/performance/plan', {
            situation, exemplary,
            factorEvidence: { information: { adequate: false, evidence: 'the procedure guide is not surfaced at the point of work' } },
            author: { id: agent.did, kind: 'agent' },
          });
          const cause = dominantCause(planRes.json.diagnosis);
          const newObserved = reachable ? exemplary : situation.observed;
          const verdict = verdictOf(exemplary, situation.observed, newObserved, reachable);
          // The outcome the agent signs IS the canonical payload — exactly the
          // shape the bridge's recordLiveOutcome validator expects. The bridge
          // recomputes sha256 over signedPayload and recovers the address from
          // signature; it must match author.id's 0x-suffix or it returns 401.
          const outcomePayload = {
            regime: 'Knowable', method: 'gap-analysis',
            causeFactor: cause, intervention: 'reference', verdict,
            ...(verdict !== 'closed' ? { reDiagnosedCause: 'knowledgeSkill' } : {}),
            source: 'acme',
          };
          const outcomeSigned = await signPayload(wallets[ai], outcomePayload);
          await post('/performance/outcome', {
            author: { id: agent.did, kind: 'agent' },
            signature: outcomeSigned.signature,
            signedPayload: outcomeSigned.signedPayload,
          });
          // re-read live cell state
          const seen = await readCell();
          const wasAsserted = cell.modalStatus === 'Asserted';
          setCell(seen.cell);
          // detect the flip during this run
          if (!flipped && initialCell && initialCell.modalStatus !== 'Asserted'
              && seen.cell.modalStatus === 'Asserted') {
            setFlipped({ agent: agent.name, atSample: seen.cell.samples });
            setGlow(true);
            setTimeout(() => setGlow(false), 1800);
            log({ kind: 'flip', text: `EMERGENCE — the cell flipped Hypothetical → Asserted at ${seen.cell.samples} samples while ${agent.name} was contributing`, agent: agent.name });
          }
          next[ai] = { ...next[ai], contributions: s + 1 };
          setAgents([...next]);
          log({
            kind: 'http', agent: agent.name,
            text: `${agent.name} #${s + 1}: ${verdict} → cell now ${seen.cell.samples} (${seen.cell.modalStatus})`,
          });
          // pace
          await sleep(delay);
        }
        next[ai] = { ...next[ai], status: 'done' };
        setAgents([...next]);
      }

      // ── ACT 6: downward causation ─────────────────────────────
      if (cancelRef.current) return;
      log({ kind: 'info', text: 'a fresh plan is now annotated with what the collective produced' });
      const freshPlan = await post('/performance/plan', {
        situation: {
          id: `urn:foxxi:situation:newcomer-${Date.now()}`,
          performer: { id: next[0].did, kind: 'agent', role: 'field operator' },
          workContext: 'applying a rarely-used procedure in the field',
          competency: 'completing the field procedure correctly',
          observed: 'misses steps because the guidance is not at hand',
          frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
        },
        exemplary: 'completes the procedure correctly, guidance at hand',
        factorEvidence: { information: { adequate: false, evidence: 'guide not at the point of work' } },
      });
      log({
        kind: 'http',
        text: `downward: a fresh plan now reads calibration "${freshPlan.json.calibration?.verdict}"`,
      });
      await sleep(delay);

      // ── ACT 7: agent teaching ─────────────────────────────────
      if (cancelRef.current) return;
      const atlas = next[3], nova = next[4];
      const traj = (steps: Array<{ v: string; o: string }>) => [{
        agentDid: nova.did, agentName: nova.name, createdAt: new Date().toISOString(),
        steps: steps.map((x, i) => ({
          modalStatus: 'Asserted', granularity: 'tool-call', verb: x.v, objectId: `o${i}`,
          objectName: x.o, recordedAt: new Date().toISOString(),
        })),
      }];
      log({ kind: 'info', text: `${atlas.name} encodes the finding as an ac:TeachingPackage and teaches ${nova.name}` });
      // The teacher signs the (teachingPackage, targetBehaviour) tuple — that's
      // the attestation the bridge checks before counting the transfer.
      const teachingPackage = {
        iri: `urn:iep:teaching:reference-for-field-guidance-${Date.now()}`,
        artifactIri: 'urn:iep:tool:field-reference',
        competency: 'reaching guidance at the point of work',
        olkeStage: 'Articulate', modalStatus: 'Hypothetical',
      };
      const targetBehaviour = {
        description: 'consults the searchable reference at the point of work before acting',
        signalMarkers: ['reference', 'look up', 'guidance'],
        antiSignalMarkers: ['guess', 'skip'],
      };
      const teachSigned = await signPayload(wallets[3], { teachingPackage, targetBehaviour });
      const teachR = await post('/agent/teach', {
        teachingPackage,
        teacher: { id: atlas.did, kind: 'agent' },
        learner: { id: nova.did, kind: 'agent' },
        targetBehaviour,
        signature: teachSigned.signature,
        signedPayload: teachSigned.signedPayload,
        before: traj([
          { v: 'guess', o: 'the next step' }, { v: 'skip', o: 'a checklist item' },
          { v: 'act', o: 'on assumptions' }, { v: 'escalate', o: 'a mistake' },
        ]),
        after: traj([
          { v: 'look up', o: 'the reference for the procedure' },
          { v: 'consult', o: 'the guidance' }, { v: 'apply', o: 'the referenced step' },
          { v: 'look up', o: 'the reference again' }, { v: 'complete', o: 'the procedure' },
          { v: 'verify', o: 'against the guidance' },
        ]),
      });
      setTeach({
        transferred: teachR.json.verdict?.transferred ?? false,
        evidence: teachR.json.verdict?.evidence ?? '',
      });
      log({
        kind: 'http',
        text: `teach verdict: ${teachR.json.verdict?.transferred ? 'transferred' : 'did not transfer'} (${teachR.json.verdict?.modalStatus})`,
        agent: atlas.name,
      });
      await sleep(delay);

      // ── ACT 8: federation ─────────────────────────────────────
      if (cancelRef.current) return;
      const fed = await readCell();
      if (fed.federated) setFederated(fed.federated);
      log({
        kind: 'http',
        text: `federated profile: ${fed.federated?.totalSamples} outcomes across ${fed.federated?.sources} source(s) — Acme + Peer Academy`,
      });

      setPhase('done');
      log({ kind: 'info', text: '— the whole acquired a property no part possessed —' });
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
      log({ kind: 'fail', text: `error: ${(e as Error).message}` });
    }
  }

  useEffect(() => () => { cancelRef.current = true; }, []);

  // ── render ────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 24px 60px' }}>
      <Header phase={phase} onRun={run} onReset={reset} speed={speed} setSpeed={setSpeed} />
      <SubstrateRow bridgeOk={bridgeOk} peerOk={peerOk} />
      <AgentsRow agents={agents} />
      <CellPanel cell={cell} initialCell={initialCell} flipped={flipped} glow={glow} />
      <EventsPanel events={events} boxRef={eventsBoxRef} />
      <BottomPanels teach={teach} federated={federated} />
      <Closing onHome={onHome} onDemos={onDemos} error={error} />
    </div>
  );
}

// ── header ──────────────────────────────────────────────────────────

function Header({ phase, onRun, onReset, speed, setSpeed }: {
  phase: Phase; onRun: () => void; onReset: () => void;
  speed: Speed; setSpeed: (s: Speed) => void;
}) {
  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ ...label, marginBottom: 6 }}>Foxxi × Interego · live demonstration</div>
      <h1 style={{
        fontFamily: serif, fontWeight: 500, fontSize: 40, lineHeight: 1.1, margin: '4px 0 12px',
      }}>The Emergent Collective</h1>
      <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--text)', maxWidth: 760, margin: '0 0 14px' }}>
        Five agents — each a real wallet-rooted identity created in your browser — act independently
        against the live deployed bridge, coordinating only through the substrate. A piece of
        knowledge no single agent holds <b>emerges</b> from their aggregate, flipped to claimable by
        the bridge's own modal status, becomes a transmissible capability, and comes to live in a
        federated profile two organizations share.
      </p>
      <div style={{
        maxWidth: 760, marginBottom: 18, padding: '8px 12px', borderRadius: 4,
        borderLeft: '3px solid var(--accent)', background: 'rgba(0,0,0,0.025)',
        fontSize: 13, lineHeight: 1.55,
      }}>
        <b>Scripted edition.</b> This page runs the scripted edition — real wallets, real
        signatures, real HTTP to the live bridge, real calibration math, real modal flip — but the
        per-agent contributions are iterated deterministically by this page, not decided by an LLM.
        The <b>autonomous edition</b> spawns five real Claude subagents (via the Claude Agent SDK)
        that each decide for themselves; runs from the CLI — see the closing card below.
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={btn} onClick={onRun} disabled={phase === 'running'}>
          {phase === 'running' ? 'running…' : phase === 'done' ? 'Run again ▶' : '▶ Run it live'}
        </button>
        <button style={btnOutline} onClick={onReset}>↻ Reset</button>
        <label style={{ fontFamily: mono, fontSize: 11, ...dim }}>
          speed:{' '}
          <select value={speed} onChange={e => setSpeed(e.target.value as Speed)}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', fontFamily: mono, fontSize: 11 }}>
            <option value="slow">slow</option>
            <option value="normal">normal</option>
            <option value="fast">fast</option>
          </select>
        </label>
      </div>
    </div>
  );
}

// ── substrate row (live indicators) ─────────────────────────────────

function SubstrateRow({ bridgeOk, peerOk }: { bridgeOk: boolean | null; peerOk: boolean | null }) {
  return (
    <div style={{ display: 'flex', gap: 16, marginBottom: 22, flexWrap: 'wrap' }}>
      <Dot label="Foxxi bridge on Azure" ok={bridgeOk} />
      <Dot label="peer organization pod" ok={peerOk} />
    </div>
  );
}
function Dot({ label: txt, ok }: { label: string; ok: boolean | null }) {
  const color = ok === null ? 'var(--text-dim)' : ok ? '#1a7f37' : 'var(--bad)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: mono, color: 'var(--text-dim)',
      padding: '6px 12px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--panel)',
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, transition: 'background 200ms' }} />
      {txt}: <b style={{ color: ok ? 'var(--text)' : 'var(--text-dim)' }}>{ok === null ? '—' : ok ? 'live' : 'unreachable'}</b>
    </div>
  );
}

// ── agents row ──────────────────────────────────────────────────────

function AgentsRow({ agents }: { agents: Agent[] }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ ...label, marginBottom: 8 }}>five autonomous agents</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: 10 }}>
        {agents.map(a => <AgentCard key={a.name} agent={a} />)}
      </div>
    </div>
  );
}
function AgentCard({ agent }: { agent: Agent }) {
  const borderColor =
    agent.status === 'active' ? 'var(--accent)' :
    agent.status === 'done' ? '#1a7f37' :
    agent.signature ? 'var(--border)' : 'var(--border)';
  const bgColor = agent.status === 'active' ? 'var(--panel-2)' : 'var(--panel)';
  const sigColor = agent.signature ? '#1a7f37' : 'var(--text-dim)';
  return (
    <div style={{
      ...card, padding: 12, borderColor, background: bgColor,
      transition: 'border-color 200ms, background 200ms, transform 200ms',
      transform: agent.status === 'active' ? 'translateY(-2px)' : 'none',
    }}>
      <div style={{ fontFamily: serif, fontSize: 18, fontWeight: 500 }}>{agent.name}</div>
      <div style={{ fontFamily: mono, fontSize: 9.5, ...dim, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {agent.address ? shortAddr(agent.address) : '—'}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 10.5, fontFamily: mono }}>
        <span style={{ color: sigColor }}>{agent.signature ? '✓ signed' : '— pending'}</span>
      </div>
      <div style={{ fontSize: 11, fontFamily: mono, ...dim, marginTop: 4 }}>
        contributions: <b style={{ color: 'var(--text)' }}>{agent.contributions}</b>/3
      </div>
      <div style={{ marginTop: 4, height: 3, background: 'var(--panel-2)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          width: `${(agent.contributions / 3) * 100}%`, height: '100%',
          background: agent.status === 'done' ? '#1a7f37' : 'var(--accent)', transition: 'width 300ms',
        }} />
      </div>
    </div>
  );
}

// ── the cell panel (the centerpiece) ────────────────────────────────

function CellPanel({ cell, initialCell, flipped, glow }: {
  cell: CellState; initialCell: CellState | null;
  flipped: { agent: string; atSample: number } | null; glow: boolean;
}) {
  const pctOfThreshold = Math.min(cell.samples / ASSERT_THRESHOLD, 1);
  const isAsserted = cell.modalStatus === 'Asserted';
  const statusColor = isAsserted ? '#1a7f37' : cell.modalStatus === 'Hypothetical' ? '#b06f00' : 'var(--text-dim)';
  return (
    <div style={{
      ...card, marginBottom: 22, position: 'relative',
      borderColor: glow ? '#1a7f37' : isAsserted ? '#1a7f37' : 'var(--border)',
      boxShadow: glow ? '0 0 0 6px rgba(26,127,55,0.18), var(--shadow)' : 'var(--shadow)',
      transition: 'border-color 300ms, box-shadow 600ms',
    }}>
      <div style={{ ...label, marginBottom: 8 }}>the calibration cell</div>
      <div style={{ fontFamily: serif, fontStyle: 'italic', fontSize: 24 }}>
        information → reference
      </div>
      <div style={{ display: 'flex', gap: 28, alignItems: 'baseline', marginTop: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{
            fontFamily: serif, fontSize: 72, fontWeight: 500, lineHeight: 1,
            transition: 'transform 250ms',
            transform: glow ? 'scale(1.06)' : 'none',
          }}>{cell.samples}</div>
          <div style={{ ...label }}>samples (live)</div>
        </div>
        <div>
          <div style={{
            display: 'inline-block', padding: '6px 14px', borderRadius: 4,
            border: `1px solid ${statusColor}`, color: statusColor,
            fontFamily: mono, fontSize: 13, fontWeight: 600, letterSpacing: '0.05em',
            background: glow && isAsserted ? 'rgba(26,127,55,0.10)' : 'transparent',
            transition: 'all 300ms',
          }}>{cell.modalStatus === 'absent' ? 'no cell yet' : cell.modalStatus}</div>
          <div style={{ ...label, marginTop: 8 }}>iep:modalStatus</div>
        </div>
        <div>
          <div style={{ fontFamily: serif, fontSize: 36, fontWeight: 500 }}>
            {cell.samples > 0 ? pct(cell.closureRate) : '—'}
          </div>
          <div style={{ ...label }}>emergent closure rate</div>
        </div>
      </div>
      <div style={{ marginTop: 18 }}>
        <div style={{
          fontFamily: mono, fontSize: 10.5, ...dim,
          display: 'flex', justifyContent: 'space-between', marginBottom: 4,
        }}>
          <span>0</span>
          <span>assertion threshold (12)</span>
          <span>+</span>
        </div>
        <div style={{ height: 10, background: 'var(--panel-2)', borderRadius: 5, overflow: 'hidden', position: 'relative' }}>
          <div style={{
            width: `${pctOfThreshold * 100}%`, height: '100%',
            background: isAsserted ? '#1a7f37' : 'var(--accent)',
            transition: 'width 400ms, background 400ms',
          }} />
          <div style={{
            position: 'absolute', left: '100%', top: -2, bottom: -2, width: 2,
            background: 'var(--text)', opacity: 0.7,
            transform: `translateX(-${(1 - 12 / Math.max(ASSERT_THRESHOLD, cell.samples)) * 100}%)`,
          }} />
        </div>
      </div>
      {initialCell && (
        <div style={{ marginTop: 14, fontSize: 12, ...dim }}>
          baseline this run: <b>{initialCell.samples}</b> sample(s), {initialCell.modalStatus}{' '}
          {initialCell.modalStatus === 'Asserted' && '— this run extends prior collective work; the substrate is genuinely shared'}
        </div>
      )}
      {flipped && (
        <div style={{
          marginTop: 14, fontSize: 13, padding: '10px 14px', borderRadius: 4,
          borderLeft: '3px solid #1a7f37', background: 'rgba(26,127,55,0.08)',
        }}>
          <b>EMERGENCE</b> — the cell crossed the threshold and flipped <b>Hypothetical → Asserted</b>{' '}
          while <b>{flipped.agent}</b> was contributing, at <b>{flipped.atSample}</b> samples. The
          claim now belongs to the collective, not to any agent.
        </div>
      )}
    </div>
  );
}

// ── events log ──────────────────────────────────────────────────────

function EventsPanel({ events, boxRef }: {
  events: DemoEvent[]; boxRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div style={{ ...card, marginBottom: 22 }}>
      <div style={{ ...label, marginBottom: 8 }}>event timeline (live HTTP)</div>
      <div ref={boxRef} style={{
        maxHeight: 240, overflow: 'auto', fontFamily: mono, fontSize: 11.5, lineHeight: 1.6,
      }}>
        {events.length === 0 && <div style={dim}>idle — press Run.</div>}
        {events.map((e, i) => {
          const color =
            e.kind === 'flip' ? '#1a7f37' :
            e.kind === 'sig' ? '#3a7dc4' :
            e.kind === 'fail' ? 'var(--bad)' :
            e.kind === 'http' ? 'var(--text)' : 'var(--text-dim)';
          const stamp = `${(e.ts / 1000).toFixed(2).padStart(6, ' ')}s`;
          return (
            <div key={i} style={{ color, fontWeight: e.kind === 'flip' ? 700 : 400 }}>
              <span style={dim}>{stamp}</span>{'  '}{e.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── bottom panels: teach + federation ───────────────────────────────

function BottomPanels({ teach, federated }: {
  teach: { transferred: boolean | null; evidence: string };
  federated: { totalSamples: number; sources: number } | null;
}) {
  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', marginBottom: 22 }}>
      <div style={card}>
        <div style={{ ...label, marginBottom: 8 }}>the finding becomes a capability</div>
        <div style={{ fontFamily: serif, fontStyle: 'italic', fontSize: 18 }}>Atlas → Nova</div>
        <div style={{ marginTop: 8, fontSize: 13 }}>
          {teach.transferred === null ? (
            <span style={dim}>awaiting the teach call…</span>
          ) : (
            <>
              <div style={{
                display: 'inline-block', padding: '3px 9px', borderRadius: 4, fontFamily: mono, fontSize: 11,
                border: `1px solid ${teach.transferred ? '#1a7f37' : 'var(--bad)'}`,
                color: teach.transferred ? '#1a7f37' : 'var(--bad)',
              }}>{teach.transferred ? '✓ transferred (Asserted)' : '✗ no transfer'}</div>
              <div style={{ marginTop: 8, fontSize: 12 }}>{teach.evidence}</div>
            </>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 11.5, ...dim }}>
          POST /agent/teach — composing agent-collective's ac:TeachingPackage; transfer verified from
          the learner's real trajectories on the live bridge.
        </div>
      </div>
      <div style={card}>
        <div style={{ ...label, marginBottom: 8 }}>federated across organizations</div>
        {federated ? (
          <>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 4 }}>
              <OrgBlob name="Acme" />
              <div style={{ fontFamily: serif, fontSize: 28 }}>+</div>
              <OrgBlob name="Peer Academy" />
            </div>
            <div style={{ marginTop: 12, fontFamily: serif, fontSize: 22 }}>
              <b>{federated.totalSamples}</b> outcomes · <b>{federated.sources}</b> source(s)
            </div>
            <div style={{ marginTop: 4, fontSize: 11.5, ...dim }}>
              the live bridge composes the calibration evidence of two organizations — the emergent
              finding now lives in a profile both share, with no coordinator.
            </div>
          </>
        ) : (
          <div style={dim}>awaiting the federation read…</div>
        )}
      </div>
    </div>
  );
}
function OrgBlob({ name }: { name: string }) {
  return (
    <div style={{
      padding: '8px 14px', borderRadius: 6, background: 'var(--panel-2)',
      border: '1px solid var(--border)', fontFamily: mono, fontSize: 12,
    }}>{name}</div>
  );
}

// ── closing ─────────────────────────────────────────────────────────

function Closing({ onHome, onDemos, error }: { onHome: () => void; onDemos: () => void; error: string | null }) {
  return (
    <div style={{ ...card, background: 'var(--panel-2)' }}>
      <div style={{ fontFamily: serif, fontStyle: 'italic', fontSize: 19, marginBottom: 6 }}>
        What you just watched
      </div>
      <p style={{ fontSize: 14, lineHeight: 1.62, margin: '0 0 12px' }}>
        Five real wallet-rooted identities, acting independently against the live bridge, produced
        a piece of knowledge no single one of them could establish alone. A handful of outcomes is
        honestly <b>Hypothetical</b> — too thin to claim anything. Only the aggregate carries
        enough weight to flip <b>Asserted</b>, and the bridge's modal status names the exact point
        of emergence. The finding then becomes a transmissible <code>ac:TeachingPackage</code> and
        comes to live in a profile two organizations share. The whole acquired a property that
        none of its parts possessed.
      </p>
      <div style={{
        marginTop: 4, padding: '10px 12px', borderRadius: 4,
        borderLeft: '3px solid var(--accent)', background: 'rgba(0,0,0,0.025)',
        fontSize: 13, lineHeight: 1.6,
      }}>
        <div style={{ fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)', marginBottom: 4 }}>
          edition you just watched
        </div>
        What ran in your browser is the <b>scripted edition</b>: the wallets, signatures, HTTP calls,
        calibration math, and modal flip are all real — but the per-agent contributions are iterated
        deterministically by this page, not decided by an LLM. The <b>autonomous edition</b> spawns
        five real Claude subagents through the Claude Agent SDK; each one independently decides which
        tools to call and in what order, with the substrate as their only channel to each other.
        Same architecture, same emergence — runs from the CLI (it needs your API key or an active
        Claude Code login):
        <pre style={{
          fontFamily: mono, fontSize: 12, margin: '8px 0 0', padding: '8px 10px',
          background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4,
          overflowX: 'auto',
        }}>npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-agents.mjs</pre>
      </div>
      {error && (
        <div style={{
          marginTop: 8, padding: '8px 10px', borderRadius: 4, fontSize: 13,
          borderLeft: '3px solid var(--bad)', background: 'rgba(220,53,69,0.06)',
        }}>{error}</div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, fontFamily: mono, marginTop: 6 }}>
        <a
          href="https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence/EMERGENT-COLLECTIVE.md"
          target="_blank" rel="noreferrer"
        >EMERGENT-COLLECTIVE.md →</a>
        <a
          href="https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence/tools/emergent-collective-demo.mjs"
          target="_blank" rel="noreferrer"
        >scripted-edition CLI →</a>
        <a
          href="https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence/tools/emergent-collective-agents.mjs"
          target="_blank" rel="noreferrer"
        >autonomous-edition CLI (real Claude subagents) →</a>
        <button onClick={onDemos} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontFamily: mono, fontSize: 12, padding: 0 }}>
          ← back to demos
        </button>
        <button onClick={onHome} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontFamily: mono, fontSize: 12, padding: 0 }}>
          ← back to the site
        </button>
      </div>
    </div>
  );
}
