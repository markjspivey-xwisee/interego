import type React from 'react';

// ── Shared style primitives used across the Interego main site. ───

export const mono = "'JetBrains Mono', monospace";
export const serif = "'EB Garamond', serif";

export const page: React.CSSProperties = {
  maxWidth: 1200, margin: '0 auto', padding: '40px 28px',
};
export const card: React.CSSProperties = {
  background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
  padding: 22, boxShadow: 'var(--shadow)',
};
export const eyebrow: React.CSSProperties = {
  fontFamily: mono, fontSize: 11, textTransform: 'uppercase',
  letterSpacing: '0.08em', color: 'var(--text-dim)',
};
export const h1: React.CSSProperties = {
  fontFamily: serif, fontWeight: 500, fontSize: 44, lineHeight: 1.08,
  margin: '6px 0 16px', color: 'var(--text)',
};
export const h2: React.CSSProperties = {
  fontFamily: serif, fontWeight: 500, fontSize: 28, lineHeight: 1.15,
  margin: '34px 0 10px', color: 'var(--text)',
};
export const h3: React.CSSProperties = {
  fontFamily: serif, fontWeight: 500, fontSize: 20, lineHeight: 1.25,
  margin: '0 0 6px', color: 'var(--text)',
};
export const lede: React.CSSProperties = {
  fontFamily: serif, fontSize: 19, lineHeight: 1.55, color: 'var(--text)',
  maxWidth: 800, margin: '0 0 22px',
};
export const para: React.CSSProperties = {
  fontSize: 16, lineHeight: 1.62, color: 'var(--text)', margin: '0 0 12px',
};
export const small: React.CSSProperties = {
  fontFamily: mono, fontSize: 12, color: 'var(--text-dim)',
};
export const pill: React.CSSProperties = {
  display: 'inline-block', padding: '2px 9px', borderRadius: 999,
  fontFamily: mono, fontSize: 10, textTransform: 'uppercase',
  letterSpacing: '0.06em', background: 'rgba(0,0,0,0.04)', color: 'var(--text-dim)',
  border: '1px solid var(--border)', marginRight: 6,
};
export const btnPrimary: React.CSSProperties = {
  padding: '10px 22px', background: 'var(--text)', color: 'var(--panel)', border: 'none',
  borderRadius: 4, fontFamily: mono, fontSize: 12, fontWeight: 600,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
  textDecoration: 'none', display: 'inline-block',
};
export const btnOutline: React.CSSProperties = {
  ...btnPrimary,
  background: 'transparent', color: 'var(--text)', border: '1px solid var(--text)',
};
export const accentLink: React.CSSProperties = {
  color: 'var(--accent)', fontWeight: 600, textDecoration: 'none',
};
export const codeChip: React.CSSProperties = {
  fontFamily: mono, fontSize: 13, background: 'rgba(0,0,0,0.05)',
  padding: '1px 6px', borderRadius: 3,
};

