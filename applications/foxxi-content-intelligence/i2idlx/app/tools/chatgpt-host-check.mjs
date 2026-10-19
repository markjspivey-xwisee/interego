// Run: node --experimental-vm-modules app/tools/chatgpt-host-check.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../src/chatgpt-host.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(condition, description) { assert.ok(condition, description); checks++; }

async function fixture({ embedded = true, caps, hostContext, hostVersion = "26.1017.11052", auto = true } = {}) {
  const handlers = new Set(), sent = [], timers = new Map(), css = new Map(), nodes = new Map();
  let timerId = 0;
  const root = { dataset: {}, style: { setProperty: (k, v) => css.set(k, v), removeProperty: (k) => css.delete(k) } };
  const document = { documentElement: root, body: { getBoundingClientRect: () => ({ height: 700 }) },
    head: { append: (node) => nodes.set(node.id, node) }, getElementById: (id) => nodes.get(id), createElement: () => ({}) };
  const window = { __I2IDLX_CHATGPT_APP__: embedded,
    addEventListener: (_, handler) => handlers.add(handler), removeEventListener: (_, handler) => handlers.delete(handler) };
  const context = vm.createContext({ window, document, console,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id) });
  function receive(message, from = window.parent) {
    for (const handler of [...handlers]) handler({ source: from, data: message });
  }
  function respond(request, result) { receive({ jsonrpc: "2.0", id: request.id, result }); }
  window.parent = embedded ? { postMessage: (message, origin) => {
    sent.push(plain(message)); assert.equal(origin, "*");
    if (auto && message.method === "ui/initialize") queueMicrotask(() => respond(message, {
      protocolVersion: "2026-01-26", hostInfo: { name: "ChatGPT", version: hostVersion },
      hostCapabilities: caps || { message: { text: {} }, serverTools: {}, updateModelContext: { text: {}, structuredContent: {} }, experimental: { "openai/message": {} } },
      hostContext: hostContext || { platform: "web", theme: "dark", availableDisplayModes: ["inline", "fullscreen"], safeAreaInsets: { top: 12, right: 3, bottom: 8, left: 3 }, styles: { variables: { "--color-text-primary": "#fafafa" } } },
    }));
  } } : window;
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => { throw new Error("No dependencies expected."); }); await module.evaluate();
  return { api: module.namespace, sent, receive, respond, timers, css, root, nodes, window,
    flush: async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); } };
}

{
  const f = await fixture({ embedded: false });
  check(!f.api.isChatGPTApp(), "Normal website is not a ChatGPT app");
  check(f.window.__APP_URL__ === undefined, "Normal website share URL is unchanged");
  assert.equal((await f.api.connectHost()).status, "unavailable"); checks++;
  assert.equal(await f.api.updateModelContext({ page: "ask" }), null); checks++;
  await assert.rejects(f.api.sendConversation("Question"), /inside ChatGPT/); checks++;
  check(f.sent.length === 0, "Normal website sends no host messages");
}
{
  const f = await fixture();
  const snapshots = [], unsubscribe = f.api.subscribeHost((state) => snapshots.push(state));
  await Promise.all([f.api.connectHost(), f.api.connectHost()]);
  check(f.window.__APP_URL__ === "https://foxxi-bridge.interego.xwisee.com/i2idlx/", "Embedded app shares the deployed workbench URL");
  check(f.sent.filter((m) => m.method === "ui/initialize").length === 1, "Concurrent callers share one handshake");
  assert.deepEqual(f.sent[0].params, { appInfo: { name: "I2IDL-X Workbench", version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] }, protocolVersion: "2026-01-26" }); checks++;
  check(f.sent[1].method === "ui/notifications/initialized", "Initialized follows successful negotiation");
  check(f.api.getHostState().canMessage && f.api.getHostState().canCallTools, "Capabilities enable conversation and tools");
  check(f.root.dataset.theme === "dark" && f.css.get("--safe-area-top") === "12px", "Theme and safe areas applied");
  check(f.css.get("--color-text-primary") === "#fafafa", "Host style variables applied");
  f.receive({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light", safeAreaInsets: { bottom: -4 } } });
  check(f.api.getHostState().hostContext.platform === "web" && f.root.dataset.theme === "light", "Partial host update preserves unrelated fields");
  check(f.css.get("--safe-area-bottom") === "0px" && !f.css.has("--safe-area-top"), "Safe areas clamp and clear omitted edges");
  f.receive({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { availableDisplayModes: false } });
  check(!f.api.getHostState().canFullscreen && f.api.getHostState().hostContext.platform === "web", "Malformed display capability is disabled without losing previous host context");
  f.receive({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { availableDisplayModes: ["inline", "fullscreen"] } });

  const message = f.api.sendConversation("Use the selected canonical concept."); await f.flush();
  const request = f.sent.at(-1);
  check(request.method === "ui/message" && Array.isArray(request.params.content), "Conversation uses content array");
  assert.deepEqual(request.params._meta, { "openai/message": { target: "active", send: true } }); checks++;
  let settled = false; message.then(() => { settled = true; });
  f.receive({ jsonrpc: "2.0", id: request.id, result: {} }, {}); await f.flush();
  check(!settled, "Untrusted window cannot spoof a message receipt");
  f.respond(request, {}); assert.deepEqual(plain(await message), {}); checks++;
  check(f.api.getHostState().lastToolResult === null, "Message receipt is never invented as a model or tool answer");

  const update = f.api.updateModelContext({ page: "glossary", selected: ["mentorship"] }, [{ type: "text", text: "Selected definition" }]); await f.flush();
  const updateRequest = f.sent.at(-1);
  check(updateRequest.method === "ui/update-model-context" && updateRequest.params.structuredContent.page === "glossary", "Context preserves structured state and explicit attachment");
  f.respond(updateRequest, {}); await update;

  const tool = f.api.callWorkbenchTool("i2idlx_classify", { triples: "actual input" }); await f.flush();
  const toolRequest = f.sent.at(-1); assert.equal(toolRequest.method, "tools/call"); checks++;
  const result = { content: [{ type: "text", text: "Zero conflicts" }], structuredContent: { conflicts: 0 } };
  f.respond(toolRequest, result); assert.deepEqual(plain(await tool), result); checks++;
  assert.deepEqual(plain(f.api.getHostState().lastToolResult), result); checks++;
  const notified = { content: [], structuredContent: { sourceVersion: "v0.0.93" } };
  f.receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: notified });
  assert.deepEqual(plain(f.api.getHostState().lastToolResult), notified); checks++;
  f.receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { invented: true } } });
  assert.deepEqual(plain(f.api.getHostState().lastToolResult), notified); checks++;

  const full = f.api.requestFullscreen(); await f.flush();
  check(f.sent.at(-1).method === "ui/request-display-mode", "Fullscreen request uses MCP Apps method");
  f.respond(f.sent.at(-1), { mode: "inline" }); await full;
  check(f.api.getHostState().hostContext.displayMode === "inline", "Actual host display mode is respected");
  const canceled = f.api.sendConversation("A pending task"); await f.flush();
  f.receive({ jsonrpc: "2.0", id: "host-teardown", method: "ui/resource-teardown", params: {} });
  await assert.rejects(canceled, /closed/); checks++;
  check(f.api.getHostState().status === "unavailable" && f.timers.size === 0, "Teardown rejects pending operations and clears timers");
  unsubscribe(); check(snapshots.some((s) => s.status === "connecting") && snapshots.some((s) => s.status === "ready"), "Subscribers see connection lifecycle");
  check(!f.sent.some((m) => m.method === "sampling/createMessage"), "No sampling or invented subscription model API");
}
{
  const f = await fixture({ caps: { updateModelContext: { text: {} } } }); await f.api.connectHost();
  await assert.rejects(f.api.sendConversation("Question"), /does not support/); checks++;
  await assert.rejects(f.api.callWorkbenchTool("classify", {}), /does not support/); checks++;
  const context = f.api.updateModelContext({ page: "ask" }); await f.flush();
  const request = f.sent.at(-1);
  check(request.params.content[0].annotations.audience[0] === "assistant" && !request.params.structuredContent, "Text-only context host gets explicit background state fallback");
  f.respond(request, {}); await context;
}
{
  const f = await fixture({ caps: { message: { text: {} } } }); await f.api.connectHost();
  const send = f.api.sendConversation("Standard MCP Apps message"); await f.flush();
  check(!f.sent.at(-1).params._meta, "OpenAI extension metadata omitted when not advertised");
  f.respond(f.sent.at(-1), { isError: true }); await assert.rejects(send, /could not complete/); checks++;
  check(!!f.api.getHostState().error, "Host refusal remains visible to the UI");
}
for (const value of [false, true, "enabled", []]) {
  const f = await fixture({ caps: { message: { text: value }, serverTools: value, updateModelContext: { text: value, structuredContent: value }, experimental: { "openai/message": value } } });
  await f.api.connectHost();
  check(!f.api.getHostState().canMessage && !f.api.getHostState().canCallTools && !f.api.getHostState().canUpdateModelContext, "False or malformed capabilities cannot enable actions: " + JSON.stringify(value));
  const before = f.sent.length;
  await assert.rejects(f.api.sendConversation("Question"), /does not support/); checks++;
  await assert.rejects(f.api.callWorkbenchTool("i2idlx_classify", {}), /does not support/); checks++;
  assert.equal(await f.api.updateModelContext({ page: "ask" }), null); checks++;
  check(f.sent.length === before, "Unsupported actions emit no request");
}
{
  const f = await fixture({ caps: { message: { text: {} }, experimental: { "openai/message": false } } }); await f.api.connectHost();
  const send = f.api.sendConversation("Standard message only"); await f.flush();
  check(!f.sent.at(-1).params._meta, "Explicit false OpenAI message extension cannot add extension metadata");
  f.respond(f.sent.at(-1), {}); await send;
}
{
  const f = await fixture({ auto: false }); const connect = f.api.connectHost();
  const timer = [...f.timers.values()][0]; check(timer.ms === 12000, "Initialization has bounded timeout");
  timer.fn(); await connect;
  check(f.api.getHostState().status === "unavailable" && /in time/.test(f.api.getHostState().error), "Timeout fails visibly without claiming connection");
  check(!f.sent.some((m) => m.method === "ui/notifications/initialized"), "Failed negotiation sends no initialized notification");
}
{
  const f = await fixture({ auto: false }); const connect = f.api.connectHost();
  f.respond(f.sent[0], { protocolVersion: "unsupported", hostInfo: { name: "host", version: "1" }, hostCapabilities: {}, hostContext: {} });
  await connect;
  check(f.api.getHostState().status === "unavailable" && /unsupported/.test(f.api.getHostState().error), "Invalid negotiated protocol cannot enable the app");
}
{
  const f = await fixture(); await f.api.connectHost();
  const send = f.api.sendConversation("Actual delivery only"); await f.flush();
  f.respond(f.sent.at(-1), null); await assert.rejects(send, /invalid response/); checks++;
  const tool = f.api.callWorkbenchTool("i2idlx_classify", {}); await f.flush();
  f.respond(f.sent.at(-1), { structuredContent: { invented: true } });
  await assert.rejects(tool, /invalid workbench tool result/); checks++;
  check(f.api.getHostState().lastToolResult === null, "Malformed tool result is never recorded as actual evidence");
}
{
  const f = await fixture({ hostContext: { platform: "desktop" }, hostVersion: "26.900.1" });
  await f.api.connectHost();
  check(f.api.getHostState().status === "unavailable" && /Update ChatGPT Desktop/.test(f.api.getHostState().error), "Older desktop receives actionable upgrade state");
}
console.log(JSON.stringify({ ok: true, checks, scope: "Isolated MCP Apps transport, capability, lifecycle and truthful-result checks; not a real ChatGPT host acceptance test." }));
