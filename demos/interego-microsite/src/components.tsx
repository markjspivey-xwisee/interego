import React from 'react';
import { card, lbl, inp, linkBtn } from './styles.js';

export function KeyCard({ apiKey, setKey, note }: { apiKey: string; setKey: (v: string) => void; note: string }) {
  return (
    <div style={{ ...card, marginTop: 18 }}>
      <div style={{ ...lbl, marginBottom: 4 }}>Anthropic key — {note} (sent only to api.anthropic.com from this tab; the substrate calls are signature-bound, not key-bound)</div>
      <input type="password" value={apiKey} onChange={e => setKey(e.target.value)} placeholder="sk-ant-… (required — real LLM agents drive this)"
        autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" style={inp} />
    </div>
  );
}

export function Back({ onHome }: { onHome: () => void }) {
  return <button onClick={onHome} style={linkBtn}>← interego</button>;
}
