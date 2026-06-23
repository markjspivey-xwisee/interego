import type React from 'react';
export const mono = "'JetBrains Mono', monospace";
export const serif = "'EB Garamond', serif";
export const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
export const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
export const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: 'var(--panel-2)', padding: '1px 5px', borderRadius: 3 };
export const btn: React.CSSProperties = { background: 'var(--accent)', color: '#0d1117', border: 'none', padding: '11px 22px', borderRadius: 6, fontFamily: mono, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer', fontWeight: 600 };
export const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };
export const inp: React.CSSProperties = { width: '100%', padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' };
