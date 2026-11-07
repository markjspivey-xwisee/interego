"""Actual bundled Ask UI with deterministic local course and paired-agent fixtures.

Usage: python -X utf8 -I tools/i2idlx-user-course-browser-check.py APP_ROOT CACHE SHOTS [BUNDLE]
The optional bundle replaces the final app script for a development preview.
No provider, model, wallet or other external API is contacted.
"""
import json
import pathlib
import sys
from html.parser import HTMLParser
from playwright.sync_api import sync_playwright


def replace_final_script(source, bundle):
    """Replace one closed script in a generated preview, preserving its surrounding HTML."""
    class ScriptSpans(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.line_starts = [0] + [i + 1 for i, char in enumerate(source) if char == "\n"]
            self.open_script = None
            self.spans = []

        def absolute_offset(self):
            line, column = self.getpos()
            return self.line_starts[line - 1] + column

        def handle_starttag(self, tag, attrs):
            if tag == "script":
                self.open_script = self.absolute_offset()

        def handle_startendtag(self, tag, attrs):
            if tag == "script":
                raise ValueError("A preview cannot replace a self-closing script tag.")

        def handle_endtag(self, tag):
            if tag == "script" and self.open_script is not None:
                self.spans.append((self.open_script, source.index(">", self.absolute_offset()) + 1))
                self.open_script = None

    parser = ScriptSpans()
    parser.feed(source)
    parser.close()
    if parser.open_script is not None:
        raise ValueError("A preview cannot replace an unclosed script tag.")
    if not parser.spans:
        raise ValueError("The preview has no closed script tag to replace.")
    start, end = parser.spans[-1]
    return source[:start] + "<script>" + bundle + "</script>" + source[end:]


root, cache, shots = [pathlib.Path(value).resolve() for value in sys.argv[1:4]]
shots.mkdir(parents=True, exist_ok=True)
html_path = root / "site/app.html"
if not html_path.exists():
    html_path = root / "site-ts/app.html"
html = html_path.read_text(encoding="utf-8")
if len(sys.argv) > 4:
    html = replace_final_script(html, pathlib.Path(sys.argv[4]).read_text(encoding="utf-8"))

EXPIRES = "2099-01-01T00:00:00.000Z"
APP_ID, SECRET = "local-app-fixture", "local-secret-never-send-to-agent"
courses = [{"id": "course-a", "title": "Safety fundamentals", "version": 3, "standard": "SCORM 2004"},
           {"id": "course-b", "title": "Equipment checks", "version": 5, "standard": "SCORM 1.2"}]
errors, calls, source_calls, agent_calls = [], [], [], []
state = {"session": 0, "connection": None, "expire": False, "wrong_source": False, "omit_content_digest": False,
         "digest": "a" * 64, "content_digest": "c" * 64, "content_body": "Inspect the equipment before use."}

def reply(route, value, status=200):
    return route.fulfill(status=status, content_type="application/json", body=json.dumps(value))

def route_handler(route):
    request, url = route.request, route.request.url
    if url.startswith("http://app.test/i2idlx/api/"):
        assert request.method == "POST", "fixtures accept explicit API actions only"
        body = request.post_data_json
        calls.append((url, body))
        session = str(state["session"]) * 32
        if url.endswith("/agent-sessions/create"):
            state["session"] += 1
            session = str(state["session"]) * 32
            return reply(route, {"session_id": session, "browser_token": "2" * 64, "invite_token": "3" * 64,
                "expires_at": EXPIRES, "invite_expires_at": EXPIRES, "audience": "http://app.test",
                "action_iri": "urn:foxxi:i2idlx:agent-session", "protocol": {"driver": {"action": "urn:foxxi:i2idlx:agent-session",
                "signed_fields": {"i2idlx_operation": "agent-session", "bridge_audience": "http://app.test", "session_id": session}}}})
        assert request.headers.get("authorization") == "Bearer " + "2" * 64
        assert body["session_id"] == session, "course and agent operations use the active session"
        operation = body["operation"]
        if url.endswith("/agent-sessions/browser"):
            if operation == "status":
                return reply(route, {"session_id": session, "state": "connected", "driver": {"actor": "did:example:fixture-agent"}, "expires_at": EXPIRES})
            if operation == "disconnect":
                state["connection"] = None
                return reply(route, {"disconnected": True})
            if operation == "invite":
                state["connection"] = None
                return reply(route, {"invite_token": "4" * 64, "invite_expires_at": EXPIRES})
            if operation == "request":
                agent_calls.append(body)
                assert SECRET not in json.dumps(body) and APP_ID not in json.dumps(body), "provider credentials cannot reach the agent"
                return reply(route, {"turn_id": "turn-" + str(len(agent_calls)), "state": "completed", "revision": 1,
                    "text": "Fixture answer " + str(len(agent_calls)) + " cites SC1 and [[learning-objectives]]."})
            raise AssertionError("unexpected agent operation " + operation)
        assert url.endswith("/user-courses"), "unknown endpoint"
        if operation == "status":
            return reply(route, {"connected": bool(state["connection"]), "connection_id": state["connection"], "expires_at": EXPIRES})
        if operation == "connect":
            assert body["credentials"] == {"type": "basic", "app_id": APP_ID, "secret": SECRET}
            state["connection"] = "connection-" + str(state["session"])
            return reply(route, {"connected": True, "provider": "scorm-cloud", "connection_id": state["connection"], "expires_at": EXPIRES})
        if operation == "disconnect":
            state["connection"] = None
            return reply(route, {"connected": False})
        assert body["connection_id"] == state["connection"]
        if operation == "courses":
            return reply(route, {"connection_id": state["connection"], "courses": courses})
        assert operation == "source"
        source_calls.append(body)
        if state["expire"]:
            state["connection"] = None
            return reply(route, {"code": "course_connection_expired", "error": "Your course connection expired. Reconnect your source."}, 410)
        selected = next(item for item in courses if item["id"] == body["course_id"])
        assert selected["version"] == body["version"]
        source = {"provider": "scorm-cloud", "course_id": selected["id"], "title": selected["title"],
                  "version": selected["version"], "package_sha256": state["digest"], "content_sha256": state["content_digest"]}
        if state["wrong_source"]:
            source["course_id"] = "wrong-course"
        if state["omit_content_digest"]:
            del source["content_sha256"]
        citation = {"id": "SC1", "title": "Safety objective", "body": state["content_body"],
                    "locator": "lesson.html section 2", "source_uri": "urn:scorm-cloud:course:" + selected["id"] + ":version:" + str(selected["version"]) + ":content:" + state["content_digest"]}
        return reply(route, {"connection_id": state["connection"], "source": source, "citations": [citation], "missing_context": [],
            "retrieved_at": "2026-11-07T12:00:00.000Z", "truncated": False,
            "interventionContext": {"kind": "instructional-source-reference", "source": source, "passages": [citation]}})
    if request.method not in ("GET", "HEAD"):
        raise AssertionError("unexpected external write " + url)
    if url.startswith("http://app.test/i2idlx/"):
        return route.fulfill(status=200, content_type="text/html", body=html)
    if url.startswith("https://cdnjs.cloudflare.com/"):
        asset = cache / url.replace("https://", "").replace("/", "_")
        return route.fulfill(status=200, content_type="application/javascript", body=asset.read_bytes()) if asset.exists() else route.abort()
    if url.startswith("https://fonts.googleapis.com/"):
        return route.fulfill(status=200, content_type="text/css", body=(cache / "fonts.css").read_text())
    if url.startswith("https://fonts.gstatic.com/"):
        asset = cache / "gstatic" / url.replace("https://fonts.gstatic.com/", "").replace("/", "_")
        return route.fulfill(status=200, content_type="font/woff2", body=asset.read_bytes()) if asset.exists() else route.abort()
    return route.abort()

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1050})
    page.route("**/*", route_handler)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://app.test/i2idlx/#ask")
    panel = page.get_by_test_id("ask-course-source")
    panel.locator("summary").first.click()
    assert page.get_by_label("SCORM Cloud secret", exact=True).is_disabled()
    assert not calls, "no connector or identity request before explicit action"
    print("PASS unavailable Ask explains pairing and makes no automatic connection")

    def pair():
        page.get_by_role("button", name="Connect", exact=True).click()
        page.get_by_role("button", name="Connect an AI agent", exact=True).click()
        page.get_by_role("button", name="Replace connected agent", exact=True).wait_for(timeout=12000)
        page.get_by_role("button", name="Close", exact=True).click()
        page.get_by_role("textbox", name="Ask", exact=True).wait_for()

    def connect_course():
        if not panel.evaluate("element => element.open"):
            panel.locator("summary").first.click()
        page.get_by_label("SCORM Cloud application ID", exact=True).fill(APP_ID)
        page.get_by_label("SCORM Cloud secret", exact=True).fill(SECRET)
        page.get_by_role("button", name="Connect my SCORM Cloud", exact=True).click()
        page.get_by_label("SCORM Cloud course", exact=True).wait_for()

    def select_course(index):
        page.get_by_label("SCORM Cloud course", exact=True).select_option(json.dumps([courses[index]["id"], courses[index]["version"]], separators=(",", ":")))

    def ask(question, answer=True):
        page.get_by_role("textbox", name="Ask", exact=True).fill(question)
        page.get_by_role("button", name="Ask", exact=True).click()
        if answer:
            page.locator(".msg.bot").last.get_by_text("Fixture answer", exact=False).wait_for()
        else:
            page.get_by_role("button", name="Stop", exact=True).wait_for(state="hidden")

    pair()
    connect_course()
    assert not source_calls and not agent_calls, "listing courses must not share content with AI"
    assert not page.get_by_label("SCORM Cloud secret", exact=True).count(), "credential fields removed on successful connect"
    select_course(0)
    assert not source_calls and not agent_calls, "selecting a source does not share it"
    ask("What should I inspect?")
    assert source_calls[-1]["question"] == "What should I inspect?"
    assert "instructional-source-reference" in json.dumps(agent_calls[-1])
    assert "SC1" in json.dumps(agent_calls[-1]) and "Inspect the equipment before use." in json.dumps(agent_calls[-1])
    panel.get_by_text("Course sources for the latest question", exact=True).click()
    assert "Version 3" in panel.inner_text() and state["digest"] in panel.inner_text() and state["content_digest"] in panel.inner_text()
    assert "Package contents SHA-256" in panel.inner_text() and "Export archive SHA-256" in panel.inner_text()
    assert "urn:scorm-cloud:course:course-a:version:3" in panel.inner_text()
    page.screenshot(path=str(shots / "ask-course-source-desktop.png"), full_page=True)
    page.set_viewport_size({"width": 420, "height": 860})
    page.screenshot(path=str(shots / "ask-course-source-mobile.png"), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "course citations must fit the mobile viewport"
    page.set_viewport_size({"width": 1440, "height": 1050})
    print("PASS explicit Ask sends versioned instructional context and displays source citations/digest")

    ask("And what comes next?")
    assert source_calls[-1]["question"] == "And what comes next?" and len(source_calls) == 2
    assert any(message["content"] == "What should I inspect?" for message in agent_calls[-1]["messages"])
    print("PASS each followup retrieves fresh context and retains only its current-source conversation")

    state["digest"] = "b" * 64
    ask("Same course files in a repacked archive")
    assert source_calls[-1]["course_id"] == "course-a" and source_calls[-1]["version"] == 3
    assert page.locator(".msg").count() == 6, "repacking identical package files must preserve conversation"
    assert any(message["content"] == "What should I inspect?" for message in agent_calls[-1]["messages"])
    assert "conversation was cleared" not in panel.inner_text()
    assert state["digest"] in panel.inner_text() and state["content_digest"] in panel.inner_text()
    print("PASS repacked identical course files retain conversation while archive evidence updates")

    select_course(1)
    assert page.locator(".msg").count() == 0
    ask("What is in this course?")
    assert source_calls[-1]["course_id"] == "course-b" and source_calls[-1]["version"] == 5
    assert not any(message["content"] == "What should I inspect?" for message in agent_calls[-1]["messages"])
    before = len(agent_calls)
    state["wrong_source"] = True
    ask("Reject a mismatched source", answer=False)
    assert len(agent_calls) == before and "does not match" in panel.inner_text()
    state["wrong_source"] = False
    print("PASS switching source clears history and a mismatched source never reaches AI")

    original_content_digest = state["content_digest"]
    state["content_digest"] = "invalid-content-digest"
    ask("Reject an invalid content fingerprint", answer=False)
    assert len(agent_calls) == before and "does not match" in panel.inner_text()
    state["content_digest"] = original_content_digest
    state["omit_content_digest"] = True
    ask("Reject a missing content fingerprint", answer=False)
    assert len(agent_calls) == before and "does not match" in panel.inner_text()
    state["omit_content_digest"] = False
    print("PASS missing or invalid content identity cannot reach the paired AI")

    state["content_digest"] = "d" * 64
    state["content_body"] = "Check the power supply before use."
    ask("Use updated course content", answer=False)
    assert len(agent_calls) == before and page.locator(".msg").count() == 0
    assert "course content changed" in panel.inner_text()
    ask("Use updated course content")
    assert len(agent_calls) == before + 1
    assert "Check the power supply before use." in json.dumps(agent_calls[-1])
    assert not any(message["content"] == "What is in this course?" for message in agent_calls[-1]["messages"])
    print("PASS changed course file content clears history and requires a fresh explicit Ask")

    state["expire"] = True
    before = len(agent_calls)
    ask("Expired course source", answer=False)
    assert len(agent_calls) == before and page.locator(".msg").count() == 0
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    assert page.get_by_role("button", name="Agent connected", exact=True).count() == 1
    assert page.get_by_label("SCORM Cloud secret", exact=True).input_value() == ""
    page.get_by_role("button", name="Use glossary only", exact=True).click()
    ask("Explain formative assessment")
    assert len(agent_calls) == before + 1
    assert "Selected intervention reference context" not in json.dumps(agent_calls[-1])
    print("PASS course expiry clears private context, retains AI pairing and requires explicit glossary fallback")
    page.evaluate("location.hash = 'browse'")
    page.locator(".lex-list .li").first.wait_for()
    page.evaluate("location.hash = 'ask'")
    page.get_by_role("textbox", name="Ask", exact=True).wait_for()
    assert page.locator(".msg").count() == 2, "ordinary glossary conversations survive page navigation"
    print("PASS ordinary glossary conversation survives leaving and returning to Ask")

    state["expire"] = False
    connect_course()
    select_course(0)
    ask("New private course question")
    page.get_by_role("button", name="Agent connected", exact=True).click()
    page.get_by_role("button", name="Replace connected agent", exact=True).click()
    page.get_by_role("button", name="New connection request", exact=True).wait_for()
    page.get_by_role("button", name="Replace connected agent", exact=True).wait_for(timeout=12000)
    page.get_by_role("button", name="Close", exact=True).click()
    assert page.locator(".msg").count() == 0
    assert page.get_by_label("SCORM Cloud secret", exact=True).input_value() == ""
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    print("PASS same-session invitation renewal invalidates private source and conversation")
    connect_course()
    select_course(0)
    ask("Private question before session replacement")
    page.get_by_role("button", name="Agent connected", exact=True).click()
    page.get_by_role("button", name="Disconnect agent", exact=True).click()
    page.get_by_role("button", name="Close", exact=True).click()
    page.get_by_text("Connect an AI agent to ask here", exact=True).wait_for()
    pair()
    assert page.locator(".msg").count() == 0
    assert page.get_by_label("SCORM Cloud secret", exact=True).input_value() == ""
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    storage = page.evaluate("({local: {...localStorage}, session: {...sessionStorage}})")
    assert SECRET not in json.dumps(storage) and APP_ID not in json.dumps(storage)
    assert "Inspect the equipment" not in json.dumps(storage)
    print("PASS replacing AI session clears source, history and credentials without persisting private content")
    page.set_viewport_size({"width": 420, "height": 860})
    page.screenshot(path=str(shots / "ask-course-reconnect-mobile.png"), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "course UI must fit mobile viewport"
    browser.close()

assert not errors, "browser errors: " + repr(errors)
assert all(url.startswith("http://app.test/i2idlx/api/") for url, _ in calls)
print("PASS bundled course UI regression; no live API, provider or model calls")
