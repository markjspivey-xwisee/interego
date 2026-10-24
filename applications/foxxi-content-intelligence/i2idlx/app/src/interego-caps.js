// Optional Interego capabilities for the Railway-hosted workbench.
// A host may provide signRequest + sample through its existing MCP connection.
// No host identity claim is trusted: /session verifies the signature and returns the account.
import { backendUrl, workbenchHosted } from "./backend-url.js";
import { isChatGPTApp, connectHost, getHostState, subscribeHost, downloadWorkbenchFile } from "./chatgpt-host.js";
const hosted = workbenchHosted;
let connected = null, personalSample = null;
const announce = () => window.dispatchEvent(new Event("interego-workbench:changed"));
const failure = (message, code = "unavailable") => Object.assign(new Error(message), { code });
const json = async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw failure(data.error || "Workbench request failed.", data.code || (r.status === 409 ? "conflict" : "unavailable"));
  return data;
};
const downloads = { async save({ filename, data }) {
  if (typeof filename !== "string" || /[\\/\x00]/.test(filename)) throw failure("Invalid filename.");
  const blob = new Blob([typeof data === "string" ? data : JSON.stringify(data)], { type: "application/octet-stream" });
  const href = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = href; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
} };
const appDownloads = { save: downloadWorkbenchFile };
if (isChatGPTApp()) {
  let available = false;
  subscribeHost(state => {
    const next = state.status === "ready" && state.canDownload;
    if (next !== available) { available = next; announce(); }
  });
}
async function walletSigner() {
  const provider = window.ethereum;
  if (!provider || typeof provider.request !== "function") throw failure("Connect Interego in your AI client, or install a browser wallet and connect an existing Interego pod.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const account = accounts && accounts[0];
  if (!/^0x[a-f0-9]{40}$/i.test(account || "")) throw failure("The wallet did not provide a valid account.");
  const sign = async (payload) => {
    const _signed_payload = JSON.stringify({ ...payload, agent_id: "did:ethr:" + account, timestamp: new Date().toISOString() });
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(_signed_payload)));
    const digest = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
    const message = "sha256:" + digest;
    const hex = "0x" + [...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const _signature = await provider.request({ method: "personal_sign", params: [hex, account] });
    return { _signed_payload, _signature };
  };
  // This asks the actual owning wallet, never an unsigned document in storage.
  // Extensions without this capability cannot persist shared or private documents here.
  try {
    const key = await provider.request({ method: "eth_getEncryptionPublicKey", params: [account] });
    if (/^[A-Za-z0-9+/]{43}=$/.test(key || "")) sign.ownerEncryptionKey = key;
  } catch { /* pod saves stay unavailable unless an owner-held key is available */ }
  return sign;
}
function dbAdapter(call, poll) {
  const etags = new Map(), listeners = new Map();
  let sharedJob = null;
  const snap = (id, value) => ({ id, exists: value.exists, data: () => value.data, metadata: { fromCache: false, hasPendingWrites: false } });
  const readShared = () => {
    if (!sharedJob) {
      sharedJob = call("read", { collection: "all" }).then((v) => {
        for (const name of ["ballots", "notes", "usage"]) for (const doc of v[name].docs) etags.set(name + "/" + doc.id, doc.etag);
        etags.set("settings/policy", v.policy.etag);
        return v;
      }).finally(() => { setTimeout(() => { sharedJob = null; }, 250); });
    }
    return sharedJob;
  };
  const readDoc = async (path) => {
    if (path === "settings/policy") return snap("policy", (await readShared()).policy);
    const v = await call("read", { doc_path: path }); etags.set(path, v.etag);
    return snap(path.split("/").pop(), v);
  };
  const subscribe = (key, load, onValue, onError) => {
    let live = true, loading = false;
    const run = async () => {
      if (!live || loading) return;
      loading = true;
      try { const v = await load(); if (live) onValue(v); } catch (e) { if (live && onError) onError(e); }
      finally { loading = false; }
    };
    let bucket = listeners.get(key); if (!bucket) listeners.set(key, bucket = new Set());
    bucket.add(run); run();
    const timer = poll ? setInterval(run, 20000) : null;
    return () => { live = false; if (timer) clearInterval(timer); bucket.delete(run); };
  };
  return {
    collection(name) {
      return { onSnapshot(cb, err) { return subscribe(name, async () => ({ docs: (await readShared())[name].docs.map((d) => snap(d.id, d)) }), cb, err); } };
    },
    doc(path) {
      return {
        get: () => readDoc(path),
        onSnapshot(cb, err) { return subscribe(path, () => readDoc(path), cb, err); },
        async set(document) {
          if (!etags.has(path)) throw failure("Read this document before writing it.", "needs_read");
          const v = await call("write", { doc_path: path, document, expected_etag: etags.get(path) === null ? '' : etags.get(path) });
          etags.set(path, v.etag); sharedJob = null;
          for (const key of [path, path.split("/")[0]]) for (const run of listeners.get(key) || []) run();
          return v;
        },
      };
    },
  };
}
export async function connectWorkbench() {
  if (!hosted()) throw failure("Interego connection is available on the hosted workbench.");
  const catalog = await json(await fetch(backendUrl("/i2idlx/capabilities"), { cache: "no-store" }));
  const sessionLink = catalog._affordances.find((a) => a.action === "urn:iep:action:foxxi:i2idlx-session");
  if (!sessionLink) throw failure("Workbench did not advertise a verified session operation.");
  const base = catalog.audience;
  if (typeof base !== "string" || !base) throw failure("Workbench did not advertise its signing audience.");
  const host = window.interegoWorkbench;
  const hostSigner = host && typeof host.signRequest === "function";
  const sign = hostSigner ? (payload) => host.signRequest(payload) : await walletSigner();
  const ownerEncryptionKey = hostSigner ? (typeof host.getOwnerEncryptionKey === "function" ? await host.getOwnerEncryptionKey() : host.ownerEncryptionKey) : sign.ownerEncryptionKey;
  const call = async (operation, args) => {
    const signed = await sign({ ...args, ...(ownerEncryptionKey && (operation === "session" || (operation === "write")) ? { owner_encryption_key: ownerEncryptionKey } : {}), i2idlx_operation: operation, bridge_audience: base });
    if (!signed || typeof signed._signed_payload !== "string" || typeof signed._signature !== "string") throw failure("Interego did not return an author-signed request.");
    const link = catalog._affordances.find((a) => a.action === "urn:iep:action:foxxi:i2idlx-" + operation);
    if (!link) throw failure("Workbench operation was not advertised.");
    return json(await fetch(link.href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed) }));
  };
  const challengeLink = catalog._affordances.find((a) => a.action === "urn:iep:action:foxxi:i2idlx-challenge");
  if (!challengeLink) throw failure("Workbench did not advertise a sign-in challenge.");
  const challenge = await json(await fetch(challengeLink.href, { cache: "no-store" }));
  const session = await call("session", { nonce: challenge.nonce });
  const me = { ...session.me, sharedRead: session.sharedRead, sharedWrite: session.sharedWrite, privateWrite: session.canWrite && session.privateEncryption };
  const user = {
    me: async () => me,
    can: async (scope) => scope === "data.write" && session.canWrite,
    profiles: async (ids) => Object.fromEntries(ids.map((id) => [id, { id, name: id }])),
  };
  // A subscription is available only when the connected client provides REAL sampling.
  // This page never pays for a model on behalf of a viewer.
  const sample = hostSigner && typeof host.sample === "function" ? host.sample.bind(host) : null;
  if (sample) sample.modelTiers = host.sample.modelTiers !== false;
  if (sample && typeof host.sample.limits === "function") sample.limits = () => host.sample.limits();
  else if (sample) sample.limits = async () => ({ tools: false });
  connected = { db: dbAdapter(call, !!hostSigner), user, sample, downloads, identity: me, status: session, host: !!hostSigner };
  announce();
  return me;
}
export function disconnectWorkbench() { connected = null; personalSample = null; announce(); }
export async function resolveWorkbenchCap(name) {
  if (isChatGPTApp() && name === "downloads") {
    const current = getHostState();
    // A torn-down or failed host must not be reconnected by a capability refresh.
    const state = current.status === "unavailable" && current.error ? current : await connectHost();
    return state.status === "ready" && state.canDownload ? appDownloads : null;
  }
  if (!hosted()) return undefined; // preserve the original Claude artifact's own capability environment
  if (name === "downloads") return downloads;
  if (name === "sample") return (connected && connected.sample) || personalSample;
  return connected ? connected[name] || null : null;
}
export function workbenchConnectionStatus() {
  return { hosted: hosted(), me: connected && connected.identity, subscription: !!(connected && connected.sample), apiKey: !!personalSample };
}
/** Optional API fallback. The key is held ONLY in this tab's closure and sent to the model provider. */
export function usePersonalApiKey(key, model) {
  if (typeof key !== "string" || !key.trim() || typeof model !== "string" || !model.trim()) throw failure("Enter your own API key and model name.");
  const token = key.trim(), modelName = model.trim();
  const sample = async (input, opts = {}) => {
    const messages = input.map((m) => ({ role: m.role, content: m.content }));
    const tools = Array.isArray(opts.tools) ? opts.tools : [];
    for (let step = 0; step < 12; step++) {
      if (opts.signal && opts.signal.aborted) throw failure("Cancelled.", "cancelled");
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal: opts.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ model: modelName, messages, ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}) }),
      });
      if (!response.ok) throw failure("Your model provider returned HTTP " + response.status + ".", response.status === 429 ? "rate_limited" : "unavailable");
      const body = await response.json(), message = body.choices && body.choices[0] && body.choices[0].message;
      if (!message) throw failure("Your model provider did not return an answer.");
      if (!message.tool_calls || !message.tool_calls.length) {
        const text = typeof message.content === "string" ? message.content : "";
        if (opts.onText) opts.onText({ text });
        return { text, truncated: body.choices[0].finish_reason === "length" };
      }
      messages.push(message);
      for (const request of message.tool_calls) {
        const tool = tools.find((t) => t.name === request.function.name);
        let result;
        try {
          if (!tool) throw new Error("Unadvertised tool.");
          result = await tool.execute(JSON.parse(request.function.arguments));
        } catch (e) { result = { error: e.message || "Tool failed." }; }
        messages.push({ role: "tool", tool_call_id: request.id, content: typeof result === "string" ? result : JSON.stringify(result) });
      }
    }
    throw failure("The model reached this page's tool-call limit. Ask for a smaller task.");
  };
  sample.modelTiers = false;
  sample.limits = async () => ({ tools: { maxCount: 30 } });
  personalSample = sample; announce();
}
export function clearPersonalApiKey() { personalSample = null; announce(); }
