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
    if (!open || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 260) });
  }, [open, q]);
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
        <div className="pop" ref={pop} style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxWidth: "calc(100vw - 24px)" } : { left: -9999 }} role="listbox">
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
