import { safeNavigationHref } from "../navigation-links.js";
// Live service inventory and explicit, bounded capability trials.
import { META, ACTIONS, conceptsByAction, roleById, systemLabel } from "../data.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, CodeBlock, MethodTag, Seg } from "../ui.jsx";
import { useStored } from "../util.js";
import { backendUrl, workbenchHosted } from "../backend-url.js";
import { actionIri, actionName, actionId, actionInputs, initialPayload, parsePayload, validatePayload, fieldValue, editField, describeCapability, capabilityCall, resultLabel, isCredentialField, credentialPaths, redactCredentials, directoryRequestBody, localSigningPayload } from "../capability-directory.js";

const { useState, useEffect, useMemo } = React;
const pretty = (value) => JSON.stringify(value, null, 2);
const embedded = () => Object.entries(ACTIONS).map(([iri, action]) => ({ iri, ...action }));
const hosted = workbenchHosted;
const safeLink = (value) => /^https?:\/\//.test(value || "") ? value : null;
const timeLabel = (value) => value ? new Date(value).toLocaleString() : "No timestamp supplied";
const modeOptions = [
  { v: "examples", l: "Live examples" }, { v: "client", l: "Client tasks" },
  { v: "prepare", l: "Prepare only" }, { v: "all", l: "All capabilities" },
];
const serviceOptions = [
  { v: "all", l: "All services" }, { v: "foxxi", l: "Foxxi" }, { v: "relay", l: "Interego relay" },
  { v: "telemetry", l: "Telemetry" }, { v: "linked", l: "Linked to a term" },
];
const normalizeService = (service) => ["llmtelemetry", "llm-telemetry"].includes(service) ? "telemetry" : service;
const executionGroup = (action) => {
  const mode = action.execution?.mode;
  if (mode === "public-example") return "examples";
  if (mode === "client-required") return "client";
  return mode === "unavailable" || mode === "blocked" ? "unavailable" : "prepare";
};
const matchesMode = (action, mode) => mode === "all" || mode === executionGroup(action);
const matchesService = (action, service) => {
  if (service === "linked") return action.enacts.length > 0;
  return service === "all" || service === normalizeService(action.sys);
};
const withCounts = (options, actions, matches) => options.map(({ v, l }) => ({
  v, l: l + " · " + actions.filter((action) => matches(action, v)).length,
}));

export function Directory({ route }) {
  const section = route?.section || "";
  const selectedId = section.startsWith("act.") ? "act-" + section.slice(4) : "";
  const [inventory, setInventory] = useState(() => ({ actions: embedded(), live: false, sources: [], generated_at: null, complete: false }));
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [mode, setMode] = useState(section === "examples" ? "examples" : "all");
  const [q, setQ] = useState(""), [storedSys, setSys] = useStored("ag.sys", "all");
  const sys = normalizeService(storedSys);
  const refresh = async () => {
    if (!hosted()) { setError("The live runner is available in the hosted workbench."); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch(backendUrl("/i2idlx/directory"), { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("Directory returned HTTP " + response.status + ".");
      const data = await response.json();
      if (data.schema !== 1 || !Array.isArray(data.actions) || data.actions.some((a) => !actionIri(a))) throw new Error("Directory returned an unsupported inventory.");
      setInventory({ ...data, live: true });
    } catch (e) { setError(e.message || "The live directory could not be read."); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (hosted()) refresh(); }, []);
  const all = useMemo(() => inventory.actions.map((a) => ({ ...a, iri: actionIri(a), n: actionName(a), enacts: conceptsByAction.get(actionIri(a)) || [] })), [inventory]);
  useEffect(() => {
    if (section !== "examples" && section !== "directory") return;
    setMode(section === "examples" ? "examples" : "all");
    setSys("all");
    setQ("");
  }, [section, setSys]);
  useEffect(() => {
    if (!selectedId) return;
    const row = document.getElementById(selectedId);
    if (row) { row.open = true; row.scrollIntoView({ block: "start", behavior: "smooth" }); }
  }, [selectedId, all]);
  const query = q.trim().toLowerCase();
  const searched = all.filter((a) => !query || [a.t, a.n, a.d, a.iri].join(" ").toLowerCase().includes(query));
  const byService = searched.filter((a) => matchesService(a, sys));
  const byMode = searched.filter((a) => matchesMode(a, mode));
  const matches = byService.filter((a) => matchesMode(a, mode));
  const linked = selectedId ? all.find((a) => actionId(a) === selectedId) : null;
  const extraLinked = linked && !matches.includes(linked);
  const list = (extraLinked ? [...matches, linked] : matches).sort((a, b) =>
    b.enacts.length - a.enacts.length || (a.t || a.n).localeCompare(b.t || b.n));
  return (
    <section id="directory" className="stack" data-testid="capability-directory">
      <div className="sec-h"><h2>Capability directory</h2><span className="meta">{all.length} advertised operations · {inventory.live ? "current service inventory" : "embedded build snapshot"}</span></div>
      <div className={"note small" + ((!inventory.live || error || inventory.complete === false) ? " warn" : "")} role="status">
        <b>{inventory.live ? (inventory.complete === false ? "Partial live inventory" : "Live inventory loaded") : "Build snapshot · live status unverified"}</b>
        <p>{inventory.live ? "Fetched " + timeLabel(inventory.generated_at) + ". Listing an operation does not prove it has run successfully." : "This fallback describes the services at build time. Refresh the live inventory before trying an operation."}</p>
        {error ? <p>{error}</p> : null}
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn sm" disabled={loading || !hosted()} onClick={refresh}><Icon name="refresh" />{loading ? "Refreshing…" : "Refresh live inventory"}</button>
          {!hosted() ? <a className="btn sm" href="https://foxxi-bridge.interego.xwisee.com/i2idlx/#agents-directory" target="_blank" rel="noopener">Open hosted runner</a> : null}
          {inventory.build ? <span className="tiny muted">Bridge build <code>{String(inventory.build).slice(0, 12)}</code></span> : null}
        </div>
      </div>
      {inventory.sources && inventory.sources.length ? <details className="small"><summary>Inventory sources and freshness</summary><div className="tablewrap"><table className="tbl"><thead><tr><th>Service</th><th>Observed</th><th>Operations</th><th>Source</th></tr></thead><tbody>{inventory.sources.map((source, i) => <tr key={source.system + ":" + i}><td>{source.system}<div>{source.status}</div>{source.error ? <div className="danger">{source.error}</div> : null}</td><td>{timeLabel(source.checked_at)}</td><td>{source.count == null ? "—" : source.count}</td><td>{safeLink(source.url) ? <a href={safeNavigationHref(source.url)} target="_blank" rel="noopener">{source.url}</a> : source.url}</td></tr>)}</tbody></table></div></details> : null}
      <p className="small muted">Live examples run here and show the service response. Client tasks return instructions for your AI client. For protected operations, validate inputs here, then use the prepared call in your connected Interego client. Keep keys and passwords with that client. Requests can create service telemetry.</p>
      <p className="tiny muted">Each filter button shows how many operations it would display with your other filters and search applied.</p>
      <div className="row wrap">
        <Seg label="Execution mode" value={mode} onChange={setMode} options={withCounts(modeOptions, byService, matchesMode)} />
        <span className="spacer" />
        <input className="input" style={{ width: 240, maxWidth: "100%" }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter actions…" aria-label="Filter capabilities" />
      </div>
      <Seg label="Service or glossary link" value={sys} onChange={setSys} options={withCounts(serviceOptions, byMode, matchesService)} />
      <div className="tiny muted" role="status">
        Showing {matches.length} matching {matches.length === 1 ? "operation" : "operations"}.{extraLinked ? " The directly linked operation is also shown." : ""}
      </div>
      <div className="actions-dir">{list.map((a) => <ActionRow key={a.iri} a={a} live={inventory.live} />)}</div>
      {!list.length ? <p className="empty">{loading ? "Loading the live inventory…" : "No operations match these filters."}</p> : null}
    </section>
  );
}

function InputField({ field, payload, draft, disabled, onChange }) {
  const schema = field.schema || {}, type = schema.type || field.t || "string", value = draft == null ? fieldValue(payload, field) : draft;
  const label = field.n + (field.req ? " (required)" : " (optional)");
  if (isCredentialField(field.n)) return <div className="field stack small"><code>{field.n}</code><span className="muted">Provided by your connected client’s key provider. Do not paste credentials into this runner.</span></div>;
  return <label className="field stack" style={{ minWidth: 0, gap: 4 }}>
    <span><code>{field.n}</code>{field.req ? <span className="req"> *</span> : null}<span className="tiny muted"> · {Array.isArray(type) ? type.join(" / ") : type}</span></span>
    {Array.isArray(schema.enum) ? <select className="select" aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(field, e.target.value)}><option value="">Choose a value…</option>{schema.enum.map((x) => <option key={JSON.stringify(x)} value={typeof x === "object" ? JSON.stringify(x) : String(x)}>{typeof x === "object" ? JSON.stringify(x) : String(x)}</option>)}</select>
      : type === "boolean" ? <select className="select" aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(field, e.target.value)}><option value="">Choose true or false…</option><option value="true">true</option><option value="false">false</option></select>
        : type === "object" || type === "array" || Array.isArray(type) ? <textarea className="textarea" aria-label={label} rows={3} disabled={disabled} value={value} onChange={(e) => onChange(field, e.target.value)} style={{ fontFamily: "var(--font-mono)", width: "100%", resize: "vertical" }} />
          : <input className="input" aria-label={label} type={type === "number" || type === "integer" ? "number" : "text"} step={type === "integer" ? "1" : "any"} disabled={disabled} value={value} onChange={(e) => onChange(field, e.target.value)} />}
    {field.c ? <span className="tiny muted">{field.c}</span> : null}
  </label>;
}

function ActionRow({ a, live }) {
  const [draftText, setDraftText] = useState(null), [fieldErrors, setFieldErrors] = useState({}), [drafts, setDrafts] = useState({});
  const exampleText = useMemo(() => pretty(initialPayload(a)), [a]);
  const text = draftText ?? exampleText;
  const fieldError = Object.values(fieldErrors).join(" ");
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false);
  const id = actionId(a), description = describeCapability(a), fields = actionInputs(a);
  const parsed = parsePayload(text), secretPaths = parsed.value ? credentialPaths(parsed.value, "", true) : [];
  const invalid = secretPaths.length ? "Raw credential values stay with your connected client. Remove credential fields before sending a request." : parsed.error || (parsed.value && validatePayload(a, parsed.value));
  const call = parsed.value ? capabilityCall(a, parsed.value, META.foxxiManifest) : null;
  const updateText = (next) => { setDraftText(next); setFieldErrors({}); setDrafts({}); setResult(null); };
  const updateField = (field, value) => {
    setDrafts((current) => ({ ...current, [field.n]: value }));
    setResult(null);
    const next = editField(parsed.value || {}, field, value);
    setFieldErrors((current) => { const errors = { ...current }; if (next.error) errors[field.n] = next.error; else delete errors[field.n]; return errors; });
    if (!next.error) setDraftText(pretty(next.value));
  };
  const run = async (mode) => {
    if (busy || !live || invalid || fieldError) return;
    setBusy(true); setResult(null);
    const start = performance.now();
    try {
      const response = await fetch(backendUrl("/i2idlx/directory/run"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: directoryRequestBody(a, parsed.value, mode) });
      let data;
      try { data = await response.json(); } catch { throw new Error("Runner returned HTTP " + response.status + " without a JSON result."); }
      if (!data || data.action_iri !== a.iri || typeof data.executed !== "boolean") throw new Error("Runner returned an unbound or unsupported result.");
      setResult({ ...redactCredentials(data), runner_http_status: response.status, browser_duration_ms: Math.round(performance.now() - start) });
    } catch (e) { setResult({ status: "failed", executed: false, error: e.message || "The runner could not be reached.", checked_at: new Date().toISOString() }); }
    finally { setBusy(false); }
  };
  return (
    <details className="port" id={id} data-action-iri={a.iri}>
      <summary>
        <MethodTag m={a.m} /><span className="pt">{a.t || a.n}</span>
        <span className="row" style={{ gap: 6 }}><span className="tag">{result ? resultLabel(result, a) : description.label}</span>{a.enacts.length ? <span className="tag post">enacts {a.enacts.length}</span> : null}<span className="tag">{systemLabel(a.sys)}</span><Icon name="down" /></span>
        <span className="pu">{a.n} · {a.u}</span>
      </summary>
      <div className="pb stack" style={{ gap: 14 }}>
        {a.d ? <p className="small">{a.d}</p> : null}
        <div className="note small"><b>{description.label}</b><p>{description.reason}</p></div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="row wrap"><b className="small grow">Request inputs</b>{a.example ? <button className="btn sm" disabled={busy} onClick={() => updateText(null)}>Reset to example</button> : null}</div>
          {a.example ? <p className="tiny muted">{a.example.label || "Illustrative request"} · {a.example.provenance || "example"}. Edit the example inputs or use them as supplied.</p> : null}
          {fields.length ? <div className="qparams">{fields.map((field) => <InputField key={field.n} field={field} payload={parsed.value || {}} draft={drafts[field.n]} disabled={busy || !!parsed.error} onChange={updateField} />)}</div> : <p className="small muted">No named input fields are advertised.</p>}
          <label className="stack small" style={{ gap: 4 }}><span>JSON payload</span><textarea className="textarea" aria-label={"JSON payload for " + a.n} rows={Math.min(14, Math.max(4, text.split("\n").length))} value={text} disabled={busy} onChange={(e) => updateText(e.target.value)} spellCheck="false" style={{ width: "100%", fontFamily: "var(--font-mono)", resize: "vertical" }} /></label>
          {invalid || fieldError ? <div className="note warn small" role="status">{invalid || fieldError}</div> : null}
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {description.canRun ? <button className="btn sm primary" disabled={busy || !live || !!invalid || !!fieldError || (parsed.value && credentialPaths(parsed.value).length > 0)} onClick={() => run("example")} aria-label={(a.execution.mode === "client-required" ? "Prepare client task " : "Run live example ") + a.n}><Icon name="bolt" />{busy ? "Requesting…" : a.execution.mode === "client-required" ? "Prepare client task" : "Run live example"}</button> : null}
          <button className={"btn sm" + (!description.canRun ? " primary" : "")} disabled={busy || !live || !!invalid || !!fieldError} onClick={() => run("validate")} aria-label={"Validate inputs " + a.n}>{busy ? "Requesting…" : "Validate inputs"}</button>
          {!live ? <span className="tiny muted">Refresh the live inventory to enable requests.</span> : null}
        </div>
        {result ? <CapabilityResult result={result} a={a} /> : null}
        <b className="small">Operation details</b>
        {a.enacts.length ? <div className="stack" style={{ gap: 4 }}><b className="small">Proposed enactments</b><div className="chips">{a.enacts.map((e) => <span key={e.c + e.how} className="row" style={{ gap: 4 }}><span className="tiny muted">{e.how === "role" ? "role capability of" : (roleById.get(e.how) || {}).label}</span><ConceptChip id={e.c} /></span>)}</div></div> : null}
        <dl className="kv">
          <dt>Action</dt><dd><code className="iri">{a.iri}</code></dd>
          <dt>Target</dt><dd><code className="iri">{a.u}</code></dd>
          <dt>Behavior</dt><dd>{a.ro === true ? "Read operation" : a.ro === false ? "Writes or changes state" : "Read/write behavior not advertised"}{a.de ? " · destructive" : ""}{a.ix ? " · idempotent" : ""}{a.xr ? " · externally routed" : ""}</dd>
          {a.classification || a.cls ? <><dt>Classification</dt><dd>{a.classification || a.cls}</dd></> : null}
          {a.auth ? <><dt>Authorization</dt><dd>{typeof a.auth === "string" ? a.auth : "An authenticated Interego client and the operation's permissions are required."}</dd></> : null}
          {(a.requirements || (a.execution && a.execution.requirements)) ? <><dt>Requirements</dt><dd>{Array.isArray(a.requirements || a.execution.requirements) ? (a.requirements || a.execution.requirements).join("; ") : String(a.requirements || a.execution.requirements)}</dd></> : null}
          {a.notes ? <><dt>Implementation notes</dt><dd>{Array.isArray(a.notes) ? a.notes.join("; ") : String(a.notes)}</dd></> : null}
          {a.execution && a.execution.side_effects ? <><dt>Side effects</dt><dd>{Array.isArray(a.execution.side_effects) ? a.execution.side_effects.join("; ") : String(a.execution.side_effects)}</dd></> : null}
          {a.co && a.co.length ? <><dt>Applies to</dt><dd>{a.co.join(", ")}</dd></> : null}
        </dl>
        {a.input_schema ? <details className="small"><summary>Advertised JSON input schema</summary><CodeBlock title="Input schema" code={pretty(a.input_schema)} /></details> : null}
        {a.signing ? <SigningPayload signing={a.signing} name={a.n} /> : null}
        {call ? <CodeBlock title={a.sys === "relay" ? "Prepared Interego tool call · executes in your connected client" : "Prepared Interego act arguments · executes in your connected client"} code={call} /> : null}
      </div>
    </details>
  );
}

function SigningPayload({ signing, name }) {
  const [text, setText] = useState(() => pretty(redactCredentials(signing.payload || {})));
  const prepared = localSigningPayload(signing, text);
  return <section className="stack note small" data-testid="local-signing-editor" style={{ gap: 8 }}>
    <b>Prepare the signed request body locally</b>
    <p>Fill the course, connector or observed event fields below. This editor keeps the body in this page; it does not sign, submit or execute it. Your connected Interego client supplies the actual identity, timestamp and signature.</p>
    {signing.instructions ? <ol>{(Array.isArray(signing.instructions) ? signing.instructions : [signing.instructions]).map((instruction, i) => <li key={i}>{instruction}</li>)}</ol> : null}
    <label className="stack" style={{ gap: 4 }}><span>Local signing payload</span><textarea className="textarea" aria-label={"Local signing payload for " + name} rows={Math.min(16, Math.max(6, text.split("\n").length))} value={text} onChange={(e) => setText(e.target.value)} spellCheck="false" style={{ width: "100%", fontFamily: "var(--font-mono)", resize: "vertical" }} /></label>
    {prepared.error || prepared.warning ? <p className="note warn" role="status">{prepared.error || prepared.warning}</p> : null}
    {prepared.value ? <CodeBlock title="Local signing template · pass to your connected client's sign_request" code={pretty(prepared.value)} wrap /> : null}
    <p className="tiny muted">Only public data and established public encryption keys belong in this template. Raw credentials are removed from the prepared copy. The generic runner above never receives this editor's body. Local checks cover JSON, field types and the advertised action and audience bindings; inspect the full public schema for conditional requirements.</p>
    {signing.schema ? <details><summary>Public signing payload schema</summary><CodeBlock title="Advertised signing schema" code={pretty(signing.schema)} wrap /></details> : null}
  </section>;
}

function CapabilityResult({ result, a }) {
  const attempted = result.executed || result.evidence?.invocation_attempted === true;
  const httpStatus = result.evidence?.http_status;
  const failedMessage = httpStatus != null
    ? "A request reached the advertised service. " + (httpStatus >= 400 ? "The service returned an error." : "The response could not be used.")
    : "The runner tried to reach the advertised service. See the request details below.";
  const summary = result.status === "contract-valid"
    ? "The inputs passed validation. Use the prepared call below to run the operation in your connected Interego client."
    : result.status === "executed" && result.executed
      ? a.execution?.mode === "client-required"
        ? "The service prepared task context and instructions. Your connected AI client must perform the model work."
        : "The live example returned a response from the advertised service."
      : attempted ? failedMessage : "The runner did not send a request to the advertised service.";
  return <div className={"stack note small" + (["invalid", "refused", "failed", "unavailable"].includes(result.status) ? " warn" : "")} data-testid="capability-result" aria-live="polite" style={{ gap: 8 }}>
    <div className="row wrap"><b>{resultLabel(result, a)}</b><span className="spacer" /><span className="tiny muted">{timeLabel(result.checked_at)}</span></div>
    <p>{summary}</p>
    {result.error ? <p>{result.error}</p> : null}
    {result.validation && result.validation.errors && result.validation.errors.length ? <ul>{result.validation.errors.map((error, i) => <li key={i}>{typeof error === "string" ? error : JSON.stringify(error)}</li>)}</ul> : null}
    {result.next_step ? <p>{typeof result.next_step === "string" ? result.next_step : JSON.stringify(result.next_step)}</p> : null}
    {result.evidence ? <p className="tiny muted">Evidence: {result.evidence.source}{result.evidence.http_status != null ? " · target HTTP " + result.evidence.http_status : ""}{result.evidence.duration_ms != null ? " · " + result.evidence.duration_ms + " ms" : ""}{result.runner_http_status != null ? " · runner HTTP " + result.runner_http_status : ""}</p> : null}
    {result.result !== undefined ? <CodeBlock title="Actual returned result · credential fields redacted" code={typeof result.result === "string" ? result.result : pretty(result.result)} wrap /> : null}
    <details><summary>Full request and response evidence</summary><CodeBlock title="Observed runner response · credential fields redacted" code={pretty(result)} wrap /></details>
  </div>;
}
