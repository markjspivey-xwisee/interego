import { useCaps } from "./caps.js";
import { Icon } from "./icons.jsx";
import { CopyBtn, Modal, useUI } from "./ui.jsx";
import { connectWorkbench, disconnectWorkbench, workbenchConnectionStatus, usePersonalApiKey, clearPersonalApiKey, connectAgentSession, renewAgentInvitation, disconnectAgentSession, refreshAgentSession, subscribeAgentSession } from "./interego-caps.js";
import { isChatGPTApp } from "./chatgpt-host.js";
const { useState, useEffect } = React;
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
      <a href={CONTROLS_URL} target="_blank" rel="noreferrer">Discoverable controls</a>
    </div>
    <details className="small"><summary>Read or select the prompts</summary><p>{ASK_PROMPT}</p><p>{ORCHESTRATE_PROMPT}</p></details>
  </div>;
}

export function WorkbenchConnection() {
  const caps = useCaps(), { toast } = useUI();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [key, setKey] = useState(""), [model, setModel] = useState("");
  const [agent, setAgent] = useState(() => workbenchConnectionStatus().agent);
  const [invitation, setInvitation] = useState("");
  useEffect(() => subscribeAgentSession(setAgent), []);
  useEffect(() => {
    if (!agent || ["disconnected", "expired"].includes(agent.state)) return;
    const timer = setInterval(() => refreshAgentSession(), 2000);
    return () => clearInterval(timer);
  }, [agent?.state]);
  const status = workbenchConnectionStatus();
  if (!status.hosted) return null;
  const labels = { disconnected: "No agent connected", connecting: "Connecting…", waiting_for_agent: "Waiting for your agent", connected: "Agent connected", expired: "Agent session expired" };
  const agentLabel = labels[agent?.state] || "No agent connected";
  const connect = async () => {
    setBusy(true);
    try { await connectWorkbench(); toast("Interego identity verified.", { icon: "check" }); }
    catch (e) { toast(e.message || "Interego connection unavailable.", { icon: "warn", ms: 8000 }); }
    finally { setBusy(false); }
  };
  const pairAgent = async (renew = false) => {
    setBusy(true);
    try {
      setInvitation(await (renew ? renewAgentInvitation() : connectAgentSession()));
      toast("Connection request ready. Send it to the agent session you want to use.", { icon: "check", ms: 7000 });
    } catch (e) { toast(e.message || "Could not prepare the agent connection.", { icon: "warn", ms: 8000 }); }
    finally { setBusy(false); }
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
    <button className="btn sm" onClick={() => setOpen(true)}><Icon name="agent" />{agent?.state === "connected" ? "Agent connected" : activeAgent ? "Connect agent" : caps.me ? "Connected" : "Connect"}</button>
    {open ? <Modal title="Connect your workbench" onClose={() => { setOpen(false); setKey(""); }}>
      <div className="stack" style={{ gap: 18 }}>
        <section className="stack" style={{ gap: 12 }} aria-label="Connect an AI agent">
          <h3 style={{ margin: 0 }}>Chat inside the workbench</h3>
          <p className="small">Connect an active agent from your preferred AI client or local companion. The workbench keeps the conversation and source context together; the connected agent supplies the reasoning through its own available model.</p>
          <p className="note small" role="status">{agentLabel}{agent?.pending ? " · Question pending" : ""}{agent?.driverActor ? <><br /><span className="tiny">Verified agent: <code style={{ overflowWrap: "anywhere" }}>{agent.driverActor}</code></span></> : null}</p>
          <p className="tiny muted">Questions you submit and their selected content are shared with the agent you explicitly connect. No provider API key is requested. This temporary connection does not publish learner records or save the conversation to a pod. The agent must remain active; a subscription alone does not create an unattended service.</p>
          <div className="row wrap">
            {!activeAgent ? <button className="btn primary" disabled={busy} onClick={() => pairAgent()}>{busy ? "Preparing…" : "Connect an AI agent"}</button>
              : <button className="btn" disabled={busy || agent.pending} onClick={() => pairAgent(true)}>{agent.state === "connected" ? "Replace connected agent" : "New connection request"}</button>}
            {activeAgent ? <button className="btn" disabled={busy} onClick={closeAgent}>Disconnect agent</button> : null}
          </div>
          {invitation && agent?.state === "waiting_for_agent" ? <div className="stack" style={{ gap: 10 }}>
            <p className="small">Copy this one-use request into the agent conversation you want to connect. That client needs the Interego connection and signed action support. Only that session is invited to receive your workbench questions.</p>
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

