"""Headless test of Orchestrate in site/app.html: the recorded run replays to the end with every tool call
matching the recording, the gate waits for the viewer, and a live run drives the same tools through a
scripted stand-in for the sample capability.

python3 -I tools/smoke_orchestra.py <i2idlx-root> <cdn-cache-dir> [--shots <dir>]
"""
import json
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(sys.argv[1]).resolve()
CACHE = pathlib.Path(sys.argv[2]).resolve()
SHOTS = pathlib.Path(sys.argv[sys.argv.index("--shots") + 1]).resolve() if "--shots" in sys.argv else None
PAGE = (ROOT / "site" / "app.html").read_text()
HTML = "<!doctype html><html><head><meta charset=utf8><meta name=viewport content=\"width=device-width,initial-scale=1\"></head><body>" + PAGE + "</body></html>"
TRACE = json.loads((ROOT / "examples" / "orchestra" / "kestrel-point-run.json").read_text())

# A stand-in for the sample capability: for each step, it calls that step's tools with the inputs the
# recorded run used, then answers with that step's handoff — so the live engine is exercised end to end.
SCRIPT = {}
for e in TRACE["events"]:
    if e["k"] == "call":
        SCRIPT.setdefault(e["step"], {"calls": [], "text": ""})["calls"].append({"tool": e["tool"], "input": e["input"]})
    if e["k"] == "say" and e.get("handoff"):
        SCRIPT.setdefault(e["step"], {"calls": [], "text": ""})["text"] = e["text"]
STUBS = """
(() => {
  const SCRIPT = %s;
  window.__live = [];
  const sample = async (input, opts = {}) => {
    const prompt = typeof input === 'string' ? input : input.map((t) => t.content).join('\\n');
    const step = (prompt.match(/Your step: ([^.]+)\\./) || [])[1] || '';
    const key = Object.keys(SCRIPT).find((k) => SCRIPT[k].title === step);
    const plan = SCRIPT[key] || { calls: [], text: 'Nothing scripted.' };
    window.__live.push({ step: key, tools: (opts.tools || []).map((t) => t.name) });
    let text = 'Working on it.';
    opts.onText && opts.onText({ text, delta: text });
    for (const c of plan.calls) {
      const t = (opts.tools || []).find((x) => x.name === c.tool);
      if (!t) continue;
      try { await t.execute(c.input, { signal: new AbortController().signal }); } catch (e) { /* the tool reported an error */ }
      await new Promise((f) => setTimeout(f, 20));
    }
    text += '\\n\\n' + (plan.text || 'Done.');
    opts.onText && opts.onText({ text, delta: '' });
    return { text, truncated: false, modelTierApplied: opts.modelTier || 'default' };
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 8 } });
  sample.json = async () => ({});
  const user = { me: async () => ({ id: 'u_test', name: 'Test Viewer', color: '#2a78d6' }), id: async () => 'u_test', can: async () => true,
    isOwner: async () => true, canEdit: async () => true, profiles: async (ids) => Object.fromEntries([].concat(ids).map((i) => [i, { id: i, name: 'Someone' }])) };
  window.__saved = [];
  const downloads = { save: async (r) => { window.__saved.push(r.filename); return { status: 'saved' }; } };
  window.claude = { use: async (name) => ({ sample, user, downloads })[name] || null };
})();
"""
# The workflow, read from the page's own scenario module.
import subprocess
APP = ROOT / "app"
subprocess.run([str(APP / "node_modules/.bin/esbuild"), "src/orc/scenario.js", "--bundle", "--platform=node", "--format=cjs",
                "--outfile=build/orc-scenario.cjs", "--log-level=warning"], cwd=APP, check=True)
STEPS = json.loads(subprocess.run(["node", "-e", "process.stdout.write(JSON.stringify(require('./build/orc-scenario.cjs').STEPS))"],
                                  cwd=APP, check=True, capture_output=True, text=True).stdout)
STEP_TITLES = {s["id"]: s["title"] for s in STEPS}
STEP_TOOLS = {s["id"]: s["tools"] for s in STEPS}

failures = []


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


def route_handler(route):
    url = route.request.url
    if url.startswith("http://app.test/"):
        return route.fulfill(status=200, content_type="text/html", body=HTML)
    if url.startswith("https://cdnjs.cloudflare.com/"):
        f = CACHE / url.replace("https://", "").replace("/", "_")
        return route.fulfill(status=200, content_type="application/javascript", body=f.read_bytes()) if f.exists() else route.abort()
    if url.startswith("https://fonts.googleapis.com/"):
        return route.fulfill(status=200, content_type="text/css", body=(CACHE / "fonts.css").read_text())
    if url.startswith("https://fonts.gstatic.com/"):
        f = CACHE / "gstatic" / url.replace("https://fonts.gstatic.com/", "").replace("/", "_")
        return route.fulfill(status=200, content_type="font/woff2", body=f.read_bytes()) if f.exists() else route.abort()
    return route.abort()


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"))


def run(stubbed, width=1600, height=960, tag=""):
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": width, "height": height}, color_scheme="light")
        page = ctx.new_page()
        page.route("**/*", route_handler)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        if stubbed:
            page.add_init_script(STUBS % json.dumps({k: {**v, "title": STEP_TITLES.get(k, "")} for k, v in SCRIPT.items()}))
        page.goto("http://app.test/#orchestrate")
        page.wait_for_selector(".orc-intro", timeout=20000)
        check(page.locator(".orc-lane").count() == 8, f"[{tag}] eight agents in the swimlanes")
        shot(page, f"{tag}-0-intro")
        # ── recorded ──
        page.click(".orc-head button:has-text('Watch the recorded run')")
        page.click(".orc-head .seg button:has-text('4×')")
        page.wait_for_selector(".orc-call", timeout=20000)
        time.sleep(6)
        shot(page, f"{tag}-1-early")
        t0 = time.time()
        seen = set()
        while time.time() - t0 < 400 and not page.locator(".orc-gate").count():
            loc = page.locator(".orc-loc b").first.inner_text() if page.locator(".orc-loc b").count() else ""
            if loc and loc not in seen:
                seen.add(loc)
                shot(page, f"{tag}-2-{len(seen)}-{loc.replace(' ', '_')}")
            time.sleep(0.7)
        check(page.locator(".orc-gate").count() == 1, f"[{tag}] the run stops at the approval gate")
        check(len(seen) >= 4, f"[{tag}] the workbench pane visited {len(seen)} views: {sorted(seen)}")
        shot(page, f"{tag}-3-gate")
        page.click(".orc-gate button:has-text('Approve')")
        page.wait_for_selector(".orc-done", timeout=120000)
        shot(page, f"{tag}-4-done")
        n_calls = page.locator(".orc-call").count()
        n_rec = sum(1 for e in TRACE["events"] if e["k"] == "call")
        check(n_calls == n_rec, f"[{tag}] all {n_rec} recorded calls replayed ({n_calls})")
        check(page.locator(".orc-call .tag.warn").count() == 0, f"[{tag}] every replayed result matches the recording")
        check(page.locator(".orc-call.error").count() == sum(1 for e in TRACE["events"] if e["k"] == "result" and not e["ok"]), f"[{tag}] errors only where the recording had them")
        page.click(".orc-tabs button:has-text('Context graph')")
        page.wait_for_selector(".og-n.rec", timeout=5000)
        time.sleep(0.6)
        shot(page, f"{tag}-5-graph")
        check(page.locator(".og-n.rec").count() >= 10 and page.locator(".og-edges path").count() >= 10, f"[{tag}] the context graph draws records, concepts and edges")
        page.click(".orc-tabs button:has-text('Staged calls')")
        check(page.locator(".orc-staged-call").count() >= 3 and page.locator(".orc-staged-call .chip:has-text('approved')").count() >= 3, f"[{tag}] staged calls listed and approved")
        page.click(".orc-tabs button:has-text('Provenance')")
        txt = page.locator(".orc-prov pre").inner_text()
        check("ieh:AgentAction" in txt and "ieh:AgentTurn" in txt and "i2x:isClassifiedBy" in txt, f"[{tag}] the run exports as provenance with what it produced")
        shot(page, f"{tag}-6-prov")
        # ── live (scripted stand-in for Claude) ──
        if stubbed:
            page.click(".orc-tabs button:has-text('Transcript')")
            page.click(".orc-head button:has-text('Run it live')")
            page.click(".modal button:has-text('Start')")
            page.wait_for_selector(".orc-gate", timeout=240000)
            page.click(".orc-gate button:has-text('Approve')")
            page.wait_for_selector(".orc-done", timeout=120000)
            live = page.evaluate("window.__live")
            check(len(live) >= 10, f"[{tag}] live run made one Claude call per step ({len(live)})")
            check(all(set(x["tools"]) <= set(STEP_TOOLS.get(x["step"], [])) for x in live), f"[{tag}] each live step got only its own tools")
            check(page.locator(".orc-call.error").count() == 0, f"[{tag}] live run: no tool errors")
            shot(page, f"{tag}-7-live-done")
        check(not errors, f"[{tag}] no page errors" + (": " + "; ".join(errors[:4]) if errors else ""))
        b.close()


run(True, tag="stubbed")
run(False, tag="bare")
print(f"\n{len(failures)} failures")
sys.exit(1 if failures else 0)
