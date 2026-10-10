// Small helpers shared by every view.
/* global React */
const { useState, useEffect, useRef, useCallback, useContext, createContext } = React;

export const cx = (...a) => a.filter(Boolean).join(" ");
export const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + "s"}`;
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return iso; }
};
export function ago(ts) {
  if (!ts) return "";
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}
export const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ── Routing: bare #anchor tokens only (letters, digits, . _ ~ -) ────────────────────────────────
export function parseHash(h) {
  const s = (h || "").replace(/^#/, "");
  if (!s || s === "home") return { view: "home" };
  const m = s.match(/^([a-z]+)(?:-(.*))?$/);
  if (!m) return { view: "home" };
  const [, head, rest] = m;
  switch (head) {
    case "c": return { view: "lexicon", id: rest };
    case "browse": return { view: "lexicon", filter: rest || null };
    case "map": return { view: "map", mode: rest ? "neighborhood" : "whole", id: rest || null };
    case "whole": return { view: "map", mode: "whole", id: rest || null };
    case "path": { const [a, b] = (rest || "").split("~"); return { view: "map", mode: "path", a, b }; }
    case "cmp": return { view: "compare", ids: (rest || "").split("~").filter(Boolean) };
    case "review": return { view: "review", key: rest || null };
    case "packs": return { view: "packs", id: rest || null };
    case "pk": return { view: "packs", shared: rest || "" };
    case "insights": return { view: "insights", section: rest || null };
    case "agents": return { view: "agents", section: rest || null };
    case "ask": return { view: "ask" };
    case "for": return { view: "fori2idl", section: rest || null };
    case "annotate": return { view: "annotate" };
    case "semantic": return { view: "semantic", section: rest || null };
    case "orchestrate": return { view: "orchestrate" };
    default: return { view: "home" };
  }
}
// A view embedded in another (the workbench pane beside an orchestrated run) routes inside its frame:
// while the viewer is working in that frame, go() navigates the frame instead of the page.
let routeTarget = null;
export const setRouteTarget = (fn) => { routeTarget = fn; };
export const go = (hash) => {
  const h = hash.startsWith("#") ? hash : "#" + hash;
  if (routeTarget) return routeTarget(h);
  if (location.hash === h) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = h;
};
export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

// ── Browser storage: per-viewer conveniences only (always wrapped) ──────────────────────────────
export const store = {
  get(k, d) { try { const v = localStorage.getItem("interpretant:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("interpretant:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
// Inside a StoreScope (an embedded workbench), per-viewer state lives in that scope instead of browser
// storage, so a view driven by agents never overwrites the viewer's own filters, drafts or tabs — and the
// scope's owner can set a value (a search, a playground's text) that every view using that key shows.
export const StoreScope = createContext(null);
export function makeScope(initial = {}) {
  const m = new Map(Object.entries(initial));
  const subs = new Map();
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => { m.set(k, v); for (const f of subs.get(k) || []) f(v); },
    subscribe: (k, f) => { const s = subs.get(k) || subs.set(k, new Set()).get(k); s.add(f); return () => s.delete(f); },
  };
}
export function useStored(key, initial) {
  const scope = useContext(StoreScope);
  const [v, setV] = useState(() => (scope ? scope.get(key, initial) : store.get(key, initial)));
  useEffect(() => (scope ? scope.subscribe(key, setV) : undefined), [scope, key]);
  const set = useCallback((nv) => {
    if (scope) { scope.set(key, typeof nv === "function" ? nv(scope.get(key, initial)) : nv); return; }
    setV((old) => { const x = typeof nv === "function" ? nv(old) : nv; store.set(key, x); return x; });
  }, [key, scope]);
  return [v, set];
}

/** Set by the orchestration pane: {embedded, bridges}. Views read it to skip page-wide keys and side effects. */
export const Drive = createContext(null);
export const useDrive = () => useContext(Drive);

// ── Clipboard ───────────────────────────────────────────────────────────────────────────────────
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function useOutside(ref, onOutside, active = true) {
  useEffect(() => {
    if (!active) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onOutside(e); };
    document.addEventListener("pointerdown", h, true);
    return () => document.removeEventListener("pointerdown", h, true);
  }, [ref, onOutside, active]);
}

export function useMedia(q) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [q]);
  return m;
}

export const isTyping = (e) => {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

// Compact share codes: a list of concept indexes in base36, dot-separated (bare-anchor safe).
export const encodeIdx = (nums) => nums.map((n) => n.toString(36)).join(".");
export const decodeIdx = (s) => (s || "").split(".").filter(Boolean).map((x) => parseInt(x, 36)).filter((n) => Number.isFinite(n));

export function usePrevious(v) {
  const r = useRef();
  useEffect(() => { r.current = v; });
  return r.current;
}

export const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const ttlStr = (s) => '"' + String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
export const csvCell = (s) => { const v = String(s ?? ""); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
export const slugify = (s) => norm2(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "pack";
const norm2 = (s) => (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
