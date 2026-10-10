// Small SVG charts drawn to the dataviz spec: thin bars with a rounded data end, 2px lines with ringed
// end-dots, hairline grids, text in text tokens, a tooltip on every mark, and a table behind each chart.
const { useRef, useState, useEffect, useLayoutEffect } = React;

export function useWidth(min = 280) {
  const ref = useRef(null);
  const [w, setW] = useState(560);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function useTip() {
  const [tip, setTip] = useState(null);
  const show = (e, html) => setTip({ x: e.clientX, y: e.clientY, html });
  const hide = () => setTip(null);
  const view = tip ? <div className="charttip" style={{ left: Math.min(tip.x + 12, window.innerWidth - 290), top: tip.y + 14 }}>{tip.html}</div> : null;
  return [show, hide, view];
}

const fmt = (n) => (n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "K" : n.toLocaleString());
const niceMax = (m) => {
  if (m <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(m)));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * p >= m) return s * p;
  return 10 * p;
};

/** Rounded right end, square at the baseline. */
function barPath(x, y, w, h, r = 4) {
  if (w <= 0) return "";
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}
function colPath(x, y, w, h, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** rows: [{label, value, color?, sub?, href?, tip?}] */
export function HBars({ rows, fmtValue = fmt, max, labelW = 170, suffix = "", onPick }) {
  const [ref, w] = useWidth();
  const [show, hide, tipView] = useTip();
  const band = 30, bar = 18;
  const lw = Math.min(labelW, Math.round(w * 0.42));
  const vw = 54;
  const plotW = Math.max(60, w - lw - vw);
  const m = max || niceMax(Math.max(...rows.map((r) => r.value), 1));
  const h = rows.length * band + 22;
  const ticks = [0, 0.5, 1].map((t) => t * m);
  return (
    <div ref={ref}>
      <svg width={w} height={h} role="img" aria-label={rows.map((r) => `${r.label}: ${fmtValue(r.value)}${suffix}`).join("; ")}>
        {ticks.map((t) => <line key={t} className="gridl" x1={lw + (t / m) * plotW} x2={lw + (t / m) * plotW} y1={0} y2={h - 18} />)}
        {ticks.map((t) => <text key={"t" + t} className="tick" x={lw + (t / m) * plotW} y={h - 4} textAnchor={t === 0 ? "start" : t === m ? "end" : "middle"}>{fmtValue(t)}</text>)}
        {rows.map((r, i) => {
          const y = i * band + (band - bar) / 2;
          const bw = (r.value / m) * plotW;
          return (
            <g key={r.label} className="barg" onMouseMove={(e) => show(e, r.tip || <span><b>{r.label}</b> · {fmtValue(r.value)}{suffix}</span>)} onMouseLeave={hide}
              onClick={onPick ? () => onPick(r) : undefined} style={{ cursor: onPick ? "pointer" : "default" }}>
              <rect className="hit" x={0} y={i * band} width={w} height={band} />
              <text className="lbl" x={lw - 10} y={y + bar / 2 + 4} textAnchor="end">{truncate(r.label, Math.floor((lw - 14) / 6.4))}</text>
              <path className="bar" d={barPath(lw, y, bw, bar)} style={{ fill: r.color || "var(--k-notion)" }} />
              <text className="val" x={lw + bw + 6} y={y + bar / 2 + 4}>{fmtValue(r.value)}{suffix}</text>
            </g>
          );
        })}
      </svg>
      {tipView}
    </div>
  );
}

/** One stacked horizontal bar; segments separated by a 2px surface gap. parts: [{label, value, color}] */
export function StackBar({ parts, total }) {
  const [ref, w] = useWidth();
  const [show, hide, tipView] = useTip();
  const t = total || parts.reduce((a, p) => a + p.value, 0) || 1;
  const h = 28;
  let x = 0;
  return (
    <div ref={ref} className="stack" style={{ gap: 8 }}>
      <svg width={w} height={h} role="img" aria-label={parts.map((p) => `${p.label}: ${p.value}`).join("; ")}>
        {parts.map((p, i) => {
          const pw = (p.value / t) * w;
          const seg = { x, w: Math.max(0, pw - (i < parts.length - 1 ? 2 : 0)) };
          x += pw;
          if (!p.value) return null;
          const fits = seg.w > 44;
          return (
            <g key={p.label} onMouseMove={(e) => show(e, <span><b>{p.label}</b> · {p.value} ({Math.round((p.value / t) * 100)}%)</span>)} onMouseLeave={hide}>
              <rect x={seg.x} y={0} width={seg.w} height={h} rx={i === 0 || i === parts.length - 1 ? 4 : 0} style={{ fill: p.color }} />
              {fits ? <text x={seg.x + 8} y={h / 2 + 4} style={{ fontSize: 12, fontWeight: 700, fill: p.ink || "#fff" }}>{p.value}</text> : null}
            </g>
          );
        })}
      </svg>
      <div className="legend">{parts.map((p) => <span key={p.label}><i style={{ background: p.color }} />{p.label} · {p.value}</span>)}</div>
      {tipView}
    </div>
  );
}

/** A single-series line with a ringed end-dot and an end label; crosshair tooltip. points: [{x: label, y}] */
export function Line({ points, color = "var(--k-notion)", height = 150, yLabel }) {
  const [ref, w] = useWidth();
  const [hi, setHi] = useState(null);
  const pad = { l: 40, r: 56, t: 12, b: 24 };
  const pw = w - pad.l - pad.r, ph = height - pad.t - pad.b;
  const ys = points.map((p) => p.y);
  const lo = Math.min(...ys), top = Math.max(...ys);
  const span = top - lo || 1;
  const y0 = Math.max(0, Math.floor((lo - span * 0.2) / 10) * 10), y1 = Math.ceil((top + span * 0.15) / 10) * 10;
  const X = (i) => pad.l + (points.length === 1 ? pw / 2 : (i / (points.length - 1)) * pw);
  const Y = (v) => pad.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(i)},${Y(p.y)}`).join("");
  const last = points.length - 1;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <svg width={w} height={height} role="img" aria-label={`${yLabel}: ${points.map((p) => p.x + " " + p.y).join(", ")}`}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left - pad.l) / pw) * last); setHi(Math.max(0, Math.min(last, i))); }}
        onMouseLeave={() => setHi(null)}>
        {[y0, (y0 + y1) / 2, y1].map((v) => <g key={v}><line className="gridl" x1={pad.l} x2={w - pad.r} y1={Y(v)} y2={Y(v)} /><text className="tick" x={pad.l - 6} y={Y(v) + 4} textAnchor="end">{fmt(Math.round(v))}</text></g>)}
        <text className="tick" x={pad.l} y={height - 6}>{points[0].x}</text>
        <text className="tick" x={X(last)} y={height - 6} textAnchor="end">{points[last].x}</text>
        <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={X(last)} cy={Y(points[last].y)} r="4.5" fill={color} stroke="var(--surface)" strokeWidth="2" />
        <text className="val" x={X(last) + 9} y={Y(points[last].y) + 4}>{fmt(points[last].y)}</text>
        {hi != null ? (
          <g>
            <line className="axis" x1={X(hi)} x2={X(hi)} y1={pad.t} y2={pad.t + ph} />
            <circle cx={X(hi)} cy={Y(points[hi].y)} r="4.5" fill={color} stroke="var(--surface)" strokeWidth="2" />
          </g>
        ) : null}
      </svg>
      {hi != null ? <div className="charttip" style={{ position: "absolute", left: Math.min(X(hi) + 10, w - 160), top: 0 }}><b>{points[hi].x}</b> · {fmt(points[hi].y)} {yLabel}</div> : null}
    </div>
  );
}

/** Vertical columns. rows: [{label, value, tip?}] */
export function Columns({ rows, height = 160, color = "var(--k-notion)", every = 1 }) {
  const [ref, w] = useWidth();
  const [show, hide, tipView] = useTip();
  const pad = { l: 34, r: 8, t: 16, b: 24 };
  const pw = w - pad.l - pad.r, ph = height - pad.t - pad.b;
  const m = niceMax(Math.max(...rows.map((r) => r.value), 1));
  const bandW = pw / rows.length;
  const cw = Math.min(24, bandW - 2);
  return (
    <div ref={ref}>
      <svg width={w} height={height} role="img" aria-label={rows.map((r) => `${r.label}: ${r.value}`).join("; ")}>
        {[0, m / 2, m].map((v) => <g key={v}><line className="gridl" x1={pad.l} x2={w - pad.r} y1={pad.t + ph - (v / m) * ph} y2={pad.t + ph - (v / m) * ph} /><text className="tick" x={pad.l - 6} y={pad.t + ph - (v / m) * ph + 4} textAnchor="end">{fmt(v)}</text></g>)}
        {rows.map((r, i) => {
          const x = pad.l + i * bandW + (bandW - cw) / 2;
          const hgt = (r.value / m) * ph;
          return (
            <g key={r.label} onMouseMove={(e) => show(e, r.tip || <span><b>{r.label}</b> · {r.value}</span>)} onMouseLeave={hide}>
              <rect className="hit" x={pad.l + i * bandW} y={pad.t} width={bandW} height={ph} />
              <path d={colPath(x, pad.t + ph - hgt, cw, hgt)} style={{ fill: color }} />
              {r.value && rows.length <= 18 ? <text className="val" x={x + cw / 2} y={pad.t + ph - hgt - 4} textAnchor="middle">{r.value}</text> : null}
              {i % every === 0 ? <text className="tick" x={x + cw / 2} y={height - 6} textAnchor="middle">{r.label}</text> : null}
            </g>
          );
        })}
        <line className="axis" x1={pad.l} x2={w - pad.r} y1={pad.t + ph} y2={pad.t + ph} />
      </svg>
      {tipView}
    </div>
  );
}

const truncate = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

export function ChartCard({ title, sub, children, table }) {
  const [tab, setTab] = useState(false);
  return (
    <div className="chart">
      <div className="row"><h3 className="grow">{title}</h3>{table ? <button className="btn ghost sm" onClick={() => setTab((t) => !t)} aria-pressed={tab}>{tab ? "Chart" : "Table"}</button> : null}</div>
      {sub ? <div className="sub">{sub}</div> : null}
      {tab && table ? (
        <div className="tablewrap"><table className="tbl"><thead><tr>{table.head.map((h, i) => <th key={h} className={i ? "n" : ""}>{h}</th>)}</tr></thead>
          <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={j ? "n" : ""}>{v}</td>)}</tr>)}</tbody></table></div>
      ) : children}
    </div>
  );
}
