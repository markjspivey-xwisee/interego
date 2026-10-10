// Packs: build a course glossary from any terms — order, notes, smart suggestions, rights check, exports.
import { C, META, COLLECTIONS, KINDS, byId, indexOf, kindById, fieldById, reuseClass, RIGHTS, curatedById } from "../data.js";
import { useCaps } from "../caps.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, CopyBtn, Seg, Modal, RightsBadge, useUI } from "../ui.jsx";
import { ConceptPicker } from "../picker.jsx";
import { newPack, addToPack, suggestForPack, rightsSummary } from "../lib.js";
import { FORMATS, render, filenameFor } from "../exports.js";
import { XapiModal } from "./entry.jsx";
import { cx, go, plural, encodeIdx, decodeIdx, slugify, useStored } from "../util.js";

import { OriginStrip } from "../origin.jsx";
const { useState, useMemo, useEffect } = React;

export function Packs({ route }) {
  const { ws, updateWs, wsSource, signedIn } = useCaps();
  const { toast } = useUI();
  const packs = ws.packs;
  const shared = route.shared != null ? decodeShared(route.shared) : null;
  const cur = shared ? null : packs.find((p) => p.id === route.id) || packs[0] || null;
  const setPack = (p) => updateWs((w) => ({ packs: w.packs.map((x) => (x.id === p.id ? { ...p, updated: Date.now() } : x)) }));
  const create = () => {
    const p = newPack("Untitled pack");
    updateWs((w) => ({ packs: [p, ...w.packs] }));
    go("packs-" + p.id);
  };
  return (
    <div className="page">
      <div className="pk">
        <aside className="stack" style={{ gap: 10 }}>
          <div className="row"><h1 className="h-display grow" style={{ fontSize: 24 }}>Packs</h1><button className="btn sm primary" onClick={create}><Icon name="plus" />New</button></div>
          <p className="small muted">Course glossaries you build from the release. {wsSource === "sandbox" ? "Packs here belong to this run's sandbox." : signedIn ? "Saved privately to your account." : "Saved in this browser; sign in to keep them with your account."}</p>
          <OriginStrip items={[["i2idl", "definitions and attribution"], ["team", "your packs"]]} />
          <div className="pklist">
            {packs.map((p) => (
              <button key={p.id} className="pkitem" aria-current={cur && cur.id === p.id} onClick={() => go("packs-" + p.id)}>
                <span className="t">{p.name}</span><span className="small muted">{plural(p.items.length, "term")}{p.audience ? " · " + p.audience : ""}</span>
              </button>
            ))}
            {!packs.length ? <div className="small muted">{wsSource === "pending" ? "Loading your packs…" : "No packs yet."}</div> : null}
          </div>
          <StarterPacks onMake={(name, ids) => { const p = newPack(name, ids); updateWs((w) => ({ packs: [p, ...w.packs] })); go("packs-" + p.id); toast(`Created “${name}”`, { icon: "pack" }); }} />
        </aside>
        {shared ? <SharedPack s={shared} /> : cur ? <PackEditor key={cur.id} pack={cur} setPack={setPack} /> : (
          <div className="empty" style={{ gridColumn: "span 2" }}><Icon name="pack" /><div><b>Make your first pack</b></div>
            <div className="small">Pick terms from any entry (“Add to pack”), or start from a field or collection on the left.</div>
            <button className="btn primary" onClick={create}><Icon name="plus" />New pack</button></div>
        )}
      </div>
    </div>
  );
}

function StarterPacks({ onMake }) {
  const [src, setSrc] = useState("");
  const opts = [
    ...COLLECTIONS.curated.map((c) => ({ v: "cu." + c.id, l: c.label, ids: C.filter((x) => x.cu.includes(c.id)).map((x) => x.id) })),
    ...COLLECTIONS.field.map((f) => ({ v: "f." + f.id, l: f.label, ids: C.filter((x) => x.pf === f.id).map((x) => x.id) })),
    ...KINDS.map((k) => ({ v: "k." + k.id, l: k.label + " concepts", ids: C.filter((x) => x.k === k.id).map((x) => x.id) })),
  ];
  const o = opts.find((x) => x.v === src);
  return (
    <div className="card pad stack" style={{ gap: 8 }}>
      <b className="small">Start from a collection</b>
      <select className="select" value={src} onChange={(e) => setSrc(e.target.value)}>
        <option value="">Choose…</option>
        <optgroup label="Curated">{opts.filter((x) => x.v.startsWith("cu.")).map((x) => <option key={x.v} value={x.v}>{x.l} ({x.ids.length})</option>)}</optgroup>
        <optgroup label="Fields (primary)">{opts.filter((x) => x.v.startsWith("f.")).map((x) => <option key={x.v} value={x.v}>{x.l} ({x.ids.length})</option>)}</optgroup>
        <optgroup label="Kinds">{opts.filter((x) => x.v.startsWith("k.")).map((x) => <option key={x.v} value={x.v}>{x.l} ({x.ids.length})</option>)}</optgroup>
      </select>
      <button className="btn sm" disabled={!o} onClick={() => o && onMake(o.l, o.ids)}>Create pack</button>
    </div>
  );
}

function PackEditor({ pack, setPack }) {
  const { updateWs } = useCaps();
  const { toast } = useUI();
  const [xapi, setXapi] = useState(false);
  const ids = pack.items.map((i) => i.id);
  const sugg = useMemo(() => suggestForPack(pack, 10), [ids.join("|")]);
  const move = (i, d) => {
    const items = [...pack.items];
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    setPack({ ...pack, items });
  };
  const sortAZ = () => setPack({ ...pack, items: [...pack.items].sort((a, b) => byId.get(a.id).l.localeCompare(byId.get(b.id).l)) });
  const remove = (id) => setPack({ ...pack, items: pack.items.filter((x) => x.id !== id) });
  const setNote = (id, note) => setPack({ ...pack, items: pack.items.map((x) => (x.id === id ? { ...x, note } : x)) });
  const del = () => {
    if (!confirmDelete(pack)) { toast("Click Delete again to remove this pack", { icon: "warn" }); return; }
    updateWs((w) => ({ packs: w.packs.filter((x) => x.id !== pack.id) }));
    go("packs");
    toast(`Deleted “${pack.name}”`, { icon: "trash" });
  };
  const shareCode = `pk-${slugify(pack.name)}~${encodeIdx(ids.map((id) => indexOf.get(id)))}`;
  return (
    <>
      <div className="stack" style={{ gap: 14, minWidth: 0 }}>
        <div className="card pad stack" style={{ gap: 10 }}>
          <input className="input" style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 600, height: 44 }} value={pack.name} onChange={(e) => setPack({ ...pack, name: e.target.value })} aria-label="Pack name" />
          <div className="qparams">
            <label className="field"><span>Description</span><input className="input" value={pack.desc} onChange={(e) => setPack({ ...pack, desc: e.target.value })} placeholder="What this glossary is for" /></label>
            <label className="field"><span>Audience</span><input className="input" value={pack.audience} onChange={(e) => setPack({ ...pack, audience: e.target.value })} placeholder="e.g. new instructional designers" /></label>
          </div>
          <div className="row wrap">
            <div style={{ flex: "1 1 260px" }}><ConceptPicker placeholder="Add a term…" exclude={ids} onPick={(id) => setPack(addToPack(pack, [id]))} clearOnPick /></div>
            <button className="btn sm" onClick={sortAZ} disabled={ids.length < 2}>Sort A–Z</button>
            <CopyBtn small label="Share link" icon="link" title="Anyone with access to this page can open it" text={() => (window.__APP_URL__ ? window.__APP_URL__ + "#" + shareCode : "#" + shareCode)} />
            <button className="btn sm ghost" onClick={del}><Icon name="trash" />Delete</button>
          </div>
        </div>
        {sugg.length ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row"><span className="eyebrow grow">Often taught together</span><button className="btn ghost sm" onClick={() => setPack(addToPack(pack, sugg.map((s) => s.id)))}>Add all</button></div>
            <div className="chips">{sugg.map((s) => (
              <button key={s.id} className="chip" onClick={() => setPack(addToPack(pack, [s.id]))} title={`Linked to ${s.s} term${s.s > 1 ? "s" : ""} in this pack`}>
                <Icon name="plus" size={12} /><span className={"dot kd-" + byId.get(s.id).k} />{byId.get(s.id).l}</button>
            ))}</div>
          </div>
        ) : null}
        <div className="pkterms">
          {pack.items.map((it, i) => {
            const c = byId.get(it.id);
            if (!c) return null;
            return (
              <div className="pkterm" key={it.id}>
                <span className="n">{i + 1}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="row"><span className={"dot kd-" + c.k} /><a className="t" href={"#c-" + c.id} style={{ color: "inherit" }}>{c.l}</a>
                    {reuseClass(c) === "nc" || reuseClass(c) === "permission" ? <RightsBadge rc={reuseClass(c)} /> : null}</div>
                  <div className="d">{c.d}</div>
                  <textarea className="textarea" rows={1} value={it.note} placeholder="Course note (optional): how you use it, an example…" onChange={(e) => setNote(it.id, e.target.value)} />
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <button className="btn sm icon ghost" onClick={() => move(i, -1)} disabled={!i} aria-label="Move up"><Icon name="up" /></button>
                  <button className="btn sm icon ghost" onClick={() => move(i, 1)} disabled={i === pack.items.length - 1} aria-label="Move down"><Icon name="down" /></button>
                  <button className="btn sm icon ghost" onClick={() => remove(it.id)} aria-label="Remove"><Icon name="x" /></button>
                </div>
              </div>
            );
          })}
          {!pack.items.length ? <div className="empty"><Icon name="plus" /><div><b>No terms yet</b></div><div className="small">Add terms above or with “Add to pack” on any entry.</div></div> : null}
        </div>
      </div>
      <ExportPanel pack={pack} onXapi={() => setXapi(true)} />
      {xapi ? <XapiModal ids={ids} onClose={() => setXapi(false)} /> : null}
    </>
  );
}

function confirmDelete(pack) {
  // no browser dialogs inside the viewer: a second click within 4s confirms
  const k = "__del_" + pack.id;
  if (window[k] && Date.now() - window[k] < 4000) return true;
  window[k] = Date.now();
  return false;
}

function ExportPanel({ pack, onXapi }) {
  const { save, downloads } = useCaps();
  const { toast } = useUI();
  const [fmt, setFmt] = useStored("pk.fmt", "html");
  const [notes, setNotes] = useStored("pk.notes", true);
  const [sources, setSources] = useStored("pk.sources", true);
  const [courseBase, setCourseBase] = useStored("pk.courseBase", "");
  const out = useMemo(() => render(fmt, pack, { notes, sources, courseBase }), [fmt, pack, notes, sources, courseBase]);
  const rs = rightsSummary(pack.items.map((i) => byId.get(i.id)).filter(Boolean));
  const restricted = [...rs.nc, ...rs.permission];
  const dl = async () => {
    try { await save(filenameFor(pack, fmt), out); toast("Saved " + filenameFor(pack, fmt), { icon: "download" }); }
    catch (e) { if (e && e.code !== "declined") toast("Saving isn't available here — use Copy instead.", { icon: "warn" }); }
  };
  return (
    <aside className="stack" style={{ gap: 12, minWidth: 0 }}>
      <div className="card pad stack" style={{ gap: 10 }}>
        <b>Export</b>
        <div className="chips">{FORMATS.map((f) => <button key={f.id} className={cx("chip", fmt === f.id && "accent")} onClick={() => setFmt(f.id)} title={f.desc}>{f.label}</button>)}</div>
        <div className="small muted">{FORMATS.find((f) => f.id === fmt).desc}</div>
        {fmt === "html" || fmt === "md" || fmt === "csv" ? (
          <div className="row wrap small">
            <label className="check"><input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />Editorial notes</label>
            {fmt !== "csv" ? <label className="check"><input type="checkbox" checked={sources} onChange={(e) => setSources(e.target.checked)} />Sources</label> : null}
          </div>
        ) : null}
        {fmt === "align" ? <label className="field"><span>Course base IRI</span><input className="input sm" value={courseBase} onChange={(e) => setCourseBase(e.target.value)} placeholder="urn:foxxi:course:intro-to-xapi" /></label> : null}
        <div className="row wrap">
          {downloads ? <button className="btn sm primary" onClick={dl} disabled={!pack.items.length}><Icon name="download" />Save {filenameFor(pack, fmt).split(".").slice(1).join(".")}</button> : null}
          <CopyBtn small label="Copy" text={out} />
          {fmt === "xapi" ? <button className="btn sm" onClick={onXapi}><Icon name="code" />Statement builder</button> : null}
        </div>
        <div className="preview">{fmt === "html" ? <iframe title="Handout preview" sandbox="" srcDoc={out} /> : <pre>{out.length > 6000 ? out.slice(0, 6000) + "\n…" : out}</pre>}</div>
      </div>
      <div className="card pad stack" style={{ gap: 8 }}>
        <b className="small">Rights check</b>
        <div className="small">{Object.entries(rs).filter(([, l]) => l.length).map(([k, l]) => <div key={k} className="row"><RightsBadge rc={k} text={RIGHTS[k].label} /><span className="grow" /><span className="num">{l.length}</span></div>)}</div>
        {restricted.length ? <div className="note warn"><Icon name="warn" /><span className="small">{plural(restricted.length, "definition")} rest directly on non-commercial or permission-only sources ({restricted.slice(0, 4).map((c) => c.l).join(", ")}{restricted.length > 4 ? "…" : ""}). Check the source terms before commercial reuse. Attribution for every source is added to each export.</span></div>
          : <div className="small muted">Every definition here rests on openly licensed sources or on I2IDL's own CC BY 4.0 text. Attribution is added to each export.</div>}
      </div>
    </aside>
  );
}

function decodeShared(s) {
  const [slug, code] = (s || "").split("~");
  const ids = decodeIdx(code).map((i) => C[i]).filter(Boolean).map((c) => c.id);
  return { name: (slug || "shared pack").replace(/-/g, " ").replace(/^\w/, (m) => m.toUpperCase()), ids };
}

function SharedPack({ s }) {
  const { updateWs } = useCaps();
  const { toast } = useUI();
  const keep = () => {
    const p = newPack(s.name, s.ids);
    updateWs((w) => ({ packs: [p, ...w.packs] }));
    toast(`Saved “${s.name}” to your packs`, { icon: "pack" });
    go("packs-" + p.id);
  };
  return (
    <div className="stack" style={{ gap: 12, gridColumn: "span 2" }}>
      <div className="card pad stack" style={{ gap: 8 }}>
        <div className="eyebrow">Shared pack</div>
        <h2 className="serif" style={{ fontSize: 26 }}>{s.name}</h2>
        <div className="row wrap"><span className="small muted grow">{plural(s.ids.length, "term")}</span><button className="btn primary sm" onClick={keep}><Icon name="plus" />Save to my packs</button></div>
      </div>
      <div className="pkterms">
        {s.ids.map((id, i) => {
          const c = byId.get(id);
          return <div className="pkterm" key={id}><span className="n">{i + 1}</span><div><a className="t" href={"#c-" + id} style={{ color: "inherit" }}>{c.l}</a><div className="d">{c.d}</div></div><span /></div>;
        })}
      </div>
    </div>
  );
}
