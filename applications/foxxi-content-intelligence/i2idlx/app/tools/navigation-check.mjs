// Exercise the actual route store and link adapter without a browser that can
// accidentally make forbidden srcdoc fragment navigation look successful.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/navigation.js", import.meta.url), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const { createNavigation, installFragmentNavigation } = await import(moduleUrl);
const main = readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const tabFragments = [...main.match(/const NAV = \[([\s\S]*?)\];/)[1].matchAll(/h: "([^"]+)"/g)].map(match => "#" + match[1]);
assert.equal(tabFragments.length, 12, "Cover every current top-level tab");

function windowFixture({ app = false, opaque = false } = {}) {
  let hash = "#home", reads = 0, writes = 0, dispatched = 0;
  const listeners = new Map();
  const location = {
    get hash() { reads++; if (opaque) throw new Error("Opaque srcdoc URL cannot be read"); return hash; },
    set hash(value) { writes++; if (opaque) throw new Error("Sandbox navigation is forbidden"); hash = value; },
  };
  const host = {
    __I2IDLX_CHATGPT_APP__: app, location,
    HashChangeEvent: class { constructor(type) { this.type = type; } },
    addEventListener(type, handler) { const set = listeners.get(type) || new Set(); set.add(handler); listeners.set(type, set); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    dispatchEvent(event) { dispatched++; for (const handler of listeners.get(event.type) || []) handler(event); },
  };
  return { host, get hash() { return hash; }, get reads() { return reads; }, get writes() { return writes; },
    get dispatched() { return dispatched; }, listeners,
    externalHash(value) { hash = value; host.dispatchEvent({ type: "hashchange" }); } };
}

function documentFixture() {
  let handler = null;
  return {
    doc: {
      addEventListener(type, callback, options) {
        assert.equal(type, "click"); assert.ok(!options, "React bubble handlers run before this document listener"); handler = callback;
      },
      removeEventListener(type, callback) { assert.equal(type, "click"); if (handler === callback) handler = null; },
    },
    click(href, { target = null, download = false, textTarget = false, svgTarget = false, ...extra } = {}) {
      const anchor = { getAttribute: name => name === "href" ? href : name === "target" ? target : null, hasAttribute: name => name === "download" && download };
      const element = { nodeType: 1, closest(selector) { assert.equal(selector, "a[href]"); return anchor; } };
      const event = { button: 0, defaultPrevented: false, target: textTarget ? { nodeType: 3, parentElement: element } : svgTarget ? { nodeType: 1, closest: element.closest } : element,
        preventDefault() { this.defaultPrevented = true; }, ...extra };
      handler?.(event); return event;
    },
  };
}

// All tabs, concept links, and repeated routes work when URL reads and writes
// throw, matching an opaque frame with no navigation privileges.
const opaque = windowFixture({ app: true, opaque: true });
const app = createNavigation(opaque.host), updates = [];
assert.equal(app.getHash(), "#home");
const off = app.subscribe(value => updates.push(value));
const document = documentFixture();
const uninstall = installFragmentNavigation(document.doc, value => app.go(value));
const initialReads = opaque.reads;
for (const hash of [...tabFragments, "#home", "#for-i2idl", "#c-learning-record-store-lrs"]) {
  const event = document.click(hash, { svgTarget: true });
  assert.ok(event.defaultPrevented, hash + " cannot navigate the host document");
  assert.equal(app.getHash(), hash, hash + " updates the route directly");
  assert.equal(updates.at(-1), hash);
}
const repeated = updates.length;
document.click("#c-learning-record-store-lrs", { textTarget: true });
assert.equal(updates.length, repeated + 1, "Repeating a route still notifies subscribers");
assert.equal(opaque.writes, 0, "App navigation never writes a sandbox URL");
assert.equal(opaque.reads, initialReads, "App routing does not reread an inaccessible URL");
opaque.externalHash("#home");
assert.equal(app.getHash(), "#c-learning-record-store-lrs", "A host URL event cannot replace the App's in-memory route");
assert.equal(opaque.reads, initialReads);

// The App owns only ordinary fragment clicks. Custom React click handlers,
// external links, downloads, and modified/new-tab actions stay with the host.
const stable = updates.length;
for (const [href, options] of [
  ["https://example.org/#ask", {}], ["/i2idlx/#ask", {}], ["mailto:owner@example.org", {}],
  ["#ask", { defaultPrevented: true }], ["#ask", { button: 1 }], ["#ask", { button: 2 }],
  ["#ask", { ctrlKey: true }], ["#ask", { metaKey: true }], ["#ask", { altKey: true }], ["#ask", { shiftKey: true }],
  ["#ask", { target: "_blank" }], ["#ask", { target: "_parent" }], ["#ask", { download: true }],
]) {
  const event = document.click(href, options);
  assert.equal(event.defaultPrevented, !!options.defaultPrevented, href + " retains its existing action");
}
assert.equal(updates.length, stable, "Ignored clicks cannot change App routes");
assert.ok(document.click("#ask", { target: "_self" }).defaultPrevented);
uninstall(); document.click("#home"); assert.equal(app.getHash(), "#ask", "Unmount removes the link adapter");
off(); assert.equal(opaque.listeners.get("hashchange").size, 0, "Last subscriber removes its browser listener");

// Normal Site go() still creates native fragment history, and Back/Forward
// hashchange events still update the route. No in-memory redirect replaces it.
const siteWindow = windowFixture(), site = createNavigation(siteWindow.host), siteUpdates = [];
const stopSite = site.subscribe(value => siteUpdates.push(value));
site.go("interventions");
assert.equal(siteWindow.hash, "#interventions"); assert.equal(siteWindow.writes, 1);
assert.deepEqual(siteUpdates, ["#home"], "Wait for the native Site hashchange");
siteWindow.host.dispatchEvent({ type: "hashchange" });
assert.equal(siteUpdates.at(-1), "#interventions");
siteWindow.externalHash("#home"); assert.equal(siteUpdates.at(-1), "#home", "Browser Back updates Site route");
siteWindow.externalHash("#interventions"); assert.equal(siteUpdates.at(-1), "#interventions", "Browser Forward updates Site route");
const beforeRepeat = siteUpdates.length, beforeDispatch = siteWindow.dispatched;
site.go("#interventions");
assert.equal(siteUpdates.length, beforeRepeat + 1); assert.equal(siteWindow.dispatched, beforeDispatch + 1);
assert.equal(siteWindow.writes, 1, "Repeating a Site fragment creates no history entry");
stopSite();

// Exercise util.js too: orchestration routeTarget takes precedence, while the
// actual React hook receives the route store update without a hashchange event.
const saved = { window: globalThis.window, React: globalThis.React };
const effects = [], hookUpdates = [], hookWindow = windowFixture({ app: true, opaque: true });
try {
  globalThis.window = hookWindow.host;
  globalThis.React = { useState: value => [typeof value === "function" ? value() : value, next => hookUpdates.push(next)],
    useEffect: effect => effects.push(effect), createContext: () => ({}) };
  const utilSource = readFileSync(new URL("../src/util.js", import.meta.url), "utf8").replace('"./navigation.js"', JSON.stringify(moduleUrl));
  const util = await import("data:text/javascript;base64," + Buffer.from(utilSource).toString("base64"));
  assert.deepEqual(util.useRoute(), { view: "home" });
  const cleanup = effects[0]();
  util.go("interventions"); assert.deepEqual(hookUpdates.at(-1), { view: "interventions" });
  const delegated = [], beforeDelegation = hookUpdates.length;
  util.setRouteTarget(value => delegated.push(value)); util.go("browse");
  assert.deepEqual(delegated, ["#browse"]); assert.equal(hookUpdates.length, beforeDelegation, "Orchestration retains its own frame route");
  util.setRouteTarget(null); util.go("c-learning-record-store-lrs");
  assert.deepEqual(hookUpdates.at(-1), { view: "lexicon", id: "learning-record-store-lrs" });
  assert.equal(hookWindow.writes, 0); cleanup();
} finally {
  globalThis.window = saved.window; globalThis.React = saved.React;
}

console.log("Navigation checks passed: all 12 tabs in an opaque App, link ownership, cleanup, Site history, React updates, and orchestration routing.");
