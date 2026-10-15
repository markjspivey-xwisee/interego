"""Browser control tests against explicit fixture responses; this is not live-service evidence."""
import json
import pathlib
import sys
from playwright.sync_api import sync_playwright

root = pathlib.Path(sys.argv[1]).resolve()
cache = pathlib.Path(sys.argv[2]).resolve()
shots = pathlib.Path(sys.argv[3]).resolve()
shots.mkdir(parents=True, exist_ok=True)
html = (root / "site" / "app.html").read_text()
errors, requests = [], []
prefix = "urn:interpretant:directory-browser-fixture:"
read_action = {
    "iri": prefix + "read", "sys": "foxxi", "n": "directory-fixture-read",
    "t": "Browser fixture read", "d": "Explicit test fixture, not a production service.",
    "m": "GET", "u": "https://example.invalid/browser-fixture", "ro": True,
    "input_schema": {"type": "object", "required": ["count", "enabled"], "properties": {
        "count": {"type": "integer"}, "enabled": {"type": "boolean"},
        "meta": {"type": "object"}, "tags": {"type": "array"},
    }},
    "execution": {"mode": "public-example", "reason": "Explicit browser fixture."},
    "example": {"payload": {"count": 0, "enabled": False, "meta": {}, "tags": []}, "label": "Browser fixture", "provenance": "example"},
}
protected_action = {
    "iri": prefix + "protected", "sys": "relay", "n": "directory-fixture-protected",
    "t": "Browser fixture protected request", "m": "POST", "u": "https://example.invalid/protected",
    "ro": False, "auth": True, "input_schema": {"type": "object", "required": ["private_key"], "properties": {
        "private_key": {"type": "string"}, "title": {"type": "string"},
    }},
    "execution": {"mode": "prepare-only", "reason": "Credentials stay with your connected client."},
    "requirements": ["Connected signer required"], "notes": ["This fixture performs no protected operation"],
    "signing": {
        "schema": {"type": "object", "required": ["action", "bridge_audience", "course_iri"], "properties": {
            "action": {"type": "string"}, "bridge_audience": {"type": "string"}, "course_iri": {"type": "string"},
        }},
        "payload": {"action": "foxxi.consume_lesson", "bridge_audience": "http://app.test", "course_iri": ""},
        "instructions": ["Complete your actual course fields, then sign in your connected client."],
    },
}
client_action = {
    "iri": prefix + "client", "sys": "foxxi", "n": "directory-fixture-client",
    "t": "Browser fixture client task", "m": "POST", "u": "https://example.invalid/client",
    "ro": True, "input_schema": {"type": "object", "required": ["question"], "properties": {"question": {"type": "string"}}},
    "execution": {"mode": "client-required", "reason": "Returns instructions, not a model answer."},
    "example": {"payload": {"question": "How is this classified?"}, "label": "Browser fixture", "provenance": "example"},
}
actions = [read_action, protected_action, client_action]
inventory = {
    "schema": 1, "audience": "http://app.test", "build": "browser-fixture-build",
    "generated_at": "2026-10-15T00:00:00Z", "complete": True, "actions": actions,
    "sources": [{"system": "fixture", "url": "https://example.invalid/manifest", "status": "success", "checked_at": "2026-10-15T00:00:00Z", "count": len(actions)}],
}

def routing(fail_inventory=False):
    def handler(route):
        request, url = route.request, route.request.url
        if url == "http://app.test/i2idlx/directory":
            return route.fulfill(status=503 if fail_inventory else 200, content_type="application/json", body=json.dumps({"error": "fixture offline"} if fail_inventory else inventory))
        if url == "http://app.test/i2idlx/directory/run":
            payload = json.loads(request.post_data)
            assert "DO-NOT-SEND-CREDENTIAL" not in request.post_data, "credential reached the network"
            requests.append(payload)
            executed = payload["mode"] == "example"
            result = {
                "action_iri": payload["action_iri"], "mode": payload["mode"],
                "status": "executed" if executed else "contract-valid", "executed": executed,
                "writes_performed": False, "checked_at": "2026-10-15T00:00:00Z",
                "request": {"method": "POST", "url": "https://example.invalid/fixture", "payload": payload["payload"]},
                "validation": {"valid": True, "errors": []}, "evidence": {"source": "browser-fixture", "http_status": 200, "duration_ms": 1},
            }
            result["result"] = {"execution": "client-required", "status": "instructions-only", "sampling_performed": False} if payload["action_iri"] == client_action["iri"] else {"echo": payload["payload"]}
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(result))
        if url.startswith("http://app.test/i2idlx/"):
            assert request.method == "GET", "unexpected write outside fixture runner"
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
    return handler

with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    for width, height in ((1440, 900), (420, 860)):
        context = browser.new_context(viewport={"width": width, "height": height})
        page = context.new_page()
        page.route("**/*", routing())
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("http://app.test/i2idlx/#agents-directory")
        page.wait_for_function("document.querySelector('#directory').textContent.includes('Live inventory loaded')")
        assert page.locator("#directory [data-action-iri]").count() == 3, "fresh operations must replace the embedded snapshot"
        card = page.locator('[data-action-iri="' + read_action["iri"] + '"]')
        card.locator("summary").first.click()
        field = card.get_by_label("meta (optional)", exact=True)
        field.fill("{")
        assert field.input_value() == "{", "intermediate structured input must remain editable"
        assert card.get_by_role("button", name="Run live example directory-fixture-read", exact=True).is_disabled()
        field.fill('{"nested":1}')
        card.get_by_role("button", name="Run live example directory-fixture-read", exact=True).click()
        card.locator('[data-testid="capability-result"]').wait_for()
        assert requests[-1]["payload"] == {"count": 0, "enabled": False, "meta": {"nested": 1}, "tags": []}
        assert "Executed" in card.locator('[data-testid="capability-result"]').inner_text()
        card.get_by_role("button", name="Validate inputs directory-fixture-read", exact=True).click()
        page.wait_for_function("document.querySelector('[data-action-iri=\"" + read_action["iri"] + "\"]').textContent.includes('Inputs valid · not executed')")
        assert requests[-1]["mode"] == "validate"
        protected = page.locator('[data-action-iri="' + protected_action["iri"] + '"]')
        protected.locator("summary").first.click()
        assert protected.get_by_role("button", name="Run live example", exact=False).count() == 0
        assert protected.get_by_label("private_key (required)", exact=True).count() == 0, "browser must not solicit raw private keys"
        assert "Connected signer required" in protected.inner_text()
        assert "This fixture performs no protected operation" in protected.inner_text()
        local = protected.locator('[data-testid="local-signing-editor"]')
        assert local.count() == 1, "envelope-only actions must expose their public inner-body schema"
        before_local = len(requests)
        local.get_by_label("Local signing payload for directory-fixture-protected", exact=True).fill(json.dumps({
            "action": "foxxi.consume_lesson", "bridge_audience": "http://app.test",
            "course_iri": "https://actual.example/course#package", "private_key": "DO-NOT-SEND-CREDENTIAL",
        }))
        assert "DO-NOT-SEND-CREDENTIAL" not in "".join(local.locator(".codeblock").all_text_contents()), "local prepared copy must redact credentials"
        assert len(requests) == before_local, "local signing editor must not send any request"
        protected.get_by_role("button", name="Validate inputs directory-fixture-protected", exact=True).click()
        page.wait_for_function("document.querySelector('[data-action-iri=\"" + protected_action["iri"] + "\"]').textContent.includes('Inputs valid · not executed')")
        assert requests[-1]["mode"] == "validate"
        assert requests[-1]["payload"]["private_key"] == "<provided by your connected client>"
        assert "course_iri" not in requests[-1]["payload"], "generic validation must never receive the separate local signing body"
        before = len(requests)
        protected.get_by_label("JSON payload for directory-fixture-protected", exact=True).fill('{"private_key":"DO-NOT-SEND-CREDENTIAL","title":"local"}')
        assert protected.get_by_role("button", name="Validate inputs directory-fixture-protected", exact=True).is_disabled()
        assert "DO-NOT-SEND-CREDENTIAL" not in "".join(protected.locator(".codeblock").all_text_contents()), "prepared call must redact the credential"
        assert len(requests) == before, "credential editing must not submit a request"
        client = page.locator('[data-action-iri="' + client_action["iri"] + '"]')
        client.locator("summary").first.click()
        client.get_by_role("button", name="Prepare client task directory-fixture-client", exact=True).click()
        page.wait_for_function("document.querySelector('[data-action-iri=\"" + client_action["iri"] + "\"]').textContent.includes('Client task prepared')")
        assert "Your connected AI client must perform the model work." in client.inner_text()
        page.screenshot(path=str(shots / ("directory-controls-" + str(width) + ".png")), full_page=False)
        bounds = page.evaluate("""() => {
            const rect = (element) => { const r = element.getBoundingClientRect(); return {left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth}; };
            const overflow = document.documentElement.scrollWidth > innerWidth + 1;
            return {overflow, viewport: innerWidth, root: rect(document.documentElement), body: rect(document.body), directory: rect(document.querySelector('#directory')),
                offenders: overflow ? [...document.querySelectorAll('body *')].filter((element) => {
                    const r = element.getBoundingClientRect();
                    if (!r.width || !(r.right > innerWidth + 1 || r.left < -1) || getComputedStyle(element).clip !== 'auto') return false;
                    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                        const bounds = parent.getBoundingClientRect(), clipping = getComputedStyle(parent).overflowX;
                        if (['auto', 'scroll', 'hidden', 'clip'].includes(clipping) && bounds.left >= -1 && bounds.right <= innerWidth + 1) return false;
                    }
                    return true;
                }).map((element) => ({tag: element.tagName, id: element.id, class: element.className, ...rect(element),
                    display: getComputedStyle(element).display, overflowX: getComputedStyle(element).overflowX,
                    parent: element.parentElement && {tag: element.parentElement.tagName, class: element.parentElement.className, ...rect(element.parentElement)},
                    text: element.textContent.slice(0, 120)})).slice(0, 24) : []};
        }""")
        if bounds["overflow"]:
            print("DIRECTORY_OVERFLOW_DIAGNOSTIC=" + json.dumps(bounds, separators=(",", ":")), flush=True)
        assert not bounds["overflow"], "directory must fit the viewport"
        context.close()
        print("PASS directory browser fixture", width, "live refresh, typed request, real result rendering, protected preparation, credential refusal, client task label")
    context = browser.new_context()
    page = context.new_page()
    page.route("**/*", routing(fail_inventory=True))
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://app.test/i2idlx/#agents-directory")
    page.wait_for_function("document.querySelector('#directory').textContent.includes('Directory returned HTTP 503')")
    assert "Build snapshot · live status unverified" in page.inner_text("#directory")
    assert page.locator('#directory button[aria-label^="Validate inputs"]:not([disabled])').count() == 0, "stale fallback cannot run requests"
    context.close()
    browser.close()
assert not errors, "directory browser page errors: " + repr(errors)
print("PASS explicit browser fixtures; these checks do not assert production capability execution")
