#!/usr/bin/env python3
"""Tiny static + CORS proxy server for the hypermedia client.

Usage:
    python3 proxy.py [--port 8765] [--bind 127.0.0.1]

Then open http://127.0.0.1:8765/

- GET / and other files are served from this directory.
- GET/POST/PUT/PATCH/DELETE /proxy?url=<encoded URL> forwards the request
  and adds Access-Control-Allow-Origin: *. Use this when a descriptor
  host does not send CORS headers that a browser will accept.

Only http and https URLs are forwarded. Nothing is rewritten except CORS
headers and an optional Turtle-to-JSON-LD conversion when the client
asks for ?as=jsonld (requires rdflib).
"""

from __future__ import annotations

import argparse
import json
import posixpath
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
USER_AGENT = "hmc-proxy/1.0 (generic hypermedia client)"


def allow_url(url: str) -> str | None:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        return "Only http and https URLs can be proxied"
    if not parts.netloc:
        return "URL is missing a host"
    host = (parts.hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"} or host.endswith(".local"):
        return "Refusing to proxy loopback or .local addresses"
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type, Authorization")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        self._maybe_proxy()

    def do_PUT(self) -> None:  # noqa: N802
        self._maybe_proxy()

    def do_PATCH(self) -> None:  # noqa: N802
        self._maybe_proxy()

    def do_DELETE(self) -> None:  # noqa: N802
        self._maybe_proxy()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/proxy"):
            self._maybe_proxy()
            return
        super().do_GET()

    def _maybe_proxy(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") != "/proxy":
            self.send_error(404, "not a proxy path")
            return
        query = urllib.parse.parse_qs(parsed.query)
        targets = query.get("url") or []
        if not targets:
            self.send_error(400, "missing url query parameter")
            return
        target = targets[0]
        problem = allow_url(target)
        if problem:
            self.send_error(400, problem)
            return
        length = int(self.headers.get("Content-Length") or 0)
        payload = self.rfile.read(length) if length else None
        headers = {"User-Agent": self.headers.get("User-Agent") or USER_AGENT}
        for name in ("Accept", "Content-Type", "Authorization"):
            val = self.headers.get(name)
            if val:
                headers[name] = val
        request = urllib.request.Request(target, data=payload, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(request, timeout=60) as resp:
                status = resp.getcode() or 200
                out_headers = {k.lower(): v for k, v in resp.headers.items()}
                body = resp.read()
        except urllib.error.HTTPError as exc:
            status = exc.code
            out_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
            body = exc.read() if exc.fp else b""
        except Exception as exc:  # noqa: BLE001
            payload = json.dumps({"error": str(exc), "url": target}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        as_fmt = (query.get("as") or [""])[0]
        content_type = out_headers.get("content-type", "")
        if as_fmt == "jsonld" and "turtle" in content_type and body:
            try:
                from rdflib import Graph  # type: ignore
                graph = Graph()
                graph.parse(data=body.decode("utf-8", errors="replace"), format="turtle", publicID=target)
                body = graph.serialize(format="json-ld").encode("utf-8")
                content_type = "application/ld+json; charset=utf-8"
            except Exception:
                pass

        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        if "etag" in out_headers:
            self.send_header("ETag", out_headers["etag"])
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the hypermedia client and a CORS proxy")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"Serving {ROOT} at http://{args.bind}:{args.port}/")
    print(f"Proxy at http://{args.bind}:{args.port}/proxy?url=")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
