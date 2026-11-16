#!/usr/bin/env python3
"""Generic hypermedia client for Interego, HyperMarkdown, and Hydra descriptors.

Give it any descriptor URL. It fetches the authority document (JSON-LD preferred,
then Turtle, then HyperMarkdown), discovers every hydra:Operation / iep:Affordance
/ hmd:Control, builds forms from SHACL or JSON Schema, resolves the live
hydra:target at invocation time, and follows links in responses.

Nothing here is specific to a particular glossary or catalog.
"""

from __future__ import annotations

import argparse
import copy
import heapq
import ipaddress
import json
import math
import re
import sys
import textwrap
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

USER_AGENT = "hmc/1.0 (generic hypermedia client)"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

HYDRA = "http://www.w3.org/ns/hydra/core#"
SHACL = "http://www.w3.org/ns/shacl#"
IEP = "https://markjspivey-xwisee.github.io/interego/ns/iep#"
IEH = "https://markjspivey-xwisee.github.io/interego/ns/harness#"
HMD = "https://relay.interego.xwisee.com/ns/maintainer/hmd#"
DCT = "http://purl.org/dc/terms/"
RDFS = "http://www.w3.org/2000/01/rdf-schema#"
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DCAT = "http://www.w3.org/ns/dcat#"
XSD = "http://www.w3.org/2001/XMLSchema#"
SCHEMA = "https://schema.org/"

P_TYPE = RDF + "type"
P_ACTION = IEP + "action"
P_AFFORDANCE = IEP + "affordance"
P_READONLY = IEP + "readOnlyHint"
P_IDEMPOTENT = IEP + "idempotentHint"
P_DESTRUCTIVE = IEP + "destructiveHint"
P_METHOD = HYDRA + "method"
P_TARGET = HYDRA + "target"
P_EXPECTS = HYDRA + "expects"
P_RETURNS = HYDRA + "returns"
P_RETURNS_CT = HYDRA + "returnsContentType"
P_TITLE = HYDRA + "title"
P_DESC = HYDRA + "description"
P_TEMPLATE = HYDRA + "template"
P_MAPPING = HYDRA + "mapping"
P_VARIABLE = HYDRA + "variable"
P_PROPERTY = HYDRA + "property"
P_REQUIRED = HYDRA + "required"
P_SEARCH = HYDRA + "search"
P_SUPOP = HYDRA + "supportedOperation"
P_SUPCLASS = HYDRA + "supportedClass"
P_OPERATION = HYDRA + "operation"
P_SUPPROP = HYDRA + "supportedProperty"
P_RANGE = RDFS + "range"
P_MEDIA = DCAT + "mediaType"
P_LABEL = RDFS + "label"
P_COMMENT = RDFS + "comment"
P_SEEALSO = RDFS + "seeAlso"
P_DCTITLE = DCT + "title"
P_DCDESC = DCT + "description"
P_REL = HMD + "rel"
P_CONTROL = HMD + "control"
P_HMDTARGET = HMD + "target"
P_SH_PROP = SHACL + "property"
P_SH_PATH = SHACL + "path"
P_SH_NAME = SHACL + "name"
P_SH_DT = SHACL + "datatype"
P_SH_MIN = SHACL + "minCount"
P_SH_MAX = SHACL + "maxCount"
P_SH_PAT = SHACL + "pattern"
P_SH_DEF = SHACL + "defaultValue"
P_SH_MAXLEN = SHACL + "maxLength"
P_SH_MINLEN = SHACL + "minLength"
P_SH_DESC = SHACL + "description"
P_SH_IN = SHACL + "in"
P_SH_MINI = SHACL + "minInclusive"
P_SH_MAXI = SHACL + "maxInclusive"
P_SH_NODE = SHACL + "node"
P_SH_NODEKIND = SHACL + "nodeKind"
RDF_JSON = RDF + "JSON"
P_FIRST = RDF + "first"
P_REST = RDF + "rest"
P_NIL = RDF + "nil"

WELL_KNOWN_PREFIXES = {
    "hydra": HYDRA, "sh": SHACL, "iep": IEP, "ieh": IEH, "hmd": HMD,
    "dct": DCT, "rdfs": RDFS, "rdf": RDF, "dcat": DCAT, "xsd": XSD,
    "schema": SCHEMA, "prov": "http://www.w3.org/ns/prov#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
}

TERM_FALLBACKS = {
    "action": P_ACTION, "affordance": P_AFFORDANCE, "affordances": P_AFFORDANCE,
    "method": P_METHOD, "target": P_TARGET, "expects": P_EXPECTS,
    "returns": P_RETURNS, "mediaType": P_RETURNS_CT, "title": P_TITLE,
    "description": P_DESC, "rel": P_REL, "control": P_CONTROL,
    "template": P_TEMPLATE, "mapping": P_MAPPING, "variable": P_VARIABLE,
    "property": P_PROPERTY, "required": P_REQUIRED, "search": P_SEARCH,
    "supportedOperation": P_SUPOP, "supportedClass": P_SUPCLASS,
    "readOnlyHint": P_READONLY, "idempotentHint": P_IDEMPOTENT,
    "destructiveHint": P_DESTRUCTIVE, "label": P_LABEL, "comment": P_COMMENT,
    "seeAlso": P_SEEALSO, "operation": P_OPERATION, "supportedProperty": P_SUPPROP,
}
# The keys whose values are operations, or classes that hold them, which a
# document may write in place instead of as references.
HARVESTED = frozenset({P_AFFORDANCE, P_CONTROL, P_SUPOP, P_SUPCLASS, P_OPERATION})
HARVESTED_NAMES = frozenset({"affordance", "affordances", "control", "supportedOperation", "supportedClass", "operation"})


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def raw_id(value: Any) -> Any:
    if isinstance(value, dict):
        if "@id" in value:
            return value["@id"]
        if "@value" in value:
            return value["@value"]
    return value


def literal(value: Any) -> Any:
    items = [raw_id(v) for v in as_list(value)]
    items = [i for i in items if i is not None]
    return items[0] if items else None


def literals(value: Any) -> list[Any]:
    return [raw_id(v) for v in as_list(value) if raw_id(v) is not None]


_SCHEME_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
_SCHEME_CHARS = _SCHEME_LETTERS + "0123456789+-."


def _has_scheme(text: str) -> bool:
    """Whether a value starts with a scheme as RFC 3986 writes one: a letter,
    then letters, digits, "+", "-" or ".", then ":". A scan, so a long value
    costs linear time. The page's hasScheme is the same."""
    colon = text.find(":")
    if colon < 1 or text[0] not in _SCHEME_LETTERS:
        return False
    return all(ch in _SCHEME_CHARS for ch in text[1:colon])


def _split_iri(text: str) -> tuple[str | None, str | None, str, str | None, str | None]:
    """An IRI reference's five parts (RFC 3986, section 3): scheme, authority,
    path, query and fragment, None for a part that is absent and "" for one that
    is present and empty, so "doc#" keeps its empty fragment. A scan, so a long
    reference costs linear time. The page's splitIri is the same."""
    scheme = None
    rest = text
    if _has_scheme(text):
        colon = text.find(":")
        scheme, rest = text[:colon], text[colon + 1:]
    fragment = None
    cut = rest.find("#")
    if cut >= 0:
        rest, fragment = rest[:cut], rest[cut + 1:]
    query = None
    cut = rest.find("?")
    if cut >= 0:
        rest, query = rest[:cut], rest[cut + 1:]
    authority = None
    if rest.startswith("//"):
        end = rest.find("/", 2)
        end = len(rest) if end < 0 else end
        authority, rest = rest[2:end], rest[end:]
    return scheme, authority, rest, query, fragment


def _join_iri(scheme: str | None, authority: str | None, path: str, query: str | None, fragment: str | None) -> str:
    out = "" if scheme is None else scheme + ":"
    if authority is not None:
        out += "//" + authority
    out += path
    if query is not None:
        out += "?" + query
    if fragment is not None:
        out += "#" + fragment
    return out


def _remove_dot_segments(path: str) -> str:
    """RFC 3986, section 5.2.4, step by step. Each step consumes input, so a long
    path costs linear time. The page's removeDotSegments is the same."""
    if "." not in path:
        return path
    out: list[str] = []
    i, n = 0, len(path)
    while i < n:
        if path.startswith("../", i):
            i += 3
        elif path.startswith("./", i):
            i += 2
        elif path.startswith("/./", i):
            i += 2
        elif i + 2 == n and path.startswith("/.", i):
            out.append("/")
            i = n
        elif path.startswith("/../", i):
            i += 3
            if out:
                out.pop()
        elif i + 3 == n and path.startswith("/..", i):
            if out:
                out.pop()
            out.append("/")
            i = n
        elif (i + 1 == n and path[i] == ".") or (i + 2 == n and path.startswith("..", i)):
            i = n
        else:
            end = path.find("/", i + 1 if path[i] == "/" else i)
            end = n if end < 0 else end
            out.append(path[i:end])
            i = end
    return "".join(out)


def _resolve_iri(ref: str, base: str | None) -> str:
    """A relative reference resolved against a base (RFC 3986, section 5.2), or
    the reference as it is when there is no base or the base has no scheme. The
    strings are merged as they are written: an IRI keeps its non-ASCII
    characters, and an empty fragment or query ("#", "?") is kept, so the
    JSON-LD idiom "@vocab": "#" names the document's own fragment namespace.
    The page's resolveIri is the same."""
    if base is None:
        return ref
    b_scheme, b_auth, b_path, b_query, _ = _split_iri(base)
    if b_scheme is None:
        return ref
    scheme, auth, path, query, fragment = _split_iri(ref)
    if scheme is not None:
        return _join_iri(scheme, auth, _remove_dot_segments(path), query, fragment)
    if auth is not None:
        return _join_iri(b_scheme, auth, _remove_dot_segments(path), query, fragment)
    if path == "":
        return _join_iri(b_scheme, b_auth, b_path, b_query if query is None else query, fragment)
    if not path.startswith("/"):
        if b_auth is not None and b_path == "":
            path = "/" + path
        else:
            path = b_path[:b_path.rfind("/") + 1] + path
    return _join_iri(b_scheme, b_auth, _remove_dot_segments(path), query, fragment)


# The four characters IDNA 2003, which Python's "idna" codec implements, maps
# to other letters (ß to "ss", ς to σ) or drops (ZWJ, ZWNJ), where a browser's
# IDNA 2008 / UTS 46 keeps them: "straße.example" is another domain there.
_IDNA_DEVIATIONS = frozenset("\u00df\u03c2\u200c\u200d")


def _host_and_port(hostport: str) -> tuple[str, str | None]:
    """An authority's host and port, without user information: a bracketed
    IPv6 host keeps its brackets, and its port is what follows "]:". The port
    is None when there is none. The page's hostAndPort is the same."""
    if hostport.startswith("["):
        close = hostport.find("]")
        if close >= 0 and hostport[close + 1:close + 2] == ":":
            return hostport[:close + 1], hostport[close + 2:]
        return hostport, None
    host, colon, port = hostport.partition(":")
    return host, (port if colon else None)


def _iri_to_uri(iri: str) -> str:
    """An IRI as the URI a request carries (RFC 3987, section 3.1): each
    non-ASCII character in the path, query and fragment as the percent-encoded
    bytes of its UTF-8, and a non-ASCII host in IDNA form. Anything already
    ASCII is left as it is. The page's iriToUri is the same, but for the IDNA
    form: Python's codec is IDNA 2003 where a browser's fetch uses UTS 46, and
    the two differ only for a host with ß, ς, ZWJ or ZWNJ, which hmc.py refuses
    rather than send to another domain."""
    if iri.isascii():
        return iri
    scheme, auth, path, query, fragment = _split_iri(iri)

    def enc(part: str | None) -> str | None:
        if part is None or part.isascii():
            return part
        return "".join(ch if ord(ch) < 128 else urllib.parse.quote(ch, safe="") for ch in part)

    if auth is not None and not auth.isascii():
        userinfo, at, hostport = auth.rpartition("@")
        host, port = _host_and_port(hostport)
        if _IDNA_DEVIATIONS.intersection(host):
            raise ValueError(f"hmc.py does not send to a host with ß, ς, ZWJ or ZWNJ: Python's IDNA 2003 would "
                             f"send it to another domain than a browser does; nothing was sent to {iri}")
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            host = enc(host) or ""
        auth = (enc(userinfo) + "@" if at else "") + host + ("" if port is None else ":" + port)
    return _join_iri(scheme, auth, enc(path) or "", enc(query), enc(fragment))


_IPV4_CANONICAL = re.compile(r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}")
_HOST_NAME = re.compile(r"[A-Za-z0-9._-]+")
_IPV6_TEXT = re.compile(r"\[[0-9A-Fa-f:.]+\]")
_DIGITS = re.compile(r"[0-9]*")
_HEX_NUMBER = re.compile(r"0[xX][0-9A-Fa-f]*")
_DEFAULT_PORTS = {"http": 80, "https": 443}
# What the URL Standard's parser percent-encodes in an http(s) path and query
# that _request_url_problem lets through: the rest of its path and special-
# query percent-encode sets are spaces, controls and non-ASCII, which are
# refused or already encoded, and "#" and "?", which end a path or query.
_PATH_ENCODE = {ord(c): "%%%02X" % ord(c) for c in '"<>`{}^'}
_QUERY_ENCODE = {ord(c): "%%%02X" % ord(c) for c in "\"<>'"}


def _port_number(port: str) -> int:
    """A port of digits as a number; one past five digits, leading zeros
    aside, as 65536, so a long one is not converted."""
    digits = port.lstrip("0") or "0"
    return 65536 if len(digits) > 5 else int(digits)


def _ends_in_number(host: str) -> bool:
    labels = host.split(".")
    if len(labels) > 1 and labels[-1] == "":
        labels.pop()
    last = labels[-1]
    return bool(_DIGITS.fullmatch(last) and last) or bool(_HEX_NUMBER.fullmatch(last))


def _request_url_problem(uri: str) -> str | None:
    """Why an http(s) address in URI form cannot be sent as a person reads it,
    or None. A URL parser reads some addresses differently from the text: it
    takes a backslash for a slash, so "https://a\\@b" goes to a; drops a tab or
    line break and encodes a space; finds a host in "https:@a" or "https:/a",
    which have no "//"; and reads a host written as a number in any form other
    than four decimal parts ("0x7f.1", "2130706433") as an IPv4 address. User
    information before an "@" is refused too: urllib would send it as part of
    the Host header. The page's requestUrlProblem is the same."""
    if any(ord(ch) <= 0x20 or ch in "\x7f\\" for ch in uri):
        return "the address holds a backslash, a space or a control character, which URL parsers read in different ways"
    scheme, auth, _path, _query, _fragment = _split_iri(uri)
    if scheme is None or scheme.lower() not in WEB_SCHEMES:
        return "the address is not http or https"
    if auth is None:
        return 'the address does not name its host after "//"'
    if "@" in auth:
        return "the address carries user information before its host"
    host, port = _host_and_port(auth)
    if not host:
        return "the address names no host"
    if port is not None and not _DIGITS.fullmatch(port):
        return "the address's port is not a number"
    if port and _port_number(port) > 65535:
        return "the address's port is above 65535"
    if host.startswith("["):
        if not _IPV6_TEXT.fullmatch(host):
            return "the address's IPv6 host is not an IPv6 address"
    else:
        if not _HOST_NAME.fullmatch(host):
            return "the address's host is not a name of letters, digits, '.', '-' and '_'"
        if _ends_in_number(host) and not _IPV4_CANONICAL.fullmatch(host):
            return "the address's host is a number written other than as four decimal parts"
    return None


def _ipv6_text(inner: str) -> str:
    """An IPv6 address as a URL parser writes it: lower-case hex pieces with no
    leading zeros, the first longest run of two or more zero pieces as "::",
    and no dotted IPv4 tail."""
    value = int(ipaddress.IPv6Address(inner))
    pieces = [(value >> (16 * (7 - i))) & 0xFFFF for i in range(8)]
    best_start, best_len, i = -1, 1, 0
    while i < 8:
        if pieces[i] == 0:
            j = i
            while j < 8 and pieces[j] == 0:
                j += 1
            if j - i > best_len:
                best_start, best_len = i, j - i
            i = j
        else:
            i += 1
    if best_start < 0:
        return ":".join("%x" % p for p in pieces)
    head = ":".join("%x" % p for p in pieces[:best_start])
    tail = ":".join("%x" % p for p in pieces[best_start + best_len:])
    return head + "::" + tail


def _request_path(path: str) -> str:
    """A path as a URL parser writes it: dot segments removed, "%2e" and
    "%2e%2e" (in any case and mix) counted as dots, and empty as "/"."""
    out: list[str] = []
    segments = path[1:].split("/") if path.startswith("/") else [path]
    for i, segment in enumerate(segments):
        last = i == len(segments) - 1
        low = segment.lower()
        if low in ("..", ".%2e", "%2e.", "%2e%2e"):
            if out:
                out.pop()
            if last:
                out.append("")
        elif low in (".", "%2e"):
            if last:
                out.append("")
        else:
            out.append(segment.translate(_PATH_ENCODE))
    return "/" + "/".join(out)


def _request_url(iri: str) -> str:
    """The exact address a request to an http(s) IRI goes to: its URI form, as
    a URL parser writes it, with no fragment, which is never sent. The scheme
    and host are lower-cased, a default port is dropped, dot segments ("..",
    and "%2e%2e" too) are removed and the characters a parser percent-encodes
    are encoded. A dry run prints this string and urllib sends it. An address
    a parser would read differently from its text is refused
    (_request_url_problem). The page's requestUrl is the same; it has the
    browser's URL parser write the string."""
    uri = _iri_to_uri(str(iri))
    problem = _request_url_problem(uri)
    if problem:
        raise ValueError(f"{problem}; nothing is sent to {uri}")
    scheme, auth, path, query, _fragment = _split_iri(uri)
    scheme = (scheme or "").lower()
    host, port = _host_and_port(auth or "")
    if host.startswith("["):
        try:
            host = "[" + _ipv6_text(host[1:-1]) + "]"
        except ValueError:
            raise ValueError(f"the address is not a URL; nothing is sent to {uri}") from None
    else:
        host = host.lower()
    port_text = "" if not port or _port_number(port) == _DEFAULT_PORTS[scheme] else ":" + str(_port_number(port))
    out = f"{scheme}://{host}{port_text}{_request_path(path)}"
    return out if query is None else out + "?" + query.translate(_QUERY_ENCODE)


# Keywords a context may alias with a term ("id": "@id"), and the characters
# that end a prefix's IRI (RFC 3986 gen-delims): a simple term whose IRI ends in
# one is a prefix, as JSON-LD 1.1 says.
_ALIASABLE = frozenset({
    "@id", "@type", "@graph", "@list", "@set", "@value", "@language", "@index",
    "@included", "@nest", "@json", "@none", "@direction", "@reverse",
})
_GEN_DELIMS = ":/?#[]@"
# How much context work one document may cause: each term definition read and
# each entry copied when a node's own @context, or a scoped one, starts a child
# context. A document past it is refused, so a crafted one cannot make reading
# it cost more than linear time. The page's CONTEXT_BUDGET is the same.
CONTEXT_BUDGET = 200_000


class _Budget:
    def __init__(self) -> None:
        self.left = CONTEXT_BUDGET

    def spend(self, amount: int) -> None:
        self.left -= amount
        if self.left < 0:
            raise ValueError("This document's @context entries are too many to read.")


def _json_schema_like(item: dict[str, Any]) -> bool:
    """A JSON Schema written into a document as plain JSON, such as a
    hydra:expects object with "properties": its keys are JSON Schema's, never
    terms, so nothing in it is renamed or expanded."""
    return isinstance(item.get("properties"), dict) and not any(key.startswith("@") for key in item)


def _merge_value(item: dict[str, Any], key: str, value: Any) -> None:
    if key not in item:
        item[key] = value
        return
    current = item[key]
    if not isinstance(current, list):
        current = item[key] = [current]
    if isinstance(value, list):
        current.extend(value)
    else:
        current.append(value)


class Context:
    """The active context: prefixes, terms, which terms hold IRIs (typed "@id"
    or "@vocab" in the context; "@json" ones hold JSON), containers, scoped
    contexts, keyword aliases, terms set to null, @vocab, and the base a relative
    IRI resolves against: @base when the context gives one, else the address the
    document came from. `terms` holds only what documents defined; the reader's
    own names for the properties it reads (TERM_FALLBACKS) apply to keys only,
    never to a value such as an action written as a term."""

    def __init__(self, base: str | None = None, budget: _Budget | None = None) -> None:
        self.prefixes: dict[str, str] = dict(WELL_KNOWN_PREFIXES)
        self.terms: dict[str, str] = {}
        self.coerce: dict[str, str] = {}
        self.containers: dict[str, frozenset[str]] = {}
        self.scoped: dict[str, Any] = {}
        self.aliases: dict[str, str] = {}
        self.nulled: set[str] = set()
        self.vocab: str | None = None
        self.base: str | None = base or None
        self.document_base = self.base
        self.budget = budget or _Budget()
        self._children: dict[str, Context] = {}

    def child(self, local: Any) -> "Context":
        """A copy of this context with `local` absorbed: a node's own @context,
        or the scoped one a term or type carries."""
        self.budget.spend(len(self.prefixes) + len(self.terms) + len(self.coerce) + len(self.containers)
                          + len(self.scoped) + len(self.aliases) + len(self.nulled) + 1)
        out = Context(self.base, self.budget)
        out.prefixes, out.terms, out.coerce = dict(self.prefixes), dict(self.terms), dict(self.coerce)
        out.containers, out.scoped, out.aliases = dict(self.containers), dict(self.scoped), dict(self.aliases)
        out.nulled, out.vocab, out.document_base = set(self.nulled), self.vocab, self.document_base
        out.absorb(local)
        return out

    def scoped_child(self, term: str) -> "Context":
        """The context a term's scoped @context makes, made once per term."""
        found = self._children.get(term)
        if found is None:
            found = self._children[term] = self.child(self.scoped[term])
        return found

    def absorb(self, ctx: Any) -> None:
        for item in as_list(ctx):
            if item is None:
                # A null context empties the active context; the document's own base stays.
                self.prefixes, self.terms, self.coerce = dict(WELL_KNOWN_PREFIXES), {}, {}
                self.containers, self.scoped, self.aliases, self.nulled = {}, {}, {}, set()
                self.vocab, self.base = None, self.document_base
                self._children = {}
                continue
            if not isinstance(item, dict):
                continue
            self.budget.spend(len(item) + 1)
            self._children = {}
            if "@base" in item:
                new_base = item["@base"]
                if new_base is None:
                    self.base = None
                elif isinstance(new_base, str):
                    self.base = _resolve_iri(new_base, self.base) if self.base else (new_base if _has_scheme(new_base) else None)
            if "@vocab" in item:
                vocab = item["@vocab"]
                if vocab is None:
                    self.vocab = None
                elif isinstance(vocab, str):
                    self.vocab = self.expand_iri(vocab, vocab=True, document_relative=True)
            definitions = {key: val for key, val in item.items() if not key.startswith("@")}
            # A term may use a prefix the context defines after it, so each
            # definition waits for the one it depends on: a depth-first walk on
            # a stack, each term defined once, a cycle cut where it closes.
            state: dict[str, int] = {}
            for first in definitions:
                stack = [first]
                while stack:
                    key = stack[-1]
                    if state.get(key) == 2:
                        stack.pop()
                        continue
                    dep = self._dependency(key, definitions[key])
                    if dep is not None and dep != key and dep in definitions and dep not in state:
                        state[key] = 1
                        stack.append(dep)
                        continue
                    self._define(key, definitions[key])
                    state[key] = 2
                    stack.pop()

    @staticmethod
    def _dependency(key: str, value: Any) -> str | None:
        """The term a definition's IRI is written with, which must be defined first."""
        if isinstance(value, str):
            iri: Any = value
        elif isinstance(value, dict):
            iri = value.get("@id") if "@id" in value else (key if ":" in key else None)
        else:
            return None
        if not isinstance(iri, str) or not iri or iri.startswith("@"):
            return None
        colon = iri.find(":")
        if colon < 0:
            return iri
        prefix, suffix = iri[:colon], iri[colon + 1:]
        return None if prefix == "_" or suffix.startswith("//") else prefix

    def _define(self, key: str, value: Any) -> None:
        for table in (self.terms, self.prefixes, self.coerce, self.containers, self.scoped, self.aliases):
            table.pop(key, None)
        self.nulled.discard(key)
        if value is None:
            self.nulled.add(key)
            return
        if isinstance(value, str):
            if value.startswith("@"):
                if value in _ALIASABLE:
                    self.aliases[key] = value
                return
            iri = self.expand_iri(value, vocab=True)
            if isinstance(iri, str) and ":" in iri:
                self.terms[key] = iri
                if ":" not in key and "/" not in key and iri[-1] in _GEN_DELIMS:
                    self.prefixes[key] = iri
            return
        if not isinstance(value, dict):
            return
        if "@reverse" in value:
            # A reverse property names the node as the value, not the subject; the reader reads neither way.
            self.nulled.add(key)
            return
        iri: Any
        if "@id" in value:
            ident = value["@id"]
            if ident is None:
                self.nulled.add(key)
                return
            if not isinstance(ident, str):
                return
            if ident.startswith("@"):
                if ident in _ALIASABLE:
                    self.aliases[key] = ident
                return
            iri = self.expand_iri(ident, vocab=True)
        elif ":" in key:
            iri = self.expand_iri(key, vocab=True)
        elif self.vocab is not None:
            iri = self.vocab + key
        else:
            # A definition with no "@id" and no @vocab to supply one keeps the reader's own name for the key.
            iri = TERM_FALLBACKS.get(key)
        if isinstance(iri, str) and ":" in iri:
            self.terms[key] = iri
            flag = value.get("@prefix")
            if flag is True or (flag is None and ":" not in key and "/" not in key and iri[-1] in "#/"):
                self.prefixes[key] = iri
        kind = value.get("@type")
        if kind in ("@id", "@vocab", "@json"):
            self.coerce[key] = kind
        container = value.get("@container")
        names = frozenset(c for c in as_list(container) if isinstance(c, str))
        if names:
            self.containers[key] = names
        if "@context" in value:
            self.scoped[key] = value["@context"]

    def expand_key(self, key: str) -> str:
        """The property IRI a key names, or "" for a term the context set to null."""
        if key.startswith(("@", "http://", "https://")):
            return key
        if key in self.nulled:
            return ""
        if key in self.terms:
            return self.terms[key]
        if ":" in key:
            return str(self.expand_iri(key))
        if key in TERM_FALLBACKS:
            return TERM_FALLBACKS[key]
        return self.vocab + key if self.vocab is not None else key

    def expand_iri(self, value: Any, *, vocab: bool = False, document_relative: bool = False) -> Any:
        """JSON-LD's expansion of a value in an IRI position: a term the
        document defined where `vocab` applies; a compact IRI; an absolute IRI
        or a blank node as it is; then @vocab + the value where `vocab` applies,
        or the value resolved against the base where `document_relative`
        applies. The page's expandIri is the same."""
        if not isinstance(value, str) or value.startswith("@"):
            return value
        if vocab and value in self.terms:
            return self.terms[value]
        if ":" in value:
            prefix, suffix = value.split(":", 1)
            if prefix == "_" or suffix.startswith("//"):
                return value
            if prefix in self.prefixes:
                return self.prefixes[prefix] + suffix
            if _has_scheme(value):
                return value
        if vocab and self.vocab is not None:
            return self.vocab + value
        if document_relative and self.base is not None:
            return _resolve_iri(value, self.base)
        return value

    def _rename_aliases(self, item: dict[str, Any]) -> None:
        if not self.aliases:
            return
        for key in list(item):
            keyword = self.aliases.get(key)
            if keyword and keyword not in item:
                item[keyword] = item.pop(key)

    def _is_nest(self, key: str) -> bool:
        return key == "@nest" or self.aliases.get(key) == "@nest"

    def _lift_nests(self, item: dict[str, Any]) -> None:
        """Moves the properties under each @nest key (or a term aliased to it)
        onto the node, where JSON-LD reads them. Each nested object is moved
        once, so this costs linear time."""
        work = [key for key in item if self._is_nest(key)]
        while work:
            key = work.pop()
            if key not in item:
                continue
            for nested in as_list(item.pop(key)):
                if not isinstance(nested, dict):
                    continue
                self._rename_aliases(nested)
                for inner, value in nested.items():
                    if inner.startswith("@") and inner != "@nest":
                        continue
                    if self._is_nest(inner) and inner not in item:
                        work.append(inner)
                    _merge_value(item, inner, value)

    def _unmap(self, value: Any, containers: frozenset[str]) -> Any:
        """A map a container term holds (@index, @id, @type or @language), as
        the list of values it maps to: an @id map's key becomes its node's
        "@id", a @type map's key is added to its node's types, and a language
        map's key becomes each string's "@language"."""
        if not isinstance(value, dict) or "@value" in value or "@id" in value or "@list" in value:
            return value
        out: list[Any] = []
        for key, member in value.items():
            for entry in as_list(member):
                if "@language" in containers:
                    if isinstance(entry, str) and key != "@none":
                        out.append({"@value": entry, "@language": key})
                    elif entry is not None:
                        out.append(entry)
                elif "@id" in containers:
                    if isinstance(entry, dict):
                        if key != "@none" and "@id" not in entry:
                            entry["@id"] = key
                        out.append(entry)
                elif "@type" in containers:
                    if isinstance(entry, str):
                        entry = {"@id": entry}
                    if isinstance(entry, dict):
                        if key != "@none":
                            entry["@type"] = as_list(entry.get("@type")) + [key]
                        out.append(entry)
                else:
                    out.append(entry)
        return out

    def normalize(self, document: Any) -> None:
        """Every node in a document put in the form the reader reads, in place,
        once, before anything reads it. A node's own @context, a term's scoped
        context and a type's scoped context apply to the node and what is under
        it; keyword aliases become the keywords; @nest objects are lifted onto
        their node; a container term's map becomes a list; each "@id", each
        "@type" and each value of a term typed "@id" or "@vocab" is expanded, so
        {"@id": "xsd:integer"} is XSD's integer and {"@id": "/api"} is an
        address on the document's host; and a key that a scoped context maps
        differently from the document's own context is renamed to the IRI it
        names, so reading the node later finds it. Value objects, JSON literals
        and JSON Schemas are left as they are. A stack, not recursion, so a
        deeply nested document costs linear time and stays inside Python's
        recursion limit. The page's normalize is the same."""
        top_items = document if isinstance(document, list) else [document]
        stack: list[tuple[Any, Context, bool]] = [(item, self, not isinstance(document, list)) for item in top_items]
        while stack:
            item, ctx, top = stack.pop()
            if isinstance(item, list):
                stack.extend((x, ctx, False) for x in item if isinstance(x, (dict, list)))
                continue
            if not isinstance(item, dict) or _json_schema_like(item):
                continue
            if "@context" in item:
                if top:
                    ctx.absorb(item["@context"])
                else:
                    ctx = ctx.child(item["@context"])
            ctx._rename_aliases(item)
            if "@value" in item:
                continue
            ctx._lift_nests(item)
            for kind in sorted(t for t in as_list(item.get("@type")) if isinstance(t, str) and t in ctx.scoped):
                ctx = ctx.scoped_child(kind)
            for key in list(item):
                if key == "@context":
                    continue
                if key == "@id":
                    item[key] = ctx.expand_iri(item[key], document_relative=True)
                    continue
                if key == "@type":
                    item[key] = ctx._expand_typed(item[key], True)
                    continue
                if key.startswith("@"):
                    if isinstance(item[key], (dict, list)):
                        stack.append((item[key], ctx, False))
                    continue
                if key in ctx.nulled:
                    del item[key]
                    continue
                kind = ctx.coerce.get(key)
                containers = ctx.containers.get(key)
                value_ctx = ctx.scoped_child(key) if key in ctx.scoped else ctx
                value = item[key]
                if containers:
                    value = ctx._unmap(value, containers)
                if kind in ("@id", "@vocab"):
                    value = value_ctx._expand_typed(value, kind == "@vocab")
                name = key
                if ctx is not self:
                    expanded = ctx.expand_key(key)
                    if expanded and expanded != self.expand_key(key):
                        name = expanded
                if name != key:
                    del item[key]
                    _merge_value(item, name, value)
                else:
                    item[key] = value
                if kind != "@json" and isinstance(value, (dict, list)):
                    stack.append((value, value_ctx, False))

    def _expand_typed(self, value: Any, vocab: bool) -> Any:
        """A typed term's value: a string, or each string in an array or in a list or set object."""
        def one(entry: Any) -> Any:
            if isinstance(entry, str):
                return self.expand_iri(entry, vocab=vocab, document_relative=True)
            if isinstance(entry, dict):
                for key in ("@list", "@set"):
                    if isinstance(entry.get(key), list):
                        entry[key] = [self.expand_iri(x, vocab=vocab, document_relative=True) for x in entry[key]]
            return entry
        return [one(entry) for entry in value] if isinstance(value, list) else one(value)


def truthy(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"true", "1", "yes"}:
        return True
    if text in {"false", "0", "no"}:
        return False
    return None


def local_name(iri: str | None) -> str:
    if not iri:
        return ""
    text = str(iri).rstrip("/")
    if "#" in text:
        return text.rsplit("#", 1)[-1]
    if ":" in text and not text.startswith("http"):
        return text.rsplit(":", 1)[-1]
    return text.rsplit("/", 1)[-1]


def short_rel(iri: str | None) -> str:
    return local_name(iri) or (iri or "")



@dataclass
class Field:
    name: str
    path: str | None = None
    datatype: str | None = None
    min_count: int | None = None
    max_count: int | None = None
    pattern: str | None = None
    default: Any = None
    max_length: int | None = None
    min_length: int | None = None
    description: str | None = None
    enum: list[Any] = field(default_factory=list)
    min_inclusive: Any = None
    max_inclusive: Any = None
    required: bool = False
    raw_body: bool = False
    variable: str | None = None
    json_kind: str | None = None
    # Takes a list of values: a SHACL property with no sh:maxCount, or one above 1.
    multi: bool = False

    def to_public(self) -> dict[str, Any]:
        return {
            "name": self.name, "path": self.path, "datatype": self.datatype,
            "jsonKind": self.json_kind, "multi": self.multi,
            "minCount": self.min_count, "maxCount": self.max_count,
            "pattern": self.pattern, "defaultValue": self.default,
            "maxLength": self.max_length, "minLength": self.min_length,
            "description": self.description, "in": self.enum,
            "minInclusive": self.min_inclusive, "maxInclusive": self.max_inclusive,
            "required": self.required or (self.min_count or 0) >= 1,
            "rawBody": self.raw_body, "variable": self.variable,
        }


@dataclass
class Control:
    id: str
    rel: str
    method: str
    title: str = ""
    description: str = ""
    media_type: str | None = None
    expects: str | None = None
    returns: str | None = None
    target: str | None = None
    template: str | None = None
    fields: list[Field] = field(default_factory=list)
    read_only: bool | None = None
    idempotent: bool | None = None
    destructive: bool | None = None
    types: list[str] = field(default_factory=list)
    source: str | None = None
    # The base the descriptor's relative IRIs resolved against.
    base: str | None = None
    # Why this control cannot be invoked, when it cannot; a warning to show with it.
    problem: str | None = None
    warning: str | None = None

    @property
    def unsafe(self) -> bool:
        method = (self.method or "").upper()
        if method and method not in SAFE_METHODS:
            return True
        if self.destructive is True:
            return True
        if self.read_only is False:
            return True
        return False

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id, "rel": self.rel, "method": self.method,
            "title": self.title, "description": self.description,
            "mediaType": self.media_type, "expects": self.expects,
            "returns": self.returns, "target": self.target,
            "template": self.template,
            "fields": [f.to_public() for f in self.fields],
            "readOnly": self.read_only, "idempotent": self.idempotent,
            "destructive": self.destructive, "unsafe": self.unsafe,
            "types": self.types, "source": self.source,
            "problem": self.problem, "warning": self.warning,
        }


# A control read from a JSON-LD node builds its fields, and the problem and
# warning they give, the first time one of the three is read: describe and
# invoke read one control's, so many controls that share one large shape cost
# the shape's size once, not once per control. A builder waits in the control's
# "_build" until then; an assignment to one of the three runs it first, so it
# never overwrites the value assigned. The page's controlFromNode is the same.
_BUILT_ON_READ = ("fields", "problem", "warning")


def _built_on_read(name: str) -> property:
    def read(self: Control) -> Any:
        build = self.__dict__.pop("_build", None)
        if build is not None:
            for key, value in zip(_BUILT_ON_READ, build()):
                self.__dict__["_built_" + key] = value
        return self.__dict__.get("_built_" + name)

    def write(self: Control, value: Any) -> None:
        read(self)
        self.__dict__["_built_" + name] = value
    return property(read, write)


for _name in _BUILT_ON_READ:
    setattr(Control, _name, _built_on_read(_name))


@dataclass
class Descriptor:
    url: str
    title: str
    types: list[str]
    description: str
    content_type: str
    controls: list[Control]
    see_also: list[str] = field(default_factory=list)
    raw: Any = None
    context: Context | None = None

    def find(self, rel: str) -> Control | None:
        rel = (rel or "").strip()
        if not rel:
            return None
        # A name expands as the document's own IRIs did, so "iep:x" finds an action written "iep:x".
        full = self.context.expand_iri(rel, document_relative=True) if self.context else rel
        exact = [c for c in self.controls if c.rel in (rel, full) or c.id in (rel, full)]
        if exact:
            return exact[0]
        lowered = rel.lower()
        loose = []
        for control in self.controls:
            candidates = {short_rel(control.rel).lower(), short_rel(control.id).lower()}
            if lowered in candidates:
                loose.append(control)
            elif control.rel.endswith("#" + rel) or control.rel.endswith("/" + rel):
                loose.append(control)
            elif control.rel.lower().endswith(":" + lowered):
                loose.append(control)
        return loose[0] if loose else None

    def to_public(self) -> dict[str, Any]:
        return {
            "url": self.url, "title": self.title, "types": self.types,
            "description": self.description, "contentType": self.content_type,
            "seeAlso": self.see_also,
            "controls": [c.to_public() for c in self.controls],
        }


@dataclass
class RequestPlan:
    control: Control
    transport: str
    method: str
    url: str | None
    headers: dict[str, str]
    body: Any
    body_text: str | None
    fields: dict[str, Any]
    mcp: dict[str, Any] | None
    notes: list[str] = field(default_factory=list)

    def to_public(self) -> dict[str, Any]:
        return {
            "rel": self.control.rel, "method": self.method,
            "transport": self.transport, "url": self.url,
            "headers": self.headers, "body": self.body,
            "bodyText": self.body_text, "fields": self.fields,
            "mcp": self.mcp, "unsafe": self.control.unsafe, "notes": self.notes,
        }


class NodeIndex:
    def __init__(self, document: Any, base: str, fetched_from: str | None = None) -> None:
        # `base` is the descriptor's address; `fetched_from`, when it differs,
        # is the address its text came from, which relative IRIs resolve against.
        self.ctx = Context(fetched_from or base)
        self.base = base
        self.nodes: dict[str, dict[str, Any]] = {}
        self.order: list[dict[str, Any]] = []
        self.root: dict[str, Any] | None = None
        # Each template node's (template, mappings), read once (_template_of),
        # and each shape's fields, built once (_shared_shape_fields); keyed by
        # the node's id(), with the node kept so the id stays its own.
        self.templates: dict[int, tuple[Any, tuple[str | None, list[dict[str, Any]]]]] = {}
        self.shapes: dict[int, tuple[Any, list[Field], str | None, Any]] = {}
        self._ingest_document(document, fetched_from)

    def _ingest_document(self, document: Any, fetched_from: str | None) -> None:
        """Indexes every node object at the top of the document, in its @graph
        (and in each named graph's @graph within it) and in @included, in
        document order, then the ones embedded under an affordance-like key."""
        if not isinstance(document, (dict, list)):
            return
        self.ctx.normalize(document)
        top: dict[str, Any] | None = None
        first_named: dict[str, Any] | None = None
        first_any: dict[str, Any] | None = None
        if isinstance(document, dict):
            extras = {k: v for k, v in document.items() if k not in {"@context", "@graph", "@included"}}
            if extras or ("@graph" not in document and "@included" not in document):
                top = dict(extras)
                if "@id" not in top:
                    top["@id"] = self.base
                top = self._add(top)
            pending: list[Any] = [document.get("@included"), document.get("@graph")]
        else:
            pending = [document]
        while pending:
            value = pending.pop()
            if isinstance(value, list):
                pending.extend(reversed(value))
                continue
            if not isinstance(value, dict):
                continue
            if any(k not in {"@id", "@context", "@graph", "@included"} for k in value):
                node = self._add(value)
                first_any = first_any or node
                if first_named is None and not str(node.get("@id", "")).startswith("_:"):
                    first_named = node
            pending.extend([value.get("@included"), value.get("@graph")])
        # The descriptor is the node at its address, or at the address its text
        # came from, or at the base; only a document that names none of them
        # falls back to its top-level node or its first named node.
        for address in (self.base, fetched_from, self.ctx.base):
            if address and address in self.nodes:
                self.root = self.nodes[address]
                break
        else:
            self.root = top or first_named or first_any
        self._harvest_embedded()

    def _add(self, node: dict[str, Any], added: list[str] | None = None) -> dict[str, Any]:
        """Adds a node, or merges its keys into the node already indexed at its
        @id; `added`, when given, collects the keys a merge added."""
        node_id = node.get("@id")
        if not node_id or not isinstance(node_id, str):
            # A node with no @id gets one in place, so the object a document
            # wrote and the one indexed are the same: an operation written
            # inline with no @id and no action is still a control.
            action = literal(self.get(node, P_ACTION)) or node.get("action")
            node_id = str(action) if action else f"_:n{len(self.order)}"
            node["@id"] = node_id
        existing = self.nodes.get(node_id)
        if existing is None:
            self.nodes[node_id] = node
            self.order.append(node)
            return node
        for key, val in node.items():
            if key not in existing:
                existing[key] = val
                if added is not None:
                    added.append(key)
        return existing

    def _harvest_embedded(self) -> None:
        """Indexes the nodes written inside a node under an affordance-like
        key, and the ones inside those, starting from every node indexed so
        far, in order. One stack and one set of walked nodes serve the whole
        document, so each node's keys are walked once however many nodes name
        it, and a node that lists itself ends the walk. A node already walked
        that gains keys from another object with its @id has just those keys
        walked. The work is linear in the document. The page's _harvest is the
        same."""
        walked: set[int] = set()
        pending: list[tuple[dict[str, Any], list[str] | None]] = [(node, None) for node in reversed(self.order)]
        while pending:
            current, keys = pending.pop()
            if keys is None:
                if id(current) in walked:
                    continue
                walked.add(id(current))
            for key in keys if keys is not None else list(current):
                pred = self.ctx.expand_key(key)
                lname = local_name(pred)
                if pred not in HARVESTED and lname not in HARVESTED_NAMES:
                    continue
                for item in as_list(current[key]):
                    if isinstance(item, dict) and (
                        "@id" in item or "action" in item or "method" in item or "@type" in item
                    ):
                        added: list[str] = []
                        node = self._add(item, added)
                        if id(node) not in walked:
                            pending.append((node, None))
                        elif added:
                            pending.append((node, added))

    def get(self, node: dict[str, Any] | None, predicate: str) -> Any:
        if not node:
            return None
        if predicate in node:
            return node[predicate]
        for key, val in node.items():
            if not key.startswith("@") and self.ctx.expand_key(key) == predicate:
                return val
        want = local_name(predicate)
        if want:
            for key, val in node.items():
                if key.startswith("@") or key.startswith("http://") or key.startswith("https://"):
                    continue
                if ":" in key:
                    continue
                if key == want:
                    return val
        return None

    def node(self, ident: Any) -> dict[str, Any] | None:
        iri = raw_id(ident)
        if iri and isinstance(iri, (str, int, float)):
            found = self.nodes.get(str(iri))
            if found:
                return found
        # A plain string naming a node as its "@id" was written before expansion, such as "#S".
        if isinstance(ident, str) and ident:
            full = self.ctx.expand_iri(ident, document_relative=True)
            if full != ident and full in self.nodes:
                return self.nodes[full]
        if isinstance(ident, dict) and any(k != "@id" for k in ident):
            return ident
        return None

    def types_of(self, node: dict[str, Any] | None) -> list[str]:
        return [str(self.ctx.expand_iri(x, vocab=True)) for x in literals(self.get(node, P_TYPE) or (node or {}).get("@type"))]

    def rdf_list(self, head: Any) -> list[Any]:
        out: list[Any] = []
        seen: set[str] = set()
        current = raw_id(head)
        while current and current != P_NIL and str(current) not in seen:
            seen.add(str(current))
            node = self.node(current) if not isinstance(current, dict) else current
            if isinstance(current, dict) and "@id" not in current and P_FIRST not in current:
                out.append(raw_id(current))
                break
            if not node:
                out.append(current)
                break
            first = self.get(node, P_FIRST)
            if first is not None:
                out.extend(literals(first) or [raw_id(first)])
            current = literal(self.get(node, P_REST))
        return out

    def list_values(self, raw: Any) -> list[Any]:
        """The members of a list value such as sh:in's: a JSON-LD list object
        ({"@list": [...]}, alone or in a one-element array), an RDF list of
        rdf:first / rdf:rest nodes, or a plain array. A member is unwrapped as
        any literal is, so {"@value": v} is v and {"@id": i} is i."""
        items = as_list(raw)
        if len(items) == 1 and isinstance(items[0], dict) and "@list" in items[0]:
            return literals(items[0]["@list"])
        head = literal(raw)
        if isinstance(head, str) and (head.startswith("_:") or self.node(head)):
            return self.rdf_list(head)
        return literals(raw)



_MAX_SAFE_INTEGER = 2 ** 53 - 1


def _inty(value: Any) -> int | None:
    """A count or length facet (sh:minCount, sh:maxLength, ...) as an int: an
    integral JSON number, or a string of digits once the shared spaces are
    trimmed, within what a double counts exactly. Anything else, a boolean
    included, is None. The page's inty is the same."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if abs(value) <= _MAX_SAFE_INTEGER else None
    if isinstance(value, float):
        return int(value) if value.is_integer() and abs(value) <= _MAX_SAFE_INTEGER else None
    if isinstance(value, str):
        text = value.strip(_SPACES)
        if not _INTEGER_LEXICAL.fullmatch(text) or len(text.lstrip("+-").lstrip("0")) > 16:
            return None
        number = int(text)
        return number if abs(number) <= _MAX_SAFE_INTEGER else None
    return None


def _looks_like_operation(index: NodeIndex, node: dict[str, Any]) -> bool:
    types = set(index.types_of(node))
    if types & {
        HYDRA + "IriTemplate", HYDRA + "IriTemplateMapping",
        SHACL + "NodeShape", SHACL + "PropertyShape",
    }:
        return False
    if types & {HYDRA + "Operation", IEP + "Affordance", IEH + "Affordance", HMD + "Control"}:
        return True
    if index.get(node, P_METHOD) and (index.get(node, P_ACTION) or index.get(node, P_TARGET) or index.get(node, P_TEMPLATE)):
        return True
    if index.get(node, P_ACTION) and (index.get(node, P_EXPECTS) or index.get(node, P_TITLE) or index.get(node, P_TARGET)):
        return True
    return False


def _text(value: Any) -> str:
    """Remote text as a string; a JSON value that is not a string as its JSON,
    written as the page's JSON.stringify writes it, with no spaces."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list, bool)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, float):
        return _js_number_text(value)
    return str(value)


def _json_value(value: Any) -> Any:
    """A JSON literal written as a value object, {"@type": "@json", "@value": v}, as v."""
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict) and value.get("@type") == "@json" and "@value" in value:
        return value["@value"]
    return value


def _is_json_schema(value: Any) -> bool:
    return isinstance(value, dict) and "properties" in value and P_SH_PROP not in value


_REST_PARAM = "rest-param-"


def _field_name(name: Any, path: str | None, variable: str | None) -> str:
    """Turns "rest-param-<x>-<name>" into "<name>": the text after the last "-"
    that has at least one character on each side of it. Found by a scan, not a
    pattern, so a long crafted name costs linear time. A name with a line break
    in it is kept whole, and a single final newline is dropped, as the pattern
    this replaces did."""
    if variable:
        return str(variable)
    raw = _text(name) or local_name(path) or "value"
    body = raw[:-1] if raw.endswith("\n") else raw
    if not body or "\n" in body:
        return raw
    if body.startswith(_REST_PARAM):
        cut = body.rfind("-", 0, len(body) - 1)
        if cut > len(_REST_PARAM):
            return body[cut + 1:]
    return body


def _schema_types(prop: dict[str, Any]) -> list[str]:
    raw = prop.get("type")
    types = raw if isinstance(raw, list) else ([raw] if raw else [])
    return [str(item) for item in types if item and str(item) != "null"]


def _schema_json_kind(types: list[str]) -> str | None:
    structured = [item for item in types if item in {"object", "array"}]
    others = [item for item in types if item not in {"object", "array"}]
    if not structured or others:
        return None
    if "object" in structured and "array" in structured:
        return "json"
    return structured[0]


def _schema_datatype(types: list[str]) -> str | None:
    type_map = {
        "string": XSD + "string", "integer": XSD + "integer",
        "number": XSD + "decimal", "boolean": XSD + "boolean",
    }
    if len(types) == 1:
        return type_map.get(types[0])
    return None


def _xsd_name(datatype: Any) -> str | None:
    """A datatype reaches a field in one of two forms: an IRI in full, which is
    what every IRI in a JSON-LD document is once expanded, or a plain "xsd:" or
    "rdf:" string where nothing expands it: a HyperMarkdown block, or a
    sh:datatype written as a literal. This gives the name of an XSD datatype in
    either form, or None. The page's xsdName and isRdfJson are the same."""
    dt = _text(datatype)
    if dt.startswith(XSD):
        return dt[len(XSD):]
    return dt[4:] if dt.startswith("xsd:") else None


def _is_rdf_json(datatype: Any) -> bool:
    return _text(datatype) in (RDF_JSON, "rdf:JSON")


def _shacl_json_kind(index: NodeIndex, node: dict[str, Any], datatype: str | None, max_count: int | None) -> str | None:
    dt = datatype or ""
    if _is_rdf_json(dt):
        return "json"
    if dt:
        return None
    nested = index.get(node, P_SH_NODE)
    node_kind = str(literal(index.get(node, P_SH_NODEKIND)) or "")
    blank = node_kind == SHACL + "BlankNode" or node_kind.endswith("#BlankNode")
    if nested is not None or blank:
        return "array" if max_count is None or max_count > 1 else "object"
    return None


def _is_multi(json_kind: str | None, min_count: int | None, max_count: int | None, unbounded: bool) -> bool:
    """Whether a field takes a list of values. A SHACL property with no
    sh:maxCount may have any number (`unbounded`), which is how Interego's own
    shapes write a list: a single value carries sh:maxCount 1. A count above 1
    either way also makes a list. A JSON field's list is its JSON."""
    if json_kind:
        return False
    if (min_count or 0) > 1 or (max_count is not None and max_count > 1):
        return True
    return unbounded and max_count is None


def _defaults(index: NodeIndex, node: dict[str, Any], multi: bool) -> Any:
    if multi:
        found = literals(index.get(node, P_SH_DEF))
        return found or None
    return literal(index.get(node, P_SH_DEF))


def _supported_field(index: NodeIndex, ref: Any) -> Field | None:
    """A field for one hydra:SupportedProperty: named by its hydra:property's
    local name, or, for a property written in place as a blank node (as
    Interego's manifests write one), by that property's rdfs:label; required
    when hydra:required is true; constrained by the SHACL facets on it."""
    sp = index.node(ref) or (ref if isinstance(ref, dict) else None)
    if not sp:
        return None
    raw_prop = as_list(index.get(sp, P_PROPERTY))
    head = raw_prop[0] if raw_prop else None
    prop_node = index.node(head) or (head if isinstance(head, dict) else None)
    if isinstance(head, dict):
        iri = head.get("@id")
    else:
        # Hydra's context types hydra:property as @vocab, so a plain "schema:text" names an IRI.
        iri = index.ctx.expand_iri(head, vocab=True, document_relative=True) if isinstance(head, str) else None
    named = isinstance(iri, str) and bool(iri) and not iri.startswith("_:")
    label = literal(index.get(prop_node, P_LABEL)) if prop_node else None
    name = literal(index.get(sp, P_SH_NAME)) or (local_name(iri) if named else None) or label
    if name is None or _text(name) == "":
        return None
    datatype = str(literal(index.get(sp, P_SH_DT)) or "") or None
    if not datatype and prop_node:
        declared = literal(index.get(prop_node, P_RANGE))
        if _xsd_name(declared) is not None or _is_rdf_json(declared):
            datatype = str(declared)
    min_count = _inty(literal(index.get(sp, P_SH_MIN)))
    max_count = _inty(literal(index.get(sp, P_SH_MAX)))
    json_kind = "json" if _is_rdf_json(datatype) else None
    multi = _is_multi(json_kind, min_count, max_count, False)
    required = truthy(literal(index.get(sp, P_REQUIRED))) is True or (min_count or 0) >= 1
    enum_raw = index.get(sp, P_SH_IN)
    description = (literal(index.get(sp, P_SH_DESC)) or literal(index.get(sp, P_COMMENT)) or literal(index.get(sp, P_DESC))
                   or (literal(index.get(prop_node, P_COMMENT)) if prop_node else None) or "")
    return Field(
        name=_field_name(name, iri if named else None, None), path=iri if named else None,
        datatype=datatype, json_kind=json_kind,
        min_count=min_count if min_count is not None else (1 if required else None), max_count=max_count,
        pattern=str(literal(index.get(sp, P_SH_PAT)) or "") or None,
        default=_defaults(index, sp, multi),
        max_length=_inty(literal(index.get(sp, P_SH_MAXLEN))), min_length=_inty(literal(index.get(sp, P_SH_MINLEN))),
        description=_text(description) or None,
        enum=[] if enum_raw is None else index.list_values(enum_raw),
        min_inclusive=literal(index.get(sp, P_SH_MINI)), max_inclusive=literal(index.get(sp, P_SH_MAXI)),
        required=required, multi=multi,
    )


def _shape_fields(index: NodeIndex, shape_ref: Any) -> list[Field]:
    fields: list[Field] = []
    shape_ref = _json_value(shape_ref)
    if _is_json_schema(shape_ref):
        required = set(as_list(shape_ref.get("required") or []))
        properties = shape_ref.get("properties")
        for name, prop in (properties.items() if isinstance(properties, dict) else []):
            prop = prop if isinstance(prop, dict) else {}
            types = _schema_types(prop)
            json_kind = _schema_json_kind(types)
            fields.append(Field(
                name=str(name), path=str(name),
                datatype=None if json_kind else (_schema_datatype(types) or XSD + "string"),
                json_kind=json_kind,
                min_count=1 if name in required else 0, max_count=1,
                pattern=prop.get("pattern"), default=prop.get("default"),
                max_length=_inty(prop.get("maxLength")), min_length=_inty(prop.get("minLength")),
                description=prop.get("description"), enum=list(as_list(prop.get("enum") or [])),
                min_inclusive=prop.get("minimum"), max_inclusive=prop.get("maximum"),
                required=name in required,
            ))
        return fields
    shape = index.node(shape_ref)
    if not shape:
        return fields
    props = index.get(shape, P_SH_PROP)
    if not props:
        supported = index.get(shape, P_SUPPROP)
        if supported:
            return [f for f in (_supported_field(index, item) for item in as_list(supported)) if f]
        if index.get(shape, P_SH_DT) or index.get(shape, P_SH_MINLEN) or index.get(shape, P_SH_MAXLEN):
            label = str(literal(index.get(shape, P_LABEL)) or "")
            name = "query" if ("query" in label.lower() or "sparql" in label.lower()) else "body"
            datatype = str(literal(index.get(shape, P_SH_DT)) or XSD + "string")
            fields.append(Field(
                name=name,
                path=shape.get("@id") if isinstance(shape, dict) else None,
                datatype=datatype, json_kind="json" if _is_rdf_json(datatype) else None,
                min_count=1, max_count=1, required=True, raw_body=True,
                min_length=_inty(literal(index.get(shape, P_SH_MINLEN))),
                max_length=_inty(literal(index.get(shape, P_SH_MAXLEN))),
                description=str(literal(index.get(shape, P_COMMENT)) or literal(index.get(shape, P_SH_DESC)) or ""),
            ))
        return fields
    for pref in as_list(props):
        node = index.node(pref) or (pref if isinstance(pref, dict) else None)
        if not node:
            continue
        path = str(literal(index.get(node, P_SH_PATH)) or "")
        name = literal(index.get(node, P_SH_NAME))
        enum_raw = index.get(node, P_SH_IN)
        enum: list[Any] = [] if enum_raw is None else index.list_values(enum_raw)
        min_count = _inty(literal(index.get(node, P_SH_MIN)))
        max_count = _inty(literal(index.get(node, P_SH_MAX)))
        datatype = str(literal(index.get(node, P_SH_DT)) or "") or None
        json_kind = _shacl_json_kind(index, node, datatype, max_count)
        multi = _is_multi(json_kind, min_count, max_count, True)
        fields.append(Field(
            name=_field_name(str(name) if name else None, path, None),
            path=path or None,
            datatype=datatype,
            json_kind=json_kind,
            min_count=min_count, max_count=max_count,
            pattern=str(literal(index.get(node, P_SH_PAT)) or "") or None,
            default=_defaults(index, node, multi),
            max_length=_inty(literal(index.get(node, P_SH_MAXLEN))),
            min_length=_inty(literal(index.get(node, P_SH_MINLEN))),
            description=str(literal(index.get(node, P_SH_DESC)) or literal(index.get(node, P_COMMENT)) or literal(index.get(node, P_DESC)) or "") or None,
            enum=enum,
            min_inclusive=literal(index.get(node, P_SH_MINI)),
            max_inclusive=literal(index.get(node, P_SH_MAXI)),
            required=(min_count or 0) >= 1, multi=multi,
        ))
    return fields


def _template_of(index: NodeIndex, node: dict[str, Any]) -> tuple[str | None, list[dict[str, Any]], bool]:
    """The control's IRI template and its mappings, and whether the template is
    the control's hydra:target: a hydra:IriTemplate written as the target, as
    Interego's decoration catalogs write one, or reached through hydra:search
    or a key named for a template. A template node many controls share is read
    once (index.templates), so its mappings cost their size once, not once per
    control. The page's templateOf is the same."""
    def read_template_node(tmpl: Any) -> tuple[str | None, list[dict[str, Any]]]:
        if not tmpl:
            return None, []
        hit = index.templates.get(id(tmpl))
        if hit is None or hit[0] is not tmpl:
            hit = index.templates[id(tmpl)] = (tmpl, read_template(tmpl))
        return hit[1]

    def read_template(tmpl: Any) -> tuple[str | None, list[dict[str, Any]]]:
        template = literal(index.get(tmpl, P_TEMPLATE))
        found = []
        for item in as_list(index.get(tmpl, P_MAPPING)):
            mn = index.node(item) or (item if isinstance(item, dict) else None)
            if not mn:
                continue
            # Hydra's context types hydra:property as @vocab, so a plain "schema:query" names an IRI.
            prop = literal(index.get(mn, P_PROPERTY))
            found.append({
                "variable": _text(literal(index.get(mn, P_VARIABLE))) or None,
                "property": _text(index.ctx.expand_iri(prop, vocab=True, document_relative=True) if isinstance(prop, str) else prop) or None,
                "required": truthy(literal(index.get(mn, P_REQUIRED))),
            })
        return (str(template) if template else None), found

    def as_template(item: Any) -> dict[str, Any] | None:
        tmpl = index.node(item) or (item if isinstance(item, dict) else None)
        if tmpl and (index.get(tmpl, P_TEMPLATE) is not None or HYDRA + "IriTemplate" in index.types_of(tmpl)):
            return tmpl
        return None

    direct = literal(index.get(node, P_TEMPLATE))
    if isinstance(direct, str) and "{" in direct:
        _, mappings = read_template_node(node)
        return direct, mappings, False
    for pred in (P_TARGET, P_HMDTARGET):
        for item in as_list(index.get(node, pred)):
            template, mappings = read_template_node(as_template(item))
            if template:
                return template, mappings, True
    for key, val in node.items():
        if key.startswith("@"):
            continue
        pred = index.ctx.expand_key(key)
        lname = local_name(pred).lower()
        if pred not in {P_TEMPLATE, P_SEARCH} and "template" not in lname:
            continue
        for item in as_list(val):
            tmpl_node = index.node(item) or (item if isinstance(item, dict) else None)
            template, mappings = read_template_node(tmpl_node)
            if template:
                return template, mappings, False
    return (str(direct) if direct else None), [], False


class _FieldIndex:
    """Where each path, and each path's local name, first appears in a list of
    fields, and every position of each name, in order. Built once for a list
    that several controls share, and read by _merge_mapping_fields."""

    def __init__(self, fields: list[Field]) -> None:
        self.by_path: dict[str, int] = {}
        self.by_local: dict[str, int] = {}
        self.by_name: dict[str, list[int]] = {}
        for i, fld in enumerate(fields):
            if fld.path:
                self.by_path.setdefault(fld.path, i)
                self.by_local.setdefault(local_name(fld.path), i)
            self.by_name.setdefault(fld.name, []).append(i)


def _merge_mapping_fields(fields: list[Field], mappings: list[dict[str, Any]],
                          base: _FieldIndex | None = None) -> list[Field]:
    """Joins a template's mappings to the fields. Each mapping, in order,
    renames the first field, in field order, whose path is its hydra:property,
    or else the first field now named as its variable, or else the first whose
    path ends in its variable; a mapping that matches none adds a field. The
    fields given are not changed: a matched field is copied, so fields a shape
    gives several controls stay as they are. Positions are looked up in maps
    (`base`, the given fields' _FieldIndex, when it is at hand), and the first
    field of a name, which renames change, in a heap per name, so the work is
    linear in the mappings beyond copying the list. The page's mergeMappings
    is the same."""
    if not mappings:
        return fields
    base = base or _FieldIndex(fields)
    fields = list(fields)
    more_path: dict[str, int] = {}
    more_local: dict[str, int] = {}
    renamed: dict[str, list[int]] = {}
    start: dict[str, int] = {}

    def first_named(name: str) -> int | None:
        listed = base.by_name.get(name, [])
        at = start.get(name, 0)
        while at < len(listed) and fields[listed[at]].name != name:
            at += 1
        start[name] = at
        heap = renamed.get(name)
        while heap and fields[heap[0]].name != name:
            heapq.heappop(heap)
        found = listed[at] if at < len(listed) else None
        if heap and (found is None or heap[0] < found):
            found = heap[0]
        return found

    for mapping in mappings:
        variable = mapping.get("variable")
        prop = mapping.get("property")
        required = mapping.get("required")
        if not variable:
            continue
        # A mapping with no hydra:property matches by its variable's name only.
        at = base.by_path.get(prop, more_path.get(prop)) if prop else None
        if at is None:
            at = first_named(variable)
        if at is None:
            at = base.by_local.get(variable, more_local.get(variable))
        if at is not None:
            match = copy.copy(fields[at])
            match.variable = variable
            match.name = variable
            if required:
                match.required = True
                if not match.min_count:
                    match.min_count = 1
            if fields[at].name != variable:
                heapq.heappush(renamed.setdefault(variable, []), at)
            fields[at] = match
        else:
            added = Field(
                name=variable, path=prop or None,
                variable=variable, required=bool(required),
                min_count=1 if required else 0, max_count=1,
            )
            fields.append(added)
            at = len(fields) - 1
            if added.path:
                more_path.setdefault(added.path, at)
                more_local.setdefault(local_name(added.path), at)
            heapq.heappush(renamed.setdefault(added.name, []), at)
    return fields


_HINT_DESTRUCTIVE = "destructiveHint"
_HINT_READONLY = "readOnlyHint"


def _hint_flags(index: NodeIndex, node: dict[str, Any]) -> tuple[bool, bool]:
    """Whether a node says, under any key whose name ends in destructiveHint or
    readOnlyHint, that it destroys or writes: its own keys, such as a hint under
    a prefix the context does not define, and the keys of an object written
    directly inside it, such as MCP's "annotations". Read only to fail closed:
    either can make a control unsafe, and neither makes one safe. The page's
    hintFlags is the same."""
    destructive = writes = False
    objects = [node]
    for key, val in node.items():
        if key.startswith("@"):
            continue
        for item in as_list(val):
            if isinstance(item, dict) and "@value" not in item and "@list" not in item:
                objects.append(item)
    for obj in objects:
        for key, val in obj.items():
            if key.startswith("@"):
                continue
            names = {local_name(key), local_name(index.ctx.expand_key(key))}
            flag = truthy(literal(val))
            if _HINT_DESTRUCTIVE in names and flag is True:
                destructive = True
            if _HINT_READONLY in names and flag is False:
                writes = True
    return destructive, writes


def _duplicate_name(fields: list[Field]) -> str | None:
    seen: set[str] = set()
    for fld in fields:
        if fld.name in seen:
            return fld.name
        seen.add(fld.name)
    return None


def control_from_node(index: NodeIndex, node: dict[str, Any], source: str) -> Control:
    rel = literal(index.get(node, P_ACTION)) or literal(index.get(node, P_REL)) or node.get("@id") or ""
    # A control that names no method is sent as the substrate's own follower
    # (invoke_affordance, act) sends it: POST. So it is never a safe read by default.
    method = str(literal(index.get(node, P_METHOD)) or "POST").upper()
    title = literal(index.get(node, P_TITLE)) or literal(index.get(node, P_DCTITLE)) or literal(index.get(node, P_LABEL)) or short_rel(str(rel))
    description = literal(index.get(node, P_DESC)) or literal(index.get(node, P_DCDESC)) or literal(index.get(node, P_COMMENT)) or ""
    media = literal(index.get(node, P_RETURNS_CT)) or literal(index.get(node, P_MEDIA))
    expects_raw = _json_value(index.get(node, P_EXPECTS))
    expects = None
    if _is_json_schema(expects_raw):
        expects = None
    elif isinstance(expects_raw, dict) and "@id" in expects_raw:
        expects = expects_raw["@id"]
    else:
        expects = literal(expects_raw)
    returns = literal(index.get(node, P_RETURNS))
    template, mappings, template_is_target = _template_of(index, node)
    target = None if template_is_target else (literal(index.get(node, P_TARGET)) or literal(index.get(node, P_HMDTARGET)))
    destructive_flag, writes_flag = _hint_flags(index, node)
    read_only = truthy(literal(index.get(node, P_READONLY)))
    destructive = truthy(literal(index.get(node, P_DESTRUCTIVE)))
    control = Control(
        id=str(node.get("@id") or rel), rel=str(rel), method=method,
        title=str(title or ""), description=str(description or ""),
        media_type=str(media) if media else None,
        expects=_text(expects) if expects else None,
        returns=str(returns) if returns else None,
        target=str(target) if target else None, template=template,
        read_only=False if writes_flag else read_only,
        idempotent=truthy(literal(index.get(node, P_IDEMPOTENT))),
        destructive=True if destructive_flag else destructive,
        types=index.types_of(node), source=source, base=index.ctx.base,
    )
    control.__dict__["_build"] = lambda: _control_inputs(index, node, expects_raw, expects, mappings)
    return control


def _duplicate_problem(fields: list[Field]) -> str | None:
    duplicate = _duplicate_name(fields)
    return (f"two input fields are both named {duplicate!r}, so their values could not be told apart; "
            "this control is not invoked") if duplicate else None


def _shared_shape_fields(index: NodeIndex, shape_ref: Any) -> tuple[list[Field], str | None, _FieldIndex | None]:
    """The fields a SHACL shape or a hydra:Class gives, built once per shape
    node however many controls name it, with the problem they give and their
    _FieldIndex; a JSON Schema written in a control is its own. The list is
    shared, so it is never changed: _merge_mapping_fields copies."""
    shape = None if _is_json_schema(_json_value(shape_ref)) else index.node(_json_value(shape_ref))
    if shape is None:
        fields = _shape_fields(index, shape_ref)
        return fields, _duplicate_problem(fields), None
    hit = index.shapes.get(id(shape))
    if hit is None or hit[0] is not shape:
        fields = _shape_fields(index, shape_ref)
        hit = index.shapes[id(shape)] = (shape, fields, _duplicate_problem(fields), _FieldIndex(fields))
    return hit[1], hit[2], hit[3]


def _control_inputs(index: NodeIndex, node: dict[str, Any], expects_raw: Any, expects: Any,
                    mappings: list[dict[str, Any]]) -> tuple[list[Field], str | None, str | None]:
    """A control's input fields, from its inline fields or the shape
    hydra:expects names, joined to its template's mappings; the problem that
    keeps it from being invoked, if any; and a warning to show with it. The
    page's controlInputs is the same."""
    fields: list[Field] = []
    inline = node.get("fields")
    warning = None
    problem = None
    base: _FieldIndex | None = None
    if isinstance(inline, list) and inline and isinstance(inline[0], dict) and (
        "name" in inline[0] or "path" in inline[0] or "datatype" in inline[0]
    ):
        for item in inline:
            if not isinstance(item, dict):
                continue
            fields.append(Field(
                name=_field_name(item.get("name"), item.get("path"), None),
                path=item.get("path"), datatype=item.get("datatype"),
                min_count=_inty(item.get("minCount")), max_count=_inty(item.get("maxCount")),
                pattern=item.get("pattern"), default=item.get("defaultValue"),
                max_length=_inty(item.get("maxLength")), min_length=_inty(item.get("minLength")),
                description=item.get("description"),
                required=(_inty(item.get("minCount")) or 0) >= 1,
            ))
        problem = _duplicate_problem(fields)
    elif expects_raw is not None:
        shape_ref = expects_raw[0] if isinstance(expects_raw, list) and expects_raw else expects_raw
        fields, problem, base = _shared_shape_fields(index, shape_ref)
        if not fields and not _is_json_schema(shape_ref):
            warning = (f"hydra:expects names {_text(expects) or 'a shape'}, which this document does not describe, so no "
                       "input fields were built: what the server expects is not known here.")
    if mappings:
        fields = _merge_mapping_fields(fields, mappings, base)
        problem = _duplicate_problem(fields)
    return fields, problem, warning


def extract_controls(index: NodeIndex, source: str) -> list[Control]:
    found: dict[str, Control] = {}
    candidates: list[dict[str, Any]] = []
    seen: set[int] = set()

    def add_candidate(node: dict[str, Any] | None) -> None:
        if node and id(node) not in seen:
            seen.add(id(node))
            candidates.append(node)

    # A class many nodes name is read once, so its operations cost their number once.
    classes: set[int] = set()
    for node in index.order:
        for pred in (P_AFFORDANCE, P_CONTROL, P_SUPOP, P_OPERATION):
            for item in as_list(index.get(node, pred)):
                add_candidate(index.node(item) or (item if isinstance(item, dict) else None))
        for item in as_list(index.get(node, P_SUPCLASS)):
            cls = index.node(item)
            if not cls or id(cls) in classes:
                continue
            classes.add(id(cls))
            for op in as_list(index.get(cls, P_SUPOP)):
                add_candidate(index.node(op) or (op if isinstance(op, dict) else None))
        if _looks_like_operation(index, node):
            add_candidate(node)
    for node in candidates:
        control = control_from_node(index, node, source)
        key = control.rel or control.id
        if key and key not in found:
            found[key] = control
    controls = list(found.values())
    controls.sort(key=lambda c: (0 if not c.unsafe else 1, c.method, (c.title or c.rel).lower()))
    return controls


def descriptor_meta(index: NodeIndex, url: str, content_type: str) -> tuple[str, list[str], str, list[str]]:
    root = index.root
    title, types, description, see_also = local_name(url) or url, [], "", []
    if root:
        title = str(literal(index.get(root, P_DCTITLE)) or literal(index.get(root, P_TITLE)) or literal(index.get(root, P_LABEL)) or title)
        types = index.types_of(root)
        description = str(literal(index.get(root, P_DCDESC)) or literal(index.get(root, P_DESC)) or literal(index.get(root, P_COMMENT)) or "")
        see_also = [str(x) for x in literals(index.get(root, P_SEEALSO))]
    return title, types, description, see_also



CONTROL_BLOCK = re.compile(r":::control\s+(\S+)\s*\n(.*?)(?:\n:::|\Z)", re.DOTALL)


def parse_markdown_descriptor(text: str, url: str, content_type: str) -> Descriptor:
    controls: list[Control] = []
    for match in CONTROL_BLOCK.finditer(text):
        ident = match.group(1).strip()
        data: dict[str, Any] = {}
        for line in match.group(2).splitlines():
            if ":" not in line:
                continue
            key, val = line.split(":", 1)
            key, val = key.strip(), val.strip()
            if not key:
                continue
            if val.startswith("{") or val.startswith("["):
                try:
                    data[key] = json.loads(val)
                    continue
                except json.JSONDecodeError:
                    pass
            data[key] = val.strip('"')
        fields: list[Field] = []
        for item in data.get("fields") or []:
            if isinstance(item, dict):
                fields.append(Field(
                    name=_field_name(item.get("name"), item.get("path"), None),
                    path=item.get("path"), datatype=item.get("datatype"),
                    min_count=_inty(item.get("minCount")), max_count=_inty(item.get("maxCount")),
                    pattern=item.get("pattern"), default=item.get("defaultValue"),
                    max_length=_inty(item.get("maxLength")), min_length=_inty(item.get("minLength")),
                    description=item.get("description"),
                    required=(_inty(item.get("minCount")) or 0) >= 1,
                ))
        rel = str(data.get("rel") or ident)
        controls.append(Control(
            id=ident if ident.startswith("http") else f"{url}#{ident}",
            # No method is POST here as in a JSON-LD control, as the substrate's HyperMarkdown lift reads it.
            rel=rel, method=str(data.get("method") or "POST").upper(),
            title=str(data.get("title") or short_rel(rel)),
            description=str(data.get("description") or data.get("whenToUse") or ""),
            media_type=data.get("mediaType"), expects=data.get("expects"),
            returns=data.get("returns"), target=data.get("target"),
            fields=fields, source=url,
        ))
    title_match = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else local_name(url) or url
    return Descriptor(
        url=url, title=title, types=["hmd:Document"],
        description="Parsed from HyperMarkdown control blocks (authority JSON-LD/Turtle preferred).",
        content_type=content_type, controls=controls, raw=text,
    )


# Every URL hmc.py fetches comes from the command line or from a document
# someone else wrote, so it fetches http and https and nothing else: no file:,
# ftp: or data: URL, whether a descriptor names it or a redirect leads to it.
WEB_SCHEMES = ("http", "https")


def is_web_url(url: str | None) -> bool:
    """Whether a URL's scheme, read as RFC 3986 reads it (and the page's
    isWebUrl does), is http or https, in any case."""
    scheme = _split_iri(url)[0] if isinstance(url, str) else None
    return scheme is not None and scheme.lower() in WEB_SCHEMES


def _require_web_url(url: str, refused: str = "nothing was sent to") -> None:
    if not is_web_url(url):
        raise RuntimeError(f"hmc.py sends requests to http and https URLs only; {refused} {url}")


class _WebOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to another http or https URL, and notes where a
    303 See Other was answered from."""

    def __init__(self) -> None:
        super().__init__()
        self.see_other_from: str | None = None

    def http_error_302(self, req, fp, code, msg, headers):  # type: ignore[no-untyped-def]
        location = headers.get("location") or headers.get("uri")
        if location:
            _require_web_url(urllib.parse.urljoin(req.full_url, location), "refused a redirect to")
        if code == 303 and self.see_other_from is None:
            self.see_other_from = req.full_url
        return super().http_error_302(req, fp, code, msg, headers)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def _web_opener(redirects: _WebOnlyRedirects) -> urllib.request.OpenerDirector:
    """urlopen's handlers without the file, ftp and data ones; a URL of another
    scheme reaches UnknownHandler and fails."""
    opener = urllib.request.OpenerDirector()
    for handler in (
        urllib.request.ProxyHandler(), urllib.request.UnknownHandler(),
        urllib.request.HTTPHandler(), urllib.request.HTTPSHandler(),
        urllib.request.HTTPDefaultErrorHandler(), redirects,
        urllib.request.HTTPErrorProcessor(),
    ):
        opener.add_handler(handler)
    return opener


def http_request(url: str, method: str = "GET", headers: dict[str, str] | None = None,
                 data: bytes | None = None, timeout: int = 60) -> tuple[int, dict[str, str], bytes, str]:
    """The status, headers and body of a request, and the address the answer
    is the document at: the URL after any redirects, as JSON-LD takes a
    document's base from, except that a 303 See Other leaves it at the URL that
    answered 303. The URL is sent exactly as _request_url writes it."""
    _require_web_url(url)
    url = _request_url(url)
    req_headers = {"User-Agent": USER_AGENT}
    if headers:
        req_headers.update(headers)
    request = urllib.request.Request(url, data=data, headers=req_headers, method=method.upper())
    redirects = _WebOnlyRedirects()
    try:
        with _web_opener(redirects).open(request, timeout=timeout) as resp:
            final = redirects.see_other_from or resp.geturl() or url
            return resp.getcode() or 200, {k.lower(): v for k, v in resp.headers.items()}, resp.read(), final
    except urllib.error.HTTPError as exc:
        body = exc.read() if exc.fp else b""
        final = redirects.see_other_from or exc.geturl() or url
        return exc.code, {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}, body, final


def _with_format(url: str, fmt: str) -> str:
    parts = urllib.parse.urlsplit(url)
    query = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    query["format"] = fmt
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(query), parts.fragment))


def _strip_fragment(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))


def classify_payload(text: str, content_type: str) -> str | None:
    ct = (content_type or "").split(";")[0].strip().lower()
    sample = text.lstrip()[:240]
    if "ld+json" in ct or ct == "application/json":
        return "jsonld" if sample[:1] in "{[" else None
    if "turtle" in ct or ct in {"text/ttl", "application/x-turtle"}:
        return "turtle"
    if "markdown" in ct or "text/plain" in ct:
        if ":::control" in text or sample.startswith("---"):
            return "markdown"
    if sample[:1] in "{[":
        try:
            json.loads(text)
            return "jsonld"
        except json.JSONDecodeError:
            pass
    if sample.startswith("@prefix") or sample.startswith("PREFIX") or sample.startswith("<http"):
        return "turtle"
    if ":::control" in text:
        return "markdown"
    return None


def fetch_authority(url: str) -> tuple[str, str, str]:
    url = _strip_fragment(url)
    accept = "application/ld+json, application/json;q=0.9, text/turtle;q=0.8, text/markdown;q=0.4, */*;q=0.1"
    tried: list[str] = []
    existing = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query)).get("format", "").lower()

    def attempt(candidate: str) -> tuple[str, str, str] | None:
        tried.append(candidate)
        # The address the text came from is where it landed after redirects,
        # which its relative IRIs resolve against: /dir answered by /dir/ puts
        # "items" at /dir/items. The page's fetchAuthority does the same.
        status, headers, body, landed = http_request(candidate, headers={"Accept": accept})
        if status >= 400:
            return None
        text = body.decode("utf-8", errors="replace")
        kind = classify_payload(text, headers.get("content-type", ""))
        if kind:
            return landed, headers.get("content-type", ""), text
        return None

    if existing:
        result = attempt(url)
        if result:
            return result
    else:
        result = attempt(url)
        if result:
            kind = classify_payload(result[2], result[1])
            if kind != "jsonld":
                alt = attempt(_with_format(url, "jsonld"))
                if alt and classify_payload(alt[2], alt[1]) == "jsonld":
                    return alt
            return result
        for fmt in ("jsonld", "turtle", "markdown"):
            result = attempt(_with_format(url, fmt))
            if result:
                return result
    raise RuntimeError(f"Could not fetch a JSON-LD, Turtle, or HyperMarkdown descriptor from {url} (tried {tried})")


def parse_turtle_via_rdflib(text: str, url: str) -> Any:
    try:
        from rdflib import Graph  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "This descriptor was served as Turtle. Install rdflib "
            "(`pip install rdflib`) or request ?format=jsonld."
        ) from exc
    graph = Graph()
    graph.parse(data=text, format="turtle", publicID=url)
    return json.loads(graph.serialize(format="json-ld"))


def parse_descriptor(text: str, content_type: str, url: str, fetched_from: str | None = None) -> Descriptor:
    kind = classify_payload(text, content_type)
    if kind == "jsonld":
        document = json.loads(text)
        index = NodeIndex(document, url, fetched_from)
        title, types, description, see_also = descriptor_meta(index, url, content_type)
        return Descriptor(
            url=url, title=title, types=types, description=description,
            content_type=content_type, controls=extract_controls(index, url),
            see_also=see_also, raw=document, context=index.ctx,
        )
    if kind == "turtle":
        return parse_descriptor(json.dumps(parse_turtle_via_rdflib(text, fetched_from or url)), "application/ld+json", url, fetched_from)
    if kind == "markdown":
        return parse_markdown_descriptor(text, url, content_type)
    raise RuntimeError(f"Unrecognized descriptor representation ({content_type})")


def load_descriptor(url: str) -> Descriptor:
    fetched_from, content_type, text = fetch_authority(url)
    descriptor = parse_descriptor(text, content_type, _strip_fragment(url), fetched_from)
    descriptor.content_type = content_type
    return descriptor



# RFC 6570. quote(..., safe="!*'()") matches encodeURIComponent, including
# UTF-8 for non-ASCII (café -> caf%C3%A9). Reserved expansion (+) leaves
# ASCII reserved characters unescaped and still percent-encodes UTF-8.
_COMPONENT_SAFE = "!*'()"
_RESERVED_SAFE = _COMPONENT_SAFE + ":/?#[]@!$&+,;="
_FRAGMENT_SAFE = _COMPONENT_SAFE + ":/?[]@!$&+,;="


def _template_defined(value: Any) -> bool:
    if value is None or value == "":
        return False
    if isinstance(value, list):
        return any(_template_defined(item) for item in value)
    if isinstance(value, dict):
        return any(_template_defined(item) for item in value.values())
    return True


def _js_number_text(number: float) -> str:
    """A float as JavaScript writes a number (Number.prototype.toString):
    the shortest digits that read back as it, in plain notation from 1e-7 up to
    1e21 and exponent notation outside that, with no ".0" on a whole number. The
    page writes numbers this way itself, so a number field reaches a URL as the
    same text from both clients: 2 and not 2.0, 1e-7 and not 1e-07."""
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    mantissa, _, exponent = repr(abs(number)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = (whole + fraction).lstrip("0")
    trailing = len(digits) - len(digits.rstrip("0"))
    digits = digits.rstrip("0")
    k = len(digits)
    n = k + int(exponent or 0) - len(fraction) + trailing
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    power = n - 1
    tail = ("+" if power >= 0 else "-") + str(abs(power))
    return sign + (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + tail


def _template_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, float):
        return _js_number_text(value)
    return str(value)


def _template_encode(value: Any, op: str) -> str:
    safe = _RESERVED_SAFE if op == "+" else (_FRAGMENT_SAFE if op == "#" else _COMPONENT_SAFE)
    return urllib.parse.quote(_template_scalar(value), safe=safe)


def _template_specs(expr: str) -> list[tuple[str, bool, int | None]]:
    """Each variable in an expression: its name, whether it is exploded (*),
    and the most characters a prefix modifier (:N, 1 to 9999) lets through."""
    specs = []
    for part in expr.split(","):
        explode = "*" in part
        name, _, prefix = part.split("*", 1)[0].partition(":")
        limit = int(prefix) if prefix.isascii() and prefix.isdigit() and len(prefix) <= 4 and int(prefix) > 0 else None
        specs.append((name, explode, limit))
    return specs


def _prefixed(value: Any, limit: int | None) -> Any:
    """A string value cut to its first `limit` characters (not bytes), as RFC
    6570's prefix modifier asks; a list or a map is left whole."""
    if limit is None or isinstance(value, (dict, list)):
        return value
    return _template_scalar(value)[:limit]


def _form_parts(name: str, explode: bool, value: Any, enc_op: str) -> list[str]:
    if isinstance(value, dict):
        pairs = [(key, item) for key, item in value.items() if _template_defined(item)]
        if explode:
            return [f"{_template_encode(key, enc_op)}={_template_encode(item, enc_op)}" for key, item in pairs]
        flat = [piece for key, item in pairs for piece in (_template_encode(key, enc_op), _template_encode(item, enc_op))]
        return [f"{name}={','.join(flat)}"]
    items = value if isinstance(value, list) else [value]
    encoded = [_template_encode(item, enc_op) for item in items if item is not None and item != ""]
    if explode:
        return [f"{name}={item}" for item in encoded]
    return [f"{name}={','.join(encoded)}"]


def _path_value(explode: bool, value: Any, op: str, enc_op: str) -> str:
    if isinstance(value, dict):
        pairs = [(key, item) for key, item in value.items() if _template_defined(item)]
        rendered = [
            _template_encode(key, enc_op) + ("=" if explode else ",") + _template_encode(item, enc_op)
            for key, item in pairs
        ]
        if explode and op == "/":
            return "/".join(rendered)
        if explode and op == ".":
            return ".".join(rendered)
        return ",".join(rendered)
    items = value if isinstance(value, list) else [value]
    encoded = [_template_encode(item, enc_op) for item in items if item is not None and item != ""]
    if explode and op == "/":
        return "/".join(encoded)
    if explode and op == ".":
        return ".".join(encoded)
    return ",".join(encoded)


def _expand_expr(expr: str, values: dict[str, Any]) -> str:
    op = ""
    if expr and expr[0] in "+#./;?&":
        op, expr = expr[0], expr[1:]
    specs = [(name, explode, limit) for name, explode, limit in _template_specs(expr) if _template_defined(values.get(name))]
    if not specs:
        return ""
    enc_op = op if op in {"+", "#"} else ""
    if op in {"?", "&", ";"}:
        parts: list[str] = []
        for name, explode, limit in specs:
            parts.extend(_form_parts(name, explode, _prefixed(values[name], limit), enc_op))
        if op == ";":
            return "".join(f";{part}" for part in parts)
        return ("&" if op == "&" else "?") + "&".join(parts)
    rendered = [_path_value(explode, _prefixed(values[name], limit), op, enc_op) for name, explode, limit in specs]
    if op == "/":
        return "/" + "/".join(rendered)
    if op == ".":
        return "." + ".".join(rendered)
    if op == "#":
        return "#" + ",".join(rendered)
    return ",".join(rendered)


def expand_uri_template(template: str, values: dict[str, Any]) -> str:
    return re.sub(r"\{([^{}]+)\}", lambda match: _expand_expr(match.group(1), values), template)


def _template_variables(template: str) -> set[str]:
    used: set[str] = set()
    for match in re.finditer(r"\{[+#./;?&]?([^{}]+)\}", template):
        used.update(part.split("*", 1)[0].split(":", 1)[0] for part in match.group(1).split(","))
    return used


# XSD datatypes whose values are numbers, by their name in the XSD namespace. A bound
# a type implies, such as unsignedByte's 0 to 255, is left to the server, as xsd:int's was.
_XSD_INTEGERS = frozenset({
    "integer", "int", "long", "short", "byte", "nonNegativeInteger", "positiveInteger",
    "negativeInteger", "nonPositiveInteger", "unsignedLong", "unsignedInt", "unsignedShort", "unsignedByte",
})
_XSD_DOUBLES = frozenset({"double", "float"})
# A number as JSON can carry one: a sign, digits with an optional fraction and an
# optional exponent. NaN, inf, hex, digit separators ("1_000", which int() and
# float() accept) and trailing text are not numbers here. Each pattern matches an
# input in one way only, so a long remote default costs linear time.
_DECIMAL_LEXICAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_INTEGER_LEXICAL = re.compile(r"[+-]?[0-9]+")
# The spaces a number may have around it. The page strips the same four, so the
# two clients read every input alike; str.strip() would also take U+001C to
# U+001F, U+0085 and others that the page's String.prototype.trim leaves.
_SPACES = " \t\r\n"


def _numeric_kind(fld: Field) -> str | None:
    """"integer", "decimal" or "double" (for double and float), or None for a
    field that does not hold a number."""
    if fld.json_kind:
        return None
    local = _xsd_name(fld.datatype)
    if local is None:
        return None
    if local in _XSD_INTEGERS:
        return "integer"
    if local == "decimal":
        return "decimal"
    if local in _XSD_DOUBLES:
        return "double"
    return None


def _lexical_number(value: Any) -> int | float | None:
    """The finite number a value or a remote bound writes, or None when it writes none."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if not isinstance(value, str) or not _DECIMAL_LEXICAL.fullmatch(value.strip(_SPACES)):
        return None
    number = float(value.strip(_SPACES))
    return number if math.isfinite(number) else None


def _decimal_key(text: str) -> str:
    """The decimal a numeral writes, as its significant digits and the power of
    ten of the last one: "2.50", "25e-1" and "+2.5" all give "25e-1", and every
    zero gives "0". The text has matched _DECIMAL_LEXICAL. An exponent of more
    than 15 digits puts a nonzero value past any double (and can be past what
    int() reads), so it gives a key that no double's text gives. The page's
    decimalKey is the same."""
    negative = text.startswith("-")
    mantissa, _, exponent = text.lstrip("+-").lower().partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    significant = digits.lstrip("0").rstrip("0")
    if not significant:
        return "0"
    exp_digits = exponent.lstrip("+-").lstrip("0") or "0"
    if len(exp_digits) > 15:
        return "out of range"
    scale = -int(exp_digits) if exponent.startswith("-") else int(exp_digits)
    trailing = len(digits.rstrip("0"))
    power = scale - len(fraction) + (len(digits) - trailing)
    return ("-" if negative else "") + significant + "e" + str(power)


def _coerce_number(kind: str, value: Any) -> int | float:
    """A number field's value is the number its text writes, or a ValueError,
    never NaN or inf. An integer is sent exactly, at any length int() reads. A
    decimal is sent as a float, so one whose float's shortest text, which is
    what json.dumps sends, writes another decimal is refused. A double or float
    is the double nearest its text, which is the value XSD gives that text."""
    text = str(value).strip(_SPACES)
    if kind == "integer":
        if not _INTEGER_LEXICAL.fullmatch(text):
            raise ValueError("not an integer")
        try:
            return int(text)
        except ValueError as exc:  # more digits than int() reads (sys.get_int_max_str_digits)
            raise ValueError("integer too long") from exc
    if not _DECIMAL_LEXICAL.fullmatch(text):
        raise ValueError("not a number")
    number = float(text)
    if not math.isfinite(number):
        raise ValueError("not a finite number")
    if kind == "decimal" and _decimal_key(text) != _decimal_key(repr(number)):
        raise ValueError("decimal cannot be sent exactly")
    # A whole number is sent as JavaScript sends it, 2 and not 2.0, in a URL and in JSON alike.
    return int(number) if number.is_integer() and abs(number) < 1e21 else number


def _enum_has_number(fld: Field, kind: str, number: int | float) -> bool:
    """A number field's value is in its enum when an entry, read as a number of
    the field's type, is the same number: "1.0"^^xsd:decimal admits 1, and "+1"
    admits 1 in a long field. An entry that reads as no such number admits
    nothing. The page compares the same way."""
    for entry in fld.enum:
        if isinstance(entry, bool) or not isinstance(entry, (int, float, str)):
            continue
        try:
            if isinstance(entry, float) and entry.is_integer() and abs(entry) < 1e21:
                # The page reads JSON 2.0 as the number 2 and writes it "2", so it is an integer there too.
                text = str(int(entry))
            else:
                text = entry if isinstance(entry, str) else str(entry)
            if _coerce_number(kind, text) == number:
                return True
        except ValueError:
            continue
    return False


def coerce_value(fld: Field, value: Any) -> Any:
    if value is None or value == "":
        return None
    if fld.json_kind:
        parsed = value
        if not isinstance(value, (dict, list)):
            try:
                parsed = json.loads(str(value))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{fld.name} must be JSON") from exc
        if fld.json_kind == "object" and not isinstance(parsed, dict):
            raise ValueError(f"{fld.name} must be a JSON object")
        if fld.json_kind == "array" and not isinstance(parsed, list):
            raise ValueError(f"{fld.name} must be a JSON array")
        return parsed
    numeric = _numeric_kind(fld)
    if numeric:
        return _coerce_number(numeric, value)
    if _xsd_name(fld.datatype) == "boolean":
        text = str(value).strip().lower()
        if text in {"true", "1", "yes"}:
            return True
        if text in {"false", "0", "no"}:
            return False
        raise ValueError(f"{fld.name} must be a boolean")
    return value


def _scalar_text(value: Any) -> str:
    """A typed value as text, as the page's String() writes it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return _js_number_text(value)
    return "" if value is None else str(value)


def _multi_items(value: Any) -> list[Any]:
    """A list field's values: a list as given (a repeated --field, or the
    defaults), or text, read as a JSON array when it is one and otherwise as one
    value per line, with blank values and lines dropped. The page's multiItems
    is the same."""
    def kept(item: Any) -> bool:
        return item is not None and not (isinstance(item, str) and not item.strip(_SPACES))
    if isinstance(value, list):
        return [item for item in value if kept(item)]
    text = str(value)
    if text.strip(_SPACES).startswith("["):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list):
            return [item for item in parsed if kept(item)]
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return [line for line in lines if line.strip(_SPACES)]


def _check_value(fld: Field, found: Any, numeric: str | None, errors: list[str]) -> Any:
    """One value of a field, typed and checked; each problem goes in `errors`
    once. Returns the value to send."""
    def report(message: str) -> None:
        if message not in errors:
            errors.append(message)
    if numeric and isinstance(found, str):
        found = found.strip(_SPACES)
    try:
        typed = coerce_value(fld, found)
    except (TypeError, ValueError) as exc:
        report(f"{fld.name}: {exc}")
        return None
    structured = isinstance(typed, (dict, list))
    text = typed if isinstance(typed, str) else _scalar_text(typed)
    if not structured and fld.min_length is not None and len(text) < fld.min_length:
        report(f"{fld.name}: shorter than minLength {fld.min_length}")
    if not structured and fld.max_length is not None and len(text) > fld.max_length:
        report(f"{fld.name}: longer than maxLength {fld.max_length}")
    # A field's pattern is reported by `describe` and never run: a remote
    # regular expression can take time exponential in the input, and the
    # server that receives the value is the one that enforces it.
    allowed = [_text(x) for x in fld.enum if x is not None]
    if not structured and allowed:
        if numeric and isinstance(typed, (int, float)) and not isinstance(typed, bool):
            listed = _enum_has_number(fld, numeric, typed)
        else:
            # Each entry's JSON text, as the page offers it: true, not Python's True.
            listed = text in allowed
        if not listed:
            report(f"{fld.name}: must be one of {', '.join(allowed)}")
    # A numeric bound needs a number to compare: a value that is none is an
    # error, not a pass. A bound that is not a number, such as a date, is the
    # server's to check.
    low = None if structured else _lexical_number(fld.min_inclusive)
    high = None if structured else _lexical_number(fld.max_inclusive)
    if low is not None or high is not None:
        number = _lexical_number(typed)
        if number is None:
            report(f"{fld.name}: not a number")
        else:
            if low is not None and number < low:
                report(f"{fld.name}: below minInclusive {_scalar_text(fld.min_inclusive)}")
            if high is not None and number > high:
                report(f"{fld.name}: above maxInclusive {_scalar_text(fld.max_inclusive)}")
    # A JSON request body is sent as it was written, once it parses.
    return found if fld.raw_body and fld.json_kind and isinstance(found, str) else typed


def validate_fields(control: Control, supplied: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The values to send, each typed by its field, and every problem with
    them. A name that is no field's is a problem, not something silently
    dropped; a list field takes several values (a repeated --field, a JSON
    array, or one per line) and is checked against its sh:minCount and
    sh:maxCount, and a field that takes one value takes the last given. The
    page's validateFields is the same."""
    if control.problem:
        return {}, [control.problem]
    errors: list[str] = []
    values: dict[str, Any] = {}
    incoming = dict(supplied)
    known: set[str] = set()
    for fld in control.fields:
        aliases = list(dict.fromkeys(a for a in (fld.name, fld.variable, local_name(fld.path) if fld.path else None) if a))
        known.update(aliases)
        found = None
        for alias in aliases:
            if alias in incoming and incoming[alias] is not None and incoming[alias] != "":
                found = incoming.pop(alias)
                break
        numeric = _numeric_kind(fld)
        required = fld.required or (fld.min_count or 0) >= 1
        if fld.multi:
            items = _multi_items(found) if found is not None else []
            if not items and fld.default is not None:
                items = _multi_items(fld.default if isinstance(fld.default, list) else [fld.default])
            if not items:
                if required:
                    errors.append(f"missing required field '{fld.name}'")
                continue
            if fld.min_count and len(items) < fld.min_count:
                errors.append(f"{fld.name}: needs at least {fld.min_count} values, got {len(items)}")
            if fld.max_count is not None and len(items) > fld.max_count:
                errors.append(f"{fld.name}: takes at most {fld.max_count} values, got {len(items)}")
            typed_items = []
            for item in items:
                if isinstance(item, (dict, list)):
                    message = f"{fld.name}: each value is one {local_name(fld.datatype) or 'text'} value, not JSON"
                    if message not in errors:
                        errors.append(message)
                    continue
                typed_items.append(_check_value(fld, item if isinstance(item, str) else _scalar_text(item), numeric, errors))
            values[fld.name] = typed_items
            continue
        if isinstance(found, list):
            # A field that takes one value takes the last one given, as a repeated option does.
            found = found[-1] if found else None
        # Spaces around a number are not part of it, so a number field holding only spaces is empty.
        if numeric and isinstance(found, str):
            found = found.strip(_SPACES)
        if (found is None or found == "") and fld.default is not None:
            found = fld.default.strip(_SPACES) if numeric and isinstance(fld.default, str) else fld.default
        if found is None or found == "":
            if required:
                errors.append(f"missing required field '{fld.name}'")
            continue
        before = len(errors)
        value = _check_value(fld, found, numeric, errors)
        if len(errors) == before:
            values[fld.name] = value
    for name in incoming:
        if name not in known:
            errors.append(f"no input field is named {name!r}")
    return values, errors


def is_junction_target(target: str | None, descriptor_url: str, control_id: str, base: str | None = None) -> bool:
    """An action junction names a control in the document, not an address to
    send to: a bare "#fragment" (a HyperMarkdown block may write one), the
    control's own IRI, or the document's own IRI with any fragment, such as
    "<document>#control-search", which is how HyperMarkdown projects each
    control. In JSON-LD a target "#fragment" is that IRI once resolved (RFC
    3986, 4.4: a same-document reference), so the two are one junction. The
    document is the one at the descriptor's address or at the base its IRIs
    resolved against. A fragment is never sent, so a request to such a target
    would only reach the descriptor again. The page's isJunction is the same."""
    if not target:
        return False
    if target.startswith("#") or target == control_id:
        return True
    if "#" not in target:
        return False
    try:
        doc = _strip_fragment(target)
        return any(b and _strip_fragment(b) == doc for b in (descriptor_url, base))
    except ValueError:
        return False


def is_mcp_tool_url(target: str | None) -> bool:
    if not target:
        return False
    parts = urllib.parse.urlsplit(target)
    host = (parts.hostname or "").lower()
    return (parts.path or "").startswith("/tool/") and "interego" in host


def classify_transport(control: Control, descriptor_url: str) -> str:
    if control.template:
        # Before expansion, only what precedes the first variable is known: it
        # resolves against the base, as the expanded address will.
        head = control.template.split("{", 1)[0]
        return "http" if not head or is_web_url(_resolve_iri(head, control.base)) else "unknown"
    if is_mcp_tool_url(control.target):
        return "mcp"
    if is_junction_target(control.target, descriptor_url, control.id, control.base):
        return "junction"
    if is_web_url(control.target):
        return "http"
    if control.rel:
        return "mcp"
    return "unknown"


def _form_quote(text: str, safe: str = "", encoding: str | None = None, errors: str | None = None) -> str:
    """A query name or value as a browser's URLSearchParams writes it
    (application/x-www-form-urlencoded): letters, digits and "*-._" as they
    are, a space as "+", and every other byte of its UTF-8 percent-encoded,
    "~" included."""
    return urllib.parse.quote_plus(text, safe="*", encoding=encoding, errors=errors).replace("~", "%7E")


def add_query_params(url: str, params: dict[str, Any]) -> str:
    """Fields as query parameters. A parameter the address already carries
    under a field's name is replaced, not added to, and the query is written
    as the page's addQuery has URLSearchParams write it, byte for byte. A URL
    with no field to add is returned as it is."""
    keys = [key for key, val in params.items() if val is not None and val != ""]
    if not keys:
        return url
    parts = urllib.parse.urlsplit(url)
    pairs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    keep = [(key, val) for key, val in pairs if key not in keys]
    for key in keys:
        val = params[key]
        if isinstance(val, list):
            for item in val:
                if item is not None and item != "":
                    keep.append((key, _template_scalar(item)))
        elif isinstance(val, dict):
            keep.append((key, json.dumps(val, ensure_ascii=False, separators=(",", ":"))))
        else:
            keep.append((key, _template_scalar(val)))
    query = urllib.parse.urlencode(keep, quote_via=_form_quote)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def _raw_content_type(fld: Field) -> str:
    """The type of a body sent whole from one field: JSON for rdf:JSON, a
    SPARQL query for the field a shape labels a query, and plain text
    otherwise. The control's media type is what it returns, so it goes in
    Accept, never here."""
    if fld.json_kind:
        return "application/json"
    return "application/sparql-query" if fld.name == "query" else "text/plain"


def resolve_plan(control: Control, values: dict[str, Any], descriptor_url: str) -> RequestPlan:
    notes: list[str] = []
    transport = classify_transport(control, descriptor_url)
    method = control.method or "POST"
    safe = method in SAFE_METHODS
    headers = {"User-Agent": USER_AGENT, "Accept": control.media_type or "*/*"}
    body: Any = None
    body_text: str | None = None
    url: str | None = None
    raw_body_field = next((f for f in control.fields if f.raw_body), None)
    raw_text: str | None = None
    if raw_body_field and values.get(raw_body_field.name) is not None:
        raw_value = values[raw_body_field.name]
        raw_text = raw_value if isinstance(raw_value, str) else json.dumps(raw_value, ensure_ascii=False, separators=(",", ":"))
    # A safe method sends no body: every field goes in the address, a field
    # that is the whole body as a parameter named after it, as SPARQL's
    # protocol sends ?query=.
    params = dict(values)
    if raw_body_field and raw_text is not None:
        params[raw_body_field.name] = raw_text
    if control.warning:
        notes.append(control.warning)

    if control.template:
        url = _resolve_iri(expand_uri_template(control.template, values), control.base)
        transport = "http" if is_web_url(url) else "unknown"
        notes.append(f"Expanded hydra:IriTemplate {control.template}")
        if transport != "http":
            notes.append("The template does not expand to an http or https URL; hmc.py does not fetch it.")
        else:
            # Checked and written as it will be sent before parameters are added, so
            # adding them cannot turn an address that would be refused into one that is not.
            url = _request_url(url)
        used = _template_variables(control.template)
        leftover = {k: v for k, v in params.items() if k not in used}
        if leftover and safe and transport == "http":
            url = add_query_params(url, leftover)
    elif transport == "http" and control.target:
        url = _request_url(control.target)
        if safe and params:
            url = add_query_params(url, params)
            notes.append("Appended fields as query parameters on hydra:target")
        elif not safe and not raw_body_field:
            body = values
            body_text = json.dumps(values, indent=2, ensure_ascii=False)
            headers["Content-Type"] = "application/json"
    elif transport == "mcp":
        notes.append("hydra:target is an Interego tool junction (or missing). Plain HTTP will not reach it; use the Interego relay MCP.")
    elif transport == "junction":
        notes.append("Target is this document's action junction, not a transport URL. Re-fetch the authority JSON-LD/Turtle for the live hydra:target, or call invoke_affordance(descriptorUrl, rel).")

    mcp = None
    if transport in {"mcp", "junction"} or is_mcp_tool_url(control.target):
        mcp = {
            "tool": "invoke_affordance",
            "alternative": "act",
            "arguments": {"descriptor_url": descriptor_url, "action_iri": control.rel, "payload": values or {}},
            "act_arguments": {"descriptor_url": descriptor_url, "action_iri": control.rel, "method": method, "payload": values or {}},
            "declared_target": control.target,
        }
        transport = "mcp"
    if url and not safe:
        if raw_body_field:
            if raw_text is not None:
                body = body_text = raw_text
                headers["Content-Type"] = _raw_content_type(raw_body_field)
        elif body is None and values:
            body = values
            body_text = json.dumps(values, indent=2, ensure_ascii=False)
            headers.setdefault("Content-Type", "application/json")
    # An address that is sent is shown exactly as it is sent; one that is not
    # (a template that does not give http or https) in its URI form.
    if url:
        url = _request_url(url) if is_web_url(url) else _iri_to_uri(url)
    return RequestPlan(control=control, transport=transport, method=method, url=url,
                       headers=headers, body=body, body_text=body_text, fields=values,
                       mcp=mcp, notes=notes)


def invoke_plan(plan: RequestPlan, *, confirm: bool = False, dry_run: bool | None = None) -> dict[str, Any]:
    unsafe = plan.control.unsafe
    if dry_run is None:
        dry_run = unsafe and not confirm
    result: dict[str, Any] = {"dryRun": dry_run, "unsafe": unsafe, "request": plan.to_public()}
    if dry_run:
        result["message"] = "Dry run. Unsafe operations default to showing the exact request without sending it. Pass --confirm to execute."
        return result
    if unsafe and not confirm:
        raise RuntimeError("Refusing to execute an unsafe operation without --confirm")
    if plan.url:
        _require_web_url(plan.url)
    if plan.transport != "http" or not plan.url:
        result["message"] = "No plain-HTTP transport is available for this control. Use the Interego relay MCP call documented in request.mcp."
        result["blocked"] = "mcp-required"
        return result
    data = None
    if plan.method not in SAFE_METHODS:
        if plan.body_text is not None:
            data = plan.body_text.encode("utf-8")
        elif plan.body is not None and not isinstance(plan.body, (str, bytes)):
            data = json.dumps(plan.body).encode("utf-8")
    status, headers, body, _ = http_request(plan.url, method=plan.method, headers=plan.headers, data=data)
    content_type = headers.get("content-type", "")
    text = body.decode("utf-8", errors="replace")
    parsed = None
    if "json" in content_type or text.lstrip()[:1] in "{[":
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
    result["response"] = {"status": status, "headers": headers, "contentType": content_type,
                          "bodyText": text, "body": parsed, "url": plan.url}
    return result



# Remote text printed to a terminal could carry control sequences that set the
# window title, recolour or erase what is on screen, or write the clipboard.
# Every C0 and C1 control character except newline and tab, and DEL, is shown
# as a visible \xNN escape instead. --json output needs none of this: JSON
# escapes every control character.
_TERMINAL_CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def tty_safe(text: Any) -> str:
    return _TERMINAL_CONTROLS.sub(lambda m: "\\x%02x" % ord(m.group()), str(text))


def say(text: Any = "", file: Any = None) -> None:
    """print() for anything that may hold remote text, in text mode."""
    print(tty_safe(text), file=file or sys.stdout)


def print_control_table(descriptor: Descriptor) -> None:
    say(descriptor.title)
    say(descriptor.url)
    if descriptor.types:
        say("types: " + ", ".join(local_name(t) or t for t in descriptor.types))
    if descriptor.description:
        say(textwrap.fill(descriptor.description, 100))
    say()
    safe = [c for c in descriptor.controls if not c.unsafe]
    unsafe = [c for c in descriptor.controls if c.unsafe]
    # The names of a field list several controls share are written once.
    names_of: dict[int, tuple[list[Field], str]] = {}
    for label, group in (("Safe (GET / read)", safe), ("Unsafe (writes and non-GET)", unsafe)):
        say(f"== {label} ({len(group)}) ==")
        if not group:
            say("  (none)\n")
            continue
        for control in group:
            transport = classify_transport(control, descriptor.url)
            target = control.template or control.target or ""
            say(f"  {control.method:<6} {short_rel(control.rel):<42} {transport:<8} {control.title}")
            say(f"         rel: {control.rel}")
            if target:
                say(f"         target: {target}")
            if control.media_type:
                say(f"         media: {control.media_type}")
            fields = control.fields
            if fields:
                # * marks a required field, [] one that takes a list of values.
                hit = names_of.get(id(fields))
                if hit is None or hit[0] is not fields:
                    hit = names_of[id(fields)] = (fields, ", ".join(
                        ("*" if f.required or (f.min_count or 0) >= 1 else "") + f.name + ("[]" if f.multi else "") for f in fields))
                say(f"         fields: {hit[1]}")
            for note in (control.problem, control.warning):
                if note:
                    say(f"         note: {note}")
        say()


def parse_field_args(items: list[str]) -> dict[str, Any]:
    """--field k=v pairs. A name given more than once is a list of values,
    which a list field takes whole; any other field takes the last one."""
    values: dict[str, Any] = {}
    for item in items:
        if "=" not in item:
            raise SystemExit(tty_safe(f"--field expects k=v, got {item!r}"))
        key, val = item.split("=", 1)
        if key in values:
            current = values[key]
            values[key] = (current if isinstance(current, list) else [current]) + [val]
        else:
            values[key] = val
    return values


def cmd_list(args: argparse.Namespace) -> int:
    descriptor = load_descriptor(args.url)
    if args.json:
        print(json.dumps(descriptor.to_public(), indent=2))
    else:
        print_control_table(descriptor)
    return 0


def cmd_describe(args: argparse.Namespace) -> int:
    descriptor = load_descriptor(args.url)
    control = descriptor.find(args.rel)
    if not control:
        known = ", ".join(short_rel(c.rel) for c in descriptor.controls[:20])
        raise SystemExit(tty_safe(f"No control matching {args.rel!r}. Known (sample): {known}"))
    public = control.to_public()
    public["transport"] = classify_transport(control, descriptor.url)
    print(json.dumps(public, indent=2))
    return 0


def cmd_invoke(args: argparse.Namespace) -> int:
    descriptor = load_descriptor(args.url)
    control = descriptor.find(args.rel)
    if not control:
        known = ", ".join(short_rel(c.rel) for c in descriptor.controls[:20])
        raise SystemExit(tty_safe(f"No control matching {args.rel!r}. Known (sample): {known}"))
    supplied = parse_field_args(args.field or [])
    values, errors = validate_fields(control, supplied)
    if errors:
        say("Validation failed:", file=sys.stderr)
        for err in errors:
            say("  - " + err, file=sys.stderr)
        return 2
    plan = resolve_plan(control, values, descriptor.url)
    result = invoke_plan(plan, confirm=args.confirm, dry_run=True if args.dry_run else None)
    if args.json:
        print(json.dumps(result, indent=2))
        return 0
    req = result["request"]
    say(f"{req['method']} {req.get('url') or '(no HTTP URL)'}")
    say(f"transport: {req['transport']}")
    for note in req.get("notes") or []:
        say(f"note: {note}")
    if req.get("mcp"):
        say("mcp:")
        say(textwrap.indent(json.dumps(req["mcp"], indent=2), "  "))
    if req.get("bodyText"):
        say("body:")
        say(textwrap.indent(str(req["bodyText"]), "  "))
    if result.get("dryRun"):
        say(result.get("message", "Dry run."))
        return 0
    if result.get("blocked"):
        say(result.get("message"))
        return 3
    resp = result.get("response") or {}
    say(f"HTTP {resp.get('status')}  {resp.get('contentType')}")
    body = resp.get("body")
    text = resp.get("bodyText") or ""
    if isinstance(body, (dict, list)):
        pretty = json.dumps(body, indent=2)
        say(pretty if len(pretty) < 8000 else pretty[:8000] + "\n…")
    else:
        say(text if len(text) < 8000 else text[:8000] + "\n…")
    return 0 if (resp.get("status") or 500) < 400 else 4


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hmc",
        description="Generic hypermedia client for Interego / HyperMarkdown / Hydra descriptors.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_list = sub.add_parser("list", help="Fetch a descriptor and list its controls")
    p_list.add_argument("url")
    p_list.add_argument("--json", action="store_true")
    p_list.set_defaults(func=cmd_list)
    p_desc = sub.add_parser("describe", help="Show one control, its fields, and how its target resolves")
    p_desc.add_argument("url")
    p_desc.add_argument("rel", help="Full action IRI, or the short name after # / :")
    p_desc.set_defaults(func=cmd_describe)
    p_inv = sub.add_parser("invoke", help="Resolve a control and call it (unsafe ops dry-run by default)")
    p_inv.add_argument("url")
    p_inv.add_argument("rel")
    p_inv.add_argument("--field", action="append", default=[], metavar="K=V")
    p_inv.add_argument("--confirm", action="store_true", help="Really send an unsafe (non-GET / write) request")
    p_inv.add_argument("--dry-run", action="store_true", help="Show the request without sending it")
    p_inv.add_argument("--json", action="store_true")
    p_inv.set_defaults(func=cmd_invoke)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001
        say(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
