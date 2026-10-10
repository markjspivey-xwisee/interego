// Annotate: paste any text and see every I2IDL term in it, linked to its entry and IRI — then turn the
// set into a pack, xAPI concept tags, or Markdown with links.
import { C, META, FORMS, byId, iriOf } from "../data.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, ConceptRef, CopyBtn, useUI } from "../ui.jsx";
import { OriginStrip } from "../origin.jsx";
import { AddToPack, XapiModal } from "./entry.jsx";
import { useStored, plural } from "../util.js";
import { annotate } from "../annotate.js";

const { useState, useMemo } = React;

const EXAMPLE = "Our learning engineering team is rebuilding the onboarding course. Each activity will send xAPI statements to a Learning Record Store (LRS), and a competency framework will drive adaptive learning. We will run A/B testing on two feedback designs, review data privacy with the institution, and release the materials as open educational resources (OER). Instructors plan to use formative assessment and spaced repetition, and learners who finish can earn a digital credential.";
const MAX = 60000;

export function Annotate() {
  const [text, setText] = useStored("annotate.text", "");
  const [weak, setWeak] = useStored("annotate.weak", false);
  const [xapi, setXapi] = useState(false);
  const { ask } = useUI();
  const t = text.slice(0, MAX);
  const spans = useMemo(() => annotate(t, weak), [t, weak]);
  const found = useMemo(() => {
    const m = new Map();
    for (const [a, b, ci] of spans) {
      const id = C[ci].id;
      if (!m.has(id)) m.set(id, { id, n: 0, first: a, forms: new Set() });
      const r = m.get(id); r.n++; r.forms.add(t.slice(a, b));
    }
    return [...m.values()].sort((x, y) => x.first - y.first);
  }, [spans]);
  const ids = found.map((f) => f.id);
  const markdown = () => {
    let out = "", at = 0;
    for (const [a, b, ci] of spans) { out += t.slice(at, a) + `[${t.slice(a, b)}](${iriOf(C[ci].id)})`; at = b; }
    return out + t.slice(at) + `\n\n— Terms linked to the ${META.scheme.title} (${META.release}), CC BY 4.0 I2IDL.\n`;
  };
  return (
    <div className="page an">
      <div className="stack" style={{ gap: 6 }}>
        <div className="eyebrow">Annotate</div>
        <h1 className="h-display" style={{ fontSize: 28 }}>Find the glossary in any text</h1>
        <p className="lede" style={{ maxWidth: "70ch" }}>Paste a syllabus, a job description or a specification. Every I2IDL term it uses is found by its label, alternate labels and acronym, linked to its entry and IRI, and ready to become a pack or xAPI concept tags. Nothing leaves this page.</p>
      </div>
      <OriginStrip items={[["i2idl", "labels and alternate labels"], ["derived", "matching"], ["foxxi", "xAPI tags"]]} />
      <div className="an-grid">
        <div className="stack" style={{ gap: 10, minWidth: 0 }}>
          <textarea className="textarea an-in" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste text here…" aria-label="Text to annotate" />
          <div className="row wrap">
            <button className="btn sm" onClick={() => setText(EXAMPLE)}><Icon name="sparkle" />Try an example</button>
            {text ? <button className="btn sm ghost" onClick={() => setText("")}><Icon name="x" />Clear</button> : null}
            <label className="check small" title="Single-word labels such as “activity” or “actor” are often everyday words; off by default."><input type="checkbox" checked={weak} onChange={(e) => setWeak(e.target.checked)} />Include single-word terms</label>
            <span className="spacer" />
            {text.length > MAX ? <span className="tiny muted">Annotating the first {MAX.toLocaleString()} characters</span> : null}
          </div>
          {t ? (
            <div className="an-out" aria-label="Annotated text">
              <Annotated text={t} spans={spans} />
            </div>
          ) : (
            <div className="empty"><Icon name="edit" /><div><b>Nothing to annotate yet.</b></div><div className="small">Paste text above, or try the example.</div></div>
          )}
        </div>
        <aside className="stack an-side" style={{ gap: 10 }}>
          <div className="card pad stack" style={{ gap: 10 }}>
            <div className="row"><b className="grow">{plural(found.length, "term")} found</b><span className="small muted">{plural(spans.length, "mention")}</span></div>
            {found.length ? (
              <>
                <div className="an-list">
                  {found.map((f) => (
                    <div key={f.id} className="row" style={{ gap: 6 }}>
                      <ConceptChip id={f.id} />
                      <span className="tiny muted grow ellipsis" title={[...f.forms].join(", ")}>{[...f.forms].filter((x) => x.toLowerCase() !== byId.get(f.id).l.toLowerCase()).slice(0, 2).map((x) => "“" + x + "”").join(" ")}</span>
                      {f.n > 1 ? <span className="tiny muted">×{f.n}</span> : null}
                    </div>
                  ))}
                </div>
                <div className="row wrap">
                  <AddToPack ids={ids} label="Add all to a pack" />
                  <button className="btn sm" onClick={() => setXapi(true)}><Icon name="code" />xAPI tags</button>
                  <CopyBtn text={markdown} label="Copy as Markdown" small />
                  <CopyBtn text={() => ids.map(iriOf).join("\n")} label="Copy IRIs" small />
                </div>
                {ask ? <button className="btn sm" onClick={() => ask.open(`Here is a text I annotated with the I2IDL glossary:\n\n"""${t.slice(0, 4000)}"""\n\nIt names these terms: ${found.map((f) => byId.get(f.id).l).join(", ")}. Which other I2IDL concepts does the text imply without naming them? Search the glossary, cite each as [[concept-id]], and say which sentence implies it.`, ids.slice(0, 12))}><Icon name="sparkle" />Ask Claude for implied terms</button> : null}
              </>
            ) : <div className="small muted">Found terms appear here with how often each is used.</div>}
          </div>
          <div className="tiny muted">Matching follows the same rules as the links inside definitions: multi-word labels, acronyms and acronym-style alternate labels; a shared label goes to the concept whose own label carries it.</div>
        </aside>
      </div>
      {xapi ? <XapiModal ids={ids} onClose={() => setXapi(false)} /> : null}
    </div>
  );
}

function Annotated({ text, spans }) {
  const out = [];
  let at = 0;
  for (const [a, b, ci] of spans) {
    if (a > at) out.push(<span key={"t" + at}>{text.slice(at, a)}</span>);
    out.push(<ConceptRef key={"m" + a} id={C[ci].id} className="hx an-hit">{text.slice(a, b)}</ConceptRef>);
    at = b;
  }
  if (at < text.length) out.push(<span key={"t" + at}>{text.slice(at)}</span>);
  return <p className="an-text">{out}</p>;
}
