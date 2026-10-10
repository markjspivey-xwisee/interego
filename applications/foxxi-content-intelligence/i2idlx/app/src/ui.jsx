// Shared components: concept chips with hover previews, buttons, popovers, modals, toasts, code blocks.
import { Icon } from "./icons.jsx";
import { byId, kindById, fieldById, typeById, RIGHTS, iriOf } from "./data.js";
import { cx, copyText, initials, useOutside } from "./util.js";

const { createContext, useContext, useEffect, useRef, useState, useCallback, useLayoutEffect } = React;

export const UI = createContext(null);
export const useUI = () => useContext(UI);

// ── Toasts ──────────────────────────────────────────────────────────────────────────────────────
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((msg, opts = {}) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-2), { id, msg, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.ms || 3200);
  }, []);
  const view = (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          {t.icon ? <Icon name={t.icon} /> : null}
          <span className="grow">{t.msg}</span>
          {t.action ? <button className="btn sm" onClick={t.action.run}>{t.action.label}</button> : null}
        </div>
      ))}
    </div>
  );
  return [toast, view];
}

// ── Hover previews ──────────────────────────────────────────────────────────────────────────────
export function useHoverCards() {
  const [card, setCard] = useState(null);
  const timer = useRef(null);
  const over = useRef(false);
  const show = useCallback((id, el) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!el || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      setCard({ id, r });
    }, 380);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (!over.current) setCard(null); }, 140);
  }, []);
  const now = useCallback(() => { clearTimeout(timer.current); setCard(null); }, []);
  useEffect(() => {
    const off = () => now();
    window.addEventListener("hashchange", off);
    window.addEventListener("scroll", off, true);
    return () => { window.removeEventListener("hashchange", off); window.removeEventListener("scroll", off, true); };
  }, [now]);
  const view = card ? (
    <HoverCard id={card.id} r={card.r} onEnter={() => { over.current = true; clearTimeout(timer.current); }}
      onLeave={() => { over.current = false; hide(); }} />
  ) : null;
  return [{ show, hide, now }, view];
}

function HoverCard({ id, r, onEnter, onLeave }) {
  const c = byId.get(id);
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, hgt = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = Math.min(Math.max(8, r.left), vw - w - 8);
    let top = r.bottom + 8;
    if (top + hgt > vh - 8) top = Math.max(8, r.top - hgt - 8);
    setPos({ left, top });
  }, [id, r]);
  if (!c) return null;
  const k = kindById.get(c.k);
  return (
    <div className="hovercard" ref={ref} style={pos} onMouseEnter={onEnter} onMouseLeave={onLeave} role="tooltip">
      <div className="hc-meta"><span className={"dot kd-" + c.k} />{k.label} · {typeById.get(c.t).label} · {fieldById.get(c.pf).label}</div>
      <h4>{c.l}</h4>
      <p>{c.d.length > 280 ? c.d.slice(0, 280).replace(/\s+\S*$/, "") + "…" : c.d}</p>
    </div>
  );
}

/** A link to an entry that previews the definition on hover. */
export function ConceptChip({ id, shared, onClick, title, children, className }) {
  const c = byId.get(id);
  const { hover } = useUI();
  const ref = useRef(null);
  if (!c) return <span className="chip soft">{id}</span>;
  return (
    <a ref={ref} className={cx("cchip", shared && "shared", className)} href={"#c-" + c.id}
      onMouseEnter={() => hover.show(c.id, ref.current)} onMouseLeave={hover.hide} onFocus={() => hover.show(c.id, ref.current)} onBlur={hover.hide}
      onClick={(e) => { hover.now(); if (onClick) { e.preventDefault(); onClick(c.id); } }} title={title}>
      <span className={"dot kd-" + c.k} aria-hidden="true" />
      <span className="lbl">{children || c.l}</span>
    </a>
  );
}

/** Inline concept reference inside running text (definitions, Ask answers). */
export function ConceptRef({ id, children, className }) {
  const c = byId.get(id);
  const { hover } = useUI();
  const ref = useRef(null);
  if (!c) return <>{children}</>;
  return (
    <a ref={ref} className={className || "hx"} href={"#c-" + c.id} onMouseEnter={() => hover.show(c.id, ref.current)} onMouseLeave={hover.hide}
      onFocus={() => hover.show(c.id, ref.current)} onBlur={hover.hide} onClick={() => hover.now()}>{children || c.l}</a>
  );
}

export const KindBadge = ({ k }) => {
  const kind = kindById.get(k);
  return <span className="chip" title={kind.def}><span className={"dot kd-" + k} />{kind.label}</span>;
};

export function ModalChip({ status, children, title }) {
  const cls = status === "Asserted" ? "asserted" : status === "Counterfactual" ? "counterfactual" : "hypothetical";
  return <span className={"chip " + cls} title={title}>{children || status}</span>;
}

export function RightsBadge({ rc, text }) {
  const r = RIGHTS[rc];
  const icon = rc === "open" ? "globe" : rc === "sharealike" ? "refresh" : rc === "nc" ? "shield" : "lock";
  return <span className={"rights " + rc} title={r.note}><Icon name={icon} />{text || r.short}</span>;
}

export const MethodTag = ({ m }) => <span className={"tag " + (m || "").toLowerCase()}>{m}</span>;

export function CopyBtn({ text, label, small, className, icon = "copy", title, onCopied }) {
  const [ok, setOk] = useState(false);
  const { toast } = useUI();
  const run = async (e) => {
    e.stopPropagation();
    const t = typeof text === "function" ? text() : text;
    const done = await copyText(t);
    if (done) { setOk(true); setTimeout(() => setOk(false), 1400); onCopied && onCopied(); }
    else toast("Couldn't reach the clipboard here. Select the text and copy it instead.", { icon: "warn" });
  };
  return (
    <button type="button" className={cx("btn", small && "sm", !label && "icon", className)} onClick={run} title={title || "Copy"} aria-label={label ? undefined : title || "Copy"}>
      <Icon name={ok ? "check" : icon} />{label ? <span>{ok ? "Copied" : label}</span> : null}
    </button>
  );
}

export function CodeBlock({ title, code, lang, actions, wrap }) {
  return (
    <div className="codeblock">
      <div className="cb-bar"><span>{title || lang}</span><span className="spacer" />{actions}<CopyBtn text={code} small label="Copy" /></div>
      <pre style={wrap ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } : undefined}><code>{code}</code></pre>
    </div>
  );
}

export function Seg({ value, onChange, options, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)} title={o.title}>
          {o.icon ? <Icon name={o.icon} /> : null}{o.l}
        </button>
      ))}
    </div>
  );
}

/** A button that opens an anchored popover. children: (close) => content */
export function PopButton({ label, icon, className, children, title, align = "left", small }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const pop = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(pop, (e) => { if (!btn.current || !btn.current.contains(e.target)) close(); }, open);
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = pop.current ? pop.current.offsetWidth : 260;
    const hgt = pop.current ? pop.current.offsetHeight : 200;
    let left = align === "right" ? r.right - w : r.left;
    left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
    setPos({ left, top });
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const k = (e) => { if (e.key === "Escape") { close(); btn.current && btn.current.focus(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, close]);
  return (
    <>
      <button ref={btn} type="button" className={cx("btn", small && "sm", className, open && "on")} aria-expanded={open} onClick={() => setOpen((o) => !o)} title={title}>
        {icon ? <Icon name={icon} /> : null}{label ? <span>{label}</span> : null}
      </button>
      {open ? <div className="pop" ref={pop} style={pos || { left: -9999, top: -9999 }}>{children(close)}</div> : null}
    </>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    const prev = document.activeElement;
    setTimeout(() => { const f = ref.current && ref.current.querySelector("input, textarea, button, select"); f && f.focus(); }, 10);
    return () => { window.removeEventListener("keydown", k); prev && prev.focus && prev.focus(); };
  }, [onClose]);
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cx("modal", wide && "wide")} ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h"><h2 className="grow">{title}</h2><button className="btn ghost icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="modal-b">{children}</div>
        {footer ? <div className="modal-f">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Avatar({ p, size = 22 }) {
  if (p && p.avatarUrl) return <img src={p.avatarUrl} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: "50%" }} />;
  return <span className="av" style={{ width: size, height: size, background: (p && p.color) || "var(--faint)" }}>{initials(p && p.name)}</span>;
}

export const Empty = ({ icon = "info", title, children }) => (
  <div className="empty"><Icon name={icon} /><div style={{ fontWeight: 700, color: "var(--ink)" }}>{title}</div>{children ? <div className="small">{children}</div> : null}</div>
);

export const Meter = ({ v, title }) => (
  <span className="meter" title={title} role="meter" aria-valuemin="0" aria-valuemax="1" aria-valuenow={v}><span style={{ width: Math.round(v * 100) + "%" }} /></span>
);

export function Section({ title, meta, children, id, actions }) {
  return (
    <section id={id} style={{ scrollMarginTop: 12 }}>
      <div className="sec-h"><h2>{title}</h2>{meta ? <span className="meta">{meta}</span> : null}<span className="spacer" />{actions}</div>
      {children}
    </section>
  );
}

export const ConceptIri = ({ id }) => <code className="iri">{iriOf(id)}</code>;
