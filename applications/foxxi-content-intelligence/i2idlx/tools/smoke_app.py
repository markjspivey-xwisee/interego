"""Headless smoke test of site/app.html with stubbed runtime capabilities.

python3 -I tools/smoke_app.py <i2idlx-root> <cdn-cache-dir> [--shots <dir>]

The cache dir holds the three CDN scripts and the Google Fonts CSS/woff2 (fetched once with curl);
requests are answered from it, everything else off-origin is refused, so the test needs no network.
Two passes: with stubs for db / user / sample / downloads (a signed-in contributor), and with no
capabilities at all (a signed-out visitor). Every route must render without a page error.
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
DATA = json.loads((ROOT / "app" / "build" / "data.json").read_text())
HTML = "<!doctype html><html><head><meta charset=utf8><meta name=viewport content=\"width=device-width,initial-scale=1\"></head><body>" + PAGE + "</body></html>"

STUBS = r"""
(() => {
  const store = new Map(), docL = new Map(), colL = new Map(), log = [];
  window.__db = { store, log };
  const meta = { fromCache: false, hasPendingWrites: false };
  const snapDoc = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => store.get(p), metadata: meta });
  const snapCol = (c) => { const n = c.split('/').length + 1; const docs = [...store.keys()].filter(p => p.startsWith(c + '/') && p.split('/').length === n).sort().map(snapDoc);
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta }; };
  const notify = (p) => { const c = p.split('/').slice(0, -1).join('/'); (docL.get(p) || []).forEach(f => f(snapDoc(p))); (colL.get(c) || []).forEach(f => f(snapCol(c))); };
  const add = (m, k, f) => { const l = m.get(k) || []; l.push(f); m.set(k, l); return () => m.set(k, (m.get(k) || []).filter(x => x !== f)); };
  const docRef = (p) => ({ id: p.split('/').pop(), path: p,
    get: async () => snapDoc(p),
    set: async (d) => { if (window.__readOnly) throw { code: 'invalid_argument', message: 'read only' };
      const s = JSON.stringify(d); if (s.length > 262144) throw { code: 'invalid_argument', message: 'too big' };
      store.set(p, JSON.parse(s)); log.push(['set', p]); setTimeout(() => notify(p), 5); },
    update: async (d) => { store.set(p, Object.assign({}, store.get(p), d)); log.push(['update', p]); setTimeout(() => notify(p), 5); },
    delete: async () => { store.delete(p); log.push(['delete', p]); setTimeout(() => notify(p), 5); },
    onSnapshot: (next) => { const off = add(docL, p, next); setTimeout(() => next(snapDoc(p)), 5); return off; },
    collection: (c) => colRef(p + '/' + c) });
  const colRef = (c) => { const q = { path: c, doc: (id) => docRef(c + '/' + (id || Math.random().toString(36).slice(2))),
    onSnapshot: (next) => { const off = add(colL, c, next); setTimeout(() => next(snapCol(c)), 5); return off; },
    get: async () => snapCol(c), where: () => q, orderBy: () => q, limit: () => q }; return q; };
  const db = { doc: docRef, collection: colRef };
  const me = { id: 'u_testviewer000000000000', name: 'Test Viewer', avatarUrl: '', color: '#2a78d6', email: null, isOwner: true, canEdit: true };
  const user = { me: async () => me, id: async () => me.id, can: async () => true, isOwner: async () => true, canEdit: async () => true,
    profiles: async (ids) => Object.fromEntries([].concat(ids).map(i => [i, { id: i, name: i === me.id ? 'Test Viewer' : 'Ana Reviewer', avatarUrl: '', color: '#eb6834', email: null, isMe: i === me.id, guest: false }])) };
  window.__sampleCalls = [];
  const sample = async (input, opts = {}) => {
    window.__sampleCalls.push({ turns: input.length, tools: (opts.tools || []).map(t => t.name), tier: opts.modelTier });
    let found = null;
    if (opts.tools) {
      const s = opts.tools.find(t => t.name === 'search_glossary');
      const r = await s.execute({ query: 'record store' }, { signal: new AbortController().signal });
      found = r[0];
      const g = opts.tools.find(t => t.name === 'get_concept');
      await g.execute({ id: found.id }, { signal: new AbortController().signal });
      const p = opts.tools.find(t => t.name === 'find_path');
      await p.execute({ from: found.id, to: 'competency-based-learning' }, { signal: new AbortController().signal });
      await opts.tools.find(t => t.name === 'find_capabilities').execute({ query: 'learning record store' }, { signal: new AbortController().signal });
      await opts.tools.find(t => t.name === 'list_concepts').execute({ field: 'Learning Sciences' }, { signal: new AbortController().signal });
    }
    const text = `An LRS stores xAPI statements [[${found ? found.id : 'learning-record-store-lrs'}]].\n\n- **Grounded**: see [[xapi-statement]].\n- Unknown cite [[no-such-term]].`;
    for (let i = 10; i <= text.length; i += 25) opts.onText && opts.onText({ text: text.slice(0, i), delta: '' });
    opts.onText && opts.onText({ text, delta: '' });
    return { text, truncated: false, modelTierApplied: opts.modelTier || 'default' };
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 8 } });
  sample.json = async () => ({});
  window.__saved = [];
  const downloads = { save: async (r) => { window.__saved.push({ filename: r.filename, data: typeof r.data === 'string' ? r.data : '' }); return { status: 'saved' }; } };
  store.set('ballots/u_otherreviewer0000000000', { v: { 'm.m-xapi-statement-1': { vote: 'for', note: 'Same normative text.', at: Date.now() - 3600e3 } } });
  store.set('notes/u_otherreviewer0000000000', { n: { abc: { c: 'learning-record-store-lrs', text: 'We teach this with a live LRS demo.', at: Date.now() - 7200e3 } } });
  store.set('usage/u_otherreviewer0000000000', { u: { 'learning-record-store-lrs': { ctx: 'LE 101 · week 3', at: Date.now() } } });
  window.claude = { use: async (name) => ({ db, user, sample, downloads })[name] || null };
})();
"""

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


def run(stubbed: bool, width=1440, height=900, shots=False):
    tag = "stubbed" if stubbed else "bare"
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": width, "height": height}, color_scheme="light")
        page = ctx.new_page()
        page.route("**/*", route_handler)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        if stubbed:
            page.add_init_script(STUBS)
        page.goto("http://app.test/#home")
        page.wait_for_selector(".hero h1", timeout=15000)

        def visit(h, sel, name=None):
            page.evaluate(f"location.hash = {json.dumps(h)}")
            try:
                page.wait_for_selector(sel, timeout=8000)
                ok = True
            except Exception:
                ok = False
            check(ok, f"[{tag}] #{h} renders {sel}")
            if shots and SHOTS and name:
                page.wait_for_timeout(400)
                page.screenshot(path=str(SHOTS / f"{name}-{tag}-{width}.png"), full_page=False)

        visit("home", ".hero h1", "home")
        visit("browse", ".lex-list .li", "lexicon")
        visit("c-learning-record-store-lrs", "#hw", "entry")
        check(page.inner_text("#hw") == "Learning Record Store (LRS)", f"[{tag}] entry headword is the I2IDL label")
        check(page.locator(".definition .hx").count() >= 1, f"[{tag}] the definition is hypertext")
        for c in DATA["concepts"][::23]:
            page.evaluate(f"location.hash = 'c-{c['id']}'")
            page.wait_for_function(f"document.querySelector('#hw') && document.querySelector('#hw').textContent === {json.dumps(c['l'])}", timeout=5000)
        check(True, f"[{tag}] {len(DATA['concepts'][::23])} sampled entries render their labels")
        visit("browse-f.learning-sciences", ".lex-count")
        n = page.locator(".lex-list .li").count()
        want = sum(1 for c in DATA["concepts"] if "learning-sciences" in c["f"])
        check(n == want, f"[{tag}] field filter shows {n} of the {want} members")
        visit("whole", ".mapwrap svg circle", "map")
        check(page.locator(".mapwrap svg circle").count() == len(DATA["concepts"]), f"[{tag}] map draws every concept")
        visit("map-learning-engineering", ".mapwrap svg g circle", "neighborhood")
        visit("path-learning-record-store-lrs~competency-based-learning", ".path .pstep", "path")
        visit("cmp-formative-evaluation~formative-assessment", ".cmp-grid .cmp-row", "compare")
        visit("review", ".rcard", "review")
        visit("insights", ".chart svg", "insights")
        visit("agents", ".qcard", "agents")
        visit("agents-act.foxxi.discover-lrs", "#act-foxxi\\.discover-lrs[open]")
        visit("packs", ".pk", "packs")
        visit("ask", ".ask" if stubbed else ".empty", "ask")
        visit("for-i2idl", ".fi-hero h1", "for-i2idl")
        check(page.locator(".prio").count() == 4, f"[{tag}] For I2IDL shows I2IDL's four next priorities")
        n_unesco = sum(1 for m in DATA["mappings"] if m["v"] == "UNESCO Thesaurus")
        check(page.locator(".prio").first.locator("tbody tr").count() == n_unesco == 13, f"[{tag}] priority 1 lists the {n_unesco} UNESCO crosswalks")
        n_rel = sum(1 for r in DATA["releases"] if r.get("nch"))
        check(page.locator(".clog li").count() == n_rel + 1, f"[{tag}] the change log lists the {n_rel} releases that changed the graph, plus the baseline")
        check(page.locator(".phase").count() == 7, f"[{tag}] I2IDL's seven phases are credited")
        page.locator(".route button", has_text="Try here").first.click()
        check(page.locator(".route .cchip").count() >= 3, f"[{tag}] /api/concepts?q=competency answers here from the embedded release")
        visit("annotate", ".an textarea", "annotate")
        page.locator(".an button", has_text="Try an example").click()
        page.wait_for_selector(".an-hit")
        hits = page.locator(".an-hit").count()
        found = page.locator(".an-list .cchip").all_inner_texts()
        check(hits >= 8 and "Learning Record Store (LRS)" in found, f"[{tag}] Annotate finds {hits} mentions of {len(found)} terms in the example")
        visit("review-method.evidence-cited", ".rcard", "review-unesco")
        check(page.locator(".rcard").count() == 13 and page.locator(".rcard .cited").count() == 13, f"[{tag}] #review-method.evidence-cited opens the 13 UNESCO proposals, each marked cited by I2IDL")
        page.locator(".rv select[aria-label=Method]").select_option("all")
        # semantic layer: matrix, a category, the playground (sample, then the clash), the reasoning record, agents
        sem = DATA["semantic"]
        visit("semantic", ".matrix tbody tr", "semantic")
        n_groups = len({c["group"] for c in sem["categories"]})
        check(page.locator(".matrix tbody tr").count() == len(sem["categories"]) + n_groups, f"[{tag}] the alignment matrix has a row per referent category ({len(sem['categories'])}) under {n_groups} groups")
        visit("semantic-cat.assessment", ".catd h2", "semantic-cat")
        n_ass = sum(1 for c in DATA["concepts"] if c.get("rc") == "assessment")
        check(page.locator(".catd .cchip").count() == n_ass, f"[{tag}] the assessment category lists its {n_ass} concepts")
        visit("semantic-play", ".rescard", "semantic-play")
        page.locator(".play button", has_text="Sample organization").click()
        page.wait_for_timeout(600)
        check(page.locator(".rescard").count() == 17 and page.locator(".rescard.clash").count() == 0, f"[{tag}] the playground classifies the sample organization's 17 resources with no clash")
        page.locator(".play button", has_text="A category clash").click()
        page.wait_for_selector(".rescard.clash", timeout=5000)
        clash_text = page.locator(".rescard.clash .note.bad").first.inner_text()
        check(all(o in clash_text for o in ("BFO", "DUL", "gUFO")), f"[{tag}] the clash example is flagged with its reasons in BFO, DUL and gUFO")
        if shots and SHOTS:
            page.screenshot(path=str(SHOTS / f"semantic-clash-{tag}-{width}.png"), full_page=False)
        visit("semantic-reasoning", ".okv", "semantic-reasoning")
        check(page.locator(".okv.bad").count() == 0 and page.locator(".okv.ok").count() >= 8, f"[{tag}] every reasoning check in the record passed")
        visit("semantic-agents", ".steps li", "semantic-agents")
        visit("semantic-try.learning-record-store-lrs", ".rescard", "semantic-try")
        try:
            page.wait_for_function("document.querySelectorAll('.rescard').length === 1 && document.querySelector('.rescard').innerText.includes('Learning Record Store')", timeout=5000)
            prefilled = True
        except Exception:
            prefilled = False
        check(prefilled, f"[{tag}] 'Try it on your data' prefills the playground with the concept")
        visit("c-learning-record-store-lrs", ".layer[aria-label='What it classifies'] .term", "entry-classifies")
        check(page.locator(".layer[aria-label='What it classifies'] .term").count() >= 5, f"[{tag}] the entry says what the concept classifies, in several ontologies")
        # zones, provenance, history, origin labels, lens
        visit("c-learning-record-store-lrs", ".z-i2idl .zone-head", "entry-zones")
        lrs = next(c for c in DATA["concepts"] if c["id"] == "learning-record-store-lrs")
        want = DATA["meta"]["upstream"]["provenance"][0 if lrs["pv"] == "g" else 1]
        check(page.locator(".z-i2idl .provline").inner_text().endswith(want), f"[{tag}] the provenance line uses I2IDL's own wording: {want}")
        check(page.locator(".z-x .hist .hrow").count() >= 2, f"[{tag}] the entry shows its change history")
        check(page.locator(".z-i2idl .origin").count() >= 1 and page.locator(".z-x .origin").count() >= 5, f"[{tag}] every zone and layer section carries an origin label")
        page.locator(".z-x button.origin").first.click()
        page.wait_for_selector(".layers-legend .ll-row")
        check(page.locator(".layers-legend .ll-row").count() == 7, f"[{tag}] an origin label opens What's whose with all seven layers")
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)
        page.locator(".lens button", has_text="I2IDL only").click()
        page.wait_for_selector(".xcollapsed")
        check(page.locator(".app.lens-i2idl").count() == 1 and page.locator(".z-x").count() == 0 and page.locator(".z-i2idl .definition .hx").count() == 0,
              f"[{tag}] the I2IDL-only lens hides every layer and shows I2IDL's plain text")
        dot = page.evaluate("getComputedStyle(document.querySelector('.lex-list .li .dot')).backgroundColor")
        faint = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--faint').trim()")
        check(dot in ("rgb(132, 147, 157)",) or faint == "#84939d", f"[{tag}] the I2IDL-only lens neutralizes the derived kind colours ({dot})")
        if shots and SHOTS:
            page.screenshot(path=str(SHOTS / f"entry-i2idl-lens-{tag}-{width}.png"), full_page=False)
        page.locator(".lens button", has_text="I2IDL-X").click()
        page.wait_for_selector(".z-x")

        # search palette
        page.evaluate("location.hash = 'home'")
        page.wait_for_selector(".hero h1")
        page.keyboard.press("/")
        page.wait_for_selector(".palette input")
        page.keyboard.type("record store")
        page.wait_for_timeout(150)
        first = page.locator(".palette .res .t").first.inner_text()
        check(first == "Learning Record Store (LRS)", f"[{tag}] search 'record store' → {first}")
        page.keyboard.press("Enter")
        page.wait_for_selector("#hw")
        check(page.inner_text("#hw") == "Learning Record Store (LRS)", f"[{tag}] Enter opens the entry")
        page.keyboard.press("/")
        page.keyboard.type("lrs")
        page.wait_for_timeout(150)
        check(page.locator(".palette .res .t").first.inner_text() == "Learning Record Store (LRS)", f"[{tag}] search 'lrs' (alternate label) finds the LRS")
        page.keyboard.press("Escape")
        page.keyboard.press("/")
        page.keyboard.type("spaced repitition")
        page.wait_for_timeout(150)
        check("Spaced" in page.locator(".palette .res .t").first.inner_text(), f"[{tag}] typo 'spaced repitition' still finds spaced repetition")
        page.keyboard.press("Escape")

        if stubbed:
            # vote on a review item
            page.evaluate("location.hash = 'c-xapi-statement'")
            page.wait_for_selector('.layers section[aria-label="Crosswalk proposals"] .vb.for')
            page.locator('.layers section[aria-label="Crosswalk proposals"] .vb.for').first.click()
            page.wait_for_timeout(200)
            store = page.evaluate("JSON.stringify([...window.__db.store.entries()])")
            ballots = dict(json.loads(store))
            mine = ballots.get("ballots/u_testviewer000000000000", {}).get("v", {})
            check(mine.get("m.m-xapi-statement-1", {}).get("vote") == "for", "[stubbed] a vote is written to ballots/<me>")
            check(page.locator(".layers .chip.asserted", has_text="Ratified here").count() >= 1, "[stubbed] two votes for reach the quorum: shown as ratified")
            check(page.locator(".layers a", has_text="Suggest to I2IDL editors").count() >= 1, "[stubbed] a ratified crosswalk offers the upstream issue")
            # note
            page.evaluate("location.hash = 'c-learning-record-store-lrs'")
            page.wait_for_selector(".layers textarea")
            check(page.locator(".noteitem").count() == 1, "[stubbed] the other reviewer's note shows")
            page.fill(".layers textarea", "Test note from the smoke test.")
            page.locator(".layers button", has_text="Post note").click()
            page.wait_for_timeout(200)
            check(page.locator(".noteitem").count() == 2, "[stubbed] posting a note adds it")
            # pack
            page.locator(".entry-actions button", has_text="Add to pack").click()
            page.fill(".pop input", "Smoke pack")
            page.locator(".pop button", has_text="Create").click()
            page.wait_for_timeout(900)
            page.evaluate("location.hash = 'packs'")
            page.wait_for_selector(".pkterm")
            check(page.locator(".pkterm").count() == 1, "[stubbed] the new pack holds the term")
            page.locator(".chip", has_text="Add all").count()
            for fmt in ["Handout", "Markdown", "CSV", "JSON-LD", "Flashcards", "xAPI tags", "Foxxi alignment"]:
                page.locator(".chips .chip", has_text=fmt).first.click()
                page.wait_for_timeout(60)
                page.locator("button", has_text="Save").first.click()
                page.wait_for_timeout(120)
            saved = page.evaluate("window.__saved.map(s => [s.filename, s.data.length])")
            check(len(saved) == 7 and all(n > 50 for _, n in saved), f"[stubbed] seven export formats save: {[f for f, _ in saved]}")
            data = page.evaluate("window.__saved.map(s => s.data)")
            try:
                json.loads(data[3])
                ok = True
            except Exception:
                ok = False
            check(ok, "[stubbed] the JSON-LD export parses")
            check(data[2].startswith("term,also_known_as,definition"), "[stubbed] the CSV export has its header")
            (pathlib.Path(SHOTS or ROOT / "app" / "build") / "export-samples.json").write_text(json.dumps(dict(zip([f for f, _ in saved], data)), indent=1))
            # editorial packet
            page.evaluate("location.hash = 'for-i2idl'")
            page.wait_for_selector(".fi-hero")
            page.locator(".fi-hero button", has_text="Editorial packet").click()
            page.wait_for_timeout(200)
            last = page.evaluate("window.__saved[window.__saved.length - 1]")
            md = last["data"] if last else ""
            (pathlib.Path(SHOTS or ROOT / "app" / "build") / "editorial-packet-sample.md").write_text(md)
            check(last and last["filename"].endswith("-editorial-packet.md") and "## 1. UNESCO Thesaurus crosswalk candidates" in md and md.count("unesco:concept") == 13,
                  f"[stubbed] the editorial packet saves as Markdown with the 13 UNESCO candidates ({len(md)} chars)")
            # ask
            page.evaluate("location.hash = 'ask'")
            page.wait_for_selector(".ask textarea")
            page.fill(".ask textarea", "What is an LRS?")
            page.keyboard.press("Enter")
            page.wait_for_selector(".msg.bot .cref", timeout=8000)
            calls = page.evaluate("window.__sampleCalls")
            check(calls and set(calls[-1]["tools"]) >= {"search_glossary", "get_concept", "find_path"}, f"[stubbed] Ask offers the glossary tools: {calls[-1]['tools'] if calls else None}")
            check(page.locator(".msg.bot .cref").count() == 2, "[stubbed] the answer's [[id]] citations render as links (unknown ids do not)")
            check(page.locator(".msg .trace span").count() >= 4, "[stubbed] the tool trace shows what Claude looked up")
            # review keyboard voting
            page.evaluate("location.hash = 'review'")
            page.wait_for_selector(".rcard")
            page.keyboard.press("j")
            page.keyboard.press("a")
            page.wait_for_timeout(200)
            store = dict(json.loads(page.evaluate("JSON.stringify([...window.__db.store.entries()])")))
            check(len(store.get("ballots/u_testviewer000000000000", {}).get("v", {})) == 2, "[stubbed] keyboard voting (j, a) records a second vote")
            # exports from review: this reviewer's votes, then the team ledger
            page.locator("button", has_text="My votes").click()
            page.wait_for_selector(".modal pre")
            page.fill(".modal input", "did:web:reviewer.example")
            page.wait_for_timeout(100)
            mine_ttl = page.locator(".modal pre").nth(1).inner_text()
            (pathlib.Path(SHOTS or ROOT / "app" / "build") / "my-votes-sample.ttl").write_text(mine_ttl)
            check(mine_ttl.count("a i2x:RatificationVote") == 2 and "did:web:reviewer.example" in mine_ttl, "[stubbed] 'My votes' produces one RatificationVote per vote, attributed to the reviewer")
            page.keyboard.press("Escape")
            page.wait_for_timeout(100)
            page.locator("button", has_text="Team ledger").click()
            page.wait_for_selector(".modal pre")
            ledger = page.inner_text(".modal pre")
            (pathlib.Path(SHOTS or ROOT / "app" / "build") / "ledger-sample.ttl").write_text(ledger)
            check("i2x:RatificationVote" in ledger and "i2x:reviewStatus i2x:status-ratified" in ledger, "[stubbed] the ledger carries votes and the ratified outcome")
            page.keyboard.press("Escape")
        else:
            page.evaluate("location.hash = 'c-xapi-statement'")
            page.wait_for_selector(".layers .vb.for")
            check(page.locator(".layers .vb.for").first.is_disabled(), "[bare] voting is disabled without an identity")
            check(page.locator(".layers textarea").count() == 0, "[bare] no note box without an identity")
            check(page.locator(".nav a", has_text="Ask").count() == 0, "[bare] Ask is hidden when Claude is unavailable")
        b.close()
    real = [e for e in errors if "favicon" not in e]
    check(not real, f"[{tag}] no page errors" + ("" if not real else ": " + " | ".join(real[:6])))


if SHOTS:
    SHOTS.mkdir(parents=True, exist_ok=True)
run(True, shots=True)
run(False)
if SHOTS:
    run(True, width=420, height=860, shots=True)
print(f"\n{len(failures)} failures")
sys.exit(1 if failures else 0)
