// Run the actual pre-render component logic with retained browser callbacks.
// A callback can arrive after React clears refs, even before effect cleanup.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function component(path, header, end, bindings, exports) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const start = source.indexOf(header), stop = source.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, "Locate the actual component logic in " + path);
  const body = source.slice(start, stop).replace(/^export /, "");
  return new Function("React", "env", `
    const { useState, useRef, useEffect, useLayoutEffect, useCallback } = React;
    const { ${bindings.join(", ")} } = env;
    ${body}
      return { ${exports.join(", ")} };
    }
    return ${header.match(/function (\w+)/)[1]};
    //# sourceURL=${path}
  `);
}

const picker = component("../src/picker.jsx", "export function ConceptPicker(", "  const pick =",
  ["byId", "search", "useOutside", "window", "ResizeObserver"], ["box", "pop"]);
const wholeMap = component("../src/views/map.jsx", "function WholeMap(", "  const nb = useMemo",
  ["useStored", "useUI", "LAYOUT", "d3", "fitBox", "ResizeObserver", "setTimeout", "clearTimeout"],
  ["svgRef", "gRef", "zoomRef", "centerOn"]);

function hooks(values = []) {
  let stateIndex = 0;
  const effects = [], updates = [];
  const React = {
    useRef: current => ({ current }),
    useState: initial => {
      const index = stateIndex++;
      return [index in values ? values[index] : initial, value => updates.push({ index, value })];
    },
    useEffect: effect => effects.push(effect), useLayoutEffect: effect => effects.push(effect),
    useCallback: fn => fn,
  };
  return { React, effects, updates };
}

function events() {
  const listeners = [], retained = [];
  return {
    listeners, retained,
    addEventListener(type, fn, capture) { const listener = { type, fn, capture }; listeners.push(listener); retained.push(listener); },
    removeEventListener(type, fn, capture) {
      const index = listeners.findIndex(item => item.type === type && item.fn === fn && item.capture === capture);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

function observers() {
  const all = [];
  return { all, ResizeObserver: class {
    constructor(callback) { this.callback = callback; this.disconnected = false; all.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.disconnected = true; }
  } };
}

function node() {
  return { isConnected: true, reads: 0, scrollHeight: 120,
    getBoundingClientRect() { this.reads++; return { left: 100, top: 100, right: 300, bottom: 130, width: 200, height: 30 }; } };
}

function pickerFixture() {
  const hook = hooks(["learn", true]), observer = observers(), viewport = Object.assign(events(), { width: 800, height: 600 });
  const window = Object.assign(events(), { innerWidth: 800, innerHeight: 600, visualViewport: viewport });
  const refs = picker(hook.React, { byId: new Map(), search: () => [{ c: { id: "one" } }],
    useOutside() {}, window, ResizeObserver: observer.ResizeObserver })({});
  const anchor = node(), popup = node(); refs.box.current = anchor; refs.pop.current = popup;
  const cleanup = hook.effects[0]();
  return { ...hook, ...refs, observer, window, viewport, anchor, popup, cleanup,
    callbacks: [observer.all[0].callback, ...window.retained.map(item => item.fn), ...viewport.retained.map(item => item.fn)] };
}

function mapFixture() {
  const hook = hooks(), observer = observers(), zoomCallbacks = new Map(), calls = [], timers = [], cleared = [];
  const zoom = { scaleExtent() { return this; }, on(name, fn) { zoomCallbacks.set(name, fn); return this; }, transform() {} };
  const selection = { call(...args) { calls.push(["call", ...args]); return this; },
    on(...args) { calls.push(["on", ...args]); return this; },
    interrupt() { calls.push(["interrupt"]); return this; }, transition() { calls.push(["transition"]); return this; },
    duration() { return this; } };
  const transform = { toString: () => "translate(0,0)", k: 2 };
  const identity = { translate() { return this; }, scale() { return this; } };
  const refs = wholeMap(hook.React, { useStored: (_, value) => [value, () => {}], useUI: () => ({ hover: { now() {} } }),
    LAYOUT: { w: 100, h: 50, xy: { chosen: [10, 20] } },
    d3: { select: () => selection, zoom: () => zoom, zoomIdentity: identity }, fitBox: () => ({ cx: 50, cy: 25 }),
    ResizeObserver: observer.ResizeObserver,
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout(id) { cleared.push(id); },
  })({ focus: "chosen" });
  const svg = node(), group = { isConnected: true, writes: 0, setAttribute() { this.writes++; } };
  refs.svgRef.current = svg; refs.gRef.current = group;
  const cleanup = hook.effects[0](), cleanupFocus = hook.effects[1]();
  return { ...hook, ...refs, observer, svg, group, calls, timers, cleared, cleanup, cleanupFocus,
    resize: observer.all[0].callback, zoom: () => zoomCallbacks.get("zoom")({ transform }) };
}

const failures = [];
function check(name, run) {
  try { run(); console.log("PASS " + name); }
  catch (error) { failures.push(name); console.error("FAIL " + name + ": " + error.message); }
}

check("picker places live results and ignores callbacks while either ref is null", () => {
  const f = pickerFixture();
  assert.equal(f.updates.at(-1).value.left, 100); assert.equal(f.updates.at(-1).value.width, 260);
  const before = f.updates.length; f.callbacks[0](); assert.equal(f.updates.length, before + 1);
  for (const ref of [f.box, f.pop]) {
    const previous = ref.current; ref.current = null; const count = f.updates.length;
    for (const callback of f.callbacks) assert.doesNotThrow(callback);
    assert.equal(f.updates.length, count); ref.current = previous;
  }
  f.cleanup();
});

check("picker cleanup disables retained callbacks and removes the original viewport listeners", () => {
  const f = pickerFixture(), before = f.updates.length;
  f.window.visualViewport = Object.assign(events(), { width: 300, height: 200 }); f.cleanup();
  for (const callback of f.callbacks) callback();
  assert.equal(f.updates.length, before); assert.equal(f.window.listeners.length, 0); assert.equal(f.viewport.listeners.length, 0);
  assert.ok(f.observer.all[0].disconnected);
});

check("picker ignores disconnected or replaced nodes before cleanup", () => {
  const f = pickerFixture(), before = f.updates.length;
  f.anchor.isConnected = false; f.callbacks[0](); f.anchor.isConnected = true;
  f.pop.current = node(); f.callbacks[0](); assert.equal(f.updates.length, before); f.cleanup();
});

check("map live resize and zoom work, then ignore nulled or replaced refs", () => {
  const f = mapFixture(); f.resize(); f.zoom();
  f.centerOn("chosen");
  assert.ok(f.calls.some(call => call[0] === "transition"));
  assert.ok(f.calls.some(call => call[0] === "call" && call[1] === f.zoomRef.current.transform));
  assert.ok(f.svg.reads > 0); assert.equal(f.group.writes, 1); const before = f.updates.length;
  f.svgRef.current = null; assert.doesNotThrow(f.resize); f.gRef.current = null; assert.doesNotThrow(f.zoom);
  f.svgRef.current = node(); f.gRef.current = { setAttribute() { throw Error("stale zoom reached replacement"); } };
  f.resize(); f.zoom(); assert.equal(f.updates.length, before); f.cleanup();
});

check("map cleanup disables retained resize/zoom callbacks and clears pending focus work", () => {
  const f = mapFixture(); f.cleanup(); f.cleanupFocus?.();
  const before = f.updates.length, writes = f.group.writes, calls = f.calls.length;
  f.resize(); f.zoom(); for (const timer of f.timers) timer();
  assert.equal(f.updates.length, before); assert.equal(f.group.writes, writes); assert.equal(f.calls.length, calls);
  assert.ok(f.observer.all[0].disconnected); assert.ok(f.calls.some(call => call[0] === "interrupt"));
  assert.equal(f.zoomRef.current, null); assert.deepEqual(f.cleared, [1]);
});

if (failures.length) { console.error(failures.length + " layout lifecycle checks failed"); process.exitCode = 1; }
else console.log("Layout lifecycle checks passed: live placement, cleared refs, replaced/disconnected nodes, queued callbacks and effect cleanup.");
