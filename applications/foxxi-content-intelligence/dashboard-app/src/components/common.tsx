import React, { useEffect } from 'react';

export function Card(props: { title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; bare?: boolean }) {
  return (
    <div style={{
      background: 'var(--panel)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: props.bare ? 0 : 18,
      marginBottom: 14,
      boxShadow: 'var(--shadow)',
    }}>
      {(props.title || props.right) && (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14, gap: 12 }}>
          {props.title && (
            <div style={{
              fontFamily: "'EB Garamond', Garamond, Georgia, serif",
              fontStyle: 'italic', fontSize: 22, fontWeight: 500,
              color: 'var(--text)', letterSpacing: '-0.01em',
            }}>{props.title}</div>
          )}
          {props.right && <div style={{ marginLeft: 'auto' }}>{props.right}</div>}
        </div>
      )}
      {props.children}
    </div>
  );
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent'; children: React.ReactNode }) {
  const palette = {
    neutral: { bg: 'rgba(26,35,50,0.08)', fg: 'var(--text-dim)', border: 'rgba(26,35,50,0.16)' },
    good:    { bg: 'rgba(47,106,58,0.14)', fg: 'var(--good)', border: 'rgba(47,106,58,0.32)' },
    warn:    { bg: 'rgba(184,114,17,0.14)', fg: 'var(--warn)', border: 'rgba(184,114,17,0.32)' },
    bad:     { bg: 'rgba(168,51,31,0.14)', fg: 'var(--bad)', border: 'rgba(168,51,31,0.32)' },
    accent:  { bg: 'rgba(193,80,28,0.14)', fg: 'var(--accent)', border: 'rgba(193,80,28,0.32)' },
  }[tone];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      background: palette.bg, color: palette.fg,
      border: `1px solid ${palette.border}`,
      fontSize: 10.5, fontWeight: 500,
      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>{children}</span>
  );
}

export function Button(props: {
  onClick?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  small?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
  ariaLabel?: string;
  title?: string;
}) {
  const bg = props.danger ? 'var(--bad)' : props.primary ? 'var(--text)' : 'transparent';
  const fg = props.danger ? 'var(--panel)' : props.primary ? 'var(--panel)' : 'var(--text)';
  const border = `1px solid ${props.danger ? 'var(--bad)' : 'var(--text)'}`;
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      title={props.title}
      style={{
        padding: props.small ? '4px 10px' : '8px 14px',
        background: bg, color: fg, border,
        borderRadius: 4,
        fontSize: props.small ? 10.5 : 12,
        fontWeight: 500,
        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
        textTransform: 'uppercase', letterSpacing: '0.06em',
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.45 : 1,
        ...(props.style ?? {}),
      }}
    >{props.children}</button>
  );
}

export function TextInput(props: { value: string; onChange: (v: string) => void; placeholder?: string; onSubmit?: () => void; ariaLabel?: string }) {
  return (
    <input
      value={props.value}
      onChange={e => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      onKeyDown={e => { if (e.key === 'Enter' && props.onSubmit) props.onSubmit(); }}
      style={{
        flex: 1, padding: '8px 12px',
        background: 'var(--panel)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 4,
        fontSize: 13,
      }}
    />
  );
}

export function Header({ session, onLogout, transport }: { session: { role: string; name: string; webId: string }; onLogout: () => void; transport: 'bridge' | 'sample' | 'probing' }) {
  return (
    <header style={{
      padding: '14px 24px',
      background: 'var(--text)',
      color: 'var(--panel)',
      borderBottom: `3px solid var(--accent)`,
      display: 'flex', alignItems: 'center', gap: 16,
      position: 'sticky', top: 0, zIndex: 50,
    }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12, letterSpacing: '0.16em',
        color: 'var(--accent)', textTransform: 'uppercase',
      }}>Foxxi</div>
      <div style={{
        fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
        color: 'var(--panel)', fontSize: 18,
      }}>Interego-grounded L&amp;D</div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        <TransportPill transport={transport} />
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 12px', borderRadius: 18,
          background: 'rgba(245, 239, 226, 0.08)',
          border: '1px solid rgba(193, 80, 28, 0.4)',
        }}>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'var(--accent)', fontWeight: 600,
          }}>{session.role}</span>
          <span style={{
            fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
            fontSize: 15, color: 'var(--panel)',
          }}>{session.name}</span>
        </div>
        <button
          onClick={onLogout}
          aria-label="Sign out"
          title={`Sign out ${session.name}`}
          style={{
            font: 'inherit', fontSize: 13, fontWeight: 600,
            padding: '7px 16px', borderRadius: 4,
            border: '1px solid var(--accent)',
            background: 'var(--accent)', color: 'white',
            cursor: 'pointer',
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          Sign out ↗
        </button>
      </div>
    </header>
  );
}

function TransportPill({ transport }: { transport: 'bridge' | 'sample' | 'probing' }) {
  const label = transport === 'bridge' ? '● live bridge' : transport === 'sample' ? '● offline sample' : '● probing…';
  const color = transport === 'bridge' ? '#7fd693' : transport === 'sample' ? '#f3c267' : '#bdb8a7';
  return (
    <span style={{
      fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
      letterSpacing: '0.06em', color,
      border: `1px solid ${color}`, padding: '2px 8px', borderRadius: 999,
    }}>{label}</span>
  );
}

/**
 * Modal wrapper that closes on ESC + backdrop click. Used by detail modals,
 * the LLM settings dialog, the concept-network legend, etc.
 */
export function Modal({ title, onClose, children, width = 720 }: {
  title?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" style={{
      position: 'fixed', inset: 0,
      background: 'rgba(26,35,50,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, zIndex: 1000,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: width, maxHeight: '90vh', overflow: 'auto',
        background: 'var(--panel)', border: '1px solid var(--border)',
        borderRadius: 6, boxShadow: 'var(--shadow)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
        }}>
          {title && (
            <div style={{
              fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
              fontSize: 20, fontWeight: 500, color: 'var(--text)',
            }}>{title}</div>
          )}
          <button onClick={onClose} aria-label="Close dialog" style={{
            marginLeft: 'auto', background: 'transparent', border: 'none',
            cursor: 'pointer', fontSize: 18, color: 'var(--text-dim)',
            padding: 4,
          }}>✕</button>
        </div>
        <div style={{ padding: '16px 18px' }}>{children}</div>
      </div>
    </div>
  );
}

/**
 * Two-column label/value row used inside detail modals.
 */
export function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '130px 1fr', gap: 12,
      padding: '6px 0', alignItems: 'baseline',
      borderBottom: '1px dashed var(--border)',
    }}>
      <div className="label">{label}</div>
      <div style={{ fontSize: 14 }}>{value}</div>
    </div>
  );
}

/**
 * Big numeric stat strip cell. Used in the learner course view top strip.
 */
export function Stat({ label, value, tone = 'default' }: { label: string; value: React.ReactNode; tone?: 'default' | 'accent' }) {
  return (
    <div style={{
      borderTop: '2px solid var(--text)',
      borderBottom: '1px solid var(--border)',
      padding: '10px 4px',
    }}>
      <div className="label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 22, fontWeight: 600,
        color: tone === 'accent' ? 'var(--accent)' : 'var(--text)',
      }}>{value}</div>
    </div>
  );
}
