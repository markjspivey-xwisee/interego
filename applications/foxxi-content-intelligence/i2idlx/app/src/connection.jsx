import { safeNavigationHref } from "./navigation-links.js";
import { useCaps } from "./caps.js";
import { Icon } from "./icons.jsx";
import { CopyBtn, Modal, useUI } from "./ui.jsx";
import { connectWorkbench, disconnectWorkbench, workbenchConnectionStatus, usePersonalApiKey, clearPersonalApiKey, connectAgentSession, renewAgentInvitation, disconnectAgentSession, refreshAgentSession, subscribeAgentSession } from "./interego-caps.js";
import { isChatGPTApp } from "./chatgpt-host.js";
import { backendUrl } from "./backend-url.js";
import { grokRoutineInstructions } from "./agent-session.js";
const { useState, useEffect, useRef } = React;
const CONTROLS_URL = "https://foxxi-bridge.interego.xwisee.com/i2idlx/capabilities.ttl";
const ASK_PROMPT = "Discover the I2IDL-X Ask operation through Interego from " + CONTROLS_URL + ", follow it with my question, then answer using the returned glossary context and instructions. My question is: [add your question]";
const ORCHESTRATE_PROMPT = "Discover I2IDL-X Orchestrate through Interego from " + CONTROLS_URL + ", follow it with example set to true, and execute the returned recipe with your own model. Preflight the available checks and report the actual results in its check ledger.";

export function AIClientTaskLinks() {
  if (isChatGPTApp()) return <div className="stack" style={{ gap: 10 }}>
    <p className="small">Use ChatGPT beside this workbench to ask questions and execute an orchestration recipe.</p>
    <div className="row wrap"><a className="btn primary" href="#ask">Ask ChatGPT</a><a className="btn" href="#orchestrate">Run with ChatGPT</a></div>
  </div>;
  return <div className="stack" style={{ gap: 10 }}>
    <p className="small">Connect the Interego MCP app in ChatGPT, Claude, or your other AI client. Copy a prompt into that conversation and add your question to the Ask prompt.</p>
    <div className="row wrap">
      <CopyBtn text={ASK_PROMPT} label="Copy Ask prompt" />
      <CopyBtn text={ORCHESTRATE_PROMPT} label="Copy Orchestrate prompt" />
      <a href={safeNavigationHref(CONTROLS_URL)} target="_blank" rel="noreferrer">Discoverable controls</a>
    </div>
    <details className="small"><summary>Read or select the prompts</summary><p>{ASK_PROMPT}</p><p>{ORCHESTRATE_PROMPT}</p></details>
  </div>;
}

export function WorkbenchConnection() {
  const caps = useCaps(), { toast } = useUI();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [key, setKey] = useState(""), [model, setModel] = useState("");
  const [agent, setAgent] = useState(() => workbenchConnectionStatus().agent);
  const [invitation, setInvitation] = useState("");
  const routineUrl = useRef(null), routineKey = useRef(null), pairing = useRef(null);
  useEffect(() => subscribeAgentSession(setAgent), []);
  useEffect(() => {
    if (!agent || ["disconnected", "expired"].includes(agent.state)) return;
    const timer = setInterval(() => refreshAgentSession(), 2000);
    return () => clearInterval(timer);
  }, [agent?.state]);
  const status = workbenchConnectionStatus();
  if (!status.hosted) return null;
  const canConfigureRoutine = !isChatGPTApp() && window.isSecureContext && window.self === window.top;
  const labels = { disconnected: "No agent connected", connecting: "Connecting…", waiting_for_agent: "Waiting for your agent", connected: "Agent connected", expired: "Agent session expired" };
  const monitoringLabels = { starting: "Starting automatic monitoring", ready: "Monitoring", unavailable: "Could not start monitoring" };
  const monitoring = agent?.state === "connected" ? agent.monitoring : null;
  const agentLabel = monitoringLabels[monitoring] || labels[agent?.state] || "No agent connected";
  const connect = async () => {
    setBusy(true);
    try { await connectWorkbench(); toast("Interego identity verified.", { icon: "check" }); }
    catch (e) { toast(e.message || "Interego connection unavailable.", { icon: "warn", ms: 8000 }); }
    finally { setBusy(false); }
  };
  const clearRoutineInputs = () => {
    if (routineUrl.current) routineUrl.current.value = "";
    if (routineKey.current) routineKey.current.value = "";
  };
  const closeModal = () => {
    setOpen(false); setKey(""); clearRoutineInputs();
    if (pairing.current?.fresh) {
      pairing.current = null;
      setInvitation(""); setBusy(false);
      void disconnectAgentSession().catch(() => {});
    }
  };
  const pairAgent = async (renew = false) => {
    const url = !renew && canConfigureRoutine ? routineUrl.current?.value.trim() || "" : "";
    const routineSecret = !renew && canConfigureRoutine ? routineKey.current?.value.trim() || "" : "";
    if (!!url !== !!routineSecret) {
      toast("Enter both the Routine webhook URL and key to use automatic monitoring.", { icon: "warn", ms: 8000 });
      return;
    }
    const attempt = { fresh: !renew };
    pairing.current = attempt;
    setInvitation("");
    setBusy(true);
    try {
      const request = await (renew ? renewAgentInvitation() : connectAgentSession(url ? { provider: "grok-bot", url, key: routineSecret } : undefined));
      if (pairing.current !== attempt) return;
      clearRoutineInputs();
      setInvitation(request);
      toast("Connection request ready. Send it to the agent session you want to use.", { icon: "check", ms: 7000 });
    } catch (e) {
      if (pairing.current === attempt) toast(e.message || "Could not prepare the agent connection.", { icon: "warn", ms: 8000 });
    } finally {
      if (pairing.current === attempt) { pairing.current = null; setBusy(false); }
    }
  };
  const closeAgent = async () => {
    setBusy(true); setInvitation("");
    try { await disconnectAgentSession(); toast("Agent session disconnected.", { icon: "check" }); }
    catch (e) { toast("The connection is closed in this tab; server revocation could not be confirmed. " + (e.message || ""), { icon: "warn", ms: 9000 }); }
    finally { setBusy(false); }
  };
  const addKey = () => {
    try { usePersonalApiKey(key, model); setKey(""); setOpen(false); toast("Your API key is available in this tab.", { icon: "check" }); }
    catch (e) { toast(e.message, { icon: "warn" }); }
  };
  const activeAgent = agent && !["disconnected", "expired"].includes(agent.state);
  return <>
    <button className="btn sm" onClick={() => setOpen(true)}><Icon name="agent" />{agent?.state === "connected" ? agentLabel : activeAgent ? "Connect agent" : caps.me ? "Connected" : "Connect"}</button>
    {open ? <Modal title="Connect your workbench" onClose={closeModal}>
      <div className="stack" style={{ gap: 18 }}>
        <section className="stack" style={{ gap: 12 }} aria-label="Connect an AI agent">
          <h3 style={{ margin: 0 }}>Chat inside the workbench</h3>
          <p className="small">Connect an active agent from your preferred AI client or local companion. The workbench keeps the conversation and source context together; the connected agent supplies the reasoning through its own available model.</p>
          <p className="note small" role="status">{agentLabel}{agent?.pending ? " · Question pending" : ""}{agent?.driverActor ? <><br /><span className="tiny">Verified agent: <code style={{ overflowWrap: "anywhere" }}>{agent.driverActor}</code></span></> : null}</p>
          {monitoring === "starting" ? <p className="small">You can send requests to this agent once monitoring starts.</p> : null}
          {monitoring === "unavailable" ? <p className="small">Create a new connection request to try again.</p> : null}
          <p className="tiny muted">Questions you submit and their selected content are shared with the agent you explicitly connect. No model API key is requested. This temporary connection does not publish learner records or save the conversation to a pod. An agent can serve this tab by staying active or through its configured Routine.</p>
          {canConfigureRoutine && !activeAgent ? <details>
            <summary>Optional: automatic monitoring with Grok Bot</summary>
            <div className="stack" style={{ gap: 10, marginTop: 12 }}>
              <p className="small">Copy the setup instructions into the Grok Bot you want to connect. After it creates the Routine, copy its webhook URL and key from its settings and enter them below. Leave both fields blank for a standard agent connection.</p>
              <div><CopyBtn text={grokRoutineInstructions(backendUrl, window.location.origin)} label="Copy Routine setup instructions" /></div>
              <label className="stack small">Routine webhook URL<input className="input" type="url" ref={routineUrl} autoComplete="off" spellCheck={false} /></label>
              <label className="stack small">Routine webhook key<input className="input" type="password" ref={routineKey} autoComplete="off" spellCheck={false} /></label>
              <p className="tiny muted">The workbench keeps the URL and key only for this temporary session. Send the invitation only to the agent that owns the Routine. Its runs use your Grok plan.</p>
            </div>
          </details> : null}
          <div className="row wrap">
            {!activeAgent ? <button className="btn primary" disabled={busy} onClick={() => pairAgent()}>{busy ? "Preparing…" : "Connect an AI agent"}</button>
              : <button className="btn" disabled={busy || (agent.pending && monitoring !== "unavailable")} onClick={() => pairAgent(true)}>{agent.routineConfigured ? "New request for this Routine" : agent.state === "connected" ? "Replace connected agent" : "New connection request"}</button>}
            {activeAgent ? <button className="btn" disabled={busy} onClick={closeAgent}>Disconnect agent</button> : null}
          </div>
          {invitation && agent?.state === "waiting_for_agent" ? <div className="stack" style={{ gap: 10 }}>
            <p className="small">{agent.routineConfigured ? "Copy this one-use request into the Grok Bot that owns the Routine. That Bot needs an Interego connection and signed action support." : "Copy this one-use request into the agent conversation you want to connect. That client needs the Interego connection and signed action support. Only that session is invited to receive your workbench questions."}</p>
            <CopyBtn text={invitation} label="Copy agent connection request" />
            <details className="small"><summary>Read or select the connection request</summary><textarea className="input" aria-label="Agent connection request" readOnly value={invitation} rows={9} spellCheck={false} /></details>
          </div> : null}
          {agent?.expiresAt && activeAgent ? <p className="tiny muted">This connection expires {new Date(agent.expiresAt).toLocaleTimeString()} and stays only in this tab.</p> : null}
          {agent?.error ? <p className="note warn small" role="status">{agent.error}</p> : null}
          {status.subscription ? <p className="small">This host also supplies its own model adapter. That existing connection takes precedence.</p> : null}
        </section>
        <details>
          <summary>Use your AI client's own conversation</summary>
          <div className="stack" style={{ gap: 10, marginTop: 12 }}>
            <AIClientTaskLinks />
            <p className="tiny muted">These optional links run in that client's conversation. They do not attach a model to this tab or replace its embedded chat.</p>
          </div>
        </details>
        <details>
          <summary>Keep work with Interego</summary>
          <div className="stack" style={{ gap: 12, marginTop: 12 }}>
            <p className="small">Connect an existing Interego identity for encrypted pod saves and admitted team reviews. Model access and pod access are separate connections.</p>
            {caps.me ? <div className="note"><b>{caps.me.name}</b><div className="small"><code>{caps.me.did}</code></div>{caps.me.privateWrite === false ? <div className="small muted">Encrypted pod saves are unavailable until your connected client or wallet supplies its owned encryption key. Edits remain in this browser.</div> : null}</div>
              : <button className="btn" disabled={busy} onClick={connect}>{busy ? "Verifying…" : "Connect Interego or browser wallet"}</button>}
            {caps.me ? <button className="btn" onClick={() => { disconnectWorkbench(); toast("Interego disconnected."); }}>Disconnect Interego</button> : null}
            {caps.dbError ? <p className="note warn small">Some pod data is unavailable. Unconfirmed changes remain held in this browser.</p> : null}
          </div>
        </details>
        <details>
          <summary>Advanced: use your own API connection</summary>
          <div className="stack" style={{ gap: 12, marginTop: 12 }}>
            <p className="small">An API key is optional. Use this existing fallback only when you want requests billed to your own API account.</p>
            <label className="stack small">Your OpenAI API key<input className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></label>
            <label className="stack small">Model name<input className="input" autoComplete="off" value={model} placeholder="A model available on your API account" onChange={(e) => setModel(e.target.value)} /></label>
            <p className="tiny muted">This fallback sends the key directly to OpenAI. It stays in this tab and is never sent to the workbench server or saved in browser storage. An active agent connection takes precedence over this fallback.</p>
            <div className="row wrap">
              <button className="btn" disabled={!key.trim() || !model.trim()} onClick={addKey}>Use my API key</button>
              {status.apiKey ? <button className="btn" onClick={() => { clearPersonalApiKey(); setKey(""); toast("API key removed from this tab."); }}>Remove API key</button> : null}
            </div>
          </div>
        </details>
      </div>
    </Modal> : null}
  </>;
}

