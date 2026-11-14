#!/usr/bin/env python3
"""Tiny static + CORS proxy server for the hypermedia client.

Usage:
    python3 proxy.py [--port 8765] [--bind 127.0.0.1]
                     [--allow-private] [--allow-host HOST]

Then open http://127.0.0.1:8765/

- GET / and other files are served from this directory.
- GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS /proxy?url=<encoded URL> forwards
  the request and adds Access-Control-Allow-Origin: *. An OPTIONS request
  that carries Access-Control-Request-Method is a CORS preflight and is
  answered locally. Any other OPTIONS /proxy?url=... is forwarded.
- Turtle responses are converted to JSON-LD when the request asks for it
  with ?as=jsonld, or when Accept prefers JSON-LD over Turtle. Conversion
  needs rdflib.

The proxy listens on 127.0.0.1 unless --bind says otherwise. It forwards
only http and https URLs. After DNS resolution it refuses loopback,
private, link-local, and metadata addresses unless --allow-private is
set. --allow-host (repeatable) limits forwarding to those hosts.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
USER_AGENT = "hmc-proxy/1.0 (generic hypermedia client)"
MAX_REDIRECTS = 5

# Names that resolve to a cloud metadata service even when the address
# itself would also be caught by the link-local check.
_METADATA_HOSTS = {
    "metadata.google.internal",
    "metadata.goog",
}
_METADATA_ADDRS = {
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("100.100.100.200"),
    ipaddress.ip_address("fd00:ec2::254"),
}


def _host_key(hostname: str) -> str:
    host = hostname.strip().rstrip(".").lower()
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        pass
    return host


def _literal_ip(hostname: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    text = hostname.strip()
    try:
        return ipaddress.ip_address(text)
    except ValueError:
        pass
    if text.isdigit():
        try:
            return ipaddress.ip_address(int(text))
        except ValueError:
            return None
    return None


def _blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip in _METADATA_ADDRS:
        return True
    return bool(
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_multicast or ip.is_reserved or ip.is_unspecified
    )


def _resolved_addresses(hostname: str, port: int) -> list[str]:
    try:
        infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve {hostname}") from exc
    found: list[str] = []
    for *_, sockaddr in infos:
        ip = str(sockaddr[0]).split("%", 1)[0]
        if ip not in found:
            found.append(ip)
    if not found:
        raise ValueError(f"Could not resolve {hostname}")
    return found


def rejection_reason(url: str, *, allow_private: bool = False, allow_hosts: frozenset[str] = frozenset()) -> str | None:
    """Return why this URL must not be forwarded, or None when it may be."""
    if any(ch in url for ch in "\r\n\x00"):
        return "URL contains a control character"
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        return "Only http and https URLs can be proxied"
    if not parts.netloc or not parts.hostname:
        return "URL is missing a host"
    host = _host_key(parts.hostname)
    if allow_hosts and host not in allow_hosts:
        return f"Host {host} is not in --allow-host"
    if host in _METADATA_HOSTS or host.endswith(".localhost") or host == "localhost" or host.endswith(".local"):
        if not allow_private:
            return "Refusing to proxy a loopback, link-local, or metadata host"
    literal = _literal_ip(parts.hostname)
    if literal is not None and _blocked_ip(literal) and not allow_private:
        return "Refusing to proxy a private, loopback, link-local, or metadata address"
    if allow_private:
        return None
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        addresses = _resolved_addresses(parts.hostname, port)
    except ValueError as exc:
        return str(exc)
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return f"Unrecognised address for {host}"
        if _blocked_ip(ip):
            return "Refusing to proxy a private, loopback, link-local, or metadata address"
    return None


def _prefer_jsonld(accept: str) -> bool:
    """True when JSON-LD or JSON outranks Turtle in an Accept header."""
    best_json = -1.0
    best_turtle = -1.0
    for index, part in enumerate(accept.split(",")):
        bits = [item.strip() for item in part.split(";") if item.strip()]
        if not bits:
            continue
        media = bits[0].lower()
        q = 1.0
        for item in bits[1:]:
            if item.startswith("q="):
                try:
                    q = float(item[2:])
                except ValueError:
                    q = 0.0
        score = q - index * 1e-6
        if media in {"application/ld+json", "application/json"} or media.endswith("+json"):
            best_json = max(best_json, score)
        elif "turtle" in media or media in {"text/ttl", "application/x-turtle"}:
            best_turtle = max(best_turtle, score)
    return best_json >= 0 and best_json > best_turtle


class _Redirect(Exception):
    def __init__(self, url: str, code: int) -> None:
        super().__init__(url)
        self.url = url
        self.code = code


class _CaptureRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise _Redirect(urllib.parse.urljoin(req.full_url, newurl), code)


def open_upstream(url: str, payload: bytes | None, headers: dict[str, str], method: str,
                  *, allow_private: bool, allow_hosts: frozenset[str]):
    """Open url after each hop passes rejection_reason. Redirects are re-checked."""
    current = url
    body = payload
    verb = method
    opener = urllib.request.build_opener(_CaptureRedirect)
    for _hop in range(MAX_REDIRECTS + 1):
        problem = rejection_reason(current, allow_private=allow_private, allow_hosts=allow_hosts)
        if problem:
            raise PermissionError(problem)
        request = urllib.request.Request(
            current,
            data=body if verb not in {"GET", "HEAD", "OPTIONS"} else None,
            headers=headers,
            method=verb,
        )
        try:
            response = opener.open(request, timeout=60)
            return response, current
        except _Redirect as redirect:
            nxt = urllib.parse.urlsplit(redirect.url)
            prev = urllib.parse.urlsplit(current)
            if _host_key(nxt.hostname or "") != _host_key(prev.hostname or ""):
                headers.pop("Authorization", None)
            current = redirect.url
            if redirect.code in {301, 302, 303} and verb != "HEAD":
                verb = "GET"
                body = None
            continue
    raise PermissionError("Too many redirects")


class Handler(SimpleHTTPRequestHandler):
    allow_private = False
    allow_hosts: frozenset[str] = frozenset()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type, Authorization")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _proxy_target(self) -> str | None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") != "/proxy":
            return None
        return (urllib.parse.parse_qs(parsed.query).get("url") or [None])[0]

    def do_OPTIONS(self) -> None:  # noqa: N802
        # A browser CORS preflight sets Access-Control-Request-Method.
        # An explicit OPTIONS control does not, and is forwarded.
        target = self._proxy_target()
        if target and not self.headers.get("Access-Control-Request-Method"):
            self._maybe_proxy()
            return
        self.send_response(204)
        self.end_headers()

    def do_HEAD(self) -> None:  # noqa: N802
        if self.path.startswith("/proxy"):
            self._maybe_proxy()
            return
        super().do_HEAD()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/proxy"):
            self._maybe_proxy()
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        self._maybe_proxy()

    def do_PUT(self) -> None:  # noqa: N802
        self._maybe_proxy()

    def do_PATCH(self) -> None:  # noqa: N802
        self._maybe_proxy()

    def do_DELETE(self) -> None:  # noqa: N802
        self._maybe_proxy()

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
        length = int(self.headers.get("Content-Length") or 0)
        payload = self.rfile.read(length) if length else None
        headers = {"User-Agent": self.headers.get("User-Agent") or USER_AGENT}
        for name in ("Accept", "Content-Type", "Authorization"):
            val = self.headers.get(name)
            if val:
                headers[name] = val
        try:
            response, final_url = open_upstream(
                target, payload, headers, self.command,
                allow_private=self.allow_private, allow_hosts=self.allow_hosts,
            )
            with response:
                status = response.getcode() or 200
                out_headers = {k.lower(): v for k, v in response.headers.items()}
                body = response.read()
        except PermissionError as exc:
            message = json.dumps({"error": str(exc), "url": target}).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(message)
            return
        except urllib.error.HTTPError as exc:
            status = exc.code
            out_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
            body = exc.read() if exc.fp else b""
            final_url = target
        except Exception as exc:  # noqa: BLE001
            message = json.dumps({"error": str(exc), "url": target}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(message)
            return

        as_fmt = (query.get("as") or [""])[0]
        content_type = out_headers.get("content-type", "")
        accept = headers.get("Accept", "")
        if body and "turtle" in content_type and (as_fmt == "jsonld" or _prefer_jsonld(accept)):
            try:
                from rdflib import Graph  # type: ignore
                graph = Graph()
                graph.parse(data=body.decode("utf-8", errors="replace"), format="turtle", publicID=final_url)
                body = graph.serialize(format="json-ld").encode("utf-8")
                content_type = "application/ld+json; charset=utf-8"
            except Exception:
                pass

        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        if "etag" in out_headers:
            self.send_header("ETag", out_headers["etag"])
        if "allow" in out_headers:
            self.send_header("Allow", out_headers["allow"])
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the hypermedia client and a CORS proxy")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1",
                        help="Address to listen on (default 127.0.0.1)")
    parser.add_argument("--allow-private", action="store_true",
                        help="Also proxy loopback, private, link-local, and metadata addresses")
    parser.add_argument("--allow-host", action="append", default=[], metavar="HOST",
                        help="Only proxy this host. Repeat for more than one. "
                             "Private addresses are still refused unless --allow-private is set.")
    args = parser.parse_args()
    Handler.allow_private = bool(args.allow_private)
    Handler.allow_hosts = frozenset(_host_key(host) for host in args.allow_host if host.strip())
    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"Serving {ROOT} at http://{args.bind}:{args.port}/")
    print(f"Proxy at http://{args.bind}:{args.port}/proxy?url=")
    if not _is_loopback_bind(args.bind):
        print(f"Warning: listening on {args.bind}, not only loopback.")
    if Handler.allow_private:
        print("Warning: --allow-private is set; loopback and metadata targets are allowed.")
    if Handler.allow_hosts:
        print("Allowing hosts: " + ", ".join(sorted(Handler.allow_hosts)))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


def _is_loopback_bind(bind: str) -> bool:
    host = bind.strip().strip("[]").lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


if __name__ == "__main__":
    main()
