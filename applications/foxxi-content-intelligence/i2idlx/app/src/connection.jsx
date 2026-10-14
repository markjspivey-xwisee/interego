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
        <div className="small muted">In ChatGPT, Claude, or another supported AI client, connect Interego and open this workbench through the connected client. A browser wallet signs as its existing account. This page does not create accounts.</div>
        <b>Ask and Orchestrate</b>
        <p className="small">{status.subscription ? "Your connected client supplies the model through your existing subscription." : "No model is connected here. Connect this workbench through your AI client, or use your own API key below. Browsing and local packs remain available."}</p>
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
