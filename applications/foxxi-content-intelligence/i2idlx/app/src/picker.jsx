// A search-as-you-type concept picker (keyboard: ↑ ↓ Enter Esc).
import { byId } from "./data.js";
import { search } from "./search.js";
import { Icon } from "./icons.jsx";
import { HL } from "./text.jsx";
import { useOutside } from "./util.js";

const { useState, useRef, useLayoutEffect } = React;

export function ConceptPicker({ value, onPick, placeholder = "Find a term…", exclude = [], autoFocus, clearOnPick, small }) {
  const c = value ? byId.get(value) : null;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [pos, setPos] = useState(null);
  const box = useRef(null);
  const pop = useRef(null);
  useOutside(box, () => setOpen(false), open);
  const ex = new Set(exclude);
  const res = q.trim() ? search(q, 20).filter((r) => !ex.has(r.c.id)).slice(0, 8) : [];
  useLayoutEffect(() => {
    if (!open || !box.current || !pop.current) return;
    const anchor = box.current, popup = pop.current, viewport = window.visualViewport;
    let active = true;
    const place = () => {
      if (!active || box.current !== anchor || pop.current !== popup || !anchor.isConnected || !popup.isConnected) return;
      const r = anchor.getBoundingClientRect(), margin = 12, gap = 4;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const popupWidth = Math.min(Math.max(r.width, 260), Math.max(0, width - margin * 2));
      const below = Math.max(0, top + height - r.bottom - gap - margin);
      const above = Math.max(0, r.top - top - gap - margin);
      const desired = popup.scrollHeight + 2;
      const up = below < Math.min(desired, 160) && above > below;
      const maxHeight = Math.max(40, Math.min(height * .6, height - margin * 2, up ? above : below));
      const popupHeight = Math.min(desired, maxHeight);
      setPos({
        left: Math.max(left + margin, Math.min(r.left, left + width - popupWidth - margin)),
        top: Math.max(top + margin, Math.min(up ? r.top - gap - popupHeight : r.bottom + gap, top + height - popupHeight - margin)),
        width: popupWidth, maxHeight,
      });
    };
    place();
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    resize?.observe(popup);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      active = false;
      resize?.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [open, q, pos?.width]);
  const pick = (id) => {
    onPick(id);
    setOpen(false);
    setQ(clearOnPick ? "" : "");
  };
  return (
    <div ref={box} style={{ position: "relative", minWidth: 0 }}>
      <div className="row" style={{ gap: 6 }}>
        <input className={"input" + (small ? " sm" : "")} value={open || !c ? q : c.l} placeholder={c && !open ? c.l : placeholder} autoFocus={autoFocus}
          onFocus={() => { setOpen(true); setQ(""); }} onChange={(e) => { setQ(e.target.value); setOpen(true); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(res.length - 1, x + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
            if (e.key === "Enter" && res[i]) { e.preventDefault(); pick(res[i].c.id); e.target.blur(); }
            if (e.key === "Escape") { setOpen(false); e.target.blur(); }
          }} aria-label={placeholder} role="combobox" aria-expanded={open && res.length > 0} />
      </div>
      {open && res.length ? (
        <div className="pop" ref={pop} style={pos ? { ...pos, minWidth: 0, maxWidth: "calc(100vw - 24px)" } : { left: -9999 }} role="listbox">
          {res.map((r, k) => (
            <button key={r.c.id} className={"opt" + (k === i ? " on" : "")} role="option" aria-selected={k === i} onMouseDown={(e) => { e.preventDefault(); pick(r.c.id); }}>
              <span className={"dot kd-" + r.c.k} /><span className="grow"><HL text={r.c.l} q={q} /></span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function PickedConcept({ id, onClear }) {
  const c = byId.get(id);
  if (!c) return null;
  return <span className="chip"><span className={"dot kd-" + c.k} />{c.l}{onClear ? <button className="btn ghost sm icon" style={{ height: 18, width: 18 }} onClick={onClear} aria-label="Remove"><Icon name="x" size={12} /></button> : null}</span>;
}
