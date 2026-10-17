"""Bounded public GET/HEAD/OPTIONS evidence; stores digests, never glossary definitions."""
import datetime
import hashlib
import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

BASE = "https://id.i2idl.org"
rows = []


def request(path, method="GET", expected=200):
    assert path.startswith("/api/") and not path.startswith("//")
    req = urllib.request.Request(BASE + path, method=method, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            status, body, headers = response.status, response.read(2_000_001), response.headers
    except urllib.error.HTTPError as error:
        status, body, headers = error.code, error.read(2_000_001), error.headers
    assert len(body) <= 2_000_000, "response exceeded local probe bound"
    document = json.loads(body) if body else None
    rows.append({"url": BASE + path, "method": method, "status": status,
                 "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body),
                 "contentType": headers.get("Content-Type"),
                 "cors": headers.get("Access-Control-Allow-Origin"),
                 "apiVersion": document.get("apiVersion") if isinstance(document, dict) else None,
                 "publicationVersion": document.get("publicationVersion") if isinstance(document, dict) else None})
    assert status == expected, (path, method, status)
    return document


output = Path(sys.argv[1])
try:
    contract = request("/api/openapi.json")
    assert contract["openapi"] == "3.1.0" and len(contract["paths"]) == 8
    listing = request("/api/v1/concepts?limit=1&offset=0")
    assert listing["apiVersion"] == "v1" and len(listing["items"]) == 1
    concept = listing["items"][0]["id"]
    assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", concept)
    request(f"/api/v1/concepts/{concept}")
    request(f"/api/v1/concepts/{concept}/relationships")
    request(f"/api/v1/concepts/{concept}/versions")
    context = request(f"/api/v1/concepts/{concept}/context?depth=0&maxRelated=0")
    assert context["traversal"]["returned"] == 0
    collections = request("/api/v1/collections?limit=1&offset=0")
    collection = collections["items"][0]
    assert collection["type"] in ["field", "type", "curated"]
    assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", collection["id"])
    request(f'/api/v1/collections/{collection["type"]}/{collection["id"]}?limit=1&offset=0')
    sources = request("/api/v1/sources")
    source = sources["items"][0]["id"]
    assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", source)
    request(f"/api/v1/sources/{source}")
    request("/api/v1/concepts?limit=1", method="HEAD")
    request("/api/v1/concepts", method="OPTIONS", expected=204)
    request("/api/v1/concepts?limit=101", expected=400)
    request(f"/api/v1/concepts/{concept}/context?depth=2", expected=400)
    ok = True
except Exception as error:
    ok = False
    failure = type(error).__name__ + ": " + str(error)
finally:
    report = {"observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "ok": ok, "readOnly": True, "restReadRoutes": 9,
              "canonicalDataCopied": False, "requests": rows}
    if not ok:
        report["failure"] = failure
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"ok": ok, "requests": len(rows), "statusCodes": [r["status"] for r in rows]}))
    sys.exit(0 if ok else 1)
