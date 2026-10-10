// Definitions as hypertext, and a small Markdown renderer for Claude's answers with [[concept-id]] citations.
import { C, byId } from "./data.js";
import { ConceptRef } from "./ui.jsx";
import { highlight } from "./search.js";

/** Render text with the build's mention spans ([start, end, conceptIndex]) as concept links. */
export function Hypertext({ text, spans, linked, query }) {
  if (!text) return null;
  const out = [];
  let at = 0;
  for (const [a, b, ci] of spans || []) {
    if (a < at) continue;
    if (a > at) out.push(<Plain key={"t" + at} t={text.slice(at, a)} q={query} />);
    const target = C[ci];
    const isLinked = !linked || linked.has(target.id);
    out.push(<ConceptRef key={"m" + a} id={target.id} className={isLinked ? "hx" : "hx sugg"}>{text.slice(a, b)}</ConceptRef>);
    at = b;
  }
  if (at < text.length) out.push(<Plain key={"t" + at} t={text.slice(at)} q={query} />);
  return <>{out}</>;
}

function Plain({ t, q }) {
  if (!q) return <>{t}</>;
  return <>{highlight(t, q).map((r, i) => (r.hit ? <mark key={i}>{r.t}</mark> : <span key={i}>{r.t}</span>))}</>;
}

export function HL({ text, q }) {
  return <Plain t={text} q={q} />;
}

// ── Markdown-lite (paragraphs, bullets, numbered lists, **bold**, *em*, `code`, ### headings, [[id]] cites) ──
function inline(s, key) {
  const parts = [];
  const re = /\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*/g;
  let at = 0, m, i = 0;
  while ((m = re.exec(s))) {
    if (m.index > at) parts.push(s.slice(at, m.index));
    if (m[1]) {
      const c = byId.get(m[1]);
      parts.push(c ? <ConceptRef key={key + "c" + i} id={m[1]} className="cref">{m[2] || c.l}</ConceptRef> : <code key={key + "u" + i}>{m[1]}</code>);
    } else if (m[3]) parts.push(<strong key={key + "b" + i}>{inline(m[3], key + "b" + i)}</strong>);
    else if (m[4]) parts.push(<code key={key + "k" + i}>{m[4]}</code>);
    else if (m[5]) parts.push(<em key={key + "e" + i}>{m[5]}</em>);
    at = m.index + m[0].length;
    i++;
  }
  if (at < s.length) parts.push(s.slice(at));
  return parts;
}

export function MiniMarkdown({ text }) {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { blocks.push({ t: "p", v: para.join(" ") }); para = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const head = line.match(/^#{1,4}\s+(.*)$/);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (head) { flushPara(); flushList(); blocks.push({ t: "h", v: head[1] }); continue; }
    if (bullet || num) {
      flushPara();
      const type = bullet ? "ul" : "ol";
      if (!list || list.t !== type) { flushList(); list = { t: type, items: [] }; }
      list.items.push(bullet ? bullet[1] : num[2]);
      continue;
    }
    if (list) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
    para.push(line.trim());
  }
  flushPara(); flushList();
  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === "h") return <h4 key={i}>{inline(b.v, "h" + i)}</h4>;
        if (b.t === "ul") return <ul key={i}>{b.items.map((x, j) => <li key={j}>{inline(x, i + "-" + j)}</li>)}</ul>;
        if (b.t === "ol") return <ol key={i} style={{ paddingLeft: 22, display: "grid", gap: 4, marginTop: 6 }}>{b.items.map((x, j) => <li key={j}>{inline(x, i + "-" + j)}</li>)}</ol>;
        return <p key={i}>{inline(b.v, "p" + i)}</p>;
      })}
    </>
  );
}
