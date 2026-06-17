/**
 * Shared demo session store (module-level, sessionStorage-persisted).
 *
 * The Agents page and the Reports page BOTH read this, so: (a) the run survives
 * navigating away + back (it lived in component state before — lost on unmount),
 * and (b) the reports are scoped to the agents THIS demo spawned (A + B), never
 * to johnny/maintainer/boozer. The microsite is the demo's own window.
 */

export type EventKind = 'identity' | 'phase' | 'thinking' | 'tool-call' | 'auth' | 'xapi' | 'scorm' | 'credential' | 'verify' | 'error' | 'done';
export interface DemoEvent {
  id: number;
  agent: 'A' | 'B' | 'sys';
  kind: EventKind;
  title: string;
  detail?: string;
  data?: unknown;
  ts: string;
}
export interface DemoAgent {
  did: string;
  address: string;
  /** pod/lens label the bridge derives: eth-<first12hex>. */
  label: string;
  /** the agent's LRS tenant: lens:<label>. */
  lensTenant: string;
  role: string;
}
export type DemoStatus = 'idle' | 'running' | 'done' | 'error';
export interface DemoState {
  status: DemoStatus;
  agents: { A?: DemoAgent; B?: DemoAgent };
  events: DemoEvent[];
  error?: string;
  startedAt?: string;
}

const KEY = 'foxxi-demo-session-v1';

function load(): DemoState {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DemoState;
  } catch { /* ignore */ }
  return { status: 'idle', agents: {}, events: [] };
}

let state: DemoState = load();
let idCounter = state.events.reduce((m, e) => Math.max(m, e.id), -1) + 1;
const listeners = new Set<() => void>();

function commit(next: DemoState): void {
  state = next;
  try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota — in-memory still fine */ }
  listeners.forEach(l => l());
}

export function getDemoState(): DemoState { return state; }
export function subscribeDemo(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Begin a fresh run (clears the prior one). */
export function resetDemo(): void {
  idCounter = 0;
  commit({ status: 'running', agents: {}, events: [], startedAt: new Date().toISOString() });
}
export function clearDemo(): void {
  idCounter = 0;
  commit({ status: 'idle', agents: {}, events: [] });
}
export function setDemoAgent(slot: 'A' | 'B', agent: DemoAgent): void {
  commit({ ...state, agents: { ...state.agents, [slot]: agent } });
}
export function addDemoEvent(e: Omit<DemoEvent, 'id' | 'ts'>): void {
  commit({ ...state, events: [...state.events, { ...e, id: idCounter++, ts: new Date().toISOString() }] });
}
export function setDemoStatus(status: DemoStatus, error?: string): void {
  commit({ ...state, status, ...(error !== undefined ? { error } : {}) });
}
