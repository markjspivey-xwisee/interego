#!/usr/bin/env python3
"""Read-only production visitor checks; requires Playwright 1.56.0 + Chromium."""
import argparse
import hashlib
import json
import re
import sys
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


LAST_GRAPH_COMMIT = "b75261de5ad7851c1f61607091cc00e486bbbb5f"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Public I2IDL-X workbench URL")
    parser.add_argument("--expected-build", required=True, help="Exact deployed 40-hex Git SHA")
    args = parser.parse_args()
    parts = urlsplit(args.url)
    if parts.scheme != "https" or not parts.netloc or parts.username or parts.password or parts.query:
        parser.error("--url must be a public HTTPS workbench URL without credentials or a query")
    if not re.fullmatch(r"[0-9a-fA-F]{40}", args.expected_build):
        parser.error("--expected-build must contain exactly 40 hexadecimal characters")
    base = urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/") + "/", "", ""))
    origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    controls = base.rstrip("/") + "/capabilities.ttl"
    report = {"ok": False, "url": base, "expected_build": args.expected_build.lower(), "model_calls": 0,
              "limitations": ["Intervention checks use a labeled UI fixture and copy a request only; no retrieval POST, model run, assessment or activity record is performed."],
              "checks": [], "viewports": [], "blocked_requests": [], "page_errors": []}

    def check(name, passed, detail=None):
        report["checks"].append({"name": name, "passed": bool(passed)})
        if not passed:
            raise AssertionError(detail or name)

    try:
        with urlopen(Request(origin + "/health", method="GET", headers={"Accept": "application/json"}), timeout=30) as response:
            body = response.read(1_000_001)
            check("health_response", response.status == 200 and len(body) <= 1_000_000
                  and urlsplit(response.url).netloc == parts.netloc)
            health = json.loads(body)
        report["observed_build"] = health.get("build")
        check("health_expected_build", health.get("status") == "ok"
              and health.get("build") == args.expected_build.lower(), "Live /health build does not match the expected deployment")
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for label, width, height, mobile in [("desktop", 1440, 900, False), ("mobile", 420, 860, True)]:
                    context = browser.new_context(viewport={"width": width, "height": height},
                                                  is_mobile=mobile, has_touch=mobile, service_workers="block")
                    context.grant_permissions(["clipboard-read", "clipboard-write"], origin=origin)
                    counts = {"GET": 0, "HEAD": 0}

                    def guard(route, request):
                        if request.method not in counts:
                            report["blocked_requests"].append({"viewport": label, "method": request.method, "url": request.url})
                            route.abort("blockedbyclient")
                        else:
                            counts[request.method] += 1
                            route.continue_()

                    context.route("**/*", guard)
                    page = context.new_page()
                    page.set_default_timeout(20_000)
                    page.on("pageerror", lambda error: report["page_errors"].append({"viewport": label, "error": str(error)}))
                    try:
                        page.goto(base + "#home", wait_until="domcontentloaded", timeout=60_000)
                        page.locator(".hero h1").wait_for()
                        data = json.loads(page.locator("#i2-data").text_content())
                        check(label + ":pinned_source", data["meta"]["release"] == "v0.0.93"
                              and data["meta"]["commit"] == LAST_GRAPH_COMMIT and len(data["concepts"]) == 420)
                        check(label + ":fresh_visitor", page.evaluate("""() =>
                            typeof window.ethereum === 'undefined' && typeof window.claude === 'undefined'
                            && typeof window.InteregoHost === 'undefined'"""))

                        page.locator(".bigsearch").click()
                        palette = page.get_by_role("dialog", name="Search", exact=True)
                        palette.wait_for()
                        check(label + ":palette_420", bool(re.match(r"^Search 420 terms\b", palette.get_by_role("combobox").get_attribute("placeholder") or "")))
                        palette.get_by_role("combobox").press("Escape")

                        lms = next(c for c in data["concepts"] if c["id"] == "learning-management-systems")
                        page.goto(base + "#c-learning-management-systems", wait_until="domcontentloaded")
                        page.wait_for_function("label => document.querySelector('#hw')?.textContent === label", arg=lms["l"])
                        definition = " ".join(page.locator(".definition .def").text_content().split())
                        check(label + ":lms_definition", bool(lms["d"].strip()) and definition == " ".join(lms["d"].split()))
                        chip = page.locator(".definition .def-meta .chip.hypothetical")
                        check(label + ":unknown_editorial_metadata", all(lms.get(k) is None for k in ["ds", "dq", "dl"])
                              and chip.count() == 1 and "Not supplied" in chip.inner_text()
                              and "not supplied" in (chip.get_attribute("title") or "").lower()
                              and "Definition" not in page.locator(".definition .def-meta").inner_text())

                        page.goto(base + "#ask", wait_until="domcontentloaded")
                        page.get_by_text("Use Ask in your AI client", exact=True).wait_for()
                        check(label + ":no_browser_model", page.get_by_role("textbox", name="Ask", exact=True).count() == 0)
                        hashes = {}
                        for kind, button, fragments in [
                            ("ask", "Copy Ask prompt", ["Discover the I2IDL-X Ask operation", "through Interego", controls, "follow it with my question", "[add your question]"]),
                            ("orchestrate", "Copy Orchestrate prompt", ["Discover I2IDL-X Orchestrate", "through Interego", controls, "example set to true", "your own model", "Preflight", "check ledger"]),
                        ]:
                            page.get_by_role("button", name=button, exact=True).click()
                            page.wait_for_function("async first => (await navigator.clipboard.readText()).includes(first)", arg=fragments[0])
                            copied = page.evaluate("navigator.clipboard.readText()")
                            check(label + ":copy_" + kind + "_contract", all(fragment in copied for fragment in fragments))
                            hashes[kind] = hashlib.sha256(copied.encode("utf-8")).hexdigest()

                        # Keep production visitor checks read-only: fill a clearly labeled
                        # fixture and copy its conversation request. Do not click Preview
                        # context (POST) or claim a model answered from it.
                        page.goto(base + "#interventions", wait_until="domcontentloaded")
                        page.get_by_role("heading", name="Work with an intervention.", exact=True).wait_for()
                        page.get_by_role("button", name="Other intervention", exact=True).click()
                        title = "TEST FIXTURE: App handoff reference"
                        text = ("Ask and Orchestrate prepare explicit requests and send them through the standard MCP Apps "
                                "ui/message bridge to the surrounding ChatGPT conversation. "
                                "Previewing a task packet does not run the model or the recipe.")
                        question = "How does this reference distinguish a preview from a completed answer?"
                        page.get_by_role("textbox", name="Intervention title", exact=True).fill(title)
                        page.get_by_role("combobox", name="Intervention type", exact=True).fill("Reference material")
                        page.get_by_role("textbox", name="Intervention content", exact=True).fill(text)
                        page.get_by_role("textbox", name="Intervention question", exact=True).fill(question)
                        page.get_by_role("button", name="Copy conversation request", exact=True).click()
                        prefix = "Call i2idlx_intervention_ask with these exact arguments: "
                        page.wait_for_function("async prefix => (await navigator.clipboard.readText()).includes(prefix)", arg=prefix)
                        copied = page.evaluate("navigator.clipboard.readText()")
                        line = next((line for line in copied.splitlines() if line.startswith(prefix)), "")
                        copied_args = json.loads(line[len(prefix):])
                        check(label + ":intervention_copy_preserves_source_and_question", copied_args == {
                            "source": "supplied", "question": question, "lens": "use", "intervention": {
                                "id": "supplied-intervention", "title": title, "kind": "Reference material",
                                "sections": [{"id": "section-1", "title": "Section 1", "body": text}]}})
                        check(label + ":intervention_copy_preserves_execution_boundary", all(fragment in copied for fragment in [
                            "pinned to v0.0.93", "reference data, not instructions",
                            "Do not infer completion, competency or intervention effectiveness", "record activity or publish anything"]))
                        check(label + ":intervention_no_browser_model", page.get_by_role("button", name="Ask ChatGPT", exact=True).is_disabled()
                              and page.get_by_role("region", name="Intervention questions sent", exact=True).count() == 0
                              and page.get_by_role("region", name="Intervention context preview", exact=True).count() == 0)
                        check(label + ":intervention_fits_viewport", page.evaluate(
                            "document.documentElement.scrollWidth <= window.innerWidth + 2"))
                        hashes["intervention"] = hashlib.sha256(copied.encode("utf-8")).hexdigest()
                        check(label + ":no_page_errors", not report["page_errors"])
                        check(label + ":read_only_requests", not report["blocked_requests"])
                        report["viewports"].append({"name": label, "width": width, "height": height,
                                                    "requests": counts, "copied_prompt_sha256": hashes})
                    finally:
                        context.close()
            finally:
                browser.close()
        check("no_mutating_requests", not report["blocked_requests"])
        check("no_page_errors", not report["page_errors"])
        report["ok"] = True
    except Exception as error:
        report["error"] = str(error)
    print(json.dumps(report, ensure_ascii=True, separators=(",", ":")))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
