"""Actual bundled Ask UI with deterministic local course and paired-agent fixtures.

Usage: python -X utf8 -I tools/i2idlx-user-course-browser-check.py APP_ROOT CACHE SHOTS [BUNDLE]
The optional bundle replaces the final app script for a development preview.
No provider, model, wallet or other external API is contacted.
"""
import json
import pathlib
import sys
from datetime import datetime, timedelta, timezone
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
# Obvious synthetic placeholders; these have no SCORM Cloud provider access.
APP_ID, SECRET = "fixture-app", "test-secret"
SOURCE_URL, SOURCE_TOKEN = "https://source.example/course-access", "fixture-source-token"
courses = [{"id": "course-a", "title": "Safety fundamentals", "version": 3, "standard": "SCORM 2004", "access_modes": ["transient", "cached", "virtual"]},
           {"id": "course-b", "title": "Equipment checks", "version": 5, "standard": "SCORM 1.2", "access_modes": ["transient", "cached", "virtual"]}]
external_courses = [{"id": "external-course", "title": "Publisher hosted exercise", "version": "revision-23", "standard": "External", "access_modes": ["virtual"]}]
errors, calls, source_calls, agent_calls, host_calls, pending_sources, pending_lti_status = [], [], [], [], [], [], []
state = {"session": 0, "connection": None, "expire": False, "wrong_source": False, "omit_content_digest": False, "defer_source": False,
         "digest": "a" * 64, "content_digest": "c" * 64, "content_body": "Inspect the equipment before use.",
         "provider": "scorm-cloud", "grants": {}, "cached": set(), "grant_serial": 0, "remote_status": "pending", "grant_expires": EXPIRES, "fail_local_delete": False, "deletions": {}, "authentication_failed": False, "permission_revoked": False,
         "lti": None, "lti_setup_calls": 0, "lti_setup_uncertain": False, "lti_cleanup_fail": False, "defer_lti_status": False, "projection_digest": "d" * 64}

def reply(route, value, status=200):
    return route.fulfill(status=status, content_type="application/json", body=json.dumps(value))

def route_handler(route):
    request, url = route.request, route.request.url
    if url == "http://app.test/i2idlx/capabilities":
        return reply(route, {"audience": "http://app.test", "_affordances": [
            {"action": "urn:iep:action:foxxi:i2idlx-" + operation, "href": "http://app.test/i2idlx/api/fixture-" + operation}
            for operation in ("session", "challenge", "read", "write")]})
    if url.startswith("http://app.test/i2idlx/api/fixture-"):
        if url.endswith("fixture-challenge"):
            assert request.method == "GET"
            return reply(route, {"nonce": "fixture-challenge"})
        assert request.method == "POST"
        signed = request.post_data_json
        body = json.loads(signed["_signed_payload"])
        calls.append((url, body))
        assert signed["_signature"] == "fixture-host-signature", "this local fixture never authenticates a real identity"
        if url.endswith("fixture-session"):
            return reply(route, {"me": {"id": "fixture-owner", "did": "did:example:fixture-host", "name": "Fixture host owner"},
                "sharedRead": False, "sharedWrite": False, "canWrite": False, "privateEncryption": False})
        assert url.endswith("fixture-read"), "the fixture grants no writes"
        if "doc_path" in body:
            return reply(route, {"exists": False, "etag": "fixture-empty"})
        return reply(route, {"ballots": {"docs": []}, "notes": {"docs": []}, "usage": {"docs": []},
            "policy": {"exists": True, "data": {"quorum": 2}, "etag": "fixture-policy"}})
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
                state["grants"].clear()
                state["cached"].clear()
                state["deletions"].clear()
                return reply(route, {"disconnected": True})
            if operation == "invite":
                state["connection"] = None
                state["grants"].clear()
                state["cached"].clear()
                state["deletions"].clear()
                return reply(route, {"invite_token": "4" * 64, "invite_expires_at": EXPIRES})
            if operation == "request":
                agent_calls.append(body)
                assert all(secret not in json.dumps(body) for secret in (SECRET, APP_ID, SOURCE_TOKEN)), "provider credentials cannot reach the agent"
                return reply(route, {"turn_id": "turn-" + str(len(agent_calls)), "state": "completed", "revision": 1,
                    "text": "Fixture answer " + str(len(agent_calls)) + " cites SC1 and [[learning-objectives]]."})
            raise AssertionError("unexpected agent operation " + operation)
        assert url.endswith("/user-courses"), "unknown endpoint"
        if operation == "status":
            return reply(route, {"connected": bool(state["connection"]), "provider": state["provider"], "connection_id": state["connection"], "expires_at": EXPIRES})
        if operation == "connect":
            state["provider"] = body["provider"]
            if body["provider"] == "scorm-cloud":
                assert body["credentials"] == {"type": "basic", "app_id": APP_ID, "secret": SECRET}
            else:
                assert body["provider"] == "source-service"
                assert body["credentials"] == {"service_url": SOURCE_URL, "token": SOURCE_TOKEN}
            state["connection"] = "connection-" + str(state["session"])
            state["grants"].clear()
            state["cached"].clear()
            state["deletions"].clear()
            state["lti"] = None
            return reply(route, {"connected": True, "provider": state["provider"], "connection_id": state["connection"], "expires_at": EXPIRES})
        if operation == "disconnect":
            state["connection"] = None
            state["grants"].clear()
            state["cached"].clear()
            state["deletions"].clear()
            state["lti"] = None
            return reply(route, {"connected": False, "lti_cleanup": {"removed": not state["lti_cleanup_fail"]}})
        assert body["connection_id"] == state["connection"]
        if operation == "courses":
            return reply(route, {"connection_id": state["connection"], "courses": courses if state["provider"] == "scorm-cloud" else external_courses})
        source_key = json.dumps([body["course_id"], body["version"]])
        if operation == "access-status":
            return reply(route, {"connection_id": state["connection"], "course_id": body["course_id"], "version": body["version"],
                "grant": state["grants"].get(source_key), "deletion": state["deletions"].get(source_key),
                "cache": {"present": source_key in state["cached"], "bytes": 1200 if source_key in state["cached"] else 0}, "lti": state["lti"]})
        if operation == "grant":
            permission = body["permission"]
            assert permission["authorized"] is True and permission["authority"] in ("owner", "authorized-by-owner")
            assert permission["retention_minutes"] in (5, 10, 30)
            assert body["mode"] in (["transient", "cached", "virtual"] if state["provider"] == "scorm-cloud" else ["virtual"])
            state["grant_serial"] += 1
            grant = {"id": format(state["grant_serial"], "048x"), "mode": body["mode"], "expires_at": state["grant_expires"],
                     "authority": permission["authority"], "verification": "user-attested" if state["provider"] == "scorm-cloud" else "source-service-attested"}
            state["grants"][source_key] = grant
            return reply(route, {"grant": grant, "cache": {"present": False, "bytes": 0}})
        # Only a deterministic UI state machine: actual LTI signature/nonce/owner
        # verification belongs to backend integration tests and the live provider test.
        if operation.startswith("lti-"):
            assert state["provider"] == "scorm-cloud"
            if operation == "lti-prepare":
                assert body["grant_id"] == state["grants"][source_key]["id"]
                state["lti"] = {"id": "fixture-lti-" + str(state["grant_serial"]), "state": "prepared", "expires_at": EXPIRES,
                    "tool": {"login_url": "https://workbench.example/lti/login", "launch_url": "https://workbench.example/lti/launch",
                             "jwks_url": "https://workbench.example/lti/jwks", "public_key_pem": "PUBLIC-KEY"}}
                return reply(route, {"lti": state["lti"]})
            assert state["lti"] and body["lti_id"] == state["lti"]["id"]
            if operation == "lti-setup":
                assert state["grants"][source_key]["authority"] == "owner", "reading permission alone cannot configure trusted account access"
                state["lti_setup_calls"] += 1
                state["lti"].update(state="ready", connector_id="fixture-created-connector", helper_course_id="fixture-separate-helper")
                if state["lti_setup_uncertain"]:
                    return reply(route, {"code": "course_provider_unavailable", "error": "The Cloud setup response was interrupted. Check its status."}, 502)
            elif operation == "lti-launch":
                assert state["lti"]["state"] in ("ready", "verified", "attached")
                return reply(route, {"lti": state["lti"], "launch_url": "https://app.cloud.scorm.com/fixture-lti-preview?handoff=PRIVATE-LAUNCH-URL"})
            elif operation == "lti-attach":
                assert state["lti"]["state"] == "verified"
                state["lti"]["state"] = "attached"
            elif operation == "lti-disconnect":
                assert "grant_id" not in body, "removing an older setup must not bind to a newer source grant"
                if state["lti_cleanup_fail"]:
                    state["lti"].update(state="cleanup-failed", note="The provider did not confirm cleanup. Retry removal.")
                    return reply(route, {"removed": False, "lti": state["lti"], "original_course_unchanged": True})
                state["lti"] = None
                return reply(route, {"removed": True, "lti": None, "original_course_unchanged": True})
            else:
                assert operation == "lti-status"
                if state["defer_lti_status"]:
                    pending_lti_status.append((route, {"lti": json.loads(json.dumps(state["lti"]))}))
                    return
            return reply(route, {"lti": state["lti"]})
        if operation in ("delete", "request-deletion", "deletion-status"):
            state["grants"].pop(source_key, None)
            state["cached"].discard(source_key)
            if state["lti"]:
                if state["lti"].get("connector_id") or state["lti"].get("helper_course_id"):
                    state["lti"]["state"] = "revoked"
                    state["lti"].pop("launch", None)
                else:
                    state["lti"] = None
            if operation == "delete" and state["fail_local_delete"]:
                return reply(route, {"error": "Local deletion response was interrupted.", "code": "course_provider_unavailable"}, 502)
            status = "not_requested" if operation == "delete" else "completed" if operation == "deletion-status" else state["remote_status"] if state["provider"] == "source-service" else "unsupported"
            remote = {"status": status}
            if status in ("pending", "completed"):
                remote.update(request_id="fixture-deletion-request", scope="derived-content")
            result = {"deleted": True, "scope": "this-session", "permission_revoked": True, "remote_deletion": remote}
            state["deletions"][source_key] = {"grant_id": body["grant_id"], **result}
            return reply(route, result)
        assert operation == "source"
        source_calls.append(body)
        if state["authentication_failed"]:
            state["connection"] = None
            state["grants"].clear()
            state["cached"].clear()
            state["deletions"].clear()
            return reply(route, {"code": "course_provider_authentication_failed", "error": "SCORM Cloud refused these credentials. Connect again."}, 401)
        if state["permission_revoked"]:
            state["grants"].clear()
            state["cached"].clear()
            return reply(route, {"code": "course_permission_revoked", "error": "The course permission was revoked because source access could not be rechecked. Grant access again."}, 503)
        if state["expire"]:
            state["connection"] = None
            return reply(route, {"code": "course_connection_expired", "error": "Your course connection expired. Reconnect your source."}, 410)
        selected = next(item for item in (courses if state["provider"] == "scorm-cloud" else external_courses) if item["id"] == body["course_id"])
        assert selected["version"] == body["version"]
        grant = state["grants"][source_key]
        assert body["grant_id"] == grant["id"], "only an explicit current permission may retrieve content"
        source = {"provider": state["provider"], "course_id": selected["id"], "title": selected["title"],
                  "version": selected["version"], "content_sha256": state["content_digest"]}
        if state["provider"] == "scorm-cloud":
            if grant["mode"] == "virtual":
                source.pop("content_sha256")
                source.update(source_version="course-version:" + str(selected["version"]), projection_sha256=state["projection_digest"], fingerprint_scope="selected-instructional-projection")
                if state["lti"] and state["lti"]["state"] == "attached":
                    source["lti"] = {key: value for key, value in state["lti"]["launch"].items() if key != "subject"}
                    source["lti"].update(verification="signed-lti13-platform-launch", subject_shared=False,
                        identity_binding="The verified platform subject was explicitly associated with this authenticated browser session.")
            else:
                source["package_sha256"] = state["digest"]
        else:
            source["lti"] = {"context_id": "provider-context", "resource_link_id": "provider-resource"}
        if state["wrong_source"]:
            source["course_id"] = "wrong-course"
        if state["omit_content_digest"]:
            del source["content_sha256"]
        citation = {"id": "SC1", "title": "Safety objective", "body": state["content_body"],
                    "locator": "lesson.html section 2", "source_uri": "urn:" + state["provider"] + ":course:" + selected["id"] + ":version:" + str(selected["version"]) + ":content:" + state["content_digest"]}
        cache_hit = source_key in state["cached"] and not body.get("refresh")
        if grant["mode"] == "cached":
            state["cached"].add(source_key)
        graph = {"representation": "published-structure", "nodes": 3, "edges": 2, "semantic_prerequisites_inferred": False} if grant["mode"] == "cached" else {"representation": "source-service" if grant["mode"] == "virtual" and state["provider"] == "source-service" else "none"}
        packet = {"connection_id": state["connection"], "source": source, "citations": [citation], "missing_context": [],
            "retrieved_at": "2026-11-07T12:00:00.000Z", "truncated": False,
            "access": {"mode": grant["mode"], "permission": grant, "cache": {"present": grant["mode"] == "cached", "hit": cache_hit, "bytes": 1200 if grant["mode"] == "cached" else 0, "stored_at": "2026-11-07T11:59:00.000Z" if grant["mode"] == "cached" else None, "expires_at": EXPIRES}, "graph": graph},
            "interventionContext": {"kind": "instructional-source-reference", "source": source, "passages": [citation]}}
        if state["defer_source"]:
            pending_sources.append((route, packet))
            return
        return reply(route, packet)
    if request.method not in ("GET", "HEAD"):
        raise AssertionError("unexpected external write " + url)
    if url.startswith("https://app.cloud.scorm.com/fixture-lti-preview"):
        assert state["lti"] and state["lti"]["state"] in ("ready", "verified", "attached")
        state["lti"].update(state="verified", launch={"issuer": "https://cloud.scorm.com/fixture-platform", "client_id": "fixture-client",
            "deployment_id": "fixture-deployment", "subject": "fixture-lms-account", "context_id": "fixture-context", "resource_link_id": "fixture-resource",
            "verified_at": "2026-11-07T12:00:00.000Z", "course_id": courses[0]["id"], "version": courses[0]["version"]})
        return route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>Fixture LTI helper</title><p>Fixture launch returned.</p>")
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
    def host_sample(payload):
        host_calls.append(payload)
        encoded = json.dumps(payload["messages"])
        for private_marker in (SECRET, APP_ID, SOURCE_TOKEN, "Selected intervention reference context", "urn:scorm-cloud:course:",
                "Private course question before shortcut", "Private course followup before shortcut", "Private pending source question", "Fixture answer"):
            assert private_marker not in encoded, "a glossary shortcut must not share private course history with another executor"
        assert payload["scope"] == "Glossary only", "the visible source consent must change before the host receives the question"
        assert payload["course"] == "" and not payload["sourceDetails"], "course selection and sources clear before host execution"
        assert len(payload["messages"]) == 2, "an explicit glossary shortcut begins a fresh public discussion"
        return {"text": "Host glossary answer " + str(len(host_calls)) + "."}

    page.expose_function("__fixtureHostSample", host_sample)
    page.add_init_script("""(() => {
        const sample = async messages => window.__fixtureHostSample({messages,
            scope: document.querySelector('[data-testid="ask-context-scope"]')?.textContent,
            course: document.querySelector('select[aria-label="SCORM Cloud course"]')?.value || '',
            sourceDetails: [...document.querySelectorAll('summary')].some(el => el.textContent === 'Course sources for the latest question')});
        sample.modelTiers = false; sample.limits = async () => ({tools: false});
        window.interegoWorkbench = {sample, signRequest: async payload => ({
            _signed_payload: JSON.stringify({...payload, agent_id: 'did:example:fixture-host'}),
            _signature: 'fixture-host-signature'})};
    })();""")
    page.context.route("**/*", route_handler)
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

    def approve_course(selected_mode="transient", authority="authorized-by-owner"):
        page.get_by_text("Reading your course source…", exact=True).wait_for(state="hidden")
        mode = page.get_by_label("Course access mode", exact=True)
        if page.get_by_role("button", name="Delete local content and revoke permission", exact=True).count() and mode.input_value() == selected_mode:
            return
        mode.select_option(selected_mode)
        page.get_by_label("Confirm course owner permission", exact=True).wait_for()
        assert not page.get_by_label("Confirm course owner permission", exact=True).is_checked()
        assert page.get_by_label("Course permission authority", exact=True).input_value() == ""
        assert page.get_by_role("button", name="Apply course permission", exact=True).is_disabled()
        page.get_by_label("Course permission authority", exact=True).select_option(authority)
        page.get_by_label("Confirm course owner permission", exact=True).check()
        page.get_by_role("button", name="Apply course permission", exact=True).click()
        page.get_by_role("button", name="Delete local content and revoke permission", exact=True).wait_for()

    def select_course(index, selected_mode="transient", approve=True):
        page.get_by_label("SCORM Cloud course", exact=True).select_option(json.dumps([courses[index]["id"], courses[index]["version"]], separators=(",", ":")))
        if approve:
            approve_course(selected_mode)

    def ask(question, answer=True):
        expected_answer = len(agent_calls) + 1
        page.get_by_role("textbox", name="Ask", exact=True).fill(question)
        page.get_by_role("button", name="Ask", exact=True).click()
        if answer:
            page.locator(".msg.bot").last.get_by_text("Fixture answer " + str(expected_answer) + " cites", exact=False).wait_for()
        else:
            page.get_by_role("button", name="Stop", exact=True).wait_for(state="hidden")

    pair()
    connect_course()
    assert not source_calls and not agent_calls, "listing courses must not share content with AI"
    assert not page.get_by_label("SCORM Cloud secret", exact=True).count(), "credential fields removed on successful connect"
    select_course(0, approve=False)
    page.get_by_label("Course access mode", exact=True).wait_for()
    assert page.get_by_label("Course access mode", exact=True).input_value() == ""
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    assert page.get_by_label("Course access mode", exact=True).locator('option[value="virtual"]').count() == 1
    approve_course()
    assert not source_calls and not agent_calls, "selecting a source does not share it"
    print("PASS course selection requires explicit mode, unchecked permission and authority; Cloud offers native virtual reading explicitly")
    ask("What should I inspect?")
    assert source_calls[-1]["question"] == "What should I inspect?"
    assert "instructional-source-reference" in json.dumps(agent_calls[-1])
    assert "SC1" in json.dumps(agent_calls[-1]) and "Inspect the equipment before use." in json.dumps(agent_calls[-1])
    panel.get_by_text("Course sources for the latest question", exact=True).click()
    assert "Version 3" in panel.inner_text() and state["digest"] in panel.inner_text() and state["content_digest"] in panel.inner_text()
    assert "Content fingerprint" in panel.inner_text() and "Export archive SHA-256" in panel.inner_text()
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

    # Exercise the real global command palette while both executor paths are present.
    connect_course()
    select_course(0)
    ask("Private course question before shortcut")
    page.get_by_role("button", name="Agent connected", exact=True).click()
    page.get_by_text("Keep work with Interego", exact=True).click()
    page.get_by_role("button", name="Connect Interego or browser wallet", exact=True).click()
    page.get_by_text("Fixture host owner", exact=True).first.wait_for()
    page.get_by_role("button", name="Close", exact=True).click()
    before = len(agent_calls)
    prior_sources = len(source_calls)
    ask("Private course followup before shortcut")
    assert len(agent_calls) == before + 1 and not host_calls, "course followups stay with the paired executor even when a host is available"
    assert len(source_calls) == prior_sources + 1, "each private followup retrieves fresh source context"
    assert any(message["content"] == "Private course question before shortcut" for message in agent_calls[-1]["messages"])

    def glossary_shortcut(question, answer_number):
        page.keyboard.press("Control+k")
        page.get_by_role("combobox", name="Search", exact=True).fill(question)
        page.get_by_role("option").filter(has_text="Ask the glossary:").click()
        page.get_by_text("Host glossary answer " + str(answer_number) + ".", exact=True).wait_for()
        assert page.get_by_test_id("ask-context-scope").inner_text() == "Glossary only"
        assert page.get_by_label("SCORM Cloud course", exact=True).input_value() == ""
        assert page.locator(".msg").count() == 2

    before = len(agent_calls)
    glossary_shortcut("Explain a public glossary concept", 1)
    assert len(agent_calls) == before and len(host_calls) == 1
    print("PASS real Ctrl+K glossary shortcut clears completed private history and visible course consent before host execution")

    select_course(0)
    state["defer_source"] = True
    with page.expect_request(lambda request: request.url.endswith("/user-courses") and request.post_data_json.get("operation") == "source"):
        page.get_by_role("textbox", name="Ask", exact=True).fill("Private pending source question")
        page.get_by_role("button", name="Ask", exact=True).click()
    page.get_by_text("Reading your course source…", exact=True).wait_for()
    assert pending_sources, "the private source request must be in flight before the shortcut"
    before = len(agent_calls)
    glossary_shortcut("Explain another public glossary concept", 2)
    state["defer_source"] = False
    for pending_route, packet in pending_sources:
        reply(pending_route, packet)
    pending_sources.clear()
    page.evaluate("new Promise(resolve => setTimeout(resolve, 0))")
    assert len(agent_calls) == before and len(host_calls) == 2
    assert page.get_by_test_id("ask-context-scope").inner_text() == "Glossary only"
    assert "Private pending source question" not in page.locator(".ask-log").inner_text()
    print("PASS real Ctrl+K glossary shortcut aborts/ignores pending private retrieval and never forwards it to either executor")

    select_course(0, selected_mode="cached")
    ask("Use the local course graph")
    panel.get_by_text("Course sources for the latest question", exact=True).click()
    assert "Local content graph: 3 graph items, 2 published structure links" in panel.inner_text()
    assert page.get_by_role("button", name="Request deletion at source", exact=True).count() == 0
    assert "Semantic prerequisites have not been inferred" in panel.inner_text()
    ask("Follow up using the local graph")
    assert "Local text and graph used for the latest question" in panel.inner_text()
    assert "Context prepared" in panel.inner_text() and "This question reused the local content" in panel.inner_text()
    assert "Local content stored" in panel.inner_text()
    page.get_by_label("Refresh course content for next question", exact=True).check()
    ask("Refresh the published content")
    assert source_calls[-1].get("refresh") is True
    assert not page.get_by_label("Refresh course content for next question", exact=True).is_checked()
    page.screenshot(path=str(shots / "ask-course-cached-graph-desktop.png"), full_page=True)
    print("PASS cached mode identifies the actual published-structure graph and exposes explicit source refresh")

    before = len(agent_calls)
    assert page.locator(".msg").count() > 0 and state["cached"], "revocation starts with cached content and private conversation"
    state["authentication_failed"] = True
    ask("A cached course question after provider access was revoked", answer=False)
    page.get_by_label("SCORM Cloud secret", exact=True).wait_for()
    assert len(agent_calls) == before and page.locator(".msg").count() == 0
    assert not state["connection"] and not state["cached"] and not state["grants"]
    assert not panel.get_by_text("Course sources for the latest question", exact=True).count()
    assert not page.get_by_role("button", name="Delete local content and revoke permission", exact=True).count()
    assert page.get_by_label("SCORM Cloud application ID", exact=True).input_value() == ""
    assert page.get_by_label("SCORM Cloud secret", exact=True).input_value() == ""
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    assert page.get_by_role("button", name="Agent connected", exact=True).count() == 1
    assert "SCORM Cloud refused these credentials. Connect again." in panel.inner_text()
    state["authentication_failed"] = False
    print("PASS provider authentication revocation immediately clears cached source, grant and private history and returns an empty reconnect form")

    connect_course()
    select_course(0, selected_mode="cached")
    ask("A fresh permitted cached question before permission revocation")
    before = len(agent_calls)
    state["permission_revoked"] = True
    ask("A cached question after source access recheck failed", answer=False)
    page.get_by_label("Confirm course owner permission", exact=True).wait_for()
    assert len(agent_calls) == before and page.locator(".msg").count() == 0
    assert state["connection"] and not state["cached"] and not state["grants"]
    assert page.get_by_label("SCORM Cloud course", exact=True).count() == 1
    assert not page.get_by_label("SCORM Cloud secret", exact=True).count()
    assert not page.get_by_label("Confirm course owner permission", exact=True).is_checked()
    assert not panel.get_by_text("Course sources for the latest question", exact=True).count()
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    assert "source access could not be rechecked" in panel.inner_text()
    state["permission_revoked"] = False
    print("PASS source recheck failure clears revoked grant, cache and private context while retaining the source connection for fresh permission")

    approve_course("cached")
    ask("A fresh permitted cached question before stopping a read")
    before = len(agent_calls)
    previous_deletions = sum(body.get("operation") in ("delete", "request-deletion") for _, body in calls)
    state["defer_source"] = True
    with page.expect_request(lambda request: request.url.endswith("/user-courses") and request.post_data_json.get("operation") == "source"):
        page.get_by_role("textbox", name="Ask", exact=True).fill("Pending cached course question before Stop")
        page.get_by_role("button", name="Ask", exact=True).click()
    page.get_by_text("Reading your course source…", exact=True).wait_for()
    page.get_by_role("button", name="Stop", exact=True).click()
    page.get_by_role("button", name="Stop", exact=True).wait_for(state="hidden")
    state["defer_source"] = False
    for pending_route, packet in pending_sources:
        reply(pending_route, packet)
    pending_sources.clear()
    page.evaluate("new Promise(resolve => setTimeout(resolve, 0))")
    assert len(agent_calls) == before and state["cached"] and state["grants"]
    assert page.locator(".msg").count() == 2
    assert page.get_by_role("button", name="Delete local content and revoke permission", exact=True).is_enabled()
    assert sum(body.get("operation") in ("delete", "request-deletion") for _, body in calls) == previous_deletions
    assert "Pending cached course question before Stop" not in page.locator(".ask-log").inner_text()
    print("PASS Stop ignores a late course response without deleting an existing permitted cache or its conversation")

    state["defer_source"] = True
    with page.expect_request(lambda request: request.url.endswith("/user-courses") and request.post_data_json.get("operation") == "source"):
        page.get_by_role("textbox", name="Ask", exact=True).fill("Pending cached course question before deletion")
        page.get_by_role("button", name="Ask", exact=True).click()
    page.get_by_text("Reading your course source…", exact=True).wait_for()
    before = len(agent_calls)
    assert page.get_by_role("button", name="Delete local content and revoke permission", exact=True).is_enabled()
    page.get_by_role("button", name="Delete local content and revoke permission", exact=True).click()
    page.get_by_text("The local text, graph and permission were removed from this session.", exact=False).wait_for()
    state["defer_source"] = False
    for pending_route, packet in pending_sources:
        reply(pending_route, packet)
    pending_sources.clear()
    page.evaluate("new Promise(resolve => setTimeout(resolve, 0))")
    assert len(agent_calls) == before and page.locator(".msg").count() == 0
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    assert not state["cached"] and not state["grants"]
    assert not panel.get_by_text("Course sources for the latest question", exact=True).count()
    assert not page.get_by_label("Confirm course owner permission", exact=True).is_checked()
    print("PASS deleting local content aborts an in-flight retrieval, clears private history and requires fresh permission")

    approve_course("cached")
    page.get_by_label("Course access mode", exact=True).select_option("transient")
    page.get_by_text("The local text, graph and permission were removed from this session.", exact=False).wait_for()
    assert not state["grants"] and not state["cached"]
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    assert not page.get_by_label("Confirm course owner permission", exact=True).is_checked()
    print("PASS changing access mode revokes the prior grant without silently granting the replacement")

    approve_course("transient")
    state["fail_local_delete"] = True
    prior_remote_requests = sum(body.get("operation") == "request-deletion" for _, body in calls)
    page.get_by_role("button", name="Delete local content and revoke permission", exact=True).click()
    page.get_by_role("button", name="Retry local deletion", exact=True).wait_for()
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    state["fail_local_delete"] = False
    page.get_by_role("button", name="Retry local deletion", exact=True).click()
    page.get_by_text("The local text, graph and permission were removed from this session.", exact=False).wait_for()
    assert sum(body.get("operation") == "request-deletion" for _, body in calls) == prior_remote_requests
    print("PASS retrying an uncertain local deletion does not escalate into an unrequested remote deletion")

    approve_course("virtual")
    ask("Read selected native Cloud source files")
    panel.get_by_text("Course sources for the latest question", exact=True).click()
    assert "Read selected source files (virtual)" in panel.inner_text()
    assert "SCORM Cloud does not perform the question search" in panel.inner_text()
    assert "Selected instructional passage fingerprint" in panel.inner_text()
    assert "not the whole course" in panel.inner_text() and "Source version: course-version:3" in panel.inner_text()
    assert "Export archive SHA-256" not in panel.inner_text() and not state["cached"]
    state["projection_digest"] = "e" * 64
    ask("A follow-up selecting another native source projection")
    assert page.locator(".msg").count() == 4, "a new selected projection does not represent a new course version"
    assert "course content changed" not in panel.inner_text()
    print("PASS Cloud virtual reading labels local query planning and preserves conversation across different selected projections")

    lti_panel = page.get_by_test_id("course-lti-connection")
    lti_panel.locator("summary").first.click()
    assert state["lti_setup_calls"] == 0
    page.get_by_role("button", name="Prepare LTI connection", exact=True).click()
    page.get_by_role("button", name="Create LTI connection in my SCORM Cloud", exact=True).wait_for()
    assert page.get_by_role("button", name="Create LTI connection in my SCORM Cloud", exact=True).is_disabled()
    assert "current reading permission does not authorize it" in lti_panel.inner_text()
    assert state["lti_setup_calls"] == 0
    print("PASS preparing public LTI settings does not create Cloud objects and owner-authorized reading does not enable trusted account setup")

    page.get_by_role("button", name="Delete local content and revoke permission", exact=True).click()
    page.get_by_text("The local text, graph and permission were removed from this session.", exact=False).wait_for()
    approve_course("virtual", authority="owner")
    lti_panel = page.get_by_test_id("course-lti-connection")
    if not lti_panel.evaluate("element => element.open"):
        lti_panel.locator("summary").first.click()
    page.get_by_role("button", name="Prepare LTI connection", exact=True).click()
    page.get_by_role("button", name="Create LTI connection in my SCORM Cloud", exact=True).wait_for()
    assert "separate private helper course" in lti_panel.inner_text() and "does not edit your original course" in lti_panel.inner_text()
    state["lti_setup_uncertain"] = True
    page.get_by_role("button", name="Create LTI connection in my SCORM Cloud", exact=True).click()
    page.get_by_text("Cloud setup was not confirmed.", exact=False).wait_for()
    assert state["lti_setup_calls"] == 1
    assert not page.get_by_role("button", name="Create LTI connection in my SCORM Cloud", exact=True).count()
    state["lti_setup_uncertain"] = False
    page.get_by_role("button", name="Check LTI connection", exact=True).click()
    page.get_by_role("button", name="Open Cloud LTI helper course", exact=True).wait_for()
    assert state["lti"]["helper_course_id"] != courses[0]["id"]
    assert state["lti_setup_calls"] == 1
    print("PASS uncertain Cloud LTI creation requires a manual status check rather than another creation and uses a separate helper course")

    with page.expect_popup() as popup_event:
        page.get_by_role("button", name="Open Cloud LTI helper course", exact=True).click()
    helper_popup = popup_event.value
    helper_popup.get_by_text("Fixture launch returned.", exact=True).wait_for()
    assert "PRIVATE-LAUNCH-URL" not in page.locator("body").inner_text()
    assert state["lti"]["state"] == "verified"
    page.get_by_role("button", name="Check LTI connection", exact=True).click()
    page.get_by_role("button", name="Use verified LTI launch", exact=True).wait_for()
    assert not page.get_by_role("button", name="Open Cloud LTI helper course", exact=True).count(), "a verified one-use launch is attached rather than reopened"
    ask("A native file question before explicitly attaching the launch")
    assert "fixture-resource" not in json.dumps(agent_calls[-1]), "verified metadata is not shared before explicit attachment"
    assert "fixture-lms-account" not in json.dumps(agent_calls[-1])
    page.get_by_role("button", name="Use verified LTI launch", exact=True).click()
    page.get_by_text("The verified LTI launch is attached to this paired agent and selected course.", exact=True).wait_for()
    assert not page.get_by_role("button", name="Open Cloud LTI helper course", exact=True).count(), "an attached one-use launch cannot reopen"
    ask("A native Cloud question after verified launch attachment")
    assert "fixture-resource" in json.dumps(agent_calls[-1]), "only the explicitly attached verified reference is shared"
    assert "fixture-lms-account" not in json.dumps(agent_calls[-1]), "the private platform subject stays out of model context"
    assert len(agent_calls[-1]["messages"]) == 2, "attaching the launch starts a fresh scoped conversation"
    if not panel.get_by_text("Course sources for the latest question", exact=True).evaluate("element => element.parentElement.open"):
        panel.get_by_text("Course sources for the latest question", exact=True).click()
    assert "This source is bound to the verified LTI launch shown above" in panel.inner_text()
    assert "PRIVATE-LAUNCH-URL" not in panel.inner_text()
    page.screenshot(path=str(shots / "ask-native-cloud-lti-attached-fixture.png"), full_page=True)
    print("PASS the one-use popup stays private and explicit attachment shares a verified launch reference without its platform subject")

    page.get_by_role("link", name="Lexicon", exact=True).click()
    page.locator(".lex-list .li").first.wait_for()
    page.get_by_role("link", name="Ask", exact=True).click()
    page.get_by_role("textbox", name="Ask", exact=True).wait_for()
    if not panel.evaluate("element => element.open"):
        panel.locator("summary").first.click()
    page.get_by_role("button", name="Refresh courses", exact=True).click()
    select_course(0, selected_mode="virtual")
    lti_panel = page.get_by_test_id("course-lti-connection")
    if not lti_panel.evaluate("element => element.open"):
        lti_panel.locator("summary").first.click()
    assert "verified LTI launch is attached" in lti_panel.inner_text()
    assert state["lti_setup_calls"] == 1
    state["defer_lti_status"] = True
    with page.expect_request(lambda request: request.url.endswith("/user-courses") and request.post_data_json.get("operation") == "lti-status"):
        page.get_by_role("button", name="Check LTI connection", exact=True).click()
    page.get_by_role("button", name="Delete local content and revoke permission", exact=True).click()
    page.get_by_text("The local text, graph and permission were removed from this session.", exact=False).wait_for()
    state["defer_lti_status"] = False
    for pending_route, lti_response in pending_lti_status:
        reply(pending_route, lti_response)
    pending_lti_status.clear()
    page.evaluate("new Promise(resolve => setTimeout(resolve, 0))")
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    assert "local LTI binding ended" in lti_panel.inner_text()
    assert "verified LTI launch is attached" not in lti_panel.inner_text()
    assert not page.get_by_role("button", name="Use verified LTI launch", exact=True).count()
    print("PASS a late LTI status response cannot restore the verified binding or permission after local revocation")
    assert page.get_by_role("button", name="Remove Cloud LTI setup", exact=True).is_enabled()
    state["lti_cleanup_fail"] = True
    page.get_by_role("button", name="Remove Cloud LTI setup", exact=True).click()
    page.get_by_text("Cloud cleanup was not confirmed. Retry removal before disconnecting this source;", exact=False).wait_for()
    assert state["lti"]["state"] == "cleanup-failed"
    assert not page.get_by_text("The temporary Cloud LTI connection and helper course were removed.", exact=False).count()
    approve_course("virtual", authority="owner")
    current_grant = state["grants"][json.dumps([courses[0]["id"], courses[0]["version"]])]["id"]
    state["lti_cleanup_fail"] = False
    page.get_by_role("button", name="Remove Cloud LTI setup", exact=True).click()
    page.get_by_text("The temporary Cloud LTI connection and helper course were removed. Your original course is unchanged.", exact=True).wait_for()
    assert state["lti"] is None
    assert state["grants"][json.dumps([courses[0]["id"], courses[0]["version"]])]["id"] == current_grant
    assert page.get_by_label("SCORM Cloud course", exact=True).locator("option").count() == 3
    print("PASS LTI attachment recovers after remount and cleanup of an older setup preserves fresh source permission and the original course")

    approve_course("virtual", authority="owner")
    lti_panel = page.get_by_test_id("course-lti-connection")
    if not lti_panel.evaluate("element => element.open"):
        lti_panel.locator("summary").first.click()
    page.get_by_role("button", name="Prepare LTI connection", exact=True).click()
    page.get_by_role("button", name="Create LTI connection in my SCORM Cloud", exact=True).click()
    page.get_by_role("button", name="Open Cloud LTI helper course", exact=True).wait_for()
    state["lti_cleanup_fail"] = True
    page.get_by_role("button", name="Disconnect course source", exact=True).click()
    page.get_by_label("SCORM Cloud secret", exact=True).wait_for()
    assert "removal of the temporary Cloud LTI setup was not confirmed" in panel.inner_text()
    assert "do not assume the helper course and connection were removed" in panel.inner_text()
    assert not state["connection"]
    state["lti_cleanup_fail"] = False
    print("PASS source disconnect clears local access while preserving an honest warning when Cloud cleanup is unconfirmed")

    if page.get_by_role("button", name="Disconnect course source", exact=True).count():
        page.get_by_role("button", name="Disconnect course source", exact=True).click()
    page.get_by_label("Course source provider", exact=True).select_option("source-service")
    page.get_by_label("Source service URL", exact=True).fill(SOURCE_URL)
    page.get_by_label("Source service access token", exact=True).fill(SOURCE_TOKEN)
    page.get_by_role("button", name="Connect course source", exact=True).click()
    page.get_by_label("Source service course", exact=True).wait_for()
    page.get_by_label("Source service course", exact=True).select_option(json.dumps([external_courses[0]["id"], external_courses[0]["version"]], separators=(",", ":")))
    approve_course("virtual")
    assert page.get_by_label("Course access mode", exact=True).locator('option[value="transient"]').count() == 0
    assert page.get_by_label("Course access mode", exact=True).locator('option[value="cached"]').count() == 0
    ask("Use the source service course")
    assert source_calls[-1]["version"] == "revision-23"
    panel.get_by_text("Course sources for the latest question", exact=True).click()
    assert "Foxxi did not download the course package to verify this source-supplied fingerprint" in panel.inner_text()
    assert "Content fingerprint supplied by the source service" in panel.inner_text()
    assert "Export archive SHA-256" not in panel.inner_text()
    assert "This workbench has not independently verified an LTI login" in panel.inner_text()
    assert not state["cached"]
    page.screenshot(path=str(shots / "ask-course-virtual-desktop.png"), full_page=True)
    print("PASS virtual-only source service accepts a string version without an archive digest or invented LTI verification")

    page.get_by_role("button", name="Request deletion at source", exact=True).click()
    page.get_by_role("button", name="Check deletion request", exact=True).wait_for()
    assert "completion is pending" in panel.inner_text() and page.locator(".msg").count() == 0
    assert "Deletion request reference: fixture-deletion-request" in panel.inner_text()
    previous_source_count, previous_agent_count = len(source_calls), len(agent_calls)
    page.get_by_role("link", name="Lexicon", exact=True).click()
    page.locator(".lex-list .li").first.wait_for()
    page.get_by_role("link", name="Ask", exact=True).click()
    page.get_by_role("textbox", name="Ask", exact=True).wait_for()
    if not panel.evaluate("element => element.open"):
        panel.locator("summary").first.click()
    page.get_by_role("button", name="Refresh courses", exact=True).wait_for()
    assert not page.get_by_role("button", name="Check deletion request", exact=True).count(), "receipt starts outside the remounted React state"
    page.get_by_role("button", name="Refresh courses", exact=True).click()
    page.get_by_label("Source service course", exact=True).select_option(json.dumps([external_courses[0]["id"], external_courses[0]["version"]], separators=(",", ":")))
    page.get_by_role("button", name="Check deletion request", exact=True).wait_for()
    assert "Deletion request reference: fixture-deletion-request" in panel.inner_text()
    assert "completion is pending" in panel.inner_text()
    assert len(source_calls) == previous_source_count and len(agent_calls) == previous_agent_count
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    print("PASS pending deletion receipt and exact provider reference recover from the session after Ask remount and course reselection")
    page.get_by_role("button", name="Check deletion request", exact=True).click()
    page.get_by_text("The source service reports that its derived content was deleted.", exact=False).wait_for()
    assert "original hosted course is unchanged" in panel.inner_text()
    assert not page.get_by_role("button", name="Check deletion request", exact=True).count()
    print("PASS source deletion distinguishes accepted request from provider-reported completion and preserves the original course")

    approve_course("virtual")
    state["remote_status"] = "failed"
    page.get_by_role("button", name="Request deletion at source", exact=True).click()
    page.get_by_role("button", name="Retry deletion request", exact=True).wait_for()
    assert "did not confirm the remote deletion request" in panel.inner_text()
    state["remote_status"] = "pending"
    page.get_by_role("button", name="Retry deletion request", exact=True).click()
    page.get_by_role("button", name="Check deletion request", exact=True).wait_for()
    page.get_by_role("button", name="Check deletion request", exact=True).click()
    page.get_by_text("The source service reports that its derived content was deleted.", exact=False).wait_for()
    print("PASS a failed remote deletion is retryable and is never presented as completed")

    state["grant_expires"] = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()
    approve_course("virtual")
    ask("A question before course permission expires")
    page.get_by_text("Your course permission expired. Confirm fresh permission before asking again.", exact=True).wait_for(timeout=5000)
    assert page.locator(".msg").count() == 0
    assert page.get_by_role("button", name="Ask", exact=True).is_disabled()
    assert not page.get_by_role("button", name="Delete local content and revoke permission", exact=True).count()
    assert not panel.get_by_text("Course sources for the latest question", exact=True).count()
    state["grant_expires"] = EXPIRES
    print("PASS permission expiry clears private context and blocks further questions without a new explicit grant")

    page.set_viewport_size({"width": 420, "height": 860})
    page.screenshot(path=str(shots / "ask-course-reconnect-mobile.png"), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "course UI must fit mobile viewport"
    browser.close()

assert not errors, "browser errors: " + repr(errors)
assert all(url.startswith("http://app.test/i2idlx/api/") for url, _ in calls)
print("PASS bundled course UI regression; no live API, provider or model calls")
