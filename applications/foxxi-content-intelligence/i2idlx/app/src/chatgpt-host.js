// MCP Apps bridge for the embedded workbench. This is a conversation bridge,
// not an LLM sampling adapter: message receipts never represent model answers.
const PROTOCOL = "2026-01-26";
const MIN_DESKTOP = "26.928.20710";
const listeners = new Set();
const pending = new Map();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
let nextId = 0, connection = null, listening = false, initialized = false;
let capabilities = {}, resizeObserver = null;
let state = {
  status: "unavailable", canMessage: false, canCallTools: false,
  canUpdateModelContext: false, canFullscreen: false, canDownload: false,
  error: null, hostContext: {}, lastToolResult: null,
};

export const isChatGPTApp = () => typeof window !== "undefined" && !!window.__I2IDLX_CHATGPT_APP__;
if (isChatGPTApp()) window.__APP_URL__ = "https://foxxi-bridge.interego.xwisee.com/i2idlx/";
export const getHostState = () => ({ ...state, hostContext: { ...state.hostContext } });

export function subscribeHost(listener) {
  listeners.add(listener);
  listener(getHostState());
  return () => listeners.delete(listener);
}

function publish(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    try { listener(getHostState()); } catch { /* One UI subscriber cannot break transport. */ }
  }
}

function post(message) {
  window.parent.postMessage(message, "*");
}

function notify(method, params) {
  post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
}

function rpc(method, params, timeout = 30000) {
  const id = "i2idlx-app-" + ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("ChatGPT did not respond to " + method + " in time. Try again."));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    try { post({ jsonrpc: "2.0", id, method, params }); }
    catch (error) {
      clearTimeout(timer); pending.delete(id); reject(error);
    }
  });
}

function finishPending(error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer); entry.reject(error);
  }
  pending.clear();
}

function unavailable(error) {
  initialized = false;
  capabilities = {};
  resizeObserver?.disconnect(); resizeObserver = null;
  if (listening) window.removeEventListener("message", receive);
  listening = false;
  finishPending(new Error(error || "This ChatGPT workbench view is unavailable."));
  publish({ status: "unavailable", canMessage: false, canCallTools: false,
    canUpdateModelContext: false, canFullscreen: false, canDownload: false, error: error || null });
}

function applyHost(update) {
  if (!object(update)) return;
  const context = { ...state.hostContext, ...update };
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (update.theme === "light" || update.theme === "dark") {
      root.dataset.theme = update.theme;
      root.style.colorScheme = update.theme;
    }
    for (const [key, value] of Object.entries(update.styles?.variables || {})) {
      if (key.startsWith("--") && typeof value === "string") root.style.setProperty(key, value);
    }
    if (typeof update.styles?.css?.fonts === "string") {
      let fonts = document.getElementById("i2idlx-host-fonts");
      if (!fonts) {
        fonts = document.createElement("style"); fonts.id = "i2idlx-host-fonts";
        document.head.append(fonts);
      }
      fonts.textContent = update.styles.css.fonts;
    }
    if (own(update, "safeAreaInsets")) {
      for (const edge of ["top", "right", "bottom", "left"]) {
        const value = update.safeAreaInsets?.[edge];
        if (typeof value === "number" && Number.isFinite(value)) {
          root.style.setProperty("--safe-area-" + edge, Math.max(0, value) + "px");
        } else root.style.removeProperty("--safe-area-" + edge);
      }
    }
  }
  publish({ hostContext: context,
    canFullscreen: Array.isArray(context.availableDisplayModes) && context.availableDisplayModes.includes("fullscreen") });
}

function receive(event) {
  if (event.source !== window.parent || !object(event.data) || event.data.jsonrpc !== "2.0") return;
  const message = event.data;
  if (typeof message.method === "string") {
    if (own(message, "id")) {
      if (message.method === "ping") post({ jsonrpc: "2.0", id: message.id, result: {} });
      else if (message.method === "ui/resource-teardown") {
        post({ jsonrpc: "2.0", id: message.id, result: {} });
        unavailable("This ChatGPT workbench view was closed.");
      } else post({ jsonrpc: "2.0", id: message.id,
        error: { code: -32601, message: "Unsupported app method" } });
      return;
    }
    if (message.method === "ui/notifications/host-context-changed") applyHost(message.params);
    if (message.method === "ui/notifications/tool-result" && object(message.params) && Array.isArray(message.params.content)) {
      publish({ lastToolResult: message.params });
    }
    if (message.method === "ui/notifications/tool-cancelled") {
      publish({ error: message.params?.reason || "The ChatGPT tool operation was canceled." });
    }
    return;
  }
  const entry = pending.get(message.id);
  if (!entry || own(message, "result") === own(message, "error")) return;
  pending.delete(message.id); clearTimeout(entry.timer);
  if (own(message, "error")) entry.reject(new Error(message.error?.message || "ChatGPT rejected the request."));
  else entry.resolve(message.result);
}

function oldDesktop(hostInfo, context) {
  if (context.platform !== "desktop") return false;
  const version = hostInfo?.version;
  if (typeof version !== "string" || !/^\d+(\.\d+)+/.test(version)) return true;
  const actual = version.split(".").map((v) => parseInt(v, 10));
  const minimum = MIN_DESKTOP.split(".").map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if ((actual[i] || 0) !== minimum[i]) return (actual[i] || 0) < minimum[i];
  }
  return false;
}

function startResize() {
  if (typeof ResizeObserver === "undefined" || typeof document === "undefined") return;
  resizeObserver = new ResizeObserver(() => {
    if (!initialized || state.status !== "ready") return;
    const bounds = document.body.getBoundingClientRect();
    if (Number.isFinite(bounds.height)) {
      try { notify("ui/notifications/size-changed", { height: Math.ceil(bounds.height) }); }
      catch { /* A closed parent must not break layout. */ }
    }
  });
  resizeObserver.observe(document.body);
}

export async function connectHost() {
  if (!isChatGPTApp() || window.parent === window) return getHostState();
  if (state.status === "ready") return getHostState();
  if (connection) return connection;
  connection = (async () => {
    publish({ status: "connecting", error: null });
    if (!listening) { window.addEventListener("message", receive); listening = true; }
    try {
      const result = await rpc("ui/initialize", {
        appInfo: { name: "I2IDL-X Workbench", version: "1.0.0" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        protocolVersion: PROTOCOL,
      }, 12000);
      if (!object(result) || result.protocolVersion !== PROTOCOL ||
          typeof result.hostInfo?.name !== "string" || typeof result.hostInfo?.version !== "string" ||
          !object(result.hostCapabilities) || !object(result.hostContext)) {
        throw new Error("ChatGPT returned an unsupported MCP Apps initialization response.");
      }
      if (oldDesktop(result.hostInfo, result.hostContext)) {
        throw new Error("Update ChatGPT Desktop to version " + MIN_DESKTOP + " or newer to use this workbench.");
      }
      capabilities = result.hostCapabilities;
      notify("ui/notifications/initialized");
      initialized = true;
      applyHost(result.hostContext);
      publish({ status: "ready", error: null,
        canMessage: object(capabilities.message?.text),
        canCallTools: object(capabilities.serverTools),
        canDownload: object(capabilities.downloadFile),
        canUpdateModelContext: object(capabilities.updateModelContext?.text) ||
          object(capabilities.updateModelContext?.structuredContent) });
      startResize();
    } catch (error) { unavailable(error.message || "ChatGPT connection failed."); }
    return getHostState();
  })();
  try { return await connection; } finally { connection = null; }
}

async function ready() {
  await connectHost();
  if (!isChatGPTApp() || !initialized || state.status !== "ready") {
    throw new Error(state.error || "Open the workbench app inside ChatGPT to use this action.");
  }
}

async function action(method, params, timeout) {
  try {
    const result = await rpc(method, params, timeout);
    if (!object(result)) throw new Error("ChatGPT returned an invalid response to " + method + ".");
    if (method === "ui/download-file" && own(result, "isError") && typeof result.isError !== "boolean") throw new Error("ChatGPT returned an invalid download acknowledgement.");
    if (method === "tools/call" && !Array.isArray(result.content)) throw new Error("ChatGPT returned an invalid workbench tool result.");
    if (result?.isError && method !== "tools/call") throw new Error("ChatGPT could not complete " + method + ".");
    publish({ error: null });
    return result;
  } catch (error) { publish({ error: error.message }); throw error; }
}

export async function sendConversation(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Enter a question or task first.");
  await ready();
  if (!state.canMessage) throw new Error("This ChatGPT host does not support app conversation messages.");
  const params = { role: "user", content: [{ type: "text", text }] };
  if (object(capabilities.experimental?.["openai/message"])) {
    params._meta = { "openai/message": { target: "active", send: true } };
  }
  // An empty success result only acknowledges delivery. The answer is in chat.
  return action("ui/message", params);
}

export async function callWorkbenchTool(name, args = {}) {
  await ready();
  if (!state.canCallTools) throw new Error("This ChatGPT host does not support workbench tool calls.");
  if (typeof name !== "string" || !name.trim() || !object(args)) throw new Error("Invalid workbench tool request.");
  const result = await action("tools/call", { name, arguments: args }, 60000);
  publish({ lastToolResult: result });
  return result;
}

const exportMimeType = filename => {
  if (/\.html?$/i.test(filename)) return "text/html;charset=utf-8";
  if (/\.md$/i.test(filename)) return "text/markdown;charset=utf-8";
  if (/\.csv$/i.test(filename)) return "text/csv;charset=utf-8";
  if (/\.jsonld(?:\.json)?$/i.test(filename)) return "application/ld+json";
  if (/\.json$/i.test(filename)) return "application/json";
  if (/\.ttl(?:\.txt)?$/i.test(filename)) return "text/turtle;charset=utf-8";
  return "text/plain;charset=utf-8";
};

// Sandboxed Apps cannot initiate browser anchor downloads. Inline MCP resources
// let the host save these exact bytes without an upload or a server-side record.
export async function downloadWorkbenchFile({ filename, data } = {}) {
  if (typeof filename !== "string" || !filename.trim() || /[\\/\x00]/.test(filename)) throw new Error("Invalid export filename.");
  const text = typeof data === "string" ? data : JSON.stringify(data);
  if (typeof text !== "string") throw new Error("The export has no file contents.");
  await ready();
  if (!state.canDownload) throw new Error("Downloads aren't available in this ChatGPT view. Use Copy to export the current format.");
  return action("ui/download-file", { contents: [{ type: "resource", resource: {
    uri: "file:///" + encodeURIComponent(filename), mimeType: exportMimeType(filename), text,
  } }] }, 60000);
}

export async function updateModelContext(viewState, content = []) {
  if (!isChatGPTApp()) return null;
  await ready();
  if (!state.canUpdateModelContext) return null;
  if (!object(viewState) || !Array.isArray(content)) throw new Error("Invalid workbench model context.");
  const supported = capabilities.updateModelContext;
  const modality = { resource_link: "resourceLink", resource: "resource" };
  const blocks = content.filter((block) => object(block) && object(supported[modality[block.type] || block.type]));
  const params = {};
  if (object(supported.structuredContent)) params.structuredContent = viewState;
  else if (object(supported.text)) blocks.unshift({ type: "text", text: JSON.stringify(viewState), annotations: { audience: ["assistant"] } });
  if (blocks.length || object(supported.text)) params.content = blocks;
  return action("ui/update-model-context", params, 15000);
}

export async function requestFullscreen() {
  if (!isChatGPTApp()) return null;
  await ready();
  if (!state.canFullscreen) return null;
  const result = await action("ui/request-display-mode", { mode: "fullscreen" });
  if (result?.mode) applyHost({ displayMode: result.mode });
  return result;
}
