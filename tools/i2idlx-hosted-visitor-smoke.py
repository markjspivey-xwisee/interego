"""Additional hosted-path visitor checks of the pinned release and authored extension."""
import json
import pathlib
import sys
from playwright.sync_api import sync_playwright


# Explicit loading also works under Python -I, which omits the script directory.
import importlib.util
_oracle_spec = importlib.util.spec_from_file_location("corpus_oracle", pathlib.Path(__file__).resolve().parents[1] / "applications/foxxi-content-intelligence/i2idlx/tools/corpus_oracle.py")
_oracle = importlib.util.module_from_spec(_oracle_spec)
_oracle_spec.loader.exec_module(_oracle)

root = pathlib.Path(sys.argv[1]).resolve()
cache = pathlib.Path(sys.argv[2]).resolve()
shots = pathlib.Path(sys.argv[3]).resolve()
shots.mkdir(parents=True, exist_ok=True)
html = (root / "site" / "app.html").read_text()
data = json.loads((root / "app" / "build" / "data.json").read_text())
corpus = _oracle.validate_corpus(data)
errors, writes = [], []

def route_handler(route):
    url = route.request.url
    if route.request.method not in ("GET", "HEAD"):
        writes.append(url)
        return route.abort()
    if url.startswith("http://app.test/i2idlx/"):
        return route.fulfill(status=200, content_type="text/html", body=html)
    if url.startswith("https://cdnjs.cloudflare.com/"):
        f = cache / url.replace("https://", "").replace("/", "_")
        return route.fulfill(status=200, content_type="application/javascript", body=f.read_bytes()) if f.exists() else route.abort()
    if url.startswith("https://fonts.googleapis.com/"):
        return route.fulfill(status=200, content_type="text/css", body=(cache / "fonts.css").read_text())
    if url.startswith("https://fonts.gstatic.com/"):
        f = cache / "gstatic" / url.replace("https://fonts.gstatic.com/", "").replace("/", "_")
        return route.fulfill(status=200, content_type="font/woff2", body=f.read_bytes()) if f.exists() else route.abort()
    return route.abort()

routes = [
    ("home", ".hero h1"), ("browse", ".lex-list .li"), ("c-learning-record-store-lrs", "#hw"),
    ("c-learning-management-systems", "#hw"),
    ("whole", ".mapwrap svg circle"), ("review", ".rcard"), ("agents", ".qcard"),
    ("for-i2idl", ".fi-hero h1"), ("semantic", ".matrix tbody tr"), ("semantic-play", ".rescard"), ("ask", ".empty"),
]
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in ((1440, 900), (420, 860)):
        ctx = browser.new_context(viewport={"width": width, "height": height})
        page = ctx.new_page()
        page.route("**/*", route_handler)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("http://app.test/i2idlx/#home")
        page.wait_for_selector(".hero h1")
        assert page.evaluate("window.__APP_URL__") == "http://app.test/i2idlx/", "hosted shares must stay on the serving origin"
        assert page.evaluate("!window.claude && !window.ethereum && !window.InteregoHost"), "visitor has no signed host, wallet or Claude SDK"
        _oracle.assert_embedded_source(page, data)
        def visit(name, selector):
            page.evaluate("location.hash = " + json.dumps(name))
            page.wait_for_selector(selector, timeout=12000)
        _oracle.assert_browser_corpus(page, corpus, visit)
        print("PASS hosted exact combined/source-only counts, owned IRI and authored origin", width)
        for name, selector in routes:
            page.evaluate("location.hash = " + json.dumps(name))
            page.wait_for_selector(selector, timeout=12000)
            if name == "whole":
                assert page.locator(".mapwrap svg circle").count() == corpus["combined_count"], "every canonical and declared authored concept must be drawn"
            if name == "c-learning-record-store-lrs":
                assert page.inner_text("#hw") == next(c["l"] for c in data["concepts"] if c["id"] == "learning-record-store-lrs")
            if name == "c-learning-management-systems":
                concept = next(c for c in data["concepts"] if c["id"] == "learning-management-systems")
                page.wait_for_function("label => document.getElementById('hw')?.textContent === label", arg=concept["l"])
                assert page.inner_text("#hw") == concept["l"]
                assert concept["d"] in page.inner_text("body"), "active-only definition must be readable"
                assert concept["ds"] is None and concept["dq"] is None and concept["dl"] is None
                assert "Not supplied" in page.inner_text(".def-meta"), "absent status must not read as approval"
                assert page.locator('[title*="editorial status is not supplied"]').count() == 1
                assert "Definition" not in page.inner_text(".def-meta"), "absent sequence/language must not leave an empty metadata row"
                page.keyboard.press("/")
                search = page.locator('input[aria-label="Search"][role="combobox"]')
                search.wait_for(state="visible")
                assert search.get_attribute("placeholder").startswith("Search " + str(corpus["combined_count"]) + " terms"), "search count must include exactly the declared corpus"
                page.keyboard.press("Escape")
            if name in ("home", "c-learning-record-store-lrs", "whole", "semantic", "ask"):
                page.screenshot(path=str(shots / ("hosted-" + name + "-" + str(width) + ".png")), full_page=False)
            print("PASS hosted signed-out", width, name, selector)
        ctx.close()
    browser.close()
assert not errors, "hosted visitor browser errors: " + repr(errors)
assert not writes, "signed-out visitor unexpectedly attempted writes: " + repr(writes)
print("PASS hosted visitor has no page errors or writes and uses current-origin share URLs")
