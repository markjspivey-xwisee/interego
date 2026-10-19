#!/usr/bin/env python3
"""Render the ChatGPT App in Chromium with a SIMULATED MCP Apps parent host.

This tests the built, real workbench GUI and its postMessage integration. Only the
parent host protocol and tool responses are simulated; no model is called, no
private write is performed, and success is not real ChatGPT account acceptance.
Requires the existing UI oracle's cached CDN assets and Playwright + Chromium.
"""

import argparse
import json
import pathlib
import re
import sys


LAST_GRAPH_COMMIT = "b75261de5ad7851c1f61607091cc00e486bbbb5f"
APP_URL = "http://i2idlx-frame.test/i2idlx/"
HOST_URL = "http://chatgpt-app.test/simulated-host"
HOST_HTML = r"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SIMULATED MCP Apps host acceptance harness</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><script>
window.__host = {
  simulated: true, messages: [], requests: [], unexpected: [],
  rejectNextMessage: null, errorNextMessage: false, errorNextTool: false, errorNextDownload: false,
  noMessages: new URLSearchParams(location.search).has('no-messages'),
  noDownloads: new URLSearchParams(location.search).has('no-downloads'),
  initialToolResult: {content:[{type:'text',text:'SIMULATED host launch receipt; no model work.'}],
    structuredContent:{initial_view:'ask',query:'',concept_ids:[]}}
};
function respond(target, id, result) { target.postMessage({jsonrpc:'2.0',id,result}, '*'); }
window.addEventListener('message', event => {
  const frame = document.getElementById('workbench');
  if (!frame || event.source !== frame.contentWindow) return;
  const value = event.data;
  if (!value || value.jsonrpc !== '2.0') return;
  const host = window.__host;
  host.messages.push(JSON.parse(JSON.stringify(value)));
  if (value.method === 'ui/notifications/initialized') {
    event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:host.initialToolResult}, '*');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(value,'id')) return;
  host.requests.push(JSON.parse(JSON.stringify(value)));
  if (value.method === 'ui/initialize') {
    const caps = {serverTools:{},updateModelContext:{text:{},structuredContent:{}},
      experimental:{'openai/message':{}}};
    if (!host.noMessages) caps.message = {text:{}};
    if (!host.noDownloads) caps.downloadFile = {};
    return respond(event.source,value.id,{
      protocolVersion:'2026-01-26',hostInfo:{name:'ChatGPT SIMULATED browser harness',version:'26.1017.11052'},
      hostCapabilities:caps,hostContext:{platform:'web',theme:'dark',
        availableDisplayModes:['inline','fullscreen'],safeAreaInsets:{top:0,right:0,bottom:0,left:0}}
    });
  }
  if (value.method === 'ui/message') {
    if (host.rejectNextMessage) {
      const message = host.rejectNextMessage; host.rejectNextMessage = null;
      return event.source.postMessage({jsonrpc:'2.0',id:value.id,error:{code:-32000,message}}, '*');
    }
    if (host.errorNextMessage) {
      host.errorNextMessage = false;
      return respond(event.source,value.id,{isError:true});
    }
    return respond(event.source,value.id,{});
  }
  if (value.method === 'tools/call') {
    if (!['i2idlx_ask','i2idlx_orchestrate'].includes(value.params?.name)) {
      host.unexpected.push(value);
      return event.source.postMessage({jsonrpc:'2.0',id:value.id,error:{code:-32601,message:'Unexpected simulated tool'}}, '*');
    }
    if (host.errorNextTool) {
      host.errorNextTool = false;
      return respond(event.source,value.id,{isError:true,content:[{type:'text',text:'SIMULATED preview tool failure'}]});
    }
    return respond(event.source,value.id,{
      content:[{type:'text',text:'SIMULATED preview only; no model or semantic checks ran.'}],
      structuredContent:{simulated:true,sourceVersion:'v0.0.93',mode:'instructions-only',
        reasoningStatus:'client-required',serverModelCalls:0,serverWrites:0,
        requestedTool:value.params.name,arguments:value.params.arguments,checks:[]}
    });
  }
  if (value.method === 'ui/download-file') {
    if (host.errorNextDownload) {
      host.errorNextDownload = false;
      return respond(event.source,value.id,{isError:true});
    }
    return respond(event.source,value.id,{});
  }
  if (value.method === 'ui/update-model-context') return respond(event.source,value.id,{});
  if (value.method === 'ui/request-display-mode') return respond(event.source,value.id,{mode:value.params.mode});
  host.unexpected.push(value);
  event.source.postMessage({jsonrpc:'2.0',id:value.id,error:{code:-32601,message:'Unexpected simulated host method'}}, '*');
});
</script><iframe id="workbench" name="workbench" title="I2IDL-X Workbench" sandbox="allow-scripts allow-same-origin" src="http://i2idlx-frame.test/i2idlx/#ask"></iframe>
</body></html>"""


def embedded_html(source):
    """Mirror the resource flag, before any workbench script executes."""
    flag = "<script>window.__I2IDLX_CHATGPT_APP__=true;</script>"
    if re.search(r"<head\b[^>]*>", source, re.I):
        return re.sub(r"(<head\b[^>]*>)", lambda match: match.group(1) + flag,
                      source, count=1, flags=re.I)
    return flag + source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=pathlib.Path, help="I2IDL-X root with site/app.html and app/build/data.json")
    parser.add_argument("cache", type=pathlib.Path, help="Existing cached UI oracle CDN scripts and fonts")
    parser.add_argument("shots", type=pathlib.Path, help="Screenshots and JSON acceptance report destination")
    args = parser.parse_args()
    report = {"ok": False, "host": "SIMULATED MCP Apps postMessage parent",
              "real_chatgpt_acceptance": False, "model_calls": 0,
              "checks": [], "viewports": [], "page_errors": [],
              "blocked_mutations": [], "blocked_external_requests": [],
              "simulated_directory_failures": [],
              "limitations": ["The parent protocol and preview tool results are simulated.",
                              "The directory's public GET is intentionally simulated unavailable to exercise its build-snapshot fallback.",
                              "This does not exercise a paid ChatGPT account, real model execution, or real Foxxi semantic checks."]}
    root, cache, shots = args.root.resolve(), args.cache.resolve(), args.shots.resolve()
    shots.mkdir(parents=True, exist_ok=True)

    def check(name, passed, detail=None):
        report["checks"].append({"name": name, "passed": bool(passed)})
        if not passed:
            raise AssertionError(detail or name)

    try:
        # Keep --help usable even on hosts without Playwright or generated outputs.
        from playwright.sync_api import expect, sync_playwright

        html = embedded_html((root / "site" / "app.html").read_text(encoding="utf-8"))
        data = json.loads((root / "app" / "build" / "data.json").read_text(encoding="utf-8"))
        concepts = {concept["id"]: concept for concept in data["concepts"]}
        check("fixture_source_v93", data["meta"]["release"] == "v0.0.93"
              and data["meta"]["commit"] == LAST_GRAPH_COMMIT and len(concepts) == 420)

        def route_handler(route):
            request = route.request
            url = request.url
            if request.method not in ("GET", "HEAD"):
                report["blocked_mutations"].append({"method": request.method, "url": url})
                return route.abort("blockedbyclient")
            if url.startswith(HOST_URL):
                return route.fulfill(status=200, content_type="text/html", body=HOST_HTML)
            if url.startswith(APP_URL):
                return route.fulfill(status=200, content_type="text/html", body=html)
            if url in ("http://chatgpt-app.test/favicon.ico", "http://i2idlx-frame.test/favicon.ico"):
                return route.fulfill(status=204, body="")
            if url == "https://foxxi-bridge.interego.xwisee.com/i2idlx/directory":
                # The real embedded directory performs this public GET on mount.
                # Exercise its offline fallback, rather than fabricate a live inventory.
                report["simulated_directory_failures"].append({"url": url, "status": 503})
                return route.fulfill(status=503, content_type="application/json",
                                     headers={"Access-Control-Allow-Origin": "*"},
                                     body=json.dumps({"error": "SIMULATED offline directory"}))
            if url.startswith("https://cdnjs.cloudflare.com/"):
                asset = cache / url.replace("https://", "").replace("/", "_")
                if asset.is_file():
                    return route.fulfill(status=200, content_type="application/javascript", body=asset.read_bytes())
            if url.startswith("https://fonts.googleapis.com/") and (cache / "fonts.css").is_file():
                return route.fulfill(status=200, content_type="text/css", body=(cache / "fonts.css").read_text(encoding="utf-8"))
            if url.startswith("https://fonts.gstatic.com/"):
                asset = cache / "gstatic" / url.replace("https://fonts.gstatic.com/", "").replace("/", "_")
                if asset.is_file():
                    return route.fulfill(status=200, content_type="font/woff2", body=asset.read_bytes())
            report["blocked_external_requests"].append(url)
            return route.abort("blockedbyclient")

        def host_requests(page, method):
            return page.evaluate("method => window.__host.requests.filter(r => r.method === method)", method)

        def wait_requests(page, method, count):
            page.wait_for_function("({method,count}) => window.__host.requests.filter(r => r.method === method).length >= count",
                                   arg={"method": method, "count": count})

        def message_args(message, tool):
            params = message["params"]
            check("message_user_text_shape", params["role"] == "user"
                  and len(params["content"]) == 1 and params["content"][0]["type"] == "text"
                  and params.get("_meta") == {"openai/message": {"target": "active", "send": True}})
            text = params["content"][0]["text"]
            prefix = "Call " + tool + " with these arguments: "
            line = next((line for line in text.splitlines() if line.startswith(prefix)), "")
            check("message_preserves_named_tool", bool(line) and line.endswith("."))
            return json.loads(line[len(prefix):-1]), text

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in [(375, 812), (768, 1024), (1440, 900)]:
                    tag = str(width)
                    context = browser.new_context(viewport={"width": width, "height": height},
                                                  service_workers="block", color_scheme="dark")
                    context.route("**/*", route_handler)
                    page = context.new_page()
                    page.set_default_timeout(20_000)
                    page.on("pageerror", lambda error, viewport=tag: report["page_errors"].append(
                        {"viewport": viewport, "error": str(error)}))
                    try:
                        page.goto(HOST_URL, wait_until="domcontentloaded")
                        page.frame_locator("#workbench").get_by_role("textbox", name="Ask ChatGPT", exact=True).wait_for()
                        frame = page.frame(name="workbench")
                        frame.get_by_text("ChatGPT connected", exact=True).wait_for()
                        init = host_requests(page, "ui/initialize")
                        check(tag + ":initialize_handshake", len(init) == 1
                              and init[0]["params"]["protocolVersion"] == "2026-01-26"
                              and init[0]["params"]["appInfo"]["name"] == "I2IDL-X Workbench")
                        check(tag + ":initialized_notification", page.evaluate("window.__host.messages.some(r => r.method === 'ui/notifications/initialized')"))
                        embedded = frame.evaluate("""() => {
                            const data = JSON.parse(document.querySelector('#i2-data').textContent);
                            return {release:data.meta.release,commit:data.meta.commit,count:data.concepts.length};
                        }""")
                        check(tag + ":embedded_source_v93", embedded["release"] == "v0.0.93"
                              and embedded["commit"] == LAST_GRAPH_COMMIT and embedded["count"] == 420)
                        check(tag + ":not_a_sampling_adapter", frame.evaluate("!window.claude && !window.ethereum && !window.InteregoHost"))
                        check(tag + ":no_api_key_form", frame.locator('input[type="password"],input[placeholder*="sk-"]').count() == 0)
                        check(tag + ":no_automatic_question", len(host_requests(page, "ui/message")) == 0)

                        def visit(route, selector):
                            frame.evaluate("value => {location.hash = value}", "#" + route)
                            frame.locator(selector).first.wait_for()
                            check(tag + ":route:" + route, True)
                            check(tag + ":page_fits_width:" + route, frame.evaluate(
                                "document.documentElement.scrollWidth <= window.innerWidth + 2"))

                        # Render all ordinary workbench views in the real embedded document.
                        visit("home", ".hero h1")
                        frame.locator('nav[aria-label="Views"] a[href="#browse"]:visible').first.click()
                        visit("browse", ".lex-list .li")
                        check(tag + ":browse_420", frame.locator(".lex-list .li").count() == 420)
                        visit("c-learning-management-systems", "#hw")
                        lms = concepts["learning-management-systems"]
                        frame.wait_for_function("label => document.querySelector('#hw')?.textContent === label", arg=lms["l"])
                        check(tag + ":v93_new_term_definition", " ".join(lms["d"].split()) == " ".join(frame.locator(".definition .def").text_content().split()))
                        check(tag + ":unknown_editorial_status", "Not supplied" in frame.locator(".def-meta").inner_text())
                        visit("whole", ".mapwrap svg circle")
                        check(tag + ":map_420", frame.locator(".mapwrap svg circle").count() == 420)
                        visit("cmp-formative-evaluation~formative-assessment", ".cmp-grid .cmp-row")
                        check(tag + ":compare_two_definitions", frame.locator(".cmp-head h3").count() == 2)
                        visit("annotate", ".an textarea")
                        frame.get_by_role("button", name="Try an example", exact=True).click()
                        frame.locator(".an-hit").first.wait_for()
                        check(tag + ":annotate_real_glossary", frame.locator(".an-hit").count() >= 8
                              and "Learning Record Store (LRS)" in frame.locator(".an-list").inner_text())
                        visit("packs", ".pk")
                        frame.get_by_role("button", name="New pack", exact=True).click()
                        frame.get_by_role("textbox", name="Pack name", exact=True).fill("Embedded browser acceptance " + tag)
                        picker = frame.locator('.pk input[role="combobox"]')
                        picker.fill("learning record store")
                        frame.get_by_role("listbox").wait_for()
                        bounds = frame.get_by_role("listbox").evaluate("""element => {
                            const r = element.getBoundingClientRect();
                            return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,
                                    width:innerWidth,height:innerHeight};
                        }""")
                        check(tag + ":pack_picker_inside_viewport", bounds["left"] >= 0 and bounds["top"] >= 0
                              and bounds["right"] <= bounds["width"] and bounds["bottom"] <= bounds["height"])
                        frame.get_by_role("option", name="Learning Record Store (LRS)", exact=True).click()
                        frame.locator(".pkterm").first.wait_for()
                        check(tag + ":pack_add_local_term", frame.locator(".pkterm").count() == 1
                              and "Learning Record Store (LRS)" in frame.locator(".pkterm").inner_text())
                        check(tag + ":pack_no_private_identity", "Saved in this browser" in frame.locator(".pk aside").first.inner_text())
                        frame.get_by_role("button", name="CSV", exact=True).click()
                        csv = frame.locator(".preview pre").text_content()
                        frame.get_by_role("button", name="Save csv", exact=True).click()
                        wait_requests(page, "ui/download-file", 1)
                        resource = host_requests(page, "ui/download-file")[-1]["params"]["contents"]
                        check(tag + ":pack_export_host_download_exact_bytes", resource == [{"type": "resource", "resource": {
                            "uri": "file:///embedded-browser-acceptance-" + tag + ".csv",
                            "mimeType": "text/csv;charset=utf-8", "text": csv}}])
                        check(tag + ":pack_export_no_model_turn", len(host_requests(page, "ui/message")) == 0)
                        page.evaluate("window.__host.errorNextDownload = true")
                        frame.get_by_role("button", name="Save csv", exact=True).click()
                        wait_requests(page, "ui/download-file", 2)
                        frame.get_by_text(re.compile("Saving isn't available here.*use Copy instead")).wait_for()
                        check(tag + ":pack_export_refusal_has_copy_fallback", True)
                        visit("review", ".rcard")
                        visit("insights", ".chart svg")
                        visit("semantic", ".matrix tbody tr")
                        visit("for-i2idl", ".fi-hero h1")
                        visit("agents", ".qcard")
                        directory = frame.get_by_test_id("capability-directory")
                        directory.get_by_text("Directory returned HTTP 503.", exact=True).wait_for()
                        check(tag + ":directory_offline_fallback_honest", "Build snapshot" in directory.inner_text()
                              and "live status unverified" in directory.inner_text()
                              and directory.locator(".actions-dir > details").count() > 0)
                        visit("ask", 'textarea[aria-label="Ask ChatGPT"]')
                        check(tag + ":browsing_did_not_send_model_turn", len(host_requests(page, "ui/message")) == 0)

                        # Exact question and explicit selected IDs survive the GUI -> host boundary.
                        question = 'How do an LRS and LMS differ?\nKeep “xAPI”, quotes "intact", and café.'
                        frame.get_by_role("textbox", name="Ask ChatGPT", exact=True).fill(question)
                        selected = ["learning-record-store-lrs", "learning-management-systems"]
                        for concept_id in selected:
                            frame.get_by_role("textbox", name="Find concepts to attach", exact=True).fill(concept_id)
                            frame.get_by_role("button", name=concepts[concept_id]["l"], exact=True).click()
                        frame.get_by_role("button", name="Preview task context", exact=True).click()
                        frame.locator("details[open] summary").filter(has_text="reasoning and checks pending").wait_for()
                        preview = host_requests(page, "tools/call")[-1]["params"]
                        expected = {"question": question, "concept_ids": selected}
                        check(tag + ":ask_preview_exact_arguments", preview == {"name": "i2idlx_ask", "arguments": expected})
                        check(tag + ":preview_not_model_execution", len(host_requests(page, "ui/message")) == 0
                              and '"simulated": true' in frame.locator("details[open]").inner_text()
                              and "does not run the recipe or ask the model" in frame.locator("details[open]").inner_text())

                        # A preview belongs to its exact selected concepts. Remove each
                        # selection, including the final one, and require stale context
                        # to disappear without automatically asking the host for more.
                        remaining = selected[:]
                        for concept_id in selected:
                            calls_before = len(host_requests(page, "tools/call"))
                            frame.get_by_role("button", name="Remove " + concepts[concept_id]["l"], exact=True).click()
                            remaining.remove(concept_id)
                            expect(frame.locator("details[open] summary")).to_have_count(0)
                            check(tag + ":selection_removal_clears_preview:" + concept_id,
                                  frame.locator("details[open] summary").count() == 0)
                            check(tag + ":selection_removal_no_automatic_tool_call:" + concept_id,
                                  len(host_requests(page, "tools/call")) == calls_before)
                            if remaining:
                                frame.get_by_role("button", name="Preview task context", exact=True).click()
                                frame.locator("details[open] summary").filter(has_text="reasoning and checks pending").wait_for()
                                check(tag + ":preview_tracks_remaining_selection",
                                      host_requests(page, "tools/call")[-1]["params"] == {
                                          "name": "i2idlx_ask", "arguments": {"question": question, "concept_ids": remaining[:]}})
                        for concept_id in selected:
                            frame.get_by_role("textbox", name="Find concepts to attach", exact=True).fill(concept_id)
                            frame.get_by_role("button", name=concepts[concept_id]["l"], exact=True).click()
                        frame.get_by_role("button", name="Preview task context", exact=True).click()
                        frame.locator("details[open] summary").filter(has_text="reasoning and checks pending").wait_for()
                        check(tag + ":readded_selection_has_fresh_preview",
                              host_requests(page, "tools/call")[-1]["params"] == {"name": "i2idlx_ask", "arguments": expected})
                        frame.get_by_role("button", name="Ask ChatGPT", exact=True).click()
                        wait_requests(page, "ui/message", 1)
                        frame.get_by_role("region", name="Requests sent to ChatGPT").wait_for()
                        message, prompt = message_args(host_requests(page, "ui/message")[-1], "i2idlx_ask")
                        check(tag + ":ask_message_exact_arguments", message == expected)
                        check(tag + ":ask_source_and_grounding", "pinned to v0.0.93" in prompt
                              and "actual returned glossary definitions" in prompt)
                        check(tag + ":handoff_receipt_no_answer_claim", "Sent to ChatGPT" in frame.get_by_role("region", name="Requests sent to ChatGPT").inner_text()
                              and "does not mark tasks complete" in frame.get_by_role("region", name="Requests sent to ChatGPT").inner_text())
                        frame.locator("#main").screenshot(path=str(shots / ("chatgpt-app-ask-" + tag + ".png")))

                        # A JSON-RPC rejection and a successful envelope with isError must both
                        # display an error without adding a successful handoff.
                        baseline = frame.get_by_role("region", name="Requests sent to ChatGPT").locator("time").count()
                        page.evaluate("window.__host.rejectNextMessage = 'SIMULATED conversation permission refusal'")
                        frame.get_by_role("button", name="Ask ChatGPT", exact=True).click()
                        frame.get_by_role("alert").filter(has_text="SIMULATED conversation permission refusal").wait_for()
                        check(tag + ":rejected_message_no_false_handoff", frame.get_by_role("region", name="Requests sent to ChatGPT").locator("time").count() == baseline)
                        page.evaluate("window.__host.errorNextMessage = true")
                        frame.get_by_role("button", name="Ask ChatGPT", exact=True).click()
                        frame.get_by_role("alert").filter(has_text="ChatGPT could not complete ui/message").wait_for()
                        check(tag + ":isError_message_no_false_handoff", frame.get_by_role("region", name="Requests sent to ChatGPT").locator("time").count() == baseline)
                        frame.get_by_role("textbox", name="Ask ChatGPT", exact=True).fill(question + "\nPreview refusal case.")
                        page.evaluate("window.__host.errorNextTool = true")
                        frame.get_by_role("button", name="Preview task context", exact=True).click()
                        frame.get_by_role("alert").filter(has_text="SIMULATED preview tool failure").wait_for()
                        check(tag + ":preview_error_visible_no_packet", frame.locator("details[open] summary").count() == 0)

                        # Orchestrate sends example:true, then a separate custom inventory.
                        visit("orchestrate", 'input[type="checkbox"]')
                        checkbox = frame.get_by_role("checkbox", name="Use the fictional hospital-academy example", exact=True)
                        check(tag + ":synthetic_example_default", checkbox.is_checked())
                        before = len(host_requests(page, "ui/message"))
                        frame.get_by_role("button", name="Preview task context", exact=True).click()
                        frame.locator("details[open] summary").filter(has_text="reasoning and checks pending").wait_for()
                        check(tag + ":example_preview_exact_arguments", host_requests(page, "tools/call")[-1]["params"] == {"name": "i2idlx_orchestrate", "arguments": {"example": True}})
                        frame.get_by_role("button", name="Run with ChatGPT", exact=True).click()
                        wait_requests(page, "ui/message", before + 1)
                        frame.get_by_role("region", name="Requests sent to ChatGPT").locator("time").nth(baseline).wait_for()
                        value, prompt = message_args(host_requests(page, "ui/message")[-1], "i2idlx_orchestrate")
                        check(tag + ":example_message_exact_arguments", value == {"example": True})
                        check(tag + ":recipe_checks_pending_boundary", all(fragment in prompt for fragment in [
                            "using your own model in this conversation", "i2idlx_classify", "i2idlx_validate",
                            "i2idlx_peer_term", "i2idlx_source_version", "actual check ledger", "hold publication as a draft",
                            "not proof that any model work or checks have been completed"]))
                        checkbox.uncheck()
                        brief = 'Make reusable onboarding materials distinguishable from live sessions — café.'
                        records = [{"id": "course-1", "title": 'Safety "induction"', "description": "A reusable self-paced course"},
                                   {"id": "session-1", "title": "Live practice", "description": "A facilitated session\nwith an instructor"}]
                        frame.get_by_role("textbox", name="Orchestration goal", exact=True).fill(brief)
                        frame.get_by_role("textbox", name="Inventory records", exact=True).fill(json.dumps(records, ensure_ascii=False))
                        before = len(host_requests(page, "ui/message"))
                        frame.get_by_role("button", name="Run with ChatGPT", exact=True).click()
                        wait_requests(page, "ui/message", before + 1)
                        frame.wait_for_function("count => document.querySelectorAll('section[aria-label=\"Requests sent to ChatGPT\"] time').length === count", arg=baseline + 2)
                        value, _ = message_args(host_requests(page, "ui/message")[-1], "i2idlx_orchestrate")
                        check(tag + ":custom_inventory_exact_arguments", value == {"brief": brief, "records": records})
                        frame.locator("#main").screenshot(path=str(shots / ("chatgpt-app-orchestrate-" + tag + ".png")))

                        before = len(host_requests(page, "ui/message"))
                        frame.get_by_role("textbox", name="Inventory records", exact=True).fill("not JSON")
                        expect(frame.get_by_role("button", name="Run with ChatGPT", exact=True)).to_be_disabled()
                        check(tag + ":invalid_inventory_disables_submit", frame.get_by_role("button", name="Run with ChatGPT", exact=True).is_disabled())
                        check(tag + ":invalid_inventory_no_host_message", len(host_requests(page, "ui/message")) == before)
                        contexts = host_requests(page, "ui/update-model-context")
                        check(tag + ":context_excludes_private_form_drafts", bool(contexts) and all(
                            set(request["params"].get("structuredContent", {})) <= {"page", "sourceVersion", "selectedConceptIds"}
                            and brief not in json.dumps(request) and question not in json.dumps(request)
                            for request in contexts))

                        # A host tool-result notification routes the UI. A theme change is
                        # delivered as a real parent postMessage notification too.
                        page.evaluate("""() => document.getElementById('workbench').contentWindow.postMessage({
                            jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[],
                              structuredContent:{initial_view:'compare',concept_ids:['formative-evaluation','formative-assessment']}}
                        }, '*')""")
                        frame.locator(".cmp-grid .cmp-row").first.wait_for()
                        check(tag + ":tool_result_notification_routes_gui", frame.locator(".cmp-head h3").count() == 2)
                        page.evaluate("""() => document.getElementById('workbench').contentWindow.postMessage({
                            jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'light',safeAreaInsets:{top:8,right:0,bottom:12,left:0}}
                        }, '*')""")
                        frame.wait_for_function("document.documentElement.dataset.theme === 'light'")
                        check(tag + ":host_theme_and_safe_area", frame.evaluate("document.documentElement.style.getPropertyValue('--safe-area-top')") == "8px")
                        page.screenshot(path=str(shots / ("chatgpt-app-compare-" + tag + ".png")), full_page=False)
                        methods = page.evaluate("window.__host.requests.map(r => r.method)")
                        check(tag + ":no_sampling_or_unexpected_host_operations", not page.evaluate("window.__host.unexpected.length")
                              and not any("sampling" in method for method in methods))
                        check(tag + ":no_page_errors", not report["page_errors"])
                        report["viewports"].append({"width": width, "height": height, "simulated_host_requests": len(methods),
                                                    "screenshots": ["chatgpt-app-" + view + "-" + tag + ".png" for view in ["ask", "orchestrate", "compare"]]})
                    finally:
                        context.close()

                # Absence of the host's message capability must leave sending disabled.
                context = browser.new_context(viewport={"width": 768, "height": 1024}, service_workers="block")
                context.route("**/*", route_handler)
                page = context.new_page()
                page.set_default_timeout(20_000)
                try:
                    page.goto(HOST_URL + "?no-messages&no-downloads", wait_until="domcontentloaded")
                    page.frame_locator("#workbench").get_by_role("textbox", name="Ask ChatGPT", exact=True).wait_for()
                    frame = page.frame(name="workbench")
                    frame.get_by_role("textbox", name="Ask ChatGPT", exact=True).fill("Host lacks message capability.")
                    frame.get_by_text("ChatGPT unavailable", exact=True).wait_for()
                    expect(frame.get_by_role("button", name="Ask ChatGPT", exact=True)).to_be_disabled()
                    check("missing_message_capability_disables_send", frame.get_by_role("button", name="Ask ChatGPT", exact=True).is_disabled())
                    check("missing_message_capability_no_false_handoff", len(host_requests(page, "ui/message")) == 0
                          and frame.get_by_role("region", name="Requests sent to ChatGPT").count() == 0)
                    frame.evaluate("location.hash = '#packs'")
                    frame.get_by_role("button", name="New pack", exact=True).click()
                    frame.get_by_text("Downloads aren't available in this ChatGPT view. Use Copy to export the current format.", exact=True).wait_for()
                    check("missing_download_capability_no_save_action", frame.get_by_role("button", name=re.compile(r"^Save ")).count() == 0)
                    check("missing_download_capability_keeps_copy", frame.locator(".pk").get_by_role("button", name="Copy", exact=True).count() == 1)
                    check("missing_download_capability_no_host_request", len(host_requests(page, "ui/download-file")) == 0)
                finally:
                    context.close()
            finally:
                browser.close()

        check("no_private_network_writes", not report["blocked_mutations"])
        check("all_required_assets_available_offline", not report["blocked_external_requests"])
        check("no_browser_page_errors", not report["page_errors"])
        report["ok"] = True
    except Exception as error:
        report["error"] = type(error).__name__ + ": " + str(error)
    destination = shots / "chatgpt-app-simulated-host-acceptance.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, separators=(",", ":")))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
