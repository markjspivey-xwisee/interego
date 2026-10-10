// Where each thing on screen comes from. I2IDL's published record is one layer; everything else is
// labelled as I2IDL-X (derived, added or proposed), Interego, Foxxi or this page's team. The labels and
// their wording come from src/origins.json, the same source as the ontology's i2x:Origins scheme.
import { META, C, MAPPINGS, ENACTMENTS, SUGGESTIONS, ACTIONS, PORTS, QUERIES } from "./data.js";
import { Icon } from "./icons.jsx";
import { Modal, useUI } from "./ui.jsx";
import { plural } from "./util.js";

const ICONS = { i2idl: "book", derived: "layers", added: "plus", proposed: "vote", interego: "globe", foxxi: "bolt", team: "users" };
export const ORIGINS = META.origins.map((o) => ({ ...o, icon: ICONS[o.id] || "layers", where: () => o.where }));
export const originById = new Map(ORIGINS.map((o) => [o.id, o]));

/** A labelled origin pill. The label carries the meaning; colour only groups. */
export function Origin({ o, children, title, quiet }) {
  const x = originById.get(o);
  const { layers } = useUI() || {};
  const tip = title || `${x.label}: ${x.trust} ${x.where()}`;
  return (
    <button type="button" className={"origin o-" + o + (quiet ? " quiet" : "")} title={tip} onClick={(e) => { e.stopPropagation(); layers && layers.open(o); }}>
      <Icon name={x.icon} size={11} /><span>{children || x.label}</span>
    </button>
  );
}

/** Heading for a zone of the page that belongs to one layer. */
export function ZoneHead({ o, title, sub, right }) {
  return (
    <div className={"zone-head o-" + o}>
      <div className="zt"><Origin o={o} /><h2>{title}</h2></div>
      {sub ? <div className="zs">{sub}</div> : null}
      {right ? <div className="zr">{right}</div> : null}
    </div>
  );
}

/** "On this view:" a strip of the layers a view shows. */
export function OriginStrip({ items, note }) {
  const { layers } = useUI() || {};
  return (
    <div className="ostrip" role="note">
      <span className="tiny muted">On this view</span>
      {items.map(([o, txt]) => <Origin key={o + (txt || "")} o={o} quiet>{txt || originById.get(o).label}</Origin>)}
      {note ? <span className="tiny muted">{note}</span> : null}
      <span className="spacer" />
      <button className="btn ghost sm" onClick={() => layers && layers.open()}><Icon name="layers" />What's whose?</button>
    </div>
  );
}

/** Global lens: the I2IDL record alone, or with everything I2IDL-X layers on top. */
export function LensToggle({ lens, setLens }) {
  return (
    <div className="lens" role="group" aria-label="Lens">
      <button type="button" aria-pressed={lens === "i2idl"} onClick={() => setLens("i2idl")} title="Show only what I2IDL publishes">I2IDL only</button>
      <button type="button" aria-pressed={lens === "x"} onClick={() => setLens("x")} title="Show I2IDL with the I2IDL-X, Interego and Foxxi layers">+ I2IDL-X</button>
    </div>
  );
}

const COUNTS = () => {
  const fox = Object.values(ACTIONS).filter((a) => a.sys !== "relay").length;
  return [
    ["i2idl", `${C.length} concepts · ${META.counts.evidence} evidence records · ${META.counts.related} related and ${META.counts.broader} broader pairs · ${META.counts.sources} sources`],
    ["derived", `${C.length} provenance lines · ${META.counts.links} in-text links · ${SUGGESTIONS.length} unlinked mentions · ${META.changes.facts.toLocaleString()} changes since ${META.changes.baseline}`],
    ["added", `${C.filter((c) => c.spec).length} specification links · ${C.filter((c) => c.exm).length} exemplars`],
    ["proposed", `${ENACTMENTS.length} enactments · ${MAPPINGS.length} crosswalks (${META.counts.unesco} to UNESCO terms I2IDL itself cites) · ${META.counts.roleCaps} role capabilities`],
    ["interego", `${META.graphs.length} signed graphs · ${PORTS.length} catalog controls · ${QUERIES.length} stored queries · ${Object.values(ACTIONS).filter((a) => a.sys === "relay").length} relay operations`],
    ["foxxi", `${fox} live bridge affordances · xAPI tagging · course alignment`],
    ["team", "Votes · notes · usage marks · your packs"],
  ];
};

export function LayersModal({ focus, onClose }) {
  const counts = new Map(COUNTS());
  return (
    <Modal title="What's whose" onClose={onClose} wide>
      <div className="stack" style={{ gap: 14 }}>
        <p className="small">Everything on this page carries one of these labels. <b>I2IDL</b> is the glossary exactly as I2IDL publishes it. Everything else is a layer on top, kept separate on purpose: it never restates or edits I2IDL's record, and anything that makes a claim I2IDL hasn't made is published <i>Hypothetical</i> until reviewers ratify it.</p>
        <div className="layers-legend">
          {ORIGINS.map((o) => (
            <div key={o.id} className={"ll-row o-" + o.id + (focus === o.id ? " focus" : "")}>
              <div className="ll-h"><Origin o={o.id} /></div>
              <div className="ll-b">
                <p>{o.what}</p>
                <div className="tiny muted"><b>Lives at</b> {o.where()} · <b>Status</b> {o.trust}</div>
                {counts.get(o.id) ? <div className="tiny ll-n">{counts.get(o.id)}</div> : null}
              </div>
            </div>
          ))}
        </div>
        <p className="tiny muted">Switch the lens in the top bar to <b>I2IDL only</b> to see the published record with every layer hidden. Agents get the same labels: they are published in the I2IDL-X ontology as <a href={META.ns + "Origins"} target="_blank" rel="noopener">i2x:Origins</a>, each naming the graphs that hold it.</p>
      </div>
    </Modal>
  );
}
