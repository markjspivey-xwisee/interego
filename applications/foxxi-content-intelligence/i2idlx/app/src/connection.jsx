import { useCaps } from "./caps.js";
import { Icon } from "./icons.jsx";
import { Modal, useUI } from "./ui.jsx";
import { connectWorkbench, disconnectWorkbench, workbenchConnectionStatus, usePersonalApiKey, clearPersonalApiKey } from "./interego-caps.js";
const { useState } = React;
export function WorkbenchConnection() {
  const caps = useCaps(), { toast } = useUI();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [key, setKey] = useState(""), [model, setModel] = useState("");
  const status = workbenchConnectionStatus();
  if (!status.hosted) return null;
  const connect = async () => {
    setBusy(true);
    try { await connectWorkbench(); toast("Interego identity verified.", { icon: "check" }); }
    catch (e) { toast(e.message || "Interego connection unavailable.", { icon: "warn", ms: 8000 }); }
    finally { setBusy(false); }
  };
  const addKey = () => {
    try { usePersonalApiKey(key, model); setKey(""); setOpen(false); toast("Your API key is available in this tab.", { icon: "check" }); }
    catch (e) { toast(e.message, { icon: "warn" }); }
  };
  return <>
    <button className="btn sm" onClick={() => setOpen(true)}><Icon name="agent" />{caps.me ? "Connected" : "Connect"}</button>
    {open ? <Modal title="Connect Interego" onClose={() => { setOpen(false); setKey(""); }}>
      <div className="stack" style={{ gap: 14 }}>
        <p>Connect an existing Interego identity to keep your work across devices. Shared reviews are signed as you and encrypted for admitted participants. Private packs and stars are encrypted on your own pod.</p>
        {caps.me ? <div className="note"><b>{caps.me.name}</b><div className="small"><code>{caps.me.did}</code></div>{caps.me.privateWrite === false ? <div className="small muted">Encrypted pod saves are unavailable until your connected client or wallet supplies its owned encryption key. Edits remain in this browser.</div> : null}</div>
          : <button className="btn primary" disabled={busy} onClick={connect}>{busy ? "Verifying…" : "Connect Interego or browser wallet"}</button>}
        <div className="small muted">Your connected MCP client can invoke the public task operations below. Browser pod identity requires a host signing adapter or a browser wallet with an existing account. This page does not create accounts.</div>
        <b>Ask and Orchestrate in your AI client</b>
        <p className="small">Connect the Interego MCP app in ChatGPT, Claude, or your other AI client. Ask it: “Discover the I2IDL-X Ask operation through Interego, follow it with my question, then answer using the returned glossary context and instructions.” For the eight-role walkthrough, ask: “Discover I2IDL-X Orchestrate, follow it with example set to true, and execute the returned recipe with your own model. Report which checks you actually run.”</p>
        <p className="tiny muted">These operations return public context and a task for your client. This server runs no model and publishes nothing. <a href="/i2idlx/capabilities" target="_blank" rel="noreferrer">Connection controls</a></p>
        <b>Run inside this page</b>
        <p className="small">{status.subscription ? "Your connected client supplies the model through your existing subscription." : "No browser model is connected here. The MCP workflow above works in your connected AI conversation. Running inside this page requires a host that supplies the sampling adapter, or your own API key below. Browsing and local packs remain available."}</p>
        <label className="stack small">Your OpenAI API key<input className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></label>
        <label className="stack small">Model name<input className="input" autoComplete="off" value={model} placeholder="A model available on your API account" onChange={(e) => setModel(e.target.value)} /></label>
        <p className="tiny muted">API use is billed to your account. Your key stays in this tab and goes directly to OpenAI. It is never sent to this workbench's server or saved in browser storage.</p>
        <div className="row wrap">
          <button className="btn" disabled={!key.trim() || !model.trim()} onClick={addKey}>Use my API key</button>
          {status.apiKey ? <button className="btn" onClick={() => { clearPersonalApiKey(); setKey(""); toast("API key removed from this tab."); }}>Remove API key</button> : null}
          {caps.me ? <button className="btn" onClick={() => { disconnectWorkbench(); setKey(""); setOpen(false); toast("Disconnected."); }}>Disconnect</button> : null}
        </div>
        {caps.dbError ? <p className="note warn small">Some pod data is unavailable. Unconfirmed changes remain held in this browser until a verified save succeeds.</p> : null}
      </div>
    </Modal> : null}
  </>;
}
