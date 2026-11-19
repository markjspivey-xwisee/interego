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
import contextlib
import copy
import encodings.idna as _idna_codec
import heapq
import http.client
import ipaddress
import json
import math
import re
import struct
import sys
import textwrap
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator, Sequence
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
P_SH_HASVALUE = SHACL + "hasValue"
P_SH_MINE = SHACL + "minExclusive"
P_SH_MAXE = SHACL + "maxExclusive"
P_WRITABLE = HYDRA + "writable"
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
# The properties whose values the reader takes as members: operations and the
# classes that hold them, a shape's properties, a class's supported properties
# and a template's mappings. A @list or a graph object there holds members.
MEMBERS = HARVESTED | {SHACL + "property", HYDRA + "supportedProperty", HYDRA + "mapping"}

# What a document that uses a JSON-LD structure this reader does not read is
# refused with. The page's REFUSED is the same.
REFUSED = {
    "graph": "This document holds a @graph inside a node, which this client does not read, so it is not read.",
    "included": "This document holds @included inside a node that is not at its top or in a @graph, which this client "
                "does not read, so it is not read.",
    "reverse": "This document uses @reverse, which this client does not read, so it is not read.",
    "set": "This document has a @set object with a key other than @set and @index, which JSON-LD does not allow, so it is "
           "not read.",
    "set-in-list": "This document has a @set object inside a @list or with a @context of its own, which this client does not "
                   "read, so it is not read.",
    "import": "This document's @context uses @import, which this client does not fetch, so it is not read.",
}


def _colliding(keyword: str) -> ValueError:
    return ValueError(f"This document gives one node {keyword} twice, which JSON-LD does not allow, so it is not read.")


def _nested_keyword(keyword: str) -> ValueError:
    return ValueError(f"This document puts {keyword} inside a @nest object, which this client does not read, so it is not read.")


class _RepeatedKey(ValueError):
    """An object that gives one key twice; `key` is the key."""

    def __init__(self, key: str) -> None:
        super().__init__(f'This document repeats the key "{key}" in one object, so which value it means is not known, and it is '
                         "not read.")
        self.key = key


def _repeated_key(key: str) -> ValueError:
    return _RepeatedKey(key)


def _not_json(constant: str) -> Any:
    """json.loads' parse_constant: NaN and Infinity are not JSON, and the
    page's JSON.parse refuses them, so this does too."""
    raise ValueError(f"This document writes {constant}, which is not JSON, so it is not read.")


def _json_int(digits: str) -> int | float:
    """json.loads' parse_int: a JSON integer as the page's JSON.parse reads it.
    One a double holds exactly as an integer, at most 2^53 - 1 in size, is
    that int; any other is the double nearest it, as JSON.parse gives, and an
    infinity past the largest double (one that holds it is not sent; see
    _past_double). So both clients see one number, with one text, one length
    and one order: 2^53 + 1 is 2^53, and 31 digits are 1e+30. An integer
    field's own text is not JSON, and is read as written, and refused past
    2^53 - 1 as the page refuses it; see _coerce_number."""
    if len(digits) <= 17:
        number = int(digits)
        if abs(number) <= _MAX_SAFE_INTEGER:
            return number
    return float(digits)


# JSON nested deeper than _JSON_DEPTH arrays and objects is not read, whether a
# document, a value given or a response: json.loads would run out of call stack
# where the page's JSON.parse does not, and a request body's indentation grows
# with depth, so each client refuses it alike before it is parsed. The scan
# skips strings by their escapes and counts brackets, so it is linear. The
# page's JSON_DEPTH, jsonTooDeep and parseJson are the same.
_JSON_DEPTH = 256
_JSON_TOKEN = re.compile(r'"(?:[^"\\]+|\\.)*"?|[\[\]{}]', re.DOTALL)
# What a value nested past _JSON_DEPTH is refused with, after the field's name.
_DEEP_VALUE = f": nests JSON deeper than {_JSON_DEPTH} levels, which this client does not read, so it is not sent"


class _TooDeep(ValueError):
    """JSON nested past _JSON_DEPTH, refused before it is parsed."""

    def __init__(self) -> None:
        super().__init__(f"This document nests JSON deeper than {_JSON_DEPTH} levels, which this client does not read, so it is not "
                         "read.")


def _json_too_deep(text: str) -> bool:
    depth = 0
    for match in _JSON_TOKEN.finditer(text):
        token = match.group()
        if token[0] == '"':
            continue
        if token in "[{":
            depth += 1
            if depth > _JSON_DEPTH:
                return True
        else:
            depth -= 1
    return False


def _page_json(text: str) -> Any:
    """JSON as the page's JSON.parse reads it: NaN and Infinity refused (a
    ValueError), and a repeated key taking its last value. For what is only
    looked at, never sent: whether a payload is JSON, and a response. JSON
    nested past _JSON_DEPTH is refused first (_TooDeep)."""
    if _json_too_deep(text):
        raise _TooDeep()
    return json.loads(text, parse_constant=_not_json, parse_int=_json_int)


def _past_double(value: Any, *, integers: bool = True) -> bool:
    """Whether a value holds a number no double holds: NaN, an infinity (JSON's
    1e400, or an integer past the largest double, reads as one in both
    clients) or, with `integers`, a Python int past the largest double, which
    only a library caller can give. A walk with a stack, so a deep value costs
    no recursion. The page's tooLarge is the same."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, float):
            if not math.isfinite(item):
                return True
        elif isinstance(item, int) and not isinstance(item, bool):
            if integers:
                try:
                    float(item)
                except OverflowError:
                    return True
        elif isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return False


class UnsendableValue(ValueError):
    """A request that would carry NaN or an infinity, which json.dumps writes
    as NaN or Infinity, text that is not JSON. validate_fields refuses such a
    value first; this stops one given to resolve_plan or invoke_plan unchecked.
    cmd_invoke reports it as a validation failure, and nothing is sent."""


def _request_json(value: Any, indent: int | None = None) -> str:
    """JSON text that goes into a request, as its body or in its address,
    written as the page's JSON.stringify writes it (see _js_json), byte for
    byte. A non-finite number raises UnsendableValue instead of being written
    as null, or as text that is not JSON."""
    if _past_double(value, integers=False):
        raise UnsendableValue("a value holds NaN or an infinity, which is not JSON, so nothing is sent")
    return _js_json(value, indent)


def _finite_copy(value: Any) -> Any:
    """A copy of a value with each NaN or infinity as None, which is how
    JSON.stringify writes them. Built with a stack, so a value as deep as
    json.loads reads costs no recursion."""
    def fresh(item: Any) -> Any:
        if isinstance(item, float) and not math.isfinite(item):
            return None
        return {} if isinstance(item, dict) else [] if isinstance(item, list) else item
    root = fresh(value)
    stack = [(value, root)] if isinstance(value, (dict, list)) else []
    while stack:
        source, target = stack.pop()
        for key, item in (source.items() if isinstance(source, dict) else enumerate(source)):
            made = fresh(item)
            if isinstance(target, dict):
                target[key] = made
            else:
                target.append(made)
            if isinstance(item, (dict, list)):
                stack.append((item, made))
    return root


def _json_out(value: Any, indent: int | None = 2) -> str:
    """What --json, list --json and describe print, and text mode's mcp:
    block: JSON, always, every character past ASCII escaped (_json_written
    chooses the indent). A remote 1e400 reads as an infinity, which json.dumps
    would write as Infinity; it is written null, as the page's JSON.stringify
    writes it. A response shown as JSON in text mode is written as the page
    shows it (_json_shown)."""
    try:
        return json.dumps(value, indent=indent, allow_nan=False)
    except ValueError:
        return json.dumps(_finite_copy(value), indent=indent)


def _no_repeated_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """json.loads' object_pairs_hook: an object, or a refusal when it repeats a
    key. JSON leaves a repeated key's meaning open; a reader that took its last
    value would read a method the document also says is something else. The
    page's repeatedKey finds the same key: the first repeated in the object
    that closes first."""
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise _repeated_key(key)
        out[key] = value
    return out


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


def literals(value: Any) -> list[Any]:
    return [raw_id(v) for v in as_list(value) if raw_id(v) is not None]


# The reader reads the JSON-LD forms it models and fails closed on the rest. A
# property that decides what a control does (its method, target, template,
# hints, action, shape, media type, an input's datatype, counts, lengths, path,
# name, pattern or default) is read with _one: more than one distinct value, or
# a value in a form this reader does not read there (a @list, a JSON literal, a
# node written in place with no @id), is a problem that names it, and the
# control is listed with the writes and not invoked. A label or a description is
# only shown, so the first value it can read is enough (_label).
_VALUE_KEYS = frozenset({"@value", "@type", "@language", "@direction", "@index"})


def _value_of(item: Any) -> tuple[bool, Any]:
    """One JSON-LD value read as a single value: (True, value) for a string,
    number or boolean, a value object's @value when it is one, or a node's
    @id (a reference, or a node written in place with one); (True, None) for
    null; (False, why) for a form this reader does not read as one value. The
    page's valueOf is the same."""
    if item is None or isinstance(item, (str, int, float)):
        return True, item
    if isinstance(item, dict):
        if "@value" in item:
            if item.get("@type") == "@json":
                return False, "a JSON literal (@json)"
            value = item["@value"]
            if any(key not in _VALUE_KEYS for key in item) or not (value is None or isinstance(value, (str, int, float))):
                return False, "a value object this client does not read"
            return True, value
        for keyword in ("@list", "@set", "@graph"):
            if keyword in item:
                return False, f"a JSON-LD {keyword}"
        if isinstance(item.get("@id"), str):
            return True, item["@id"]
        return False, "a node written in place with no @id"
    return False, "a value this client does not read"


def _label(value: Any) -> Any:
    """The first value of a property that is only shown (a title, a label, a
    description) that reads as one value, or None."""
    for item in as_list(value):
        ok, found = _value_of(item)
        if ok and found is not None:
            return found
    return None


def _distinct(value: Any, key: Any = None) -> tuple[list[Any], str | None]:
    """A property's values as _value_of reads them, each distinct one once, in
    the order written (two are the same when `key` gives them one key, their
    text by default), and why the first value that could not be read could
    not, or None."""
    key = key or _text
    found: list[Any] = []
    keys: set[str] = set()
    for item in as_list(value):
        ok, read = _value_of(item)
        if not ok:
            return found, read
        if read is None:
            continue
        k = key(read)
        if k not in keys:
            keys.add(k)
            found.append(read)
    return found, None


def _distinct_read(value: Any, key: Any = None) -> tuple[list[Any], str | None, str | None]:
    """What _distinct reads of a value, and the text a problem names its
    values by when it has more than one: what _one acts on, which a node's
    reading keeps (NodeIndex.distinct_of). The page's distinctRead is the
    same."""
    found, why = _distinct(value, key)
    return found, why, (", ".join(_text(v) for v in found) if len(found) > 1 else None)


def _one(value: Any, label: str, problems: list[str], what: str, subject: str = "this control",
         tail: str = "it is not invoked", key: Any = None) -> Any:
    """The one value of a property the reader acts on, or None when it has
    none. More than one distinct value, or one it cannot read, adds a problem
    that names the property to `problems` (the first value read, if any, is
    still returned, to show). The page's one is the same."""
    return _one_of(_distinct_read(value, key), label, problems, what, subject, tail)


def _one_of(read: tuple[list[Any], str | None, str | None], label: str, problems: list[str], what: str,
            subject: str = "this control", tail: str = "it is not invoked") -> Any:
    """_one of a value already read (_distinct_read). The text of the values a
    problem names is charged as the problem is written (_spend): a node that
    many inputs or mappings name is read once, but each names it in a problem
    of its own. The page's oneOf is the same."""
    found, why, shown = read
    if why is not None:
        problems.append(f"{subject} writes {label} as {why}, which this client does not read, so {what} is not known; {tail}")
    elif len(found) > 1:
        _spend(_utf16_length(shown or ""))
        problems.append(f"{subject} names more than one {label} ({shown}), so {what} is not known; {tail}")
    return found[0] if found else None


def _count_key(value: Any) -> str:
    number = _inty(value)
    return _text(value) if number is None else str(number)


def _truthy_key(value: Any) -> str:
    """Values told apart by their truth, as a flag such as hydra:required is read."""
    return str(truthy(value))


def _count_of(read: tuple[list[Any], str | None, str | None], label: str, problems: list[str], subject: str) -> int | None:
    """A count or length facet of an input: a whole number of zero or more,
    one value of it, read (_distinct_read) by _count_key. One that is no such
    number (a fraction, text that is none, a negative number, which SHACL
    fails every value set against) is a problem, not a facet left out. The
    page's countOf is the same."""
    before = len(problems)
    found = _one_of(read, label, problems, "what it takes", subject, "this control is not invoked")
    if found is None:
        return None
    number = _inty(found)
    if (number is None or number < 0) and len(problems) == before:
        problems.append(f"{subject} names an {label} that is not a whole number ({_text(found)}), so what it takes is not "
                        "known; this control is not invoked")
    return number if number is not None and number >= 0 else None


_XSD_BOOLEAN = XSD + "boolean"


def _hint_value(item: Any) -> tuple[str, Any]:
    """One value of a destructiveHint or readOnlyHint: ("bool", True or False)
    for a JSON boolean, an xsd:boolean literal or a string "true", "false",
    "1" or "0"; ("none", None) for null; ("unread", None) for any other
    string, number or literal, which the reader takes as the unsafe value;
    ("form", why) for a form it does not read as one value. The page's
    hintValue is the same."""
    if item is None:
        return "none", None
    if isinstance(item, bool):
        return "bool", item
    if isinstance(item, dict) and "@value" in item:
        ok, why = _value_of(item)
        if not ok:
            return "form", why
        if item["@value"] is None:
            return "none", None
        kind = item.get("@type")
        if (kind is not None and kind != _XSD_BOOLEAN) or "@language" in item or "@direction" in item:
            return "unread", None
        item = item["@value"]
        if isinstance(item, bool):
            return "bool", item
    elif isinstance(item, dict):
        ok, why = _value_of(item)
        return ("unread", None) if ok else ("form", why)
    if isinstance(item, str):
        text = item.strip(_SPACES)
        if text in ("true", "1"):
            return "bool", True
        if text in ("false", "0"):
            return "bool", False
    return "unread", None


# A key JavaScript keeps as an array index: a whole number written without a
# sign or a leading zero, below 2^32 - 1.
_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]{0,9}")
_SURROGATE = re.compile("[\ud800-\udfff]")


def _js_keys(value: dict[Any, Any]) -> list[Any]:
    """An object's keys in the order JavaScript keeps them, which is the
    order JSON.stringify writes and Object.keys gives: each array index first,
    in numeric order, then the rest in the order written."""
    index = [key for key in value if isinstance(key, str) and _ARRAY_INDEX.fullmatch(key) and int(key) < 2 ** 32 - 1]
    if not index:
        return list(value)
    first = set(index)
    return sorted(index, key=int) + [key for key in value if key not in first]


def _js_string(text: str) -> str:
    """A string as JSON.stringify writes it: as json.dumps does, and each
    unpaired surrogate as a \\u escape (a Python string holds a surrogate only
    unpaired)."""
    out = json.dumps(text, ensure_ascii=False)
    return _SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group()), out) if _SURROGATE.search(out) else out


def _js_members(item: Any, inner: str, colon: str) -> Iterator[tuple[str, Any]]:
    """Each member of an array or object as _js_json writes it, one at a
    time: the text before it (a comma, the line it starts, an object's key),
    and the member."""
    if isinstance(item, dict):
        for at, key in enumerate(_js_keys(item)):
            yield ("," if at else "") + inner + _js_string(str(key)) + colon, item[key]
    else:
        for at, one in enumerate(item):
            yield ("," if at else "") + inner, one


def _js_json(value: Any, indent: int | None = None, named: dict[float, dict[str, str]] | None = None,
             limit: int | None = None) -> str:
    """JSON text as the page's JSON.stringify(value, null, indent) writes it:
    each number as JavaScript writes it (a JSON 1.0 is 1, 1e-7 is 1e-7, -0 is
    0) and NaN or an infinity as null; an object's keys in the order
    JavaScript keeps them (see _js_keys); and with `indent`, each member on a
    line of its own, as json.dumps(indent=) lays it out too. With `named`,
    a number written otherwise than its double is written as its document
    writes it (_named_text). With `limit`, it stops once it has written that
    many characters, so it writes the whole text's start, at least `limit`
    characters of it or all of it, at the cost of what it writes, not of the
    value. Built with a stack, which takes each container's members as it
    writes them, so a value as deep as json.loads reads costs no recursion."""
    pad = " " * indent if indent else ""
    colon = ": " if pad else ":"
    parts: list[str] = []
    written = 0
    # Each entry is (0, text written as it is), (1, a value, its depth), or (2,
    # the members of an array or object yet to be written (_js_members), its depth).
    stack: list[tuple[int, Any, int]] = [(1, value, 0)]
    while stack and (limit is None or written < limit):
        kind, item, depth = stack.pop()
        if kind == 2:
            member = next(item, None)
            if member is None:
                continue
            stack.append((2, item, depth))
            stack.append((1, member[1], depth + 1))
            text = member[0]
        elif kind == 0:
            text = item
        elif item is None:
            text = "null"
        elif isinstance(item, bool):
            text = "true" if item else "false"
        elif isinstance(item, str):
            text = _js_string(item)
        elif named is not None and isinstance(item, (int, float)) and _number_name(item, named) is not None:
            text = str(_number_name(item, named))
        elif isinstance(item, int):
            text = str(item)
        elif isinstance(item, float):
            text = _js_number_text(item) if math.isfinite(item) else "null"
        elif isinstance(item, (dict, list, tuple)):
            opening, closing = ("{", "}") if isinstance(item, dict) else ("[", "]")
            if not item:
                text = opening + closing
            else:
                stack.append((0, ("\n" + pad * depth if pad else "") + closing, depth))
                stack.append((2, _js_members(item, "\n" + pad * (depth + 1) if pad else "", colon), depth))
                text = opening
        else:
            text = _js_string(str(item))
        parts.append(text)
        written += len(text)
    return "".join(parts)


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


_TEXT_PROBLEM = "the address holds a backslash, a space or a control character, which URL parsers read in different ways"


def _address_text_problem(uri: str) -> str | None:
    """Why an address's text cannot be read as it is written, or None: a
    backslash, a space or a control character, which a URL parser drops,
    encodes or reads as a slash. The page's addressTextProblem is the same."""
    return _TEXT_PROBLEM if any(ord(ch) <= 0x20 or ch in "\x7f\\" for ch in uri) else None


def _request_url_problem(uri: str) -> str | None:
    """Why an http(s) address in URI form cannot be sent as a person reads it,
    or None. A URL parser reads some addresses differently from the text: it
    takes a backslash for a slash, so "https://a\\@b" goes to a; drops a tab or
    line break and encodes a space; finds a host in "https:@a" or "https:/a",
    which have no "//"; and reads a host written as a number in any form other
    than four decimal parts ("0x7f.1", "2130706433") as an IPv4 address. User
    information before an "@" is refused too: urllib would send it as part of
    the Host header. The page's requestUrlProblem is the same."""
    if _address_text_problem(uri):
        return _TEXT_PROBLEM
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


# The characters IDNA 2003 maps to others and a browser keeps, each with one
# IDNA 2003 keeps that checks as it does; a joiner is refused outright.
_DEVIATION_STAND_INS = {0xDF: "s", 0x3C2: "\u03c3"}


def _punycode_valid(host: str) -> bool:
    """Whether each "xn--" label of an ASCII host is one a browser's URL
    parser accepts: punycode that decodes, to a label that is not all ASCII
    and that IDNA writes back as it is, with nothing mapped away. Python's
    IDNA 2003 stands in for the browser's UTS 46 check; the two differ for ß
    and ς, which a browser keeps, so those are checked as the letters IDNA 2003
    keeps, and for ZWJ and ZWNJ, which are refused. The page's URL parser makes
    this check itself."""
    for label in host.split("."):
        if label[:4].lower() != "xn--":
            continue
        try:
            decoded = label[4:].encode("ascii").decode("punycode")
        except UnicodeError:
            return False
        if decoded.isascii() or "\u200c" in decoded or "\u200d" in decoded:
            return False
        checked = decoded.translate(_DEVIATION_STAND_INS)
        try:
            if _idna_codec.nameprep(checked) != checked:
                return False
            _idna_codec.ToASCII(checked)
        except UnicodeError:
            return False
    return True


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
        if not _punycode_valid(host):
            raise ValueError(f"the address is not a URL; nothing is sent to {uri}")
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
# How much text expanding one document's IRIs may produce: a few times its own
# length, and a fixed amount besides, in UTF-16 code units as the page counts
# them. While a document is read (Context.normalize), each IRI a prefix, a term,
# @vocab or @base expands to is charged, and so, once, is what its base, a
# prefix or @vocab would expand each plain string it holds to, which the
# clients look up as a node later (Context.lookup). A document past it is
# refused, so a prefix, a @vocab or a @base written once cannot make the IRIs
# it expands cost far more than the document. The page's IRI_BUDGET_PER_UNIT,
# IRI_BUDGET_FIXED and EXPANSION_PROBLEM are the same.
IRI_BUDGET_PER_UNIT = 8
IRI_BUDGET_FIXED = 1_000_000
EXPANSION_PROBLEM = ("This document's prefixes, terms, @vocab and @base expand its IRIs to far more text than the document holds, "
                     "which this client does not read, so it is not read.")
# One budget of work for each thing a person asks of a document: reading it,
# listing it, opening one control (describe, and invoke before it checks a
# value), checking the values given, and building the request. Work is counted
# in units: a UTF-16 code unit of text a prefix, a term, @vocab or @base
# expands to (_Budget.charge), or that a control or a field carries into what
# is shown or written (_control_texts, _field_texts), or that a template
# expands to or a request holds; CONTROL_WORK for each control read or shown;
# FIELD_WORK for each field a control uses, however many controls share it,
# and for each field shown; one for each value checked; and, for Turtle, which
# rdflib reads first, TURTLE_TERM_WORK for each term (_turtle_charges). A document of n
# bytes (its text in UTF-8, as received) allows WORK_PER_BYTE * n units, and
# WORK_FLOOR at least; checking values also allows WORK_PER_BYTE units for
# each byte given, and building a request for each byte of the values it
# sends, as JSON writes them. Past it, the step stops and is refused by name
# (_work_problem): the document as it is read or listed, the control as it is
# opened, the request as it is checked or built; nothing is written in part
# and nothing is sent. So no shape of document, however its controls share
# what they name, makes either client do or write more than a few times its
# size; the specific limits above (CONTEXT_BUDGET, the IRI budget, the
# listing budget, shared lists and texts refused) still name their own
# problems first. The page's WORK_PER_BYTE, WORK_FLOOR, CONTROL_WORK,
# FIELD_WORK and workProblem are the same.
WORK_PER_BYTE = 64
WORK_FLOOR = 2_000_000
CONTROL_WORK = 16
FIELD_WORK = 8


def _work_problem(allowed: int, size: int) -> str:
    return f"This document asks for more work than its size allows ({allowed} units for {size} bytes); nothing was sent."


class WorkExceeded(Exception):
    """A step's work passed what its document's size allows (_Work). Not a
    ValueError, so no reading of a value or a document takes it for its own
    problem: it ends the step."""


class _Work:
    """One step's budget of work: WORK_PER_BYTE units for each of `size`
    bytes, and WORK_FLOOR at least."""

    def __init__(self, size: int) -> None:
        self.size = size
        self.allowed = max(WORK_FLOOR, WORK_PER_BYTE * size)
        self.left = self.allowed

    def spend(self, units: int) -> None:
        self.left -= units
        if self.left < 0:
            raise WorkExceeded(_work_problem(self.allowed, self.size))


# The step under way, whose budget each charge (_spend) counts against; none outside a step.
_WORK: list[_Work | None] = [None]


def _spend(units: int) -> None:
    work = _WORK[0]
    if work is not None:
        work.spend(units)


@contextlib.contextmanager
def _working(size: int) -> Iterator[_Work]:
    """A step of work for a document of `size` bytes: each charge while it
    runs is counted against its budget, which a nested step does not share."""
    previous = _WORK[0]
    _WORK[0] = work = _Work(size)
    try:
        yield work
    finally:
        _WORK[0] = previous


def _utf8_length(text: str) -> int:
    """A text's size in bytes, as UTF-8 writes it."""
    return len(text.encode("utf-8", "surrogatepass"))


def _json_size(value: Any) -> int:
    """What a JSON value a field carries costs to show: its strings' and
    keys' UTF-16 code units, and one for each other value, array and object.
    A walk with a stack. The page's jsonSize is the same."""
    total = 0
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            total += _utf16_length(item)
        elif isinstance(item, dict):
            total += 1 + sum(_utf16_length(str(key)) for key in item)
            stack.extend(item.values())
        elif isinstance(item, (list, tuple)):
            total += 1
            stack.extend(item)
        elif item is not None:
            total += 1
    return total


def _utf16_length(text: str) -> int:
    """A string's length as JavaScript counts it, in UTF-16 code units."""
    return len(text) if text.isascii() else len(text.encode("utf-16-le", "surrogatepass")) // 2


class _Budget:
    def __init__(self, size: int = 0) -> None:
        self.left = CONTEXT_BUDGET
        self.iris = IRI_BUDGET_PER_UNIT * size + IRI_BUDGET_FIXED
        # Whether expansions are charged: while a document is read.
        self.charging = False
        # Whether the document names a remote @context, whose terms this client does not know (REMOTE_SCHEMA).
        self.remote = False

    def spend(self, amount: int) -> None:
        self.left -= amount
        if self.left < 0:
            raise ValueError("This document's @context entries are too many to read.")

    def charge(self, value: Any, out: Any) -> Any:
        """An expansion's result, charged when it is one: text other than the value expanded."""
        if self.charging and isinstance(out, str) and out != value:
            self.expanded(_utf16_length(out))
        return out

    def expanded(self, length: int) -> None:
        """Charges `length` units of text an expansion makes, against this
        document's IRI budget and the step's work."""
        self.iris -= length
        if self.iris < 0:
            raise ValueError(EXPANSION_PROBLEM)
        _spend(length)


def _json_schema_like(item: dict[str, Any], expected: bool = False) -> bool:
    """A JSON Schema written into a document as plain JSON, where hydra:expects
    names it: an object whose "properties" is an object, or one of JSON
    Schema's keywords (_schema_by_keywords). Its keys are JSON Schema's, never
    terms, so only its own "@id" and "@type" are read as JSON-LD, and nothing
    under it is renamed or expanded; what JSON-LD would read in it that this
    client does not is refused (_schema_hides). Anywhere else an object is read
    as JSON-LD, whatever keys it has, so a node written in it is read. The
    page's jsonSchemaLike is the same."""
    if not expected:
        return False
    return isinstance(item.get("properties"), dict) or _schema_by_keywords(item)


# JSON Schema's keywords, and those of them that only describe. Where
# hydra:expects names it, an object whose keys are all keywords (or @id and
# @type), one or more of which constrains, is a JSON Schema though it has no
# "properties": {"type": "object", "additionalProperties": false} is the schema
# of a body of no properties, not a node the document does not describe. The
# page's SCHEMA_NOTES, SCHEMA_KEYWORDS and schemaByKeywords are the same.
_SCHEMA_NOTES = frozenset({
    "$schema", "$id", "$anchor", "$dynamicAnchor", "$recursiveAnchor", "$vocabulary", "$comment", "$defs", "definitions", "title",
    "description", "default", "deprecated", "examples", "format", "contentEncoding", "contentMediaType", "contentSchema", "writeOnly",
})
_SCHEMA_KEYWORDS = _SCHEMA_NOTES | frozenset({
    "type", "enum", "const", "properties", "additionalProperties", "required", "items", "minItems", "maxItems", "minLength", "maxLength",
    "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "readOnly", "allOf", "anyOf", "oneOf", "not", "if", "then",
    "else", "multipleOf", "uniqueItems", "contains", "minContains", "maxContains", "prefixItems", "additionalItems", "unevaluatedItems",
    "unevaluatedProperties", "minProperties", "maxProperties", "patternProperties", "propertyNames", "dependencies",
    "dependentRequired", "dependentSchemas", "$ref", "$dynamicRef", "$recursiveRef",
})


# JSON Schema's keywords whose value is a schema, a list of schemas, or an
# object of names and schemas. The page's SCHEMA_ONE, SCHEMA_MANY and
# SCHEMA_MAPS are the same.
_SCHEMA_ONE = frozenset({"items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames",
                         "additionalItems", "unevaluatedItems", "unevaluatedProperties", "contentSchema"})
_SCHEMA_MANY = frozenset({"allOf", "anyOf", "oneOf", "prefixItems"})
_SCHEMA_MAPS = frozenset({"properties", "patternProperties", "$defs", "definitions", "dependentSchemas"})
# The JSON-LD keywords an object may hold and still say nothing JSON-LD reads
# as a node: a type, a list or a set of values, an index, a language or a
# direction. The page's LITERAL_KEYWORDS is the same.
_LITERAL_KEYWORDS = frozenset({"@type", "@list", "@set", "@index", "@language", "@direction"})


def _in_schema(what: str) -> ValueError:
    return ValueError(f"This document writes {what} in a JSON Schema, which this client does not read as JSON-LD, so it is not read.")


# What a document that names a remote @context and writes a JSON Schema in place
# under hydra:expects is refused with: the remote context may name any of the
# schema's keywords as a term, which JSON-LD would read, and this client does
# not fetch it to know. The page's REMOTE_SCHEMA is the same.
REMOTE_SCHEMA = ("This document names a remote @context, which this client does not fetch, so what the keys of a JSON Schema "
                 "written in it mean is not known, and it is not read.")


def _holds_node(ctx: "Context", value: Any) -> bool:
    """Whether a value written in a JSON Schema holds, at any depth, what
    JSON-LD reads as a node: an object with an @id, with a key the context
    expands to an IRI (a term, a compact or absolute IRI, @vocab, or one of
    this client's own names), or with a JSON-LD keyword other than those of
    _LITERAL_KEYWORDS. A value object is a literal. A walk with a stack. The
    page's holdsNode is the same."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(item)
            continue
        if not isinstance(item, dict):
            continue
        keywords = [(key, ctx._keyword(key)) for key in item]
        if any(keyword == "@value" for _, keyword in keywords):
            continue
        for key, keyword in keywords:
            if keyword is not None:
                if keyword not in _LITERAL_KEYWORDS:
                    return True
            elif ":" in ctx.expand_key(key):
                return True
        stack.extend(item.values())
    return False


def _schema_hides(ctx: "Context", root: dict[str, Any]) -> None:
    """Refuses, by raising, a JSON Schema written in place under hydra:expects
    that holds what JSON-LD reads and this client, which reads it as JSON
    Schema, does not: at its top, a JSON-LD keyword other than its own @id and
    @type; in it or any schema inside it, a node (_holds_node) under a key that
    is no JSON Schema keyword or under a JSON-LD keyword; a key that is no
    JSON Schema keyword and that the context expands to an IRI, which JSON-LD
    reads as a property, of the node the schema names when it has an @id; and,
    in it or any schema inside it, a JSON Schema keyword the document's context
    gives a meaning (Context.gives_meaning: a term of that name, or @vocab),
    which JSON-LD reads as a property, with what is under it. A document that
    names a remote @context may give any keyword a meaning, so a schema written
    in place in it is refused (REMOTE_SCHEMA). A hint written there would
    otherwise be passed over, as JSON-LD reads it. Each object's keys are taken
    in sorted order, the schemas inside it after. The page's schemaHides is the
    same."""
    if ctx.budget.remote:
        raise ValueError(REMOTE_SCHEMA)
    stack: list[tuple[Any, bool]] = [(root, True)]
    while stack:
        schema, top = stack.pop()
        if isinstance(schema, list):
            stack.extend((item, False) for item in reversed(schema))
            continue
        if not isinstance(schema, dict):
            continue
        named = any(ctx._keyword(key) == "@id" for key in schema)
        inside: list[Any] = []
        for key in sorted(schema, key=_utf16_key):
            value = schema[key]
            keyword = ctx._keyword(key)
            if keyword is not None:
                if top and keyword in ("@id", "@type"):
                    continue
                if top or _holds_node(ctx, value):
                    raise _in_schema(keyword)
                continue
            if key in _SCHEMA_KEYWORDS:
                if ctx.gives_meaning(key):
                    raise _in_schema(f"{_js_string(key)}, a key its @context gives a meaning,")
                if key in _SCHEMA_MAPS and isinstance(value, dict):
                    inside.extend(value[name] for name in sorted(value, key=_utf16_key))
                elif key in _SCHEMA_ONE or key in _SCHEMA_MANY:
                    inside.append(value)
                continue
            if _holds_node(ctx, value):
                raise _in_schema(f"a node under {_js_string(key)}")
            if ":" in ctx.expand_key(key):
                raise _in_schema(f"{_js_string(key)} beside its own @id" if named
                                 else f"{_js_string(key)}, a key its @context gives a meaning,")
        stack.extend((item, False) for item in reversed(inside))


def _schema_by_keywords(item: dict[str, Any]) -> bool:
    # A key with no value (None or []) is absent, as JSON-LD drops it.
    keys = [key for key in item if key not in ("@id", "@type") and _present(item[key])]
    return bool(keys) and all(key in _SCHEMA_KEYWORDS for key in keys) and any(key not in _SCHEMA_NOTES for key in keys)


def _propagates(local: Any, fallback: bool) -> bool:
    """Whether a local context propagates to the node objects under the node
    it applies to: its first entry's "@propagate" when that is a boolean, as
    jsonld.js reads it, else `fallback` (False for a type's scoped context,
    True for any other)."""
    first = local[0] if isinstance(local, list) and local else local
    flag = first.get("@propagate") if isinstance(first, dict) else None
    return flag if isinstance(flag, bool) else fallback


def _utf16_key(text: str) -> bytes:
    """A key that sorts strings as JavaScript's sort() does, by UTF-16 code
    unit, so both clients read a map's keys in one order."""
    return text.encode("utf-16-be", "surrogatepass")


_ABSENT = object()


def _same_entry(a: Any, b: Any) -> bool:
    return a is b or (isinstance(a, (str, frozenset)) and type(a) is type(b) and a == b)


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
    or "@vocab" in the context; "@json" ones hold JSON), containers, the property
    whose values an @index map's keys are, scoped contexts, keyword aliases,
    terms set to null, @vocab, and the base a relative
    IRI resolves against: @base when the context gives one, else the address the
    document came from. `previous`, when set, is the context a node object under
    the node goes back to: a type's scoped context, and one whose "@propagate"
    is false, hold for that node's own keys only. `terms` holds only what
    documents defined; the reader's own names for the properties it reads
    (TERM_FALLBACKS) apply to keys only, never to a value such as an action
    written as a term. The page's Ctx is the same."""

    def __init__(self, base: str | None = None, budget: _Budget | None = None) -> None:
        self.prefixes: dict[str, str] = dict(WELL_KNOWN_PREFIXES)
        self.terms: dict[str, str] = {}
        self.coerce: dict[str, str] = {}
        self.containers: dict[str, frozenset[str]] = {}
        self.indexes: dict[str, str] = {}
        self.scoped: dict[str, Any] = {}
        self.aliases: dict[str, str] = {}
        self.nulled: set[str] = set()
        self.vocab: str | None = None
        self.base: str | None = base or None
        self.document_base = self.base
        self.budget = budget or _Budget()
        self.previous: Context | None = None
        # The contexts scoped contexts made from this one, each made once
        # (scoped_child), keyed by the scoped context's id() with it kept.
        self._made: dict[Any, tuple[Any, list[Context | None]]] = {}
        # While would_keep absorbs a context, each key's entries before it changed.
        self._journal: dict[str, tuple[Any, ...]] | None = None
        # The id() of each JSON Schema normalize read in place (_json_schema_like).
        self.schemas: set[int] = set()
        # Each plain string a document holds, as normalize meets it, and what
        # each is looked up as (lookup), keyed by (string, vocab); and each
        # key's property IRI, once it is read (expand_key).
        self._strings: dict[str, None] = {}
        self._lookups: dict[tuple[str, bool], Any] = {}
        self._keys: dict[str, str] = {}

    def _tables(self) -> tuple[dict[str, Any], ...]:
        return (self.prefixes, self.terms, self.coerce, self.containers, self.indexes, self.scoped, self.aliases)

    def _entries(self, key: str) -> tuple[Any, ...]:
        return tuple(table.get(key, _ABSENT) for table in self._tables()) + (key in self.nulled,)

    def copy(self) -> "Context":
        """A copy of this context, `previous` included."""
        self.budget.spend(sum(len(table) for table in self._tables()) + len(self.nulled) + 1)
        out = Context(self.base, self.budget)
        out.prefixes, out.terms, out.coerce = dict(self.prefixes), dict(self.terms), dict(self.coerce)
        out.containers, out.indexes = dict(self.containers), dict(self.indexes)
        out.scoped, out.aliases = dict(self.scoped), dict(self.aliases)
        out.nulled, out.vocab, out.document_base = set(self.nulled), self.vocab, self.document_base
        out.previous = self.previous
        return out

    def child(self, local: Any, propagate: bool = True) -> "Context":
        """This context with `local` absorbed: a node's own @context, or the
        scoped one a term or type carries. One that does not propagate keeps the
        context before it as `previous`, as jsonld.js does."""
        out = self.copy()
        if not propagate and out.previous is None:
            out.previous = self
        out.absorb(local)
        return out

    def scoped_child(self, local: Any, fallback: bool) -> "Context":
        """The context a scoped @context makes from this one, made once for
        each scoped context and fallback. A scoped context that would change
        nothing here, such as a term's met again inside its own value, gives
        this context itself, so a term nested in itself many levels deep makes
        no copy per level."""
        propagate = _propagates(local, fallback)
        key = id(local) if isinstance(local, (dict, list)) else ("value", local)
        hit = self._made.get(key)
        if hit is None or hit[0] is not local:
            hit = self._made[key] = (local, [None, None])
        slot = 1 if propagate else 0
        made = hit[1][slot]
        if made is None:
            keep = (propagate or self.previous is not None) and self.would_keep(local)
            made = hit[1][slot] = self if keep else self.child(local, propagate)
        return made

    def would_keep(self, local: Any) -> bool:
        """Whether absorbing `local` would leave this context as it is. It is
        absorbed here with each entry it changes saved first and put back
        after, so the check costs `local`'s size, not this context's. A local
        context that empties the context (null) is not checked."""
        if any(item is None for item in as_list(local)):
            return False
        base, vocab, made = self.base, self.vocab, self._made
        saved: dict[str, tuple[Any, ...]] = {}
        self._journal = saved
        try:
            self.absorb(local)
        finally:
            self._journal = None
        same = self.base == base and self.vocab == vocab
        for key, before in saved.items():
            now = self._entries(key)
            if not all(_same_entry(a, b) for a, b in zip(before, now)):
                same = False
            for table, value in zip(self._tables(), before):
                if value is _ABSENT:
                    table.pop(key, None)
                else:
                    table[key] = value
            if before[-1]:
                self.nulled.add(key)
            else:
                self.nulled.discard(key)
        self.base, self.vocab, self._made = base, vocab, made
        self._keys = {}
        return same

    def absorb(self, ctx: Any) -> None:
        self._keys = {}
        for item in as_list(ctx):
            if item is None:
                # A null context empties the active context; the document's own base stays.
                self.prefixes, self.terms, self.coerce = dict(WELL_KNOWN_PREFIXES), {}, {}
                self.containers, self.indexes, self.scoped, self.aliases, self.nulled = {}, {}, {}, {}, set()
                self.vocab, self.base = None, self.document_base
                self._made = {}
                continue
            if not isinstance(item, dict):
                if isinstance(item, str):
                    # A remote context: its terms are not known (REMOTE_SCHEMA).
                    self.budget.remote = True
                continue
            self.budget.spend(len(item) + 1)
            if "@import" in item:
                # An imported context is fetched by a JSON-LD processor; this reader fetches no context, so it refuses one.
                raise ValueError(REFUSED["import"])
            self._made = {}
            if "@base" in item:
                new_base = item["@base"]
                if new_base is None:
                    self.base = None
                elif isinstance(new_base, str):
                    self.base = (self.budget.charge(new_base, _resolve_iri(new_base, self.base)) if self.base
                                 else (new_base if _has_scheme(new_base) else None))
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
        if self._journal is not None and key not in self._journal:
            self._journal[key] = self._entries(key)
        for table in self._tables():
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
            # A reverse property names the node as the value, not the subject. The
            # reader does not read it, so a document that uses one is refused (normalize).
            self.coerce[key] = "@reverse"
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
            # An expanded definition is a prefix only when it says so, as JSON-LD 1.1 has it.
            if value.get("@prefix") is True:
                self.prefixes[key] = iri
        kind = value.get("@type")
        if kind in ("@id", "@vocab", "@json"):
            self.coerce[key] = kind
        container = value.get("@container")
        names = frozenset(c for c in as_list(container) if isinstance(c, str))
        if names:
            self.containers[key] = names
        # An @index map whose keys are values of a property ("@index": "schema:name"), not bare index strings.
        index_by = value.get("@index")
        if "@index" in names and isinstance(index_by, str) and index_by and not index_by.startswith("@"):
            self.indexes[key] = index_by
        if "@context" in value:
            self.scoped[key] = value["@context"]

    def expand_key(self, key: str) -> str:
        """The property IRI a key names, or "" for a term the context set to
        null: charged while a document is read (_Budget.charge), and kept
        afterwards, when reading it looks up the same keys again and again.
        The page's expandKey is the same."""
        if self.budget.charging:
            return self.budget.charge(key, self._expand_key(key))
        hit = self._keys.get(key)
        if hit is None:
            hit = self._keys[key] = self._expand_key(key)
        return hit

    def _expand_key(self, key: str) -> str:
        if key.startswith(("@", "http://", "https://")):
            return key
        if key in self.nulled:
            return ""
        if key in self.terms:
            return self.terms[key]
        if ":" in key:
            return str(self._expand_iri(key))
        if key in TERM_FALLBACKS:
            return TERM_FALLBACKS[key]
        return self.vocab + key if self.vocab is not None else key

    def expand_iri(self, value: Any, *, vocab: bool = False, document_relative: bool = False) -> Any:
        """JSON-LD's expansion of a value in an IRI position (_expand_iri),
        charged while a document is read (_Budget.charge). The page's expandIri
        is the same."""
        return self.budget.charge(value, self._expand_iri(value, vocab=vocab, document_relative=document_relative))

    def lookup(self, value: str, vocab: bool = False) -> Any:
        """What a plain string a document holds is looked up as, a node's IRI
        perhaps: expanded against the base, and @vocab and terms where `vocab`
        applies, once, as normalize charged it; any other string as it
        expands. The page's lookup is the same."""
        hit = self._lookups.get((value, vocab), _ABSENT)
        if hit is _ABSENT:
            hit = self._expand_iri(value, vocab=vocab, document_relative=True)
        return hit

    def _expand_iri(self, value: Any, *, vocab: bool = False, document_relative: bool = False) -> Any:
        """JSON-LD's expansion of a value in an IRI position: a term the
        document defined where `vocab` applies; a compact IRI; an absolute IRI
        or a blank node as it is; then @vocab + the value where `vocab` applies,
        or the value resolved against the base where `document_relative`
        applies."""
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
        """Each key aliased to a keyword renamed to it. A second @type or
        @included adds to the first, as JSON-LD 1.1 has it; a second of any
        other keyword is refused, as JSON-LD refuses colliding keywords. A
        @nest alias keeps its name (_is_nest reads it)."""
        if not self.aliases:
            return
        for key in list(item):
            keyword = self.aliases.get(key)
            if not keyword or keyword == "@nest":
                continue
            if keyword not in item:
                item[keyword] = item.pop(key)
            elif keyword in ("@type", "@included"):
                _merge_value(item, keyword, item.pop(key))
            else:
                raise _colliding(keyword)

    def _keyword(self, key: str) -> str | None:
        return key if key.startswith("@") else self.aliases.get(key)

    def gives_meaning(self, key: str) -> bool:
        """Whether this context makes a key that is no keyword a property, as
        JSON-LD reads it: a term of that name, or any key where @vocab is set,
        unless the key is a term set to null. This client's own names
        (TERM_FALLBACKS) are not counted: they stand in for a remote context,
        which a document that names one is refused for (REMOTE_SCHEMA). The
        page's givesMeaning is the same."""
        return key not in self.nulled and (key in self.terms or self.vocab is not None)

    def _wrapper(self, item: dict[str, Any], member: bool) -> str | None:
        """The key holding what `item` wraps, when it is a @set object or, as
        a value of a property whose values are members (MEMBERS), a @list
        object or a graph object with no @context or properties of its own;
        else None. Keys are read through this context's aliases. A @set object
        with a key other than @index is refused, as JSON-LD refuses it."""
        kinds = {key: self._keyword(key) for key in item}
        for wanted, allowed in (("@set", ("@set", "@index")), ("@list", ("@list", "@index")), ("@graph", ("@graph", "@id", "@index"))):
            found = [key for key, kind in kinds.items() if kind == wanted]
            if len(found) > 1:
                raise _colliding(wanted)
            if not found:
                continue
            if wanted == "@set" and any(kind not in allowed for kind in kinds.values()):
                raise ValueError(REFUSED["set"])
            if wanted == "@set" or (member and all(kind in allowed for kind in kinds.values())):
                return found[0]
            return None
        return None

    def _contents(self, value: Any, member: bool) -> Any:
        """A property's value as JSON-LD expands it, with each @set object in
        it (and, as a value of a member property, each @list object and graph
        object _wrapper unwraps) replaced by what it holds, and nested arrays
        flattened. A value that holds none of these is returned as it is. A
        stack, so a deep value costs linear time. The page's contents is the
        same."""
        if isinstance(value, dict):
            if self._wrapper(value, member) is None:
                return value
        elif not isinstance(value, list):
            return value
        out: list[Any] = []
        stack: list[Any] = [value]
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                stack.extend(reversed(item))
                continue
            key = self._wrapper(item, member) if isinstance(item, dict) else None
            if key is None:
                out.append(item)
            else:
                stack.append(item[key])
        return out

    def _is_nest(self, key: str) -> bool:
        return key == "@nest" or self.aliases.get(key) == "@nest"

    def _lift_nests(self, item: dict[str, Any]) -> None:
        """Moves the properties under each @nest key (or a term aliased to it)
        onto the node, where JSON-LD reads them: a nested "@type" (or its
        alias) adds to the node's types, and a nested "@id" is the node's when
        it has none. Each nested object is moved once, so this costs linear
        time."""
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
                    if inner == "@type":
                        _merge_value(item, "@type", value)
                        continue
                    if inner == "@id":
                        if "@id" in item:
                            raise _colliding("@id")
                        item["@id"] = value
                        continue
                    if inner.startswith("@") and inner != "@nest":
                        raise _nested_keyword(inner)
                    if self._is_nest(inner) and inner not in item:
                        work.append(inner)
                    _merge_value(item, inner, value)

    def _unmap(self, term: str, value: Any, keyed: dict[int, tuple[Any, dict[str, Any]]], value_ctx: "Context") -> Any:
        """A container term's value as the values it holds, as JSON-LD 1.1
        expands it. Only an @language, @index, @id or @type container holds a
        map (alone, with @set, or, for @index and @id, with @graph), and there
        every object is a map, whatever its keys. A map's keys are read in
        sorted order, as jsonld.js reads them, so both clients meet its values
        in one order. A language map's key becomes each string's "@language";
        an @index map's key is dropped, or is a value of the property the
        term's "@index" names, put before the node's own (under @graph that
        property is the graph's, which the reader does not keep, so the node
        gets nothing); an @id map's key becomes its node's "@id" unless the
        node has one, or @graph makes the key the IRI of the graph that holds
        the node; and a @type map's key is put before its node's types. A
        string where the term holds IRIs (a @type map's always does) is a
        reference to the node it names, which an @index property reaches as it
        reaches a node written in place. Keys are read in `value_ctx`, the
        context the term's values are read in, as jsonld.js reads them.
        `keyed` holds each object a map gives, with the "@id" or type for
        normalize to give it once its keyword aliases are keywords, so a node's
        own "id": "@id" alias is its own "@id". A key that is @none, or a term
        aliased to it, adds nothing. Under any other container (@set, @list,
        @graph alone or with @set) a value is what it is, so one node object
        stays one node, never a list of its properties. The page's unmap is the
        same."""
        containers = self.containers[term]
        if not isinstance(value, dict):
            return value
        language, index = "@language" in containers, "@index" in containers
        ids, types = "@id" in containers, "@type" in containers
        if not (language or index or ids or types):
            return value
        graph = "@graph" in containers
        index_by = self.indexes.get(term) if index else None
        coerced = self.coerce.get(term)
        ref_kind = ("@vocab" if coerced == "@vocab" else "@id") if types else (coerced if coerced in ("@id", "@vocab") else None)
        out: list[Any] = []
        for key in sorted(value, key=_utf16_key):
            none = key == "@none" or value_ctx.aliases.get(key) == "@none"
            for entry in as_list(value_ctx._contents(value[key], False)):
                if language:
                    if isinstance(entry, str) and not none:
                        out.append({"@value": entry, "@language": key})
                    elif entry is not None:
                        out.append(entry)
                    continue
                info: dict[str, Any] = {}
                if isinstance(entry, str) and ref_kind:
                    entry = {"@id": value_ctx.expand_iri(entry, vocab=ref_kind == "@vocab", document_relative=True)}
                    info["expanded"] = True
                if index:
                    if isinstance(entry, dict) and index_by and not none and not graph and "@value" not in entry:
                        # The key is the property's value as a value of that term is read: an IRI where the term holds IRIs.
                        kind = value_ctx.coerce.get(index_by)
                        indexed = (value_ctx.expand_iri(key, vocab=kind == "@vocab", document_relative=True)
                                   if kind in ("@id", "@vocab") else key)
                        name = self.expand_key(index_by) or index_by
                        entry[name] = [indexed] + (as_list(entry[name]) if name in entry else [])
                    if isinstance(entry, dict):
                        keyed[id(entry)] = (entry, info)
                    if entry is not None:
                        out.append(entry)
                elif isinstance(entry, dict):
                    if not none and (types or not graph):
                        if ids:
                            info["id"] = value_ctx.expand_iri(key, document_relative=True)
                        else:
                            info["type"] = key
                    # A @type map's values go back to the context before a type's scoped one, as jsonld.js reads them.
                    if types:
                        info["revert"] = True
                    keyed[id(entry)] = (entry, info)
                    out.append(entry)
        return out

    def _keeps_context(self, item: dict[str, Any]) -> bool:
        """Whether an object is a value object or a node reference (one "@id"
        and nothing else), which keep the context they are written in, as
        jsonld.js reads them: only a node object under a type's scoped context
        goes back."""
        if len(item) > 2 or "@context" in item:
            return False
        for key in item:
            keyword = key if key.startswith("@") else self.aliases.get(key)
            if keyword == "@value":
                return True
            if keyword == "@id" and len(item) == 1:
                return True
        return False

    def normalize(self, document: Any) -> set[int]:
        """_normalize, with each expansion it makes charged (_Budget.charge),
        and then each plain string the document holds charged once for what it
        is looked up as (lookup): expanded against the base, and where it
        differs, against @vocab and terms too. The page's normalize is the
        same."""
        self.budget.charging = True
        try:
            nodes = self._normalize(document)
            for text in self._strings:
                plain = self._lookups[(text, False)] = self.expand_iri(text, document_relative=True)
                vocab = self._expand_iri(text, vocab=True, document_relative=True)
                self._lookups[(text, True)] = self.budget.charge(plain, vocab) if vocab != text else vocab
        finally:
            self.budget.charging = False
        return nodes

    def _normalize(self, document: Any) -> set[int]:
        """Every node in a document put in the form the reader reads, in place,
        once, before anything reads it, and the id() of each object that is a
        node object, which NodeIndex indexes. A node's own @context and a term's
        scoped context apply to the node and what is under it unless they say
        "@propagate": false; a type's scoped context applies to the node's own
        keys only, so a node object under the node goes back to the context
        before it, and a property-scoped context is taken again from there, as
        jsonld.js reads them. Keyword aliases become the keywords; @nest objects
        are lifted onto their node; a container term's map becomes a list; each
        "@id", each "@type" and each value of a term typed "@id" or "@vocab" is
        expanded, so {"@id": "xsd:integer"} is XSD's integer and
        {"@id": "/api"} is an address on the document's host; and a key that a
        scoped context maps differently from the document's own context is
        renamed to the IRI it names, so reading the node later finds it. A value
        of a term typed "@json" becomes a JSON literal value object, so it is
        never read as an address, a method or a node, and a term whose values are
        graphs is refused unless it holds members (MEMBERS), as a @graph inside a
        node is. Value objects, JSON literals and JSON Schemas are left as they
        are, but for a schema's own "@id" and "@type". A stack, not recursion,
        so a deeply nested document costs linear time and stays inside Python's
        recursion limit. The page's normalize is the same."""
        unset = object()
        top_items = document if isinstance(document, list) else [document]
        # Each entry: the item, its context, whether it is the document's top,
        # the property-scoped context of the key it is a value of (taken again
        # after a type's scoped context ends), whether that key is hydra:expects,
        # and whether the item is a node of the document's graphs (its top, or in
        # a @graph or @included of one), which the reader indexes.
        stack: list[tuple[Any, Context, bool, Any, bool, bool]] = [
            (item, self, not isinstance(document, list), unset, False, True) for item in top_items]
        keyed: dict[int, tuple[Any, dict[str, Any]]] = {}
        node_objects: set[int] = set()
        # The id() of each JSON Schema written in place, which _shape_fields
        # tells apart from one a JSON literal holds.
        schemas: set[int] = self.schemas
        while stack:
            item, ctx, top, scoped, expected, level = stack.pop()
            if isinstance(item, list):
                stack.extend((x, ctx, False, scoped, expected, level) for x in item if isinstance(x, (dict, list)))
                continue
            if not isinstance(item, dict):
                continue
            # A map's value is a node, whatever keys it has, and keeps the context the map is read in.
            hit = keyed.get(id(item))
            from_map = hit[1] if hit is not None and hit[0] is item else None
            if from_map is None and _json_schema_like(item, expected):
                # JSON-LD reads a schema's own keys, as any node's, in the context
                # before a type's scoped context that does not propagate, and then
                # in the scoped contexts its own types name, which a type the schema
                # names may give a keyword: it is checked there, and where it sits.
                own = ctx
                if own.previous is not None and not own._keeps_context(item):
                    own = own.previous
                    if scoped is not unset:
                        own = own.scoped_child(scoped, True)
                own._rename_aliases(item)
                typed = own
                for kind in sorted((t for t in as_list(item.get("@type")) if isinstance(t, str) and t in own.scoped), key=_utf16_key):
                    typed = typed.scoped_child(own.scoped[kind], False)
                if typed is not own:
                    typed._rename_aliases(item)
                _schema_hides(typed, item)
                if ctx is not typed:
                    _schema_hides(ctx, item)
                schemas.add(id(item))
                if "@id" in item:
                    item["@id"] = typed.expand_iri(item["@id"], document_relative=True)
                if "@type" in item:
                    item["@type"] = own._expand_typed(item["@type"], True)
                continue
            if ctx.previous is not None and (from_map.get("revert", False) if from_map is not None else not ctx._keeps_context(item)):
                ctx = ctx.previous
                if scoped is not unset and from_map is None:
                    ctx = ctx.scoped_child(scoped, True)
            if "@context" in item:
                local = item["@context"]
                if top:
                    # A top-level context that does not propagate leaves the nodes under the top with the empty context.
                    if not _propagates(local, True):
                        self.previous = Context(self.document_base, self.budget)
                    ctx.absorb(local)
                else:
                    ctx = ctx.child(local, _propagates(local, True))
            ctx._rename_aliases(item)
            if from_map is not None:
                if "id" in from_map and "@id" not in item:
                    item["@id"] = from_map["id"]
                if "type" in from_map:
                    item["@type"] = [from_map["type"]] + as_list(item.get("@type"))
            if "@value" in item:
                # A literal's datatype is an IRI, expanded as @vocab expands one.
                if isinstance(item.get("@type"), str) and item["@type"] != "@json":
                    item["@type"] = ctx.expand_iri(item["@type"], vocab=True, document_relative=True)
                continue
            # A type's scoped context, looked up in the context before any of
            # them, in the order of the types' names, holds for this node's own keys.
            type_ctx = ctx
            for kind in sorted((t for t in as_list(item.get("@type")) if isinstance(t, str) and t in type_ctx.scoped), key=_utf16_key):
                ctx = ctx.scoped_child(type_ctx.scoped[kind], False)
            if ctx is not type_ctx:
                ctx._rename_aliases(item)
            ctx._lift_nests(item)
            if "@list" not in item:
                node_objects.add(id(item))
            for key in sorted(item, key=_utf16_key):
                if key == "@context":
                    continue
                if key == "@id":
                    if not (from_map is not None and from_map.get("expanded")):
                        item[key] = ctx.expand_iri(item[key], document_relative=True)
                    continue
                if key == "@type":
                    item[key] = type_ctx._expand_typed(item[key], True)
                    continue
                if key.startswith("@"):
                    # The structures the reader does not read are refused, not skipped:
                    # @reverse, and a @graph or @included it would not index.
                    if key == "@reverse":
                        raise ValueError(REFUSED["reverse"])
                    if key == "@set":
                        raise ValueError(REFUSED["set-in-list"])
                    graphs = key in ("@graph", "@included")
                    if graphs:
                        if not level:
                            raise ValueError(REFUSED["graph" if key == "@graph" else "included"])
                        item[key] = ctx._contents(item[key], False)
                    if key in ("@list", "@set"):
                        self._collect(item[key])
                    if isinstance(item[key], (dict, list)):
                        stack.append((item[key], ctx, False, scoped if key in ("@list", "@set") else unset, False, graphs))
                    continue
                if key in ctx.nulled:
                    del item[key]
                    continue
                kind = ctx.coerce.get(key)
                if kind == "@reverse":
                    raise ValueError(REFUSED["reverse"])
                local = ctx.scoped[key] if key in ctx.scoped else unset
                value_ctx = ctx.scoped_child(local, True) if local is not unset else ctx
                value = item[key]
                pred = ctx.expand_key(key)
                member = pred in MEMBERS or local_name(pred) in HARVESTED_NAMES
                containers = ctx.containers.get(key)
                if kind == "@json":
                    # A JSON literal, whatever JSON it holds: never an address, a method or a node.
                    if value is not None:
                        value = {"@value": value, "@type": "@json"}
                elif containers and "@graph" in containers and not member and value is not None:
                    # Its values are nodes of a graph of their own, which the reader does not read.
                    raise ValueError(REFUSED["graph"])
                elif containers and "@list" in containers:
                    # A @list term's value is a list, as JSON-LD expands it.
                    if value is not None and not (isinstance(value, dict) and any(value_ctx._keyword(k) == "@list" for k in value)):
                        value = {"@list": as_list(value)}
                elif containers:
                    value = ctx._unmap(key, value, keyed, value_ctx)
                if kind != "@json":
                    value = value_ctx._contents(value, member)
                if kind in ("@id", "@vocab"):
                    value = value_ctx._expand_typed(value, kind == "@vocab")
                elif kind != "@json":
                    self._collect(value)
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
                    stack.append((value, value_ctx, False, local, pred == P_EXPECTS, False))
        return node_objects

    def _collect(self, value: Any) -> None:
        """Keeps each plain string a value holds, alone or in an array, which
        reading the document may look up as a node (lookup)."""
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, str):
                self._strings[item] = None

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
    """A JSON value read as a boolean, or None, as the page's truthy reads it:
    its text (2.0 as 2) trimmed of space, tab, CR and LF, and of nothing else."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = (value if isinstance(value, str) else _scalar_text(value)).strip(_SPACES).lower()
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
    # The bounds on how many values a JSON field holds: a node-valued SHACL
    # property's sh:minCount and sh:maxCount, or a JSON Schema's minItems and maxItems.
    min_items: int | None = None
    max_items: int | None = None
    # A shape's exclusive bounds, sh:hasValue and sh:nodeKind (one of SHACL's six,
    # by its local name); the constraints this client does not check, so a value
    # given is refused; and whether hydra:writable says the property is not written.
    min_exclusive: Any = None
    max_exclusive: Any = None
    has_value: Any = None
    node_kind: str | None = None
    unchecked: list[str] = field(default_factory=list)
    not_writable: bool = False
    # A JSON Schema property's: its schema, the type names it writes (None for
    # none), whether one of them is null, and the choices its select offers, as
    # (text, entry). None for a field a shape gives, whose choices are its sh:in.
    # A default of JSON null, which `default` (None for none) cannot hold, is
    # `null_default`: it is sent as null where the schema allows null.
    json_schema: bool = False
    schema: Any = None
    schema_types: list[str] | None = None
    nullable: bool = False
    choices: list[tuple[str, Any]] | None = None
    null_default: bool = False
    # The first node of the RDF list that is its sh:in, which no other field
    # of its shape may share (_shared_list_problem); and whether it is a
    # template variable a closed shape does not name, which takes no value.
    in_list: Any = None
    closed_out: bool = False
    # Whether the field's sh:in is given, even as an empty list; and the
    # constraint whose empty list allows it no value (_empty_of: "sh:in",
    # "sh:or", "sh:xone", "sh:languageIn", or a JSON Schema's "enum"), or None.
    in_given: bool = False
    empty: str | None = None
    # Whether its default holds a number reading JSON may have rounded
    # (_rounded_default), which is refused rather than sent; and the doubles of
    # the numbers its document writes with digits their doubles drop, so an
    # entry or a bound that is one of them is not compared (_holds_rounded).
    rounded_default: bool = False
    inexact: Any = None

    def to_public(self) -> dict[str, Any]:
        return {
            "name": self.name, "path": self.path, "datatype": self.datatype,
            "jsonKind": self.json_kind, "multi": self.multi,
            "minCount": self.min_count, "maxCount": self.max_count,
            "pattern": self.pattern, "defaultValue": self.default,
            "maxLength": self.max_length, "minLength": self.min_length,
            "description": self.description, "in": self.enum,
            # The constraint whose list is given empty, so the field allows no
            # value ("sh:in", "sh:or", "sh:xone", "sh:languageIn" or "enum"),
            # which "in" alone does not say; None where none is.
            "empty": self.empty,
            "minInclusive": self.min_inclusive, "maxInclusive": self.max_inclusive,
            "required": self.required or (self.min_count or 0) >= 1,
            "rawBody": self.raw_body, "variable": self.variable,
            "minItems": self.min_items, "maxItems": self.max_items,
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
    # Why the document's own reading of this control is in doubt (several
    # methods, or another control of its name that sends something else): the
    # problem shown first, and the control is listed with the writes.
    conflict: str | None = None

    @property
    def unsafe(self) -> bool:
        method = (self.method or "").upper()
        if self.conflict:
            return True
        if method and method not in SAFE_METHODS:
            return True
        if self.destructive is True:
            return True
        if self.read_only is False:
            return True
        return False

    def to_public(self, with_fields: bool = True, unlisted: bool = False) -> dict[str, Any]:
        """The control as describe writes it. A control that is not invoked
        has its problem written, not its fields (None), as the page shows it
        no form; with_fields False leaves fields out, for list --json, which
        writes each list of fields once (Descriptor.to_public), and `unlisted`
        is a control list did not build (Descriptor.listing), whose problem is
        only what reading the control itself gave."""
        problem = self.__dict__.get("conflict") if unlisted else self.problem
        warning = None if unlisted else self.warning
        public = {
            "id": self.id, "rel": self.rel, "method": self.method,
            "title": self.title, "description": self.description,
            "mediaType": self.media_type, "expects": self.expects,
            "returns": self.returns, "target": self.target,
            "template": self.template,
            "readOnly": self.read_only, "idempotent": self.idempotent,
            "destructive": self.destructive, "unsafe": self.unsafe,
            "types": self.types, "source": self.source,
            "problem": problem, "warning": warning, "unlisted": unlisted,
        }
        if with_fields:
            public["fields"] = None if self.problem else [f.to_public() for f in self.fields]
        return public


# A control read from a JSON-LD node builds its fields, and the problem and
# warning they give, the first time one of the three is read: describe and
# invoke read one control's, so many controls that share one large shape cost
# the shape's size once, not once per control. A builder waits in the control's
# "_build" until then; an assignment to one of the three runs it first, so it
# never overwrites the value assigned. The page's controlFromNode is the same.
_BUILT_ON_READ = ("fields", "problem", "warning")


class _Unlisted(Exception):
    """A control list does not build, as its fields would pass the budget Descriptor.listing sets."""


# The fields joining a template to a control's own fields may build while list
# builds every control's: one for each so many characters of the document, and
# a fixed number besides (Descriptor.listing).
_LIST_BYTES_PER_FIELD = 64
_LIST_FIELDS_FIXED = 128


def _built_on_read(name: str) -> property:
    def read(self: Control) -> Any:
        if name == "problem" and self.__dict__.get("conflict"):
            return self.__dict__["conflict"]
        build = self.__dict__.pop("_build", None)
        if build is not None:
            try:
                built = build()
            except BaseException:
                # Not built (past list's budget, or a step's): built when next read.
                self.__dict__["_build"] = build
                raise
            for key, value in zip(_BUILT_ON_READ, built):
                self.__dict__["_built_" + key] = value
        return self.__dict__.get("_built_" + name)

    def write(self: Control, value: Any) -> None:
        read(self)
        self.__dict__["_built_" + name] = value
    return property(read, write)


for _name in _BUILT_ON_READ:
    setattr(Control, _name, _built_on_read(_name))


def _control_texts(control: Control) -> int:
    """The text a control carries into what is shown or written of it, in
    UTF-16 code units: its @id, name, method, title, description, media type,
    what it expects and returns, its target, its template and its types. The
    page's controlTexts is the same."""
    texts = (control.id, control.rel, control.method, control.title, control.description, control.media_type, control.expects,
             control.returns, control.target, control.template, *control.types)
    return sum(_utf16_length(text) for text in texts if isinstance(text, str))


def _field_texts(fld: Field) -> int:
    """The text a field carries into what is shown or written of it: its
    name, path, datatype, pattern and description, its default and each of
    its entries (_json_size). The page's fieldTexts is the same."""
    texts = (fld.name, fld.path, fld.datatype, fld.pattern, fld.description)
    return (sum(_utf16_length(text) for text in texts if isinstance(text, str)) + _json_size(fld.default)
            + sum(_json_size(entry) for entry in fld.enum))


def _charge_read(control: Control, problems: list[str]) -> None:
    """Charges a control read from a document (_spend): CONTROL_WORK, the
    text it carries and the problems reading it gave, however many controls
    share what they name, as a target or a template. The page's chargeRead
    is the same."""
    _spend(CONTROL_WORK + _control_texts(control) + sum(_utf16_length(problem) for problem in problems))


def _charge_shown(control: Control) -> None:
    """Charges showing a control, as the page does when it is opened and
    describe and invoke do: it builds its fields, then CONTROL_WORK, the text
    it carries, its problem and its warning; and, for a control that is
    invoked, FIELD_WORK and the text of each field, one at a time, so a
    step past its budget stops at the field that passes it. The page's
    chargeShown is the same."""
    problem = control.problem
    warning = control.warning
    _spend(CONTROL_WORK + _control_texts(control) + _utf16_length(problem or "") + _utf16_length(warning or ""))
    if not problem:
        for fld in control.fields:
            _spend(FIELD_WORK + _field_texts(fld))


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
    # Why what is listed is not read as safe, when it is not: the JSON-LD a
    # retry answered, the authority for this answer, was refused.
    problem: str | None = None
    index: Any = None
    # Its text's size in bytes as received, which sets each step's budget of work (_Work).
    size: int = 0

    def listing(self) -> list[bool]:
        """Builds each control's fields for list and list --json, in the
        order they are listed, while the fields that joining a template to
        fields of a control's own builds (_read_control_inputs) stay within a
        budget the document's length sets; whether each was built. One past
        it is listed without its fields (and the problems they would give),
        which describe and invoke build, as the page builds a control's
        fields only when it is opened: so controls whose own fields a large
        template's mappings each match, or whose schemas each type its
        variables, cannot make list cost the product of the two."""
        index = self.index
        if index is not None:
            index.listing = [index.size // _LIST_BYTES_PER_FIELD + _LIST_FIELDS_FIXED]
        built: list[bool] = []
        try:
            for control in self.controls:
                try:
                    control.problem
                    built.append(True)
                except _Unlisted:
                    built.append(False)
        finally:
            if index is not None:
                index.listing = None
        return built

    def matches(self, rel: str) -> list[Control]:
        """The controls a name given on the command line names: those it names
        exactly (as an action or an @id), or else those whose short name it is.
        The page's matchControls is the same."""
        rel = (rel or "").strip()
        if not rel:
            return []
        # A name expands as the document's own IRIs did, so "iep:x" finds an action written "iep:x".
        full = self.context.expand_iri(rel, document_relative=True) if self.context else rel
        exact = [c for c in self.controls if c.rel in (rel, full) or c.id in (rel, full)]
        if exact:
            return exact
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
        return loose

    def find(self, rel: str) -> Control | None:
        """The one control a name names, or None when it names none or more
        than one: a short name two controls share is never read as the first."""
        found = self.matches(rel)
        return found[0] if len(found) == 1 else None

    def to_public(self) -> dict[str, Any]:
        """The descriptor as list --json writes it. Each field is written
        once, in fields, however many controls or shapes share it, and each
        sh:in list once, in inLists, which a field names as "in" by its place,
        an empty one (an sh:in or an enum given with no entry, which allows no
        value) among them, and None for a field that names none; each list of
        fields once, in fieldLists, as the places of its fields.
        Each control names its own list's place as fieldList, or None for a
        control that is not invoked, whose fields are not written, and as
        templateFields the place of its template's fields, which follow its
        own and which the controls that share the template share (_Joined), or
        None. What is written grows with the document, never with the product
        of its controls and the fields, lists or texts they share: each field,
        list and control is charged as it is written (_spend), so one step of
        work writes all of it or, past its budget, none."""
        fields: list[dict[str, Any]] = []
        field_at: dict[int, tuple[Field, int]] = {}
        in_lists: list[list[Any]] = []
        in_at: dict[int, tuple[list[Any], int]] = {}
        field_lists: list[list[int]] = []
        list_at: dict[tuple[int, ...], int] = {}
        listed: dict[int, tuple[Any, int]] = {}
        built = self.listing()

        def place_of(fld: Field) -> int:
            hit = field_at.get(id(fld))
            if hit is None or hit[0] is not fld:
                _spend(FIELD_WORK + _field_texts(fld))
                public = fld.to_public()
                choices = fld.enum
                # An empty list is given: it allows no value, which no list leaves unsaid.
                if choices or fld.in_given or fld.empty == "enum":
                    seen = in_at.get(id(choices))
                    if seen is None or seen[0] is not choices:
                        seen = in_at[id(choices)] = (choices, len(in_lists))
                        in_lists.append(choices)
                    public["in"] = seen[1]
                else:
                    public["in"] = None
                hit = field_at[id(fld)] = (fld, len(fields))
                fields.append(public)
            return hit[1]

        def list_of(items: list[Field]) -> int:
            hit = listed.get(id(items))
            if hit is None or hit[0] is not items:
                _spend(len(items))
                places = tuple(place_of(fld) for fld in items)
                if places not in list_at:
                    list_at[places] = len(field_lists)
                    field_lists.append(list(places))
                hit = listed[id(items)] = (items, list_at[places])
            return hit[1]
        controls = []
        for control, whole in zip(self.controls, built):
            public = control.to_public(with_fields=False, unlisted=not whole)
            _spend(CONTROL_WORK + _control_texts(control) + _utf16_length(public["problem"] or "") + _utf16_length(public["warning"] or ""))
            own = template = None
            if whole and not control.problem:
                built = control.fields
                if isinstance(built, _Joined):
                    own, template = list_of(built.own), list_of(built.template.fields)
                else:
                    own = list_of(built)
            public["fieldList"] = own
            public["templateFields"] = template
            controls.append(public)
        return {
            "url": self.url, "title": self.title, "types": self.types,
            "description": self.description, "contentType": self.content_type,
            "seeAlso": self.see_also, "problem": self.problem,
            "fields": fields, "inLists": in_lists, "fieldLists": field_lists, "controls": controls,
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


# The keys of a node object that are not what it says about itself: a node
# object with none but these is a reference, or a graph's name.
_NOT_DESCRIPTION = frozenset({"@id", "@context", "@index", "@graph", "@included"})


class _Facts:
    """What is read of one node again and again (NodeIndex.facts): its keys
    by the property each names, the values of several joined, what reading
    its values for a property gives (NodeIndex.kept), its types, whether it
    is a shape that constrains nothing, its hints' summary, and what it says
    of sh:closed."""

    __slots__ = ("node", "keys", "values", "reads", "types", "trivial", "hints", "closed")

    def __init__(self, node: dict[str, Any], keys: dict[str, list[str]]) -> None:
        self.node = node
        self.keys = keys
        self.values: dict[str, list[Any]] = {}
        self.reads: dict[tuple[str, str], Any] = {}
        self.types: list[str] | None = None
        self.trivial: bool | None = None
        self.hints: dict[str, _HintRead] | None = None
        self.closed: _ClosedRead | None = None


def _describes(item: dict[str, Any]) -> bool:
    """Whether a node object says something about its node: a key other than
    its @id, @context, @index, @graph or @included."""
    return any(key not in _NOT_DESCRIPTION for key in item)


def _node_walk(document: Any) -> list[dict[str, Any]]:
    """Every object in a document, each once, in the order a depth-first walk
    meets them with each object's keys taken in sorted order (by UTF-16 code
    unit, as the page sorts them), skipping @context. A stack, so a deep
    document costs linear time. The page's nodeWalk is the same."""
    out: list[dict[str, Any]] = []
    seen: set[int] = set()
    stack: list[Any] = [document]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(reversed(item))
            continue
        if not isinstance(item, dict) or id(item) in seen:
            continue
        seen.add(id(item))
        out.append(item)
        for key in sorted(item, key=_utf16_key, reverse=True):
            if key != "@context" and isinstance(item[key], (dict, list)):
                stack.append(item[key])
    return out


class NodeIndex:
    def __init__(self, document: Any, base: str, fetched_from: str | None = None, inexact: set[Any] | None = None,
                 size: int | None = None) -> None:
        # `base` is the descriptor's address; `fetched_from`, when it differs,
        # is the address its text came from, which relative IRIs resolve
        # against; `inexact`, the doubles of the numbers its text writes with
        # digits their doubles drop (_changed_numbers), whose every reading may
        # have been rounded; `size`, its text's length in UTF-16 code units,
        # which sets how much text expanding its IRIs may produce (_Budget),
        # or, for a document handed over without its text, its JSON's.
        if size is None:
            size = _utf16_length(json.dumps(document, ensure_ascii=False)) if isinstance(document, (dict, list)) else 0
        self.size = size
        # While list builds every control's fields, what is left of its budget (Descriptor.listing).
        self.listing: list[int] | None = None
        self.ctx = Context(fetched_from or base, _Budget(size))
        self.inexact: set[Any] = inexact if inexact is not None else set()
        self.base = base
        self.nodes: dict[str, dict[str, Any]] = {}
        self.order: list[dict[str, Any]] = []
        # Each blank node's label, keyed by its id() with the node kept: a node
        # with no @id is never given one, so it is never merged with another.
        self.labels: dict[int, tuple[dict[str, Any], str]] = {}
        self.root: dict[str, Any] | None = None
        # Each template node's (template, mappings, problems), read once
        # (_address_of), and each shape's fields and the problems they give,
        # built once (_shared_shape_fields); keyed by the node's id(), with the
        # node kept so the id stays its own.
        self.templates: dict[int, tuple[Any, tuple[str | None, list[dict[str, Any]], list[str]]]] = {}
        self.shapes: dict[int, tuple[Any, list[Field], list[str], str | None, Any]] = {}
        # Each RDF list's members, read once, keyed by its first node's id()
        # with the node kept; and the id() of the first node of the list each
        # list node was read in (rdf_list). Beside them, each RDF list's
        # members' text as a set, made once and keyed the same way (list_texts).
        self.lists: dict[int, tuple[Any, tuple[list[Any], str | None]]] = {}
        self.list_owners: dict[int, int] = {}
        self.list_sets: dict[int, tuple[Any, set[str]]] = {}
        # Each control's inputs, built once for all the controls that read
        # them from the same shape and mappings (_control_inputs), so they share
        # one list of fields; keyed by what they are read from, which is kept.
        self.inputs: dict[tuple[Any, ...], tuple[Any, tuple[list[Field], str | None, str | None]]] = {}
        # Each property shape's or supported property's field, built once
        # however many shapes name the node (_cached_field), and each template's
        # own fields, built once from its mappings alone (_template_fields);
        # keyed by the node's or the mappings' id(), which is kept.
        self.fields: dict[tuple[int, Any], tuple[Any, Field | None, list[str]]] = {}
        self.mapped: dict[int, tuple[Any, _TemplateFields]] = {}
        # What is read of a node again and again, kept the first time it is
        # read, keyed by the node's id() with the node kept (_Facts): its keys
        # by the property each names (get), its types (types_of), whether a
        # shape constrains nothing (_trivial_shape), what its hints say
        # (_hint_flags), what it says of sh:closed (_closed_shape), and what
        # reading its values for a property gives (kept). So a node that many
        # controls, fields or mappings name costs its keys and values once, not
        # once for each, however many it has. Nothing changes a node once the
        # document is indexed, and every key is read in this index's context.
        # The page's NodeIndex.facts is the same; it also keeps whether a node
        # describes itself, which _describes finds at its first keys and the
        # page's describes lists every key for.
        self.facts: dict[int, _Facts] = {}
        self._ingest_document(document, fetched_from)

    def facts_of(self, node: dict[str, Any]) -> "_Facts":
        """A node's kept facts (self.facts), its keys by the property each
        names among them: each key is listed under itself and, unless it is a
        keyword, under the property it expands to."""
        facts = self.facts.get(id(node))
        if facts is not None and facts.node is node:
            return facts
        keys: dict[str, list[str]] = {}
        for key in node:
            keys.setdefault(key, []).append(key)
            if not key.startswith("@"):
                pred = self.ctx.expand_key(key)
                if pred != key:
                    keys.setdefault(pred, []).append(key)
        facts = self.facts[id(node)] = _Facts(node, keys)
        return facts

    def kept(self, node: Any, predicate: str, kind: str, read: Any) -> Any:
        """What `read` makes of a node's values for a property, kept for the
        node (facts_of) under `kind` where they are an array or an object, so
        a node that many inputs or mappings name costs reading its values
        once, however many it holds and however many name it. `read` is given
        the values alone, and each kind is one reading of them. The page's
        kept is the same."""
        raw = self.get(node, predicate)
        if not isinstance(node, dict) or not isinstance(raw, (list, dict)):
            return read(raw)
        reads = self.facts_of(node).reads
        key = (kind, predicate)
        if key not in reads:
            reads[key] = read(raw)
        return reads[key]

    def distinct_of(self, node: Any, predicate: str, key: Any = None) -> tuple[list[Any], str | None, str | None]:
        """A node's values for a property as _distinct_read reads them, told
        apart by their text, their count (_count_key) or their truth
        (_truthy_key), kept (kept). The page's distinctOf is the same."""
        key = key or _text
        kind = _DISTINCT_KINDS.get(key)
        if kind is None:
            return _distinct_read(self.get(node, predicate), key)
        return self.kept(node, predicate, kind, lambda raw: _distinct_read(raw, key))

    def label_of(self, node: Any, predicate: str) -> Any:
        """The first value of a node's property that reads as one value (_label), kept (kept)."""
        return self.kept(node, predicate, "label", _label)

    def _ingest_document(self, document: Any, fetched_from: str | None) -> None:
        """Indexes every node object in the document: first the ones at its
        top, in its @graph (and in each named graph's @graph within it) and in
        @included, in document order; then every other one, wherever it is
        written, in the order a walk of the document meets them, each object's
        keys taken in sorted order. A node with an @id is merged into the node
        already indexed at it, so each @id is one node however many places
        describe it, as JSON-LD merges a node's descriptions; a node with none
        is a blank node, its own node. The page's _ingest is the same."""
        if not isinstance(document, (dict, list)):
            return
        node_objects = self.ctx.normalize(document)
        walk = _node_walk(document)
        handled: set[int] = {id(document)}
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
            handled.add(id(value))
            if any(k not in {"@id", "@context", "@graph", "@included"} for k in value):
                node = self._add(value)
                first_any = first_any or node
                node_id = node.get("@id")
                if first_named is None and isinstance(node_id, str) and node_id and not node_id.startswith("_:"):
                    first_named = node
            pending.extend([value.get("@included"), value.get("@graph")])
        for item in walk:
            if id(item) in node_objects and id(item) not in handled and _describes(item):
                self._add(item)
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

    def _add(self, node: dict[str, Any]) -> dict[str, Any]:
        """Adds a node, or merges it into the node already indexed at its @id:
        a key that node lacks is added, and a key both have gets the other's
        values, objects written in place included, so a method, a target or a
        hint written in two places is read in both, as JSON-LD merges a node's
        values. A node with no @id is a blank node: it is indexed as itself,
        with a label to show it by, and is never given an @id, which would merge
        it with a node a document names so (by its action, or by a label like
        the one it is shown by). The page's _add is the same."""
        node_id = node.get("@id")
        if not isinstance(node_id, str) or not node_id:
            hit = self.labels.get(id(node))
            if hit is None or hit[0] is not node:
                self.labels[id(node)] = (node, f"_:n{len(self.order)}")
                self.order.append(node)
            return node
        existing = self.nodes.get(node_id)
        if existing is None:
            self.nodes[node_id] = node
            self.order.append(node)
            return node
        if existing is node:
            return existing
        for key, val in node.items():
            if key in ("@id", "@context"):
                continue
            if key not in existing:
                existing[key] = val
                continue
            more = as_list(val)
            if more:
                _merge_value(existing, key, more)
        return existing

    def ident(self, node: dict[str, Any]) -> str:
        """The IRI or blank node label a node is named by: its @id, or the label
        a blank node is shown by; "" for an object that is not indexed."""
        node_id = node.get("@id")
        if isinstance(node_id, str) and node_id:
            return node_id
        hit = self.labels.get(id(node))
        return hit[1] if hit is not None and hit[0] is node else ""

    def _harvest_embedded(self) -> None:
        """Every node object is indexed by now (_ingest_document). A reference
        under an affordance-like key to a node the document does not describe
        is indexed too, as a node with nothing but its @id, so every reference
        to it names one node. The page's _harvest is the same."""
        for current in list(self.order):
            for key in sorted(current, key=_utf16_key):
                val = current[key]
                pred = self.ctx.expand_key(key)
                if pred not in HARVESTED and local_name(pred) not in HARVESTED_NAMES:
                    continue
                for item in as_list(val):
                    if isinstance(item, dict) and "@value" not in item:
                        ident = item.get("@id")
                        if isinstance(ident, str) and ident and ident not in self.nodes:
                            self._add(item)

    def get(self, node: dict[str, Any] | None, predicate: str) -> Any:
        """A node's values for a property: those of every key that names it,
        joined in the order of the keys' names, as jsonld.js joins them, so two
        terms for one property are both read and both clients read the same
        value first. Only when no key names it is a key the context does not
        define (no term, alias or null, and no compact or absolute IRI) read by
        the property's local name, as a plain JSON document's "target" is. The
        page's get is the same. The keys that name the property are looked up
        among the node's kept facts (facts_of), and the values of several kept
        once joined, so reading a node costs its keys once however many times
        it is read. Nothing a caller is given is changed."""
        if not node:
            return None
        if isinstance(node, dict):
            facts = self.facts_of(node)
            keys = facts.keys.get(predicate)
            if keys is not None and len(keys) == 1:
                return node[keys[0]]
            if keys:
                joined = facts.values.get(predicate)
                if joined is None:
                    joined = facts.values[predicate] = [value for key in sorted(keys, key=_utf16_key) for value in as_list(node[key])]
                return joined
        else:
            keys = [key for key in node
                    if key == predicate or (not key.startswith("@") and self.ctx.expand_key(key) == predicate)]
            if len(keys) == 1:
                return node[keys[0]]
            if keys:
                return [value for key in sorted(keys, key=_utf16_key) for value in as_list(node[key])]
        want = local_name(predicate)
        ctx = self.ctx
        if (want and want in node and not want.startswith("@") and ":" not in want
                and want not in ctx.terms and want not in ctx.aliases and want not in ctx.nulled):
            return node[want]
        return None

    def node(self, ident: Any) -> dict[str, Any] | None:
        iri = raw_id(ident)
        if iri and isinstance(iri, (str, int, float)):
            found = self.nodes.get(str(iri))
            if found:
                return found
        # A plain string naming a node as its "@id" was written before expansion, such as "#S".
        if isinstance(ident, str) and ident:
            full = self.ctx.lookup(ident)
            if full != ident and full in self.nodes:
                return self.nodes[full]
        if isinstance(ident, dict) and any(k != "@id" for k in ident):
            return ident
        return None

    def types_of(self, node: dict[str, Any] | None) -> list[str]:
        """A node's types, kept (facts_of): one list, which no caller changes."""
        if not isinstance(node, dict):
            return [str(self.ctx.expand_iri(x, vocab=True)) for x in literals(self.get(node, P_TYPE) or (node or {}).get("@type"))]
        facts = self.facts_of(node)
        if facts.types is None:
            facts.types = [str(self.ctx.expand_iri(x, vocab=True)) for x in literals(self.get(node, P_TYPE) or node.get("@type"))]
        return facts.types

    def _list_node(self, item: Any) -> dict[str, Any] | None:
        """The node an RDF list value names, written in place or by its @id,
        when it has an rdf:first or rdf:rest; else None."""
        if isinstance(item, dict) and ("@value" in item or "@list" in item):
            return None
        node = self.node(item)
        if node is not None and (self.get(node, P_FIRST) is not None or self.get(node, P_REST) is not None):
            return node
        return None

    def rdf_list(self, head: Any) -> tuple[list[Any], str | None]:
        """The members of an RDF list of rdf:first / rdf:rest nodes, and why it
        could not be read: a node with other than one rdf:first and one
        rdf:rest, a rest that is no list node, a cycle, a member this reader
        does not read as one value, or a node of another list (two lists that
        share their tail). A list is read once however many values name it,
        so lists cost their size once. The page's rdfList is the same."""
        first = self._list_node(head)
        if first is None:
            return [], None
        hit = self.lists.get(id(first))
        if hit is None or hit[0] is not first:
            hit = self.lists[id(first)] = (first, self._walk_list(first))
        return hit[1]

    def _walk_list(self, first: dict[str, Any]) -> tuple[list[Any], str | None]:
        out: list[Any] = []
        seen: set[int] = set()
        node: dict[str, Any] | None = first
        while node is not None:
            if id(node) in seen:
                return out, "a malformed RDF list"
            seen.add(id(node))
            owner = self.list_owners.get(id(node))
            if owner is not None and owner != id(first):
                return out, "an RDF list that shares nodes with another list"
            self.list_owners[id(node)] = id(first)
            firsts = [x for x in as_list(self.get(node, P_FIRST)) if x is not None]
            rests = [x for x in as_list(self.get(node, P_REST)) if x is not None]
            if len(firsts) != 1 or len(rests) != 1:
                return out, "a malformed RDF list"
            ok, value = _value_of(firsts[0])
            if not ok:
                return out, f"a list with {value} in it"
            if value is not None:
                out.append(value)
            rest = raw_id(rests[0])
            if isinstance(rest, str) and self.ctx.expand_iri(rest) == P_NIL:
                return out, None
            node = self._list_node(rests[0])
            if node is None:
                return out, "a malformed RDF list"
        return out, None

    def list_head(self, raw: Any) -> dict[str, Any] | None:
        """The first node of the one RDF list a value such as sh:in's names, or
        None. The page's listHead is the same."""
        items = [item for item in as_list(raw) if item is not None]
        return self._list_node(items[0]) if len(items) == 1 else None

    def names_nil(self, item: Any) -> bool:
        """Whether a value names rdf:nil, the empty RDF list: an IRI, written
        as a string or as a node's @id, that is rdf:nil once expanded, as a
        list's rdf:rest is read. The page's namesNil is the same."""
        iri = (None if "@value" in item or "@list" in item else item.get("@id")) if isinstance(item, dict) else item
        return isinstance(iri, str) and self.ctx.lookup(iri) == P_NIL

    def empty_list(self, raw: Any) -> bool:
        """Whether a list value is the empty list, which allows nothing in
        sh:in, sh:or, sh:xone and sh:languageIn and asks nothing in sh:and:
        written as an array with no value in it, a JSON-LD list object with
        none ({"@list": []}, a null dropped as JSON-LD drops it), or rdf:nil.
        One with more than one value is more than one list, which is not
        empty. The page's emptyList is the same."""
        items = [item for item in as_list(raw) if item is not None]
        if not items:
            return True
        if len(items) > 1:
            return False
        item = items[0]
        if isinstance(item, dict) and "@list" in item:
            return all(ok and value is None for ok, value in (_value_of(member) for member in as_list(item["@list"])))
        return self.names_nil(item)

    def list_values(self, raw: Any) -> tuple[list[Any], str | None, bool]:
        """The members of a list value such as sh:in's: a JSON-LD list object
        ({"@list": [...]}), an RDF list of rdf:first / rdf:rest nodes or
        rdf:nil, or a plain array of values; why it could not be read, or
        None; and whether it holds more than one list. A member is read as
        _value_of reads one, so {"@value": v} is v and {"@id": i} is i. The
        page's listValues is the same."""
        items = [item for item in as_list(raw) if item is not None]
        lists = [item for item in items if isinstance(item, dict) and "@list" in item]
        if lists:
            if len(items) > 1:
                return [], None, True
            members = as_list(lists[0]["@list"])
        else:
            # rdf:nil is the empty list, as it ends a list: no member, never the IRI as one.
            heads = [item for item in items if self._list_node(item) is not None or self.names_nil(item)]
            if heads:
                if len(items) > 1:
                    return [], None, True
                found, why = self.rdf_list(heads[0])
                return found, why, False
            # A blank node that is no list node is no value: a list head the document does not describe.
            if any(_blank_label(item) is not None for item in items if isinstance(item, dict)):
                return [], "a malformed RDF list", False
            members = items
        out: list[Any] = []
        for member in members:
            ok, value = _value_of(member)
            if not ok:
                return out, f"a list with {value} in it", False
            if value is not None:
                out.append(value)
        return out, None, False

    def list_texts(self, raw: Any) -> tuple[set[str], str | None, bool]:
        """The text of each member of a list value (list_values) as a set, why
        it could not be read, and whether it holds more than one list. An RDF
        list's set is made once, kept beside its members (rdf_list) and keyed
        by its first node as they are, so many shapes whose
        sh:ignoredProperties names one list cost its length once, not once
        for each shape. No caller changes the set. The page's listTexts is
        the same."""
        members, why, several = self.list_values(raw)
        first = None if several else self.list_head(raw)
        if first is None:
            return {_text(item) for item in members}, why, several
        hit = self.list_sets.get(id(first))
        if hit is None or hit[0] is not first:
            hit = self.list_sets[id(first)] = (first, {_text(item) for item in members})
        return hit[1], why, several


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


def _present(value: Any) -> bool:
    """Whether a property has a value: JSON-LD drops null and an empty array,
    and keeps anything else, false, 0, "" and {} included. The page's present
    is the same, so neither client reads JSON's truth and falsity."""
    return value is not None and (not isinstance(value, list) or any(item is not None for item in value))


_OPERATION_TYPES = frozenset({HYDRA + "Operation", IEP + "Affordance", IEH + "Affordance", HMD + "Control"})
_NOT_OPERATION_TYPES = frozenset({HYDRA + "IriTemplate", HYDRA + "IriTemplateMapping", SHACL + "NodeShape", SHACL + "PropertyShape"})


def _node_of(index: NodeIndex, item: Any) -> dict[str, Any] | None:
    """The node a value names, read as the document describes it, never as
    the object that names it: for an object with an @id (aliased, compact or
    relative, all expanded by now) or an IRI string, the node indexed at that
    IRI, every description of it merged; for a node written in place with no
    @id, itself. None for a value that names no node the document describes:
    a literal, or a reference to an @id it says nothing about. Each caller
    reads one level, so a reference that loops back costs nothing more. The
    page's nodeOf is the same."""
    if item is None or (isinstance(item, dict) and ("@value" in item or "@list" in item)):
        return None
    found = index.node(item)
    return found if found is not None and _describes(found) else None


def _blank_label(item: Any) -> str | None:
    """The label of a blank node a value names, or None."""
    ident = item.get("@id") if isinstance(item, dict) and "@value" not in item else item
    return ident if isinstance(ident, str) and ident.startswith("_:") else None


def _looks_like_operation(index: NodeIndex, node: dict[str, Any]) -> bool:
    """Whether a node no affordance-like key names is an operation: one typed
    as one, or one that names a method and an action, a target or a template,
    whatever else it is typed as, so a node that says what it sends is never
    left out; or, unless it is typed as a template or a shape, one that names
    an action and what it expects, a title or a target. The page's
    looksLikeOp is the same."""
    types = set(index.types_of(node))
    if types & _OPERATION_TYPES:
        return True
    def has(predicate: str) -> bool:
        return _present(index.get(node, predicate))
    if has(P_METHOD) and (has(P_ACTION) or has(P_TARGET) or has(P_TEMPLATE)):
        return True
    if types & _NOT_OPERATION_TYPES:
        return False
    return has(P_ACTION) and (has(P_EXPECTS) or has(P_TITLE) or has(P_TARGET))


def _text(value: Any) -> str:
    """Remote text as a string; a JSON value that is not a string as its JSON,
    written as the page's JSON.stringify writes it, with no spaces."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list, bool)):
        return _js_json(value)
    if isinstance(value, float):
        return _js_number_text(value)
    return str(value)


# The readings a node keeps of its values (NodeIndex.distinct_of), one for each key.
_DISTINCT_KINDS = {_text: "text", _count_key: "count", _truthy_key: "truthy"}


def _json_value(value: Any) -> Any:
    """A JSON literal written as a value object, {"@type": "@json", "@value": v}, as v."""
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict) and value.get("@type") == "@json" and "@value" in value:
        return value["@value"]
    return value


def _is_json_schema(value: Any) -> bool:
    """A JSON Schema written in place: an object whose "properties" is an
    object, or whose keys are JSON Schema's (_schema_by_keywords). The page's
    isJsonSchema is the same."""
    return isinstance(value, dict) and P_SH_PROP not in value and (isinstance(value.get("properties"), dict) or _schema_by_keywords(value))


_REST_PARAM = "rest-param-"


_LINE_BREAKS = ("\n", "\r", "\u2028", "\u2029")


def _field_name(name: Any, path: str | None, variable: str | None) -> str:
    """Turns "rest-param-<x>-<name>" into "<name>": the text after the last "-"
    that has at least one character on each side of it. Found by a scan, not a
    pattern, so a long crafted name costs linear time. A name with a line break
    in it (LF, CR, U+2028 or U+2029, wherever it is) is kept whole. The page's
    fieldName is the same."""
    if variable:
        return str(variable)
    raw = _text(name) or local_name(path) or "value"
    if not raw.startswith(_REST_PARAM) or any(brk in raw for brk in _LINE_BREAKS):
        return raw
    cut = raw.rfind("-", 0, len(raw) - 1)
    return raw[cut + 1:] if cut > len(_REST_PARAM) else raw


def _schema_types(prop: dict[str, Any]) -> list[str]:
    """A JSON Schema property's types: each string its "type" names but "null"."""
    return [item for item in as_list(prop.get("type")) if isinstance(item, str) and item and item != "null"]


def _schema_json_kind(types: list[str]) -> str | None:
    structured = [item for item in types if item in {"object", "array"}]
    others = [item for item in types if item not in {"object", "array"}]
    if not structured or others:
        return None
    if "object" in structured and "array" in structured:
        return "json"
    return structured[0]


_SCHEMA_DATATYPES = {
    "string": XSD + "string", "integer": XSD + "integer",
    "number": XSD + "decimal", "boolean": XSD + "boolean",
}


def _schema_datatype(types: list[str]) -> str | None:
    if len(types) == 1:
        return _SCHEMA_DATATYPES.get(types[0])
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


def _shacl_json_kind(index: NodeIndex, node: dict[str, Any], datatype: str | None, max_count: int | None,
                     node_kind: str | None) -> str | None:
    dt = datatype or ""
    if _is_rdf_json(dt):
        return "json"
    if dt:
        return None
    nested = index.get(node, P_SH_NODE)
    blank = node_kind == "BlankNode"
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


# SHACL constraints on an input that this client does not check, so a value
# given for it is refused by name (a property shape's own sh:property among
# them, which constrains its value node); those that relate the input to other
# properties or count its values that conform to a shape, which keep the control
# from being invoked; those on a shape as a whole, which do too; and the value
# constraints a shape may put on its own focus node, which make a body sent
# whole of a shape with no properties, and keep a control whose shape has
# properties from being invoked, since no input checks the body as a whole. The
# six node kinds SHACL names. The page's SHAPE_UNCHECKED, SHAPE_UNREAD,
# SHAPE_NODE_UNREAD, SHAPE_NODE_VALUE and NODE_KINDS are the same.
_SHAPE_UNCHECKED = ("class", "or", "and", "xone", "not", "languageIn", "sparql", "property")
_SHAPE_UNREAD = ("qualifiedValueShape", "equals", "disjoint", "lessThan", "lessThanOrEquals")
_SHAPE_NODE_UNREAD = ("class", "or", "and", "xone", "not", "node", "sparql", "qualifiedValueShape")
_SHAPE_NODE_VALUE = ("datatype", "minLength", "maxLength", "in", "hasValue", "nodeKind", "pattern", "languageIn",
                     "minInclusive", "maxInclusive", "minExclusive", "maxExclusive")
_NODE_KINDS = frozenset({"IRI", "Literal", "BlankNode", "BlankNodeOrIRI", "IRIOrLiteral", "BlankNodeOrLiteral"})
# The SHACL parameters whose value is a list. One is given when it is written
# at all, as an array with no value in it among the rest, so an empty list is
# read as SHACL reads it, never as no constraint: sh:in (), sh:or (),
# sh:xone () and sh:languageIn () allow no value, and sh:and () asks nothing.
# The page's LIST_PARAMS and shaclGiven are the same.
_LIST_PARAMS = frozenset({"in", "or", "and", "xone", "languageIn"})


def _shacl_given(index: NodeIndex, node: Any, key: str) -> bool:
    raw = index.get(node, SHACL + key)
    if key not in _LIST_PARAMS:
        return _present(raw)
    return raw is not None and not (key == "and" and index.empty_list(raw))


# What a shape may say of itself that constrains nothing: its type, label,
# comment, name and description.
_SHAPE_NOTES = frozenset({P_TYPE, P_LABEL, P_COMMENT, P_SH_NAME, P_SH_DESC})


def _trivial_shape(index: NodeIndex, ref: Any) -> bool:
    """Whether a sh:node names a shape this document describes that constrains
    nothing, which every node conforms to, so it is met without being checked.
    A shape it does not describe, or one that says anything else, is not. The
    page's trivialShape is the same."""
    node = _node_of(index, ref)
    if node is None:
        return False
    # Read once for each shape, however many inputs name it (facts_of).
    facts = index.facts_of(node)
    if facts.trivial is None:
        facts.trivial = all(key in ("@id", "@type") if key.startswith("@") else index.ctx.expand_key(key) in _SHAPE_NOTES
                            for key in node)
    return facts.trivial


class _Facets:
    """Reads the facets of one input (a SHACL property shape, a hydra:
    SupportedProperty, or a shape whose own datatype makes a request body),
    each one it acts on as one value, adding to `problems` what _one_of and
    _count_of find. `subject` names the input in a problem. What its one,
    count and describe read is kept for the node (NodeIndex.distinct_of,
    label_of), so a node many inputs name, such as a hydra:property, costs its
    values once. The page's facets is the same."""

    def __init__(self, index: NodeIndex, node: dict[str, Any], problems: list[str], subject: str) -> None:
        self.index, self.node, self.problems, self.subject = index, node, problems, subject

    def one(self, predicate: str, label: str, key: Any = None) -> Any:
        return _one_of(self.index.distinct_of(self.node, predicate, key), label, self.problems, "what it takes", self.subject,
                       "this control is not invoked")

    def text(self, predicate: str, label: str) -> str | None:
        return _text(self.one(predicate, label)) or None

    def count(self, predicate: str, label: str) -> int | None:
        return _count_of(self.index.distinct_of(self.node, predicate, _count_key), label, self.problems, self.subject)

    def enum(self) -> list[Any] | None:
        """The entries of its sh:in, or None where it names none: an empty
        list is sh:in given, which allows no value (_empty_of)."""
        raw = self.index.get(self.node, P_SH_IN)
        if raw is None:
            return None
        found, why, several = self.index.list_values(raw)
        if several:
            self.problems.append(f"{self.subject} names more than one sh:in, so what it takes is not known; this control is not invoked")
        elif why is not None:
            self.problems.append(f"{self.subject} writes sh:in as {why}, which this client does not read, so what it takes is not "
                                 "known; this control is not invoked")
        return found

    def defaults(self, multi: bool) -> Any:
        """A field's default: every value for a field that takes a list, else one."""
        if not multi:
            return self.one(P_SH_DEF, "sh:defaultValue")
        found: list[Any] = []
        for item in as_list(self.index.get(self.node, P_SH_DEF)):
            ok, value = _value_of(item)
            if not ok:
                self.problems.append(f"{self.subject} writes sh:defaultValue as {value}, which this client does not read, so what "
                                     "it takes is not known; this control is not invoked")
                break
            if value is not None:
                found.append(value)
        return found or None

    def extra(self) -> dict[str, Any]:
        """The facets of an input beyond those every field has: exclusive
        bounds, sh:hasValue and sh:nodeKind, which are checked; the constraints
        this client does not check, named in "unchecked" so that a value given
        is refused, never sent unchecked (sh:node only when the shape it names
        constrains something, sh:uniqueLang and sh:closed unless false); and those that relate the input to others or
        count its conforming values, which keep the control from being invoked.
        A sh:nodeKind is one of SHACL's six. A list parameter whose list is
        empty is read as SHACL reads it (_shacl_given): sh:and () asks nothing,
        and sh:or (), sh:xone () and sh:languageIn () allow no value, named in
        "empty". The page's facets.extra is the same."""
        index, node = self.index, self.node
        unchecked: list[str] = []
        empty: list[str] = []
        for key in _SHAPE_UNCHECKED:
            if not _shacl_given(index, node, key):
                continue
            if key in _LIST_PARAMS and index.empty_list(index.get(node, SHACL + key)):
                empty.append("sh:" + key)
            else:
                unchecked.append("sh:" + key)
        # sh:uniqueLang and sh:closed constrain nothing when false.
        for key in ("uniqueLang", "closed"):
            flag = index.get(node, SHACL + key)
            if _present(flag) and truthy(_label(flag)) is not False:
                unchecked.append("sh:" + key)
        nested = index.get(node, P_SH_NODE)
        if _present(nested) and not all(ref is None or _trivial_shape(index, ref) for ref in as_list(nested)):
            unchecked.append("sh:node")
        for key in _SHAPE_UNREAD:
            if _present(index.get(node, SHACL + key)):
                self.problems.append(f"{self.subject} names sh:{key}, which this client does not check, so what it takes is not "
                                     "known; this control is not invoked")
        kind_text = self.text(P_SH_NODEKIND, "sh:nodeKind")
        node_kind = None
        if kind_text:
            local = kind_text[len(SHACL):] if kind_text.startswith(SHACL) else (kind_text[3:] if kind_text.startswith("sh:") else None)
            if local is not None and local in _NODE_KINDS:
                node_kind = local
            else:
                self.problems.append(f"{self.subject} names a sh:nodeKind this client does not read ({kind_text}), so what it takes "
                                     "is not known; this control is not invoked")
        return {"unchecked": unchecked, "empty": empty, "node_kind": node_kind, "has_value": self.one(P_SH_HASVALUE, "sh:hasValue"),
                "min_exclusive": self.one(P_SH_MINE, "sh:minExclusive"), "max_exclusive": self.one(P_SH_MAXE, "sh:maxExclusive")}

    def describe(self, *predicates: str) -> str | None:
        """The first description that reads as one value, of the first predicate that gives one: shown, never acted on."""
        for predicate in predicates:
            found = self.index.label_of(self.node, predicate)
            if found is not None and found != "":
                return _text(found)
        return None


def _subject(name: Any, path: Any) -> str:
    """How a problem names an input: by the name the field would get from the
    first name and path that read as one value."""
    return f'the input "{_field_name(name, path if isinstance(path, str) else None, None)}"'


def _empty_of(enum: list[Any] | None, extra: dict[str, Any]) -> str | None:
    """The constraint whose empty list allows a field no value, or None: its
    sh:in given with no entry, or an empty sh:or, sh:xone or sh:languageIn
    (extra's "empty"). A JSON Schema field's is an enum with no entry at the
    top of its schema (_schema_field). The page's emptyOf is the same."""
    if enum is not None and not any(entry is not None for entry in enum):
        return "sh:in"
    return extra["empty"][0] if extra["empty"] else None


def _empty_text(fld: Field) -> str:
    """How a problem says a field allows no value. The page's emptyText is the same."""
    return f"{'its schema' if fld.json_schema else 'its shape'} allows no value ({fld.empty} is empty)"


def _supported_field(index: NodeIndex, ref: Any, problems: list[str]) -> Field | None:
    """A field for one hydra:SupportedProperty: named by its hydra:property's
    local name, or, for a property written in place as a blank node (as
    Interego's manifests write one), by that property's rdfs:label; required
    when hydra:required is true; constrained by the SHACL facets on it."""
    sp = _node_of(index, ref)
    if sp is None:
        if ref is not None:
            problems.append(f"the class names a hydra:supportedProperty {_text(raw_id(ref))}, which this document does not describe, "
                            "so what it takes is not known; this control is not invoked")
        return None
    props = [item for item in as_list(index.get(sp, P_PROPERTY)) if item is not None]
    head = props[0] if props else None
    prop_node = _node_of(index, head)
    if isinstance(head, dict):
        iri = head.get("@id")
    else:
        # Hydra's context types hydra:property as @vocab, so a plain "schema:text" names an IRI.
        iri = index.ctx.lookup(head, True) if isinstance(head, str) else None
    named = isinstance(iri, str) and bool(iri) and not iri.startswith("_:")
    shown_label = index.label_of(prop_node, P_LABEL) if prop_node else None
    shown = _label(index.get(sp, P_SH_NAME)) or (local_name(iri) if named else None) or shown_label
    facets = _Facets(index, sp, problems, _subject(shown, None))
    if len({_text(p.get("@id")) if isinstance(p, dict) and isinstance(p.get("@id"), str) else _js_json(p) for p in props}) > 1:
        problems.append(f"{facets.subject} names more than one hydra:property, so what it takes is not known; this control is not invoked")
    name = facets.one(P_SH_NAME, "sh:name")
    if (name is None or name == "") and not named and prop_node:
        name = _Facets(index, prop_node, problems, facets.subject).one(P_LABEL, "rdfs:label")
    elif name is None or name == "":
        name = local_name(iri) if named else None
    if name is None or _text(name) == "":
        return None
    datatype = facets.text(P_SH_DT, "sh:datatype")
    if not datatype and prop_node:
        declared = _Facets(index, prop_node, problems, facets.subject).one(P_RANGE, "rdfs:range")
        if _xsd_name(declared) is not None or _is_rdf_json(declared):
            datatype = _text(declared)
    min_count = facets.count(P_SH_MIN, "sh:minCount")
    max_count = facets.count(P_SH_MAX, "sh:maxCount")
    json_kind = "json" if _is_rdf_json(datatype) else None
    multi = _is_multi(json_kind, min_count, max_count, False)
    extra = facets.extra()
    required = (truthy(facets.one(P_REQUIRED, "hydra:required", _truthy_key)) is True or (min_count or 0) >= 1
                or extra["has_value"] is not None)
    # Hydra's hydra:writable false says a client does not change the property, so
    # a value given for it is refused; a value that is not true reads as false.
    writable = facets.one(P_WRITABLE, "hydra:writable", _truthy_key)
    enum = facets.enum()
    description = facets.describe(P_SH_DESC, P_COMMENT, P_DESC) or (
        _Facets(index, prop_node, problems, facets.subject).describe(P_COMMENT) if prop_node else None)
    fld = Field(
        name=_field_name(name, iri if named else None, None), path=iri if named else None,
        datatype=datatype, json_kind=json_kind,
        min_count=min_count if min_count is not None else (1 if required else None), max_count=max_count,
        pattern=facets.text(P_SH_PAT, "sh:pattern"),
        default=facets.defaults(multi),
        max_length=facets.count(P_SH_MAXLEN, "sh:maxLength"), min_length=facets.count(P_SH_MINLEN, "sh:minLength"),
        description=description,
        enum=enum or [], in_given=enum is not None, empty=_empty_of(enum, extra),
        min_inclusive=facets.one(P_SH_MINI, "sh:minInclusive"), max_inclusive=facets.one(P_SH_MAXI, "sh:maxInclusive"),
        min_exclusive=extra["min_exclusive"], max_exclusive=extra["max_exclusive"], has_value=extra["has_value"],
        node_kind=extra["node_kind"], unchecked=extra["unchecked"], not_writable=writable is not None and truthy(writable) is not True,
        required=required, multi=multi, in_list=index.list_head(index.get(sp, P_SH_IN)),
    )
    # A property that is not written is never given its default either.
    if fld.not_writable:
        fld.default = None
    return fld


_PATH_KEYS = (SHACL + "inversePath", SHACL + "alternativePath", SHACL + "zeroOrMorePath", SHACL + "oneOrMorePath",
              SHACL + "zeroOrOnePath", P_FIRST, P_REST)


def _complex_path(index: NodeIndex, path: str) -> bool:
    """Whether a sh:path names more than one property: a blank node, which a
    predicate path never is, or a node that is an inverse, alternative or
    repeated path or an RDF list. The page's complexPath is the same."""
    if path.startswith("_:"):
        return True
    node = index.nodes.get(path)
    return node is not None and any(index.get(node, key) is not None for key in _PATH_KEYS)


def _schema_field(name: str, prop0: Any, required: bool, problems: list[str]) -> Field:
    """The field for one JSON Schema property, `name`, whose schema is
    `prop0`, and the problems reading it gives: its schema's own
    (_read_schema), a reference, a union of types that is no one input's, and
    choices written alike. The page's schemaField is the same."""
    prop = prop0 if isinstance(prop0, dict) else {}
    subject = _subject(name, None)
    ref_key = next((key for key in ("$ref", "@id") if key in prop), None)
    if ref_key is not None:
        # A reference is not read here: what it names is not known, and its own keys are not the property's.
        problems.append(f"{subject} writes its JSON Schema as a reference ({ref_key}), which this client does "
                        "not read, so what it takes is not known; this control is not invoked")
    read_problems, unchecked = _read_schema(prop0, subject)
    problems.extend(read_problems)
    enum = prop.get("enum")
    written = [t for t in as_list(prop.get("type")) if isinstance(t, str)] if "type" in prop else None
    types = _schema_types(prop)
    json_kind = _schema_json_kind(types)
    datatype = None if json_kind else (_schema_datatype(types) or XSD + "string")
    # Types that are not one input's: a union with no string in it (a string
    # can always be sent as text), other than numbers alone (a number) or an
    # array and an object (JSON). Where the property names choices, its value
    # is one of them, and is read as one; otherwise it is a problem. The page
    # reads the same.
    if written is not None and not json_kind and "string" not in types and not (len(types) == 1 and types[0] in _SCHEMA_DATATYPES):
        if types and all(t in ("integer", "number") for t in types):
            datatype = XSD + "decimal"
        elif not isinstance(enum, list) and "const" not in prop:
            problems.append(f"{subject} names JSON Schema types ({', '.join(written)}) that this client does not read as one "
                            "input, so what it takes is not known; this control is not invoked")
    # An array's length is bounded by minItems and maxItems, whichever other types the property allows.
    items = json_kind in ("array", "json")
    fld = Field(
        name=str(name), path=str(name),
        datatype=datatype,
        json_kind=json_kind,
        min_count=1 if required else 0, max_count=1,
        min_items=_inty(prop.get("minItems")) if items else None,
        max_items=_inty(prop.get("maxItems")) if items else None,
        # A readOnly property is not the client's to write, so it is never given its default.
        pattern=_text(prop.get("pattern")) or None, default=None if prop.get("readOnly") is True else prop.get("default"),
        max_length=_inty(prop.get("maxLength")), min_length=_inty(prop.get("minLength")),
        description=prop.get("description"), enum=list(enum) if isinstance(enum, list) else [],
        # An enum given with no entry allows no value: not one with no enum.
        empty="enum" if isinstance(enum, list) and not enum else None,
        min_inclusive=prop.get("minimum"), max_inclusive=prop.get("maximum"),
        required=required,
        json_schema=True, schema=prop0, schema_types=written, nullable=written is not None and "null" in written,
        unchecked=unchecked, null_default="default" in prop and prop["default"] is None and prop.get("readOnly") is not True,
    )
    fld.choices = _schema_choices(fld, problems, subject)
    return fld


def _shape_fields(index: NodeIndex, shape_ref: Any) -> tuple[list[Field], list[str]]:
    """The fields a shape gives, and the problems reading their facets gave:
    a JSON Schema's properties, a SHACL shape's sh:property, a hydra:Class's
    hydra:supportedProperty, or one field for the whole body of a shape whose
    own value constraints (a datatype, a length, choices, a bound, a node
    kind) make one. The page's shapeFields is the same."""
    fields: list[Field] = []
    problems: list[str] = []
    shape_ref = _json_value(shape_ref)
    if _is_json_schema(shape_ref):
        # "required" is a list of names, and each "enum" a list: anything else is a problem, not a value read as one.
        named = as_list(shape_ref.get("required"))
        if isinstance(shape_ref.get("required"), dict) or not all(isinstance(name, str) for name in named):
            problems.append("the JSON Schema writes required as something other than a list of names, which this client does not "
                            "read, so which inputs it needs is not known; this control is not invoked")
        required = {name for name in named if isinstance(name, str)}
        properties = shape_ref["properties"] if isinstance(shape_ref.get("properties"), dict) else {}
        if "properties" in shape_ref and not isinstance(shape_ref["properties"], dict):
            problems.append("the JSON Schema writes properties as something other than an object, which this client does not read, so "
                            "what it sends is not known; this control is not invoked")
        # readOnly on the body's schema says the body is not the client's to write.
        if shape_ref.get("readOnly") is True:
            problems.append("the JSON Schema of the body is read-only (readOnly true), so nothing is written to it; this control is "
                            "not invoked")
        elif "readOnly" in shape_ref and not isinstance(shape_ref["readOnly"], bool):
            problems.append("the JSON Schema writes readOnly as something other than a boolean, which this client does not read, so "
                            "what it sends is not known; this control is not invoked")
        # The schema of the whole body: it describes an object, each name it
        # requires is one of its properties, and it has no keyword this client
        # does not check, an enum and a const among them, which constrain the
        # body as a whole. The body holds the properties' names, and a
        # template's variables that are none of them, whose schema is
        # additionalProperties (_control_inputs). The page reads the same.
        root_types = as_list(shape_ref.get("type")) if "type" in shape_ref else None
        if root_types is not None and "object" not in root_types:
            problems.append("the JSON Schema describes something other than an object, which this client does not send, so what "
                            "it sends is not known; this control is not invoked")
        for name in dict.fromkeys(n for n in named if isinstance(n, str)):
            if name not in properties:
                problems.append(f'the JSON Schema requires "{name}", which it does not describe, so what it sends is not known; '
                                "this control is not invoked")
        for key in (*_UNCHECKED_KEYWORDS, "enum", "const"):
            if key in shape_ref and not (key == "uniqueItems" and shape_ref[key] is False):
                problems.append(f"the JSON Schema names {key}, which this client does not check, so what it sends is not known; "
                                "this control is not invoked")
        # A JSON-LD keyword is no JSON Schema keyword: one written in place may
        # keep its own @id and @type (normalize refuses any other), and one a
        # JSON literal holds, which is JSON, keeps none.
        in_place = id(shape_ref) in index.ctx.schemas
        for key in sorted(shape_ref, key=_utf16_key):
            if isinstance(key, str) and key.startswith("@") and not (in_place and key in ("@id", "@type")):
                problems.append(f"the JSON Schema names {key}, which this client does not check, so what it sends is not known; "
                                "this control is not invoked")
        for name, prop0 in properties.items():
            fields.append(_schema_field(name, prop0, name in required, problems))
        return fields, problems
    shape = index.node(shape_ref)
    if not shape:
        return fields, problems
    # A constraint on the shape as a whole constrains the body it describes, which no field checks.
    for key in _SHAPE_NODE_UNREAD:
        if _shacl_given(index, shape, key):
            problems.append(f"the shape names sh:{key}, which this client does not check, so what it sends is not known; this "
                            "control is not invoked")
    props = index.get(shape, P_SH_PROP)
    supported = None if _present(props) else index.get(shape, P_SUPPROP)
    valued = [key for key in _SHAPE_NODE_VALUE if _shacl_given(index, shape, key)]
    if _present(props) or _present(supported):
        # A value constraint on a shape with properties is on the body those make, which no input checks.
        for key in valued:
            problems.append(f"the shape names sh:{key}, which this client does not check, so what it sends is not known; this "
                            "control is not invoked")
    if not _present(props):
        if _present(supported):
            built = [f for f in (_cached_field(index, item, problems, _supported_field) for item in _once_each(index, supported)) if f]
            shared = _shared_list_problem(built)
            if shared:
                problems.append(shared)
            return built, problems
        if valued:
            # The body sent whole, checked against the shape's own facets as an input is against its property's.
            facets = _Facets(index, shape, problems, "the request body")
            label = _text(facets.one(P_LABEL, "rdfs:label"))
            name = "query" if ("query" in label.lower() or "sparql" in label.lower()) else "body"
            datatype = facets.text(P_SH_DT, "sh:datatype") or XSD + "string"
            extra = facets.extra()
            body = Field(
                name=name,
                path=shape.get("@id") if isinstance(shape, dict) else None,
                datatype=datatype, json_kind="json" if _is_rdf_json(datatype) else None,
                min_count=1, max_count=1, required=True, raw_body=True,
                pattern=facets.text(P_SH_PAT, "sh:pattern"),
                min_length=facets.count(P_SH_MINLEN, "sh:minLength"),
                max_length=facets.count(P_SH_MAXLEN, "sh:maxLength"),
                description=facets.describe(P_COMMENT, P_SH_DESC) or "",
                enum=facets.enum(), min_inclusive=facets.one(P_SH_MINI, "sh:minInclusive"),
                max_inclusive=facets.one(P_SH_MAXI, "sh:maxInclusive"),
                min_exclusive=extra["min_exclusive"], max_exclusive=extra["max_exclusive"], has_value=extra["has_value"],
                node_kind=extra["node_kind"], unchecked=extra["unchecked"],
            )
            body.in_given = body.enum is not None
            body.empty = _empty_of(body.enum, extra)
            body.enum = body.enum or []
            fields.append(body)
        return fields, problems
    for pref in _once_each(index, props):
        node = _node_of(index, pref)
        if node is None:
            problems.append(f"the shape names a sh:property {_text(raw_id(pref))}, which this document does not describe, so what it "
                            "takes is not known; this control is not invoked")
            continue
        fld = _cached_field(index, node, problems, _property_field)
        if fld is not None:
            fields.append(fld)
    shared = _shared_list_problem(fields)
    if shared:
        problems.append(shared)
    return fields, problems


def _cached_field(index: NodeIndex, ref: Any, problems: list[str], build: Any) -> Field | None:
    """The field a property shape or a hydra:SupportedProperty gives, built
    once per node and builder however many shapes or classes name it, with
    the problems reading it gave, added to `problems` each time: many shapes
    that name one node share one Field, so what is written of it, a long
    description among the rest, is written once (Descriptor.to_public). A
    node one shape names as a property shape and a class as a supported
    property is read by each builder as its own kind, since the two read it
    differently (path, name, required, writable): a field built one way is
    never the other's. So a node many shapes or classes name is read once,
    not once for each. The page's cachedField is the same."""
    node = _node_of(index, ref)
    if node is None:
        return build(index, ref, problems)
    key = (id(node), build)
    hit = index.fields.get(key)
    if hit is None or hit[0] is not node:
        own: list[str] = []
        hit = index.fields[key] = (node, build(index, ref, own), own)
    problems.extend(hit[2])
    return hit[1]


def _property_field(index: NodeIndex, node: dict[str, Any], problems: list[str]) -> Field:
    """The field one SHACL property shape gives, and the problems reading its facets give. The page's shapeFields reads the same."""
    facets = _Facets(index, node, problems, _subject(_label(index.get(node, P_SH_NAME)), _label(index.get(node, P_SH_PATH))))
    path = facets.text(P_SH_PATH, "sh:path") or ""
    if path and _complex_path(index, path):
        problems.append(f"{facets.subject} writes sh:path as a complex SHACL path, which this client does not read, so what it "
                        "takes is not known; this control is not invoked")
    name = facets.one(P_SH_NAME, "sh:name")
    enum = facets.enum()
    min_count = facets.count(P_SH_MIN, "sh:minCount")
    max_count = facets.count(P_SH_MAX, "sh:maxCount")
    datatype = facets.text(P_SH_DT, "sh:datatype")
    extra = facets.extra()
    json_kind = _shacl_json_kind(index, node, datatype, max_count, extra["node_kind"])
    multi = _is_multi(json_kind, min_count, max_count, True)
    # Node values go in one JSON array (or, for one at most, one object), so its length is their count.
    counted = json_kind in ("array", "object")
    return Field(
        name=_field_name(_text(name) or None, path, None),
        path=path or None,
        datatype=datatype,
        json_kind=json_kind,
        min_count=min_count, max_count=max_count,
        min_items=min_count if counted else None, max_items=max_count if counted else None,
        pattern=facets.text(P_SH_PAT, "sh:pattern"),
        default=facets.defaults(multi),
        max_length=facets.count(P_SH_MAXLEN, "sh:maxLength"),
        min_length=facets.count(P_SH_MINLEN, "sh:minLength"),
        description=facets.describe(P_SH_DESC, P_COMMENT, P_DESC),
        enum=enum or [], in_given=enum is not None, empty=_empty_of(enum, extra),
        min_inclusive=facets.one(P_SH_MINI, "sh:minInclusive"),
        max_inclusive=facets.one(P_SH_MAXI, "sh:maxInclusive"),
        min_exclusive=extra["min_exclusive"], max_exclusive=extra["max_exclusive"], has_value=extra["has_value"],
        node_kind=extra["node_kind"], unchecked=extra["unchecked"],
        required=(min_count or 0) >= 1 or extra["has_value"] is not None, multi=multi,
        in_list=index.list_head(index.get(node, P_SH_IN)),
    )


def _once_each(index: NodeIndex, values: Any) -> list[Any]:
    """The values of a shape's sh:property or a class's
    hydra:supportedProperty, each node they name once: RDF reads a value given
    twice as one, so a node named many times is one input, never one for each
    time it is named, which would cost the product of the two. A value that
    names no node the document describes is kept once by its text, so the
    problem it gives is named once. The page's onceEach is the same."""
    seen: set[tuple[str, Any]] = set()
    out: list[Any] = []
    for value in as_list(values):
        if value is None:
            continue
        node = _node_of(index, value)
        key = ("node", id(node)) if node is not None else ("text", _text(raw_id(value)))
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _shared_list_problem(fields: list[Field]) -> str | None:
    """One RDF list that is the sh:in of two inputs would be offered, and
    named in a problem, once for each, so a document could make that cost the
    product of the inputs and the list's length: the control is not invoked.
    The page's sharedListProblem is the same."""
    owner: dict[int, Field] = {}
    for fld in fields:
        if fld.in_list is None:
            continue
        first = owner.get(id(fld.in_list))
        if first is not None:
            return (f'the inputs "{first.name}" and "{fld.name}" share one sh:in list, which this client would show and check once '
                    "for each, at a cost the document's size does not bound; this control is not invoked")
        owner[id(fld.in_list)] = fld
    return None


def _address_of(index: NodeIndex, node: dict[str, Any]) -> tuple[str | None, list[dict[str, Any]], bool, str | None, list[str]]:
    """Where a control sends: its IRI template and the template's mappings,
    whether the template is its hydra:target, the IRI its target names, and
    the problems reading them gave. A template of the control's own with a
    variable in it comes first; then its hydra:target (or, when it has none,
    its hmd:target), each value an IRI or a hydra:IriTemplate, as Interego's
    decoration catalogs write one; then a template reached through
    hydra:search or a key named for a template; then a template of its own
    with no variable. A target, template, variable, property or required flag
    with more than one distinct value, or one it cannot read, is a problem, and
    so is a template node (a target, a search or a template-named key's value
    that has a hydra:template or is typed hydra:IriTemplate) with no
    hydra:template it reads: it is never read as the address of the node
    itself, nor passed over for another address. A template node many
    controls share is read once (index.templates), so its mappings cost their
    size once, not once per control. The page's addressOf is the same."""
    def read_template_node(tmpl: Any) -> tuple[str | None, list[dict[str, Any]], list[str]]:
        if not tmpl:
            return None, [], []
        hit = index.templates.get(id(tmpl))
        if hit is None or hit[0] is not tmpl:
            hit = index.templates[id(tmpl)] = (tmpl, read_template(tmpl))
        return hit[1]

    def read_template(tmpl: Any) -> tuple[str | None, list[dict[str, Any]], list[str]]:
        problems: list[str] = []
        template = _one(index.get(tmpl, P_TEMPLATE), "hydra:template", problems, "where it sends")
        found = []
        for item in as_list(index.get(tmpl, P_MAPPING)):
            if item is None:
                continue
            mn = _node_of(index, item)
            if mn is None:
                # A mapping the document does not describe names a variable this client cannot read.
                problems.append(f"this control names a hydra:mapping {_text(raw_id(item))}, which this document does not describe, so "
                                "where it sends is not known; it is not invoked")
                continue
            # A mapping node many mappings name is read once (NodeIndex.distinct_of).
            variable = _one_of(index.distinct_of(mn, P_VARIABLE), "hydra:variable in one hydra:mapping", problems, "where it sends")
            # Hydra's context types hydra:property as @vocab, so a plain "schema:query" names an IRI.
            prop = _one_of(index.distinct_of(mn, P_PROPERTY), "hydra:property in one hydra:mapping", problems, "which input fills it")
            required = _one_of(index.distinct_of(mn, P_REQUIRED, _truthy_key), "hydra:required in one hydra:mapping", problems,
                               "which inputs it needs")
            found.append({
                "variable": _text(variable) or None,
                "property": _text(index.ctx.lookup(prop, True) if isinstance(prop, str) else prop) or None,
                "required": truthy(required),
            })
        return (_text(template) or None), found, problems

    def as_template(item: Any) -> dict[str, Any] | None:
        tmpl = _node_of(index, item)
        if tmpl and (index.get(tmpl, P_TEMPLATE) is not None or HYDRA + "IriTemplate" in index.types_of(tmpl)):
            return tmpl
        return None

    def unread(label: str, template_problems: list[str]) -> list[str]:
        return template_problems or [f"this control names a hydra:IriTemplate as its {label} with no hydra:template, so where it "
                                     "sends is not known; it is not invoked"]

    problems: list[str] = []
    own, own_mappings, own_problems = read_template_node(node)
    if index.get(node, P_TEMPLATE) is not None:
        problems.extend(own_problems)
    # Each distinct target once, keyed by its text: ("template", template, mappings, problems) or ("iri", iri).
    first: tuple[Any, ...] | None = None
    for pred, label in ((P_TARGET, "hydra:target"), (P_HMDTARGET, "hmd:target")):
        entries: dict[str, tuple[Any, ...]] = {}
        why = None
        unreadable = False
        for item in as_list(index.get(node, pred)):
            if item is None:
                continue
            tmpl = as_template(item)
            if tmpl is not None:
                template, mappings, template_problems = read_template_node(tmpl)
                if template is None:
                    problems.extend(unread(label, template_problems))
                    unreadable = True
                else:
                    entries.setdefault(template, ("template", template, mappings, template_problems))
                continue
            ok, value = _value_of(item)
            if not ok:
                why = value
                break
            blank = _blank_label(item)
            if blank is not None:
                # A blank node is no address: one that is no template is not sent to.
                state = "this document does not describe" if _node_of(index, item) is None else "that is no hydra:IriTemplate"
                problems.append(f"this control names {label} {blank}, a blank node {state}, so where it sends is not known; "
                                "it is not invoked")
                unreadable = True
                continue
            if value is not None and value != "":
                entries.setdefault(_text(value), ("iri", _text(value)))
        if why is not None:
            problems.append(f"this control writes {label} as {why}, which this client does not read, so where it sends is not known; "
                            "it is not invoked")
        elif len(entries) > 1:
            problems.append(f"this control names more than one {label} ({', '.join(entries)}), so where it sends is not known; "
                            "it is not invoked")
        if entries or why is not None or unreadable:
            first = next(iter(entries.values()), None)
            break
    target = first[1] if first is not None and first[0] == "iri" else None
    if own is not None and "{" in own:
        return own, own_mappings, False, target, problems
    if first is not None and first[0] == "template":
        problems.extend(first[3])
        return first[1], first[2], True, None, problems
    searched: dict[str, tuple[str, list[dict[str, Any]], list[str]]] = {}
    for key, val in node.items():
        if key.startswith("@"):
            continue
        pred = index.ctx.expand_key(key)
        if pred not in {P_TEMPLATE, P_SEARCH} and "template" not in local_name(pred).lower():
            continue
        label = "hydra:search" if pred == P_SEARCH else key
        for item in as_list(val):
            if item is None:
                continue
            tmpl = as_template(item)
            if tmpl is None:
                # A hydra:search is a template; a template-named key's text is not read (hydra:template's own was, above).
                if pred == P_SEARCH:
                    problems.append("this control writes hydra:search as something other than a hydra:IriTemplate, so where it sends "
                                    "is not known; it is not invoked")
                continue
            template, mappings, template_problems = read_template_node(tmpl)
            if template is None:
                problems.extend(unread(label, template_problems))
            else:
                searched.setdefault(template, (template, mappings, template_problems))
    if searched:
        if len(searched) > 1:
            problems.append(f"this control names more than one hydra:search ({', '.join(searched)}), so where it sends is not known; "
                            "it is not invoked")
        template, mappings, template_problems = next(iter(searched.values()))
        problems.extend(template_problems)
        return template, mappings, False, target, problems
    return own, [], False, target, problems


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
                          base: _FieldIndex | None = None, steps: list[tuple[str, Any, int]] | None = None) -> list[Field]:
    """Joins a template's mappings to the fields. Each mapping, in order,
    renames the first field, in field order, whose path is its hydra:property,
    or else the first field now named as its variable, or else the first whose
    path ends in its variable; a mapping that matches none adds a field. The
    fields given are not changed: a matched field is copied, so fields a shape
    gives several controls stay as they are. Positions are looked up in maps
    (`base`, the given fields' _FieldIndex, when it is at hand), and the first
    field of a name, which renames change, in a heap per name, so the work is
    linear in the mappings beyond copying the list. `steps`, when given, gets
    each mapping's variable, property and how it matched: 1 by path, 2 by
    name, 3 by local name, 4 none. The page's mergeMappings is the same."""
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
        step = 1
        if at is None:
            at, step = first_named(variable), 2
        if at is None:
            at, step = base.by_local.get(variable, more_local.get(variable)), 3
        if steps is not None:
            steps.append((variable, prop, step if at is not None else 4))
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


_HINTS = (("destructiveHint", "iep:destructiveHint"), ("readOnlyHint", "iep:readOnlyHint"))


def _hint_problems(found: dict[str, set[bool]], why: dict[str, str | None]) -> list[str]:
    problems = []
    for hint, label in _HINTS:
        if why[hint] is not None:
            problems.append(f"this control writes {label} as {why[hint]}, which this client does not read, so whether it is safe "
                            "is not known; it is not invoked")
        elif len(found[hint]) > 1:
            problems.append(f"this control names more than one {label} (false, true), so whether it is safe is not known; "
                            "it is not invoked")
    return problems


def _hint_flags(index: NodeIndex | None, node: dict[str, Any]) -> tuple[bool | None, bool | None, list[str]]:
    """What a node says, under every key whose name ends in destructiveHint or
    readOnlyHint, about whether it destroys or writes: its own keys, such as a
    hint under a prefix the context does not define, and the keys of an object
    written directly inside it (or in a @list in it, or in a JSON literal),
    such as MCP's "annotations". An object with an @id, and a string (alone
    or in a @list), is read as the node the document describes at that @id,
    every description of it merged (_node_of), never as the reference itself,
    so a hint written on that node anywhere counts; annotations that name a
    node the document does not describe are a problem, whether an object or a
    string names it. Every value counts, merged descriptions of one @id
    included: any destructive true or read-only false is destructive or
    writing, and so is a value that is no boolean (_hint_value). True and
    false both, or a value in a form the reader does not read, is a problem.
    Read only to fail closed: neither hint ever makes a control safe. What
    each object says is read once for each node however many controls name it
    (_hint_summary), and each it reads is charged one unit (_spend), so a node
    many controls name costs its keys once and one unit for each. The page's
    hintFlags is the same."""
    objects = [node]
    missing: list[str] = []
    for key, val in node.items():
        if key.startswith("@"):
            continue
        names = {local_name(key), local_name(index.ctx.expand_key(key))} if index else {local_name(key)}
        for item in as_list(val):
            if isinstance(item, dict) and item.get("@type") == "@json" and "@value" in item:
                # A JSON literal, such as "annotations" under a term typed "@json": its hints count too.
                objects.extend(x for x in as_list(item["@value"]) if isinstance(x, dict))
            elif isinstance(item, str) or (isinstance(item, dict) and "@value" not in item):
                members = ([x for x in as_list(item["@list"])
                            if isinstance(x, str) or (isinstance(x, dict) and "@value" not in x and "@list" not in x)]
                           if isinstance(item, dict) and "@list" in item else [item])
                for member in members:
                    # A string names a node as an object with that @id does: under a term typed
                    # "@id" or "@vocab" JSON-LD reads them alike, and under any other term a
                    # node it names is read too, since more hints can only make a control less safe.
                    text = isinstance(member, str)
                    if text and index is None:
                        continue
                    if text:
                        found = _node_of(index, member) if member else None
                    else:
                        found = member if index is None else _node_of(index, member)
                    ident = member if text else member.get("@id")
                    if found is not None:
                        objects.append(found)
                    elif "annotations" in names and isinstance(ident, str) and not missing:
                        missing.append(f"this control names {key} {_text(ident)}, which this document does not describe, so "
                                       "whether it is safe is not known; it is not invoked")
    found: dict[str, set[bool]] = {hint: set() for hint, _ in _HINTS}
    unread = {hint: False for hint, _ in _HINTS}
    why: dict[str, str | None] = {hint: None for hint, _ in _HINTS}
    for obj in objects:
        summary = _hint_summary(index, obj)
        _spend(1)
        for hint, _ in _HINTS:
            read = summary[hint]
            found[hint] |= read.found
            if read.unread:
                unread[hint] = True
            if read.why is not None and why[hint] is None:
                why[hint] = read.why
    destructive = found["destructiveHint"]
    writes = found["readOnlyHint"]
    destructive_flag = (True if True in destructive or unread["destructiveHint"] or why["destructiveHint"]
                        else (False if destructive else None))
    read_only = (False if False in writes or unread["readOnlyHint"] or why["readOnlyHint"]
                 else (True if writes else None))
    return destructive_flag, read_only, _hint_problems(found, why) + missing


class _HintRead:
    """What one object says about one hint (_hint_summary)."""

    __slots__ = ("found", "unread", "why")

    def __init__(self) -> None:
        self.found: set[bool] = set()
        self.unread = False
        self.why: str | None = None


def _hint_summary(index: NodeIndex | None, obj: dict[str, Any]) -> dict[str, _HintRead]:
    """What one object says under its own keys, each whose name ends in
    destructiveHint or readOnlyHint, about each hint: the booleans it gives,
    whether it gives a value read as the unsafe one, and the first form it
    gives that this client does not read, in the order of its keys. Built
    once for each node however many controls name it (facts_of) and charged
    (_spend) when it is built: one unit for each key it has and each value
    under a hint. With no index (a HyperMarkdown block's hints) it is built
    each time it is read. The page's hintSummary is the same."""
    facts = index.facts_of(obj) if index is not None else None
    if facts is not None and facts.hints is not None:
        return facts.hints
    summary = {hint: _HintRead() for hint, _ in _HINTS}
    units = len(obj)
    for key, val in obj.items():
        if key.startswith("@"):
            continue
        names = {local_name(key), local_name(index.ctx.expand_key(key))} if index else {local_name(key)}
        for hint, _ in _HINTS:
            if hint not in names:
                continue
            read = summary[hint]
            for item in as_list(val):
                units += 1
                kind, value = _hint_value(item)
                if kind == "bool":
                    read.found.add(value)
                elif kind == "unread":
                    read.unread = True
                elif kind == "form" and read.why is None:
                    read.why = value
    _spend(units)
    if facts is not None:
        facts.hints = summary
    return summary


def _aliases(fld: Field) -> list[str]:
    """The names a field's value may be given under: its name, its template
    variable and its path's local name. The page's aliasesOf is the same."""
    return list(dict.fromkeys(a for a in (fld.name, fld.variable, local_name(fld.path) if fld.path else None) if a))


def _twin_names(name: str) -> str:
    return f"two input fields are both named '{name}', so their values could not be told apart; this control is not invoked"


def _twin_aliases(first: str, second: str, alias: str) -> str:
    return (f"the input fields '{first}' and '{second}' both take a value named '{alias}', so which one a value fills is not "
            "known; this control is not invoked")


def _duplicate_problem(fields: list[Field]) -> str | None:
    """The problem that keeps a control's values from being told apart: two
    fields of one name, or a name one field's value may be given under
    (_aliases) that is another field's too, so which input a value fills is
    not known. The page's duplicateProblem is the same."""
    seen: set[str] = set()
    for fld in fields:
        if fld.name in seen:
            return _twin_names(fld.name)
        seen.add(fld.name)
    owner: dict[str, Field] = {}
    for fld in fields:
        for alias in _aliases(fld):
            first = owner.setdefault(alias, fld)
            if first is not fld:
                return _twin_aliases(first.name, fld.name, alias)
    return None


class _TemplateFields:
    """A template's own fields, built once from its mappings alone
    (_merge_mapping_fields joining them to no field), which every control
    that shares the template and has no field a mapping would match
    (_joins_as_is) has after its own, unchanged and by reference (_Joined):
    the properties its mappings name, and the variables of those that matched
    none of its own fields by path, or by path or name, decide that. And, so
    _joined_duplicate_problem costs a control's own fields, not these, where
    each name and each name a value may be given under (_aliases) first
    appears in them, and the first problem two of them give alone."""

    def __init__(self, mappings: list[dict[str, Any]]) -> None:
        steps: list[tuple[str, Any, int]] = []
        self.fields = _merge_mapping_fields([], mappings, None, steps)
        self.props = {prop for _, prop, _ in steps if prop}
        self.unpathed = {variable for variable, _, step in steps if step != 1}
        self.unnamed = {variable for variable, _, step in steps if step not in (1, 2)}
        self.first_named: dict[str, int] = {}
        self.twin_name: int | None = None
        for at, fld in enumerate(self.fields):
            if fld.name in self.first_named:
                if self.twin_name is None:
                    self.twin_name = at
            else:
                self.first_named[fld.name] = at
        self.first_alias: dict[str, tuple[int, int]] = {}
        self.twin_alias: tuple[int, int, int, str] | None = None
        for at, fld in enumerate(self.fields):
            for rank, alias in enumerate(_aliases(fld)):
                first = self.first_alias.setdefault(alias, (at, rank))
                if first[0] != at and self.twin_alias is None:
                    self.twin_alias = (at, rank, first[0], alias)


def _template_fields(index: NodeIndex, mappings: list[dict[str, Any]]) -> _TemplateFields:
    """A template's _TemplateFields, built once however many controls share its mappings."""
    hit = index.mapped.get(id(mappings))
    if hit is None or hit[0] is not mappings:
        hit = index.mapped[id(mappings)] = (mappings, _TemplateFields(mappings))
    return hit[1]


def _joins_as_is(fields: list[Field], template: _TemplateFields) -> bool:
    """Whether no mapping of a template matches any of these fields, by path,
    by name or by its path's local name, so joining its mappings to them
    (_merge_mapping_fields) gives them unchanged, then the template's own
    fields: a mapping matches one of these first only where it would match
    one of the template's own fields no earlier."""
    for fld in fields:
        if fld.name in template.unpathed:
            return False
        if fld.path and (fld.path in template.props or local_name(fld.path) in template.unnamed):
            return False
    return True


class _Joined(Sequence):  # type: ignore[type-arg]
    """A control's own fields, then its template's (_TemplateFields), as one
    sequence that reads both lists in place and copies neither: each control
    that shares the template holds its own fields and the template, so many
    controls and many mappings cost their sum, not their product, and list
    and list --json name the template's fields for each control that shares
    them, and write them once."""

    def __init__(self, own: list[Field], template: _TemplateFields) -> None:
        self.own = own
        self.template = template

    def __len__(self) -> int:
        return len(self.own) + len(self.template.fields)

    def __getitem__(self, at: Any) -> Any:
        if isinstance(at, slice):
            return list(self)[at]
        size = len(self)
        if at < 0:
            at += size
        if not 0 <= at < size:
            raise IndexError(at)
        return self.own[at] if at < len(self.own) else self.template.fields[at - len(self.own)]

    def __iter__(self) -> Iterator[Field]:
        yield from self.own
        yield from self.template.fields


def _joined_duplicate_problem(own: list[Field], template: _TemplateFields) -> str | None:
    """_duplicate_problem of a control's own fields and then its template's,
    found at the cost of its own fields: the first of the template's that
    takes a name or an alias of its own, or the first two of the template's
    that give one alone, whichever comes first."""
    shared = template.fields
    seen: set[str] = set()
    for fld in own:
        if fld.name in seen:
            return _twin_names(fld.name)
        seen.add(fld.name)
    first = template.twin_name
    for name in seen:
        at = template.first_named.get(name)
        if at is not None and (first is None or at < first):
            first = at
    if first is not None:
        return _twin_names(shared[first].name)
    owner: dict[str, Field] = {}
    for fld in own:
        for alias in _aliases(fld):
            held = owner.setdefault(alias, fld)
            if held is not fld:
                return _twin_aliases(held.name, fld.name, alias)
    found: tuple[int, int, str, str] | None = None
    if template.twin_alias is not None:
        at, rank, held_at, alias = template.twin_alias
        found = (at, rank, shared[held_at].name, alias)
    for alias, fld in owner.items():
        hit = template.first_alias.get(alias)
        if hit is not None and (found is None or hit < found[:2]):
            found = (hit[0], hit[1], fld.name, alias)
    return _twin_aliases(found[2], shared[found[0]].name, found[3]) if found is not None else None


def _inline_fields(node: dict[str, Any]) -> list[Any] | None:
    """A control's own "fields" list, as the HyperMarkdown lift writes one, or
    None. The page's inlineFields is the same."""
    inline = node.get("fields")
    if isinstance(inline, list) and inline and isinstance(inline[0], dict) and (
        "name" in inline[0] or "path" in inline[0] or "datatype" in inline[0]
    ):
        return inline
    return None


# The keys a field written in place may give, which are the ones the
# substrate's HyperMarkdown lift writes and _inline_field reads. Any other, a
# constraint such as "in" or "minInclusive" among them, is not read, so the
# first one an entry gives is a problem that keeps the control from being
# invoked, never a constraint passed over. The page's INLINE_KEYS and
# inlineKeyProblem are the same.
_INLINE_KEYS = frozenset({"name", "path", "datatype", "minCount", "maxCount", "minLength", "maxLength", "pattern", "defaultValue",
                          "description"})
# The counts and lengths a field written in place may give: each a JSON number
# that is a whole number of zero or more. The lift drops any other (a
# fraction, text, true), and SHACL fails every value set against a negative
# one, so neither is passed over: it keeps the control from being invoked.
_INLINE_COUNTS = ("minCount", "maxCount", "minLength", "maxLength")


def _inline_key_problem(items: list[Any]) -> str | None:
    """The first problem the keys of the fields written in place give: a key
    the lift does not write, or a count or a length that is no whole number of
    zero or more. The page's inlineKeyProblem is the same."""
    for item in items:
        if not isinstance(item, dict):
            continue
        subject = _subject(item.get("name"), item.get("path"))
        key = next((k for k in _js_keys(item) if k not in _INLINE_KEYS), None)
        if key is not None:
            return (f"{subject} names {key}, which this client does not read in a field written in place, so what it takes is not "
                    "known; this control is not invoked")
        for key in _INLINE_COUNTS:
            value = item.get(key)
            number = _inty(value) if _is_number(value) else None
            if value is not None and (number is None or number < 0):
                return (f"{subject} names a {key} that is not a whole number ({_js_json(value)}), so what it takes is not known; this "
                        "control is not invoked")
    return None


def _inline_default(value: Any) -> Any:
    """A default written in place as the substrate's lift reads one: a number
    or a boolean as its text, as JavaScript writes it."""
    return _scalar_text(value) if isinstance(value, (bool, int, float)) else value


def _inline_field(item: dict[str, Any], inexact: set[Any] | None = None) -> Field:
    """A field from one entry of a control's own "fields" list or a
    HyperMarkdown block's, each text facet read as text, as the substrate's
    HyperMarkdown lift reads one into a property shape: a default that is a
    number or a boolean is its text, an rdf:JSON datatype takes JSON, and a
    minCount or a maxCount above 1 makes a list, as they do for a
    hydra:supportedProperty. A default that holds a number reading JSON may
    have rounded, of `inexact` (_changed_numbers) or an integer past 2^53, is
    refused, its text never sent in its place. The page's inlineDefault and
    inlineField are the same."""
    min_count = _inty(item.get("minCount"))
    max_count = _inty(item.get("maxCount"))
    path = _text(item.get("path")) or None
    datatype = _text(item.get("datatype")) or None
    json_kind = "json" if _is_rdf_json(datatype) else None
    fld = Field(
        name=_field_name(item.get("name"), path, None), path=path, datatype=datatype, json_kind=json_kind,
        min_count=min_count, max_count=max_count,
        pattern=_text(item.get("pattern")) or None, default=item.get("defaultValue"),
        max_length=_inty(item.get("maxLength")), min_length=_inty(item.get("minLength")),
        description=_text(item.get("description")), required=(min_count or 0) >= 1,
        multi=_is_multi(json_kind, min_count, max_count, False),
    )
    fld.inexact = inexact if inexact is not None else set()
    fld.rounded_default = _rounded_default(fld, fld.inexact)
    fld.default = _inline_default(item.get("defaultValue"))
    return fld


# Where a control writes its fields in place beside a shape hydra:expects names
# that the document describes, the shape's fields are its inputs, and each
# field written in place must be one of them and agree with it on each of these
# that it gives; otherwise which of the two says what the input takes is not
# known. The page's INLINE_COMPARED and inlineDisagreement are the same.
_INLINE_COMPARED = ("datatype", "minCount", "maxCount", "minLength", "maxLength", "pattern", "defaultValue")
_INLINE_FIELD_KEYS = {"minCount": "min_count", "maxCount": "max_count", "minLength": "min_length", "maxLength": "max_length"}


def _datatype_iri(datatype: Any) -> str:
    text = _text(datatype)
    return XSD + text[4:] if text.startswith("xsd:") else (RDF_JSON if text == "rdf:JSON" else text)


def _default_key(value: Any) -> str:
    while isinstance(value, list) and len(value) == 1:
        value = value[0]
    return _json_key(None if value is None else _inline_default(value))


def _inline_disagreement(items: list[dict[str, Any]], fields: list[Field]) -> str | None:
    by_name: dict[str, Field] = {}
    for fld in fields:
        by_name.setdefault(fld.name, fld)
    for item in items:
        subject = _subject(item.get("name"), item.get("path"))
        fld = by_name.get(_field_name(item.get("name"), _text(item.get("path")) or None, None))
        if fld is None:
            return (f"{subject} is written in place but is not in the shape hydra:expects names, so what it takes is not known; this "
                    "control is not invoked")
        for key in _INLINE_COMPARED:
            value = item.get(key)
            if value is None:
                continue
            if key == "datatype":
                agree = _datatype_iri(value) == _datatype_iri(fld.datatype)
            elif key == "pattern":
                agree = _text(value) == _text(fld.pattern)
            elif key == "defaultValue":
                agree = _default_key(value) == _default_key(fld.default)
            elif key == "minCount":
                agree = (_inty(value) or 0) == (fld.min_count or 0)
            else:
                agree = _inty(value) == getattr(fld, _INLINE_FIELD_KEYS[key])
            if not agree:
                return (f"{subject} written in place disagrees with the shape hydra:expects names on its {key}, so what it takes is not "
                        "known; this control is not invoked")
    return None


def _expects_warning(expects: Any, inline: bool, described: bool = False) -> str:
    """The warning a control shows when hydra:expects names a shape the
    document does not describe, whose fields written in place, if any, are
    all that is known, or one it describes with no input fields (a shape with
    no properties, a class with no supported property). The page's
    expectsWarning is the same."""
    if described:
        return (f"hydra:expects names {_text(expects) or 'a shape'}, which this document describes with no input fields, so no input "
                "fields were built: what the server expects is not known here.")
    rest = ("only the input fields written in place were built: what else the server expects is not known here." if inline
            else "no input fields were built: what the server expects is not known here.")
    return f"hydra:expects names {_text(expects) or 'a shape'}, which this document does not describe, so {rest}"


def _expects_of(index: NodeIndex, node: dict[str, Any], problems: list[str]) -> tuple[Any, Any]:
    """The one shape a control expects (a reference, a shape or JSON Schema
    written in place, or a JSON literal holding a JSON Schema) and the name it
    is shown by. More than one distinct shape, or a value in a form the reader
    does not read there (a JSON literal that holds anything but a JSON Schema
    among them), is a problem. The page's expectsOf is the same."""
    values = []
    for value in as_list(index.get(node, P_EXPECTS)):
        if isinstance(value, dict) and value.get("@type") == "@json" and "@value" in value and _is_json_schema(value["@value"]):
            value = value["@value"]
        if value is not None:
            values.append(value)
    shown: dict[str, str] = {}
    for value in values:
        if isinstance(value, dict) and "@value" not in value:
            ok, why = _value_of(value) if any(k in value for k in ("@list", "@set", "@graph")) else (True, None)
            if not ok:
                problems.append(f"this control writes hydra:expects as {why}, which this client does not read, so what it sends is "
                                "not known; it is not invoked")
                return None, None
            ident = value.get("@id")
            key = _text(ident) if isinstance(ident, str) else _js_json(value)
            shown.setdefault(key, _text(ident) if isinstance(ident, str) else "a shape written in place")
        else:
            ok, read = _value_of(value)
            if not ok:
                problems.append(f"this control writes hydra:expects as {read}, which this client does not read, so what it sends is "
                                "not known; it is not invoked")
                return None, None
            if read is not None:
                shown.setdefault(_text(read), _text(read))
    if len(shown) > 1:
        problems.append(f"this control names more than one hydra:expects ({', '.join(shown.values())}), so what it sends is not "
                        "known; it is not invoked")
    expects_raw = values[0] if values else None
    blank = _blank_label(expects_raw)
    if blank is not None and _node_of(index, expects_raw) is None:
        # A blank node is this document's own: one it does not describe names no shape anywhere.
        problems.append(f"this control names hydra:expects {blank}, a blank node this document does not describe, so what it sends "
                        "is not known; it is not invoked")
    if expects_raw is None or _is_json_schema(expects_raw):
        return expects_raw, None
    if isinstance(expects_raw, dict) and "@id" in expects_raw:
        return expects_raw, expects_raw["@id"]
    return expects_raw, _label(expects_raw)


def control_from_node(index: NodeIndex, node: dict[str, Any], source: str) -> Control:
    """A control read from a JSON-LD node. Every property that decides what it
    does is read as one value (_one); a problem any of them gives is its
    `conflict`, so it is listed with the writes and not invoked. The page's
    controlFromNode is the same."""
    problems: list[str] = []
    # A control that names no method is sent as the substrate's own follower
    # (invoke_affordance, act) sends it: POST. So it is never a safe read by
    # default. One that names several is not invoked, and shows the first of
    # them that is not safe, so it is never listed as a safe read either.
    method_values, why = _distinct(index.get(node, P_METHOD), lambda v: _template_scalar(v).upper())
    methods = [m for m in dict.fromkeys(_template_scalar(v).upper() for v in method_values) if m]
    if why is not None:
        problems.append(f"this control writes hydra:method as {why}, which this client does not read, so what it does is not known; "
                        "it is not invoked")
    elif len(methods) > 1:
        problems.append(f"this control names more than one hydra:method ({', '.join(methods)}), so what it does is not known; "
                        "it is not invoked")
    method = next((m for m in methods if m not in SAFE_METHODS), None) or (methods[0] if methods else "POST")
    template, mappings, template_is_target, target, address_problems = _address_of(index, node)
    problems.extend(address_problems)
    rel = _one(index.get(node, P_ACTION), "iep:action", problems, "which affordance it names")
    if rel is None or rel == "":
        rel = _one(index.get(node, P_REL), "hmd:rel", problems, "which affordance it names")
    rel = _text(rel) if rel is not None and rel != "" else index.ident(node)
    destructive, read_only, hint_problems = _hint_flags(index, node)
    problems.extend(hint_problems)
    # A control's own "fields" list, as the HyperMarkdown lift writes one, holds
    # each field written in place; an entry that names a node is not read there.
    named_entry = next((entry["@id"] for entry in (node.get("fields") if isinstance(node.get("fields"), list) else [])
                        if isinstance(entry, dict) and isinstance(entry.get("@id"), str)), None)
    if named_entry is not None:
        problems.append(f"this control writes fields with an entry that names a node ({_text(named_entry)}), which this client does "
                        "not read there, so what it sends is not known; it is not invoked")
    unread_key = _inline_key_problem(node["fields"]) if _inline_fields(node) is not None else None
    if unread_key is not None:
        problems.append(unread_key)
    expects_raw, expects = _expects_of(index, node, problems)
    media = _one(index.get(node, P_RETURNS_CT), "hydra:returnsContentType", problems, "what it returns")
    if media is None or media == "":
        media = _one(index.get(node, P_MEDIA), "dcat:mediaType", problems, "what it returns")
    # A shape's facets are read now, once per shape (_shared_shape_fields), so
    # an input that names two datatypes or two counts is a problem here too,
    # and so are they where the control also writes its fields in place.
    if expects_raw is not None:
        problems.extend(_shared_shape_fields(index, expects_raw)[1])
    title = _label(index.get(node, P_TITLE)) or _label(index.get(node, P_DCTITLE)) or _label(index.get(node, P_LABEL)) or short_rel(str(rel))
    description = _label(index.get(node, P_DESC)) or _label(index.get(node, P_DCDESC)) or _label(index.get(node, P_COMMENT)) or ""
    returns = _label(index.get(node, P_RETURNS))
    idempotent = _label(index.get(node, P_IDEMPOTENT))
    control = Control(
        id=_text(node.get("@id") or rel), rel=str(rel), method=method,
        title=_text(title), description=_text(description),
        media_type=_text(media) if media is not None and media != "" else None,
        expects=_text(expects) if expects else None,
        returns=_text(returns) if returns is not None and returns != "" else None,
        target=target or None, template=template,
        read_only=read_only, idempotent=truthy(idempotent), destructive=destructive,
        types=index.types_of(node), source=source, base=index.ctx.base,
        conflict=problems[0] if problems else None,
    )
    control.__dict__["_build"] = lambda: _control_inputs(index, node, expects_raw, expects, mappings)
    _charge_read(control, problems)
    return control


def _shared_shape_fields(index: NodeIndex, shape_ref: Any) -> tuple[list[Field], list[str], str | None, _FieldIndex | None]:
    """The fields a SHACL shape or a hydra:Class gives, built once per shape
    node however many controls name it, with the problems reading their
    facets gave, the problem two fields of one name give, and their
    _FieldIndex; a JSON Schema written in a control is its own. The list is
    shared, so it is never changed: _merge_mapping_fields copies."""
    shape = None if _is_json_schema(_json_value(shape_ref)) else index.node(_json_value(shape_ref))

    def build() -> tuple[list[Field], list[str]]:
        fields, problems = _shape_fields(index, shape_ref)
        for fld in fields:
            # A field many shapes share (_cached_field) is read for rounding once.
            if fld.inexact is not index.inexact:
                fld.inexact = index.inexact
                fld.rounded_default = _rounded_default(fld, index.inexact)
        return fields, problems
    if shape is None:
        fields, problems = build()
        return fields, problems, _duplicate_problem(fields), None
    hit = index.shapes.get(id(shape))
    if hit is None or hit[0] is not shape:
        fields, problems = build()
        hit = index.shapes[id(shape)] = (shape, fields, problems, _duplicate_problem(fields), _FieldIndex(fields))
    return hit[1], hit[2], hit[3], hit[4]


def _control_inputs(index: NodeIndex, node: dict[str, Any], expects_raw: Any, expects: Any,
                    mappings: list[dict[str, Any]]) -> tuple[list[Field], str | None, str | None]:
    """A control's input fields, from the shape hydra:expects names when the
    document describes it (a JSON Schema, or a node it describes, whether or
    not that gives fields), checked against any fields the control writes in
    place, or else from those, joined to its template's mappings; the problem
    that keeps it from being invoked, if any; and a warning to show with it.
    A template's variable that is no input's is sent in the body too, so
    where the body is a JSON Schema's that names additionalProperties, that is
    its schema: false refuses a value for it, and a schema types and checks it
    as a property's; it is read once for all such variables, and choices, a
    default, a description or a pattern in it that two of them would share
    are a problem (_shared_schema_problem). Where the body is a closed SHACL
    shape's, with properties or none, such a variable is refused unless
    sh:ignoredProperties names its property. The page's controlInputs is the
    same. A control that writes no fields in place reads its inputs from the
    shape and the mappings alone, so the controls that share both share one
    result, built once (index.inputs): list writes their fields once."""
    inline = _inline_fields(node)
    if inline is not None:
        return _charged_inputs(_read_control_inputs(index, node, expects_raw, expects, mappings))
    raw = _json_value(expects_raw)
    if expects_raw is not None and _is_json_schema(raw):
        # A JSON Schema written in place is its text: controls whose schemas
        # read alike, each written in its own control, share one result.
        kept: Any = None
        source: Any = ("schema", id(raw) in index.ctx.schemas, json.dumps(raw, ensure_ascii=False))
    else:
        kept = None if expects_raw is None else index.node(raw)
        source = id(kept) if kept is not None else None
    # The name hydra:expects is shown by goes in a warning, so it is part of the key.
    key: tuple[Any, ...] = (source, expects_raw is not None, _text(expects), id(mappings) if mappings else None)
    hit = index.inputs.get(key)
    if hit is None or hit[0][0] is not kept or (mappings and hit[0][1] is not mappings):
        hit = index.inputs[key] = ((kept, mappings), _read_control_inputs(index, node, expects_raw, expects, mappings))
    return _charged_inputs(hit[1])


def _charged_inputs(inputs: tuple[Any, str | None, str | None]) -> tuple[Any, str | None, str | None]:
    """A control's inputs, charged FIELD_WORK for each field it has, a
    template's it shares and a property's many shapes name among them: each
    control uses each, however many controls share it. The page's
    controlInputs charges the same."""
    _spend(FIELD_WORK * len(inputs[0]))
    return inputs


def _read_control_inputs(index: NodeIndex, node: dict[str, Any], expects_raw: Any, expects: Any,
                         mappings: list[dict[str, Any]]) -> tuple[list[Field], str | None, str | None]:
    """_control_inputs' reading of one control's inputs."""
    fields: list[Field] = []
    inline = _inline_fields(node)
    items = [item for item in inline if isinstance(item, dict)] if inline is not None else []
    warning = None
    problem = None
    inline_problem = None
    base: _FieldIndex | None = None
    shape = _shared_shape_fields(index, expects_raw) if expects_raw is not None else None
    as_schema = _is_json_schema(expects_raw)
    # A node the document describes is the shape, though it gives no fields:
    # its fields, none, are the inputs, and its sh:closed is read.
    if shape is not None and not shape[0] and not as_schema and _node_of(index, _json_value(expects_raw)) is None:
        shape = None
    if shape is not None:
        fields, _, problem, base = shape
        if inline is not None:
            inline_problem = _duplicate_problem([_inline_field(item, index.inexact) for item in items]) or _inline_disagreement(items, fields)
        problem = problem or inline_problem
    elif inline is not None:
        fields = [_inline_field(item, index.inexact) for item in items]
        problem = _duplicate_problem(fields)
    if expects_raw is not None and (shape is None or (not fields and not as_schema)):
        warning = _expects_warning(expects, inline is not None and bool(items), shape is not None)
    if mappings:
        schema = _json_value(expects_raw) if shape is not None else None
        # A template's own fields, joined to fields no mapping matches, are its
        # fields by reference (_Joined), unless additionalProperties types them
        # or a closed shape refuses them, which each control does for itself.
        template = _template_fields(index, mappings)
        typed = _is_json_schema(schema) and "additionalProperties" in schema and schema["additionalProperties"] is not True
        shaped = None if shape is None or _is_json_schema(schema) else index.node(_json_value(expects_raw))
        if (template.fields and not typed and not (shaped is not None and _present(index.get(shaped, SHACL + "closed")))
                and _joins_as_is(fields, template)):
            # The template's own fields each take a value, so only these may allow none.
            return (_Joined(fields, template), inline_problem or _joined_duplicate_problem(fields, template) or _unsatisfiable(fields),
                    warning)
        if index.listing is not None:
            # While list builds every control's, each field this builds is charged (Descriptor.listing).
            index.listing[0] -= len(fields) + len(mappings)
            if index.listing[0] < 0:
                raise _Unlisted()
        given = len(fields)
        fields = _merge_mapping_fields(fields, mappings, base)
        extra: list[str] = []
        if (len(fields) > given and _is_json_schema(schema) and "additionalProperties" in schema
                and schema["additionalProperties"] is not True):
            # Built once, for the first such variable, and copied for each,
            # unless what each copy shows or sends would cost the document's
            # size once per variable: then the control is not invoked, and the
            # variables are left as they are.
            first = fields[given]
            built = _schema_field(first.name, schema["additionalProperties"], first.required, extra)
            built.inexact = index.inexact
            built.rounded_default = _rounded_default(built, index.inexact)
            shared = (_shared_schema_problem(first.name, fields[given + 1].name, schema["additionalProperties"])
                      if len(fields) - given > 1 else None)
            if shared is not None:
                extra.append(shared)
            for i in range(given, len(fields) if shared is None else given):
                added = fields[i]
                one = copy.copy(built)
                one.name, one.path, one.variable = added.name, added.path, added.variable
                one.required, one.min_count = added.required, 1 if added.required else 0
                fields[i] = one
        closed = index.node(_json_value(expects_raw)) if len(fields) > given and shape is not None and not _is_json_schema(schema) else None
        read = _closed_shape(index, closed) if closed is not None else None
        if read is not None and read.closed:
            if read.problem is not None:
                extra.append(read.problem)
            kept = read.kept
            for i in range(given, len(fields)):
                if not fields[i].path or fields[i].path not in kept:
                    fields[i] = copy.copy(fields[i])
                    fields[i].closed_out = True
        problem = inline_problem or _duplicate_problem(fields) or (extra[0] if extra else None)
    return fields, problem or _unsatisfiable(fields), warning


class _ClosedRead:
    """What a shape says of sh:closed (_closed_shape)."""

    __slots__ = ("closed", "kept", "problem")

    def __init__(self, closed: bool, kept: set[str], problem: str | None) -> None:
        self.closed = closed
        self.kept = kept
        self.problem = problem


def _closed_shape(index: NodeIndex, node: dict[str, Any]) -> _ClosedRead:
    """Whether a shape is closed (a sh:closed that is not false), the
    properties its sh:ignoredProperties names, and the problem reading those
    gives: read once for each shape however many controls name it
    (facts_of), so a long sh:ignoredProperties costs its length once, not
    once for each control that joins its template's variables to the shape,
    and an RDF list many shapes name is made a set once (list_texts), not
    once for each shape. The page's closedShape is the same."""
    facts = index.facts_of(node)
    if facts.closed is None:
        flags = index.get(node, SHACL + "closed")
        closed = any(v is not None and truthy(_label(v)) is not False for v in as_list(flags))
        kept: set[str] = set()
        problem = None
        if closed:
            kept, why, several = index.list_texts(index.get(node, SHACL + "ignoredProperties"))
            if several or why is not None:
                problem = (f"the shape writes sh:ignoredProperties as {'more than one list' if several else why}, which this client "
                           "does not read, so what it sends is not known; this control is not invoked")
        facts.closed = _ClosedRead(closed, kept, problem)
    return facts.closed


def _unsatisfiable(fields: Any) -> str | None:
    """The problem a required input that allows no value gives: an empty list
    of the values it allows (_empty_text), or sh:maxCount 0. No request it
    makes can be sent, so the control is not invoked, never offered with a
    form that can only refuse. None where each required input can take a
    value. The page's unsatisfiable is the same."""
    for fld in fields:
        if not fld.required and not (fld.min_count or 0) >= 1:
            continue
        if fld.empty:
            return f'the input "{fld.name}" is required, but {_empty_text(fld)}; this control is not invoked'
        if fld.max_count == 0:
            return f'the input "{fld.name}" is required, but it takes at most 0 values; this control is not invoked'
    return None


def _shared_schema_problem(first: str, second: str, schema: Any) -> str | None:
    """The problem with an additionalProperties schema that two or more
    template variables would each take, when what each would take with it
    costs the document's size once per variable: choices, which each input
    offers and a check names; a default, which each shows, checks and sends;
    or a description or a pattern, which each shows. None for a schema with
    none of them, which costs a fixed amount per variable. The page's
    sharedSchemaProblem is the same."""
    if _names_choices(schema):
        what, does = "choices", "show and check"
    elif isinstance(schema, dict) and "default" in schema:
        what, does = "default", "show, check and send"
    elif isinstance(schema, dict) and ("description" in schema or "pattern" in schema):
        what, does = "description" if "description" in schema else "pattern", "show"
    else:
        return None
    return (f'the inputs "{first}" and "{second}" share the {what} of additionalProperties, which this client would {does} once for '
            "each, at a cost the document's size does not bound; this control is not invoked")


def _names_choices(schema: Any) -> bool:
    """Whether a JSON Schema names choices anywhere in it: an enum or a const
    at any depth. The page's namesChoices is the same."""
    stack = [schema]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, dict):
            if "enum" in item or "const" in item:
                return True
            stack.extend(item.values())
    return False


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
    # Two nodes with one name are two controls, whatever each sends, hints and
    # inputs included: one control is listed, and it is not invoked, since which
    # one a link or a name means is not known. One node named twice is one.
    for node in candidates:
        control = control_from_node(index, node, source)
        key = control.rel or control.id
        if not key:
            continue
        first = found.get(key)
        if first is None:
            found[key] = control
            continue
        first.conflict = f"two controls are both named {key}, so which one is meant is not known; this control is not invoked"
        _spend(_utf16_length(first.conflict))
    controls = list(found.values())
    controls.sort(key=lambda c: (0 if not c.unsafe else 1, c.method, (c.title or c.rel).lower()))
    return controls


def descriptor_meta(index: NodeIndex, url: str, content_type: str) -> tuple[str, list[str], str, list[str]]:
    root = index.root
    title, types, description, see_also = local_name(url) or url, [], "", []
    if root:
        # Shown, never acted on: the first value of each that reads as one.
        title = _text(_label(index.get(root, P_DCTITLE)) or _label(index.get(root, P_TITLE)) or _label(index.get(root, P_LABEL)) or title)
        types = index.types_of(root)
        description = _text(_label(index.get(root, P_DCDESC)) or _label(index.get(root, P_DESC)) or _label(index.get(root, P_COMMENT)) or "")
        see_also = [_text(read) for ok, read in (_value_of(x) for x in as_list(index.get(root, P_SEEALSO))) if ok and read is not None]
    return title, types, description, see_also



# The keys of a HyperMarkdown control block that decide what it does, and what
# is not known when one is given twice. The page's MD_DECISIVE is the same.
_MD_DECISIVE = {"rel": "which affordance it names", "method": "what it does", "target": "where it sends",
                "expects": "what it sends", "mediaType": "what it returns", "fields": "what it sends"}
def _unquote(text: str) -> str:
    """A value with one double quote taken off each end, as the page's
    replace(/^"|"$/g, "") takes them."""
    if text.startswith('"'):
        text = text[1:]
    return text[:-1] if text.endswith('"') else text


# A control block, read after every line ending (CR LF, CR or LF, as CommonMark
# has them) is LF; only space and tab separate its parts. The page's
# CONTROL_BLOCK is the same.
CONTROL_BLOCK = re.compile(r":::control[ \t]+([^ \t\n]+)[ \t]*\n(.*?)(?:\n:::|\Z)", re.DOTALL)
# Keys of a block whose value is text, and a block's fields, which is a JSON array of objects.
_MD_TEXT = ("rel", "method", "target", "expects", "mediaType")


def _strict_json(text: str) -> Any:
    """JSON as a document's is read, and as everything that may go into a
    request is: NaN, Infinity and a repeated key are refused (a ValueError,
    _RepeatedKey for a key), as the page's JSON.parse and repeatedKey refuse
    them, and an integer of any length is read, as JSON.parse reads one. JSON
    nested past _JSON_DEPTH is refused first (_TooDeep)."""
    if _json_too_deep(text):
        raise _TooDeep()
    return json.loads(text, object_pairs_hook=_no_repeated_keys, parse_constant=_not_json, parse_int=_json_int)


def parse_markdown_descriptor(text: str, url: str, content_type: str) -> Descriptor:
    """The controls of HyperMarkdown :::control blocks. Each line is a key, a
    colon and a value, both trimmed of space, tab, CR and LF only; a value
    that starts with "[" or "{" and is JSON is that JSON. Read as a JSON-LD
    control's are, failing closed: a key that decides what the control does
    given twice, a rel, method, target, expects or mediaType written as JSON,
    fields that are not a JSON array of objects, a hint that says unsafe, and
    two fields of one name each make a problem. The page's parseMarkdown is the
    same."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    controls: list[Control] = []
    for match in CONTROL_BLOCK.finditer(text):
        ident = match.group(1)
        data: dict[str, Any] = {}
        # Every value each key is given, as written, each once.
        given: dict[str, list[str]] = {}
        for line in match.group(2).split("\n"):
            if ":" not in line:
                continue
            key, val = line.split(":", 1)
            key, val = key.strip(_SPACES), val.strip(_SPACES)
            if not key:
                continue
            if val not in given.setdefault(key, []):
                given[key].append(val)
            if val.startswith("{") or val.startswith("["):
                try:
                    data[key] = _strict_json(val)
                    continue
                except ValueError:
                    pass
            data[key] = _unquote(val)
        rel = _text(data.get("rel")) or ident
        # A key the block gives twice with different values is the last one to
        # a reader that keeps the last: one that decides what the control does
        # is a problem instead. A title or a description shows the last.
        problems: list[str] = []
        for key, values in given.items():
            if key in _MD_DECISIVE and len(values) > 1:
                problems.append(f"this control block gives {key} more than once ({', '.join(values)}), so {_MD_DECISIVE[key]} is not "
                                "known; it is not invoked")
        for key in _MD_TEXT:
            if isinstance(data.get(key), (list, dict)):
                kind = "array" if isinstance(data[key], list) else "object"
                problems.append(f"this control block writes {key} as a JSON {kind}, which this client does not read there, so "
                                f"{_MD_DECISIVE[key]} is not known; it is not invoked")
        fields: list[Field] = []
        if "fields" in given:
            try:
                listed = _strict_json(given["fields"][-1])
            except _TooDeep:
                problems.append(f"this control block writes fields as JSON nested deeper than {_JSON_DEPTH} levels, which this client "
                                "does not read, so what it sends is not known; it is not invoked")
            except ValueError:
                problems.append("this control block writes fields as text that is not JSON, so what it sends is not known; it is not "
                                "invoked")
            else:
                if isinstance(listed, list) and all(isinstance(item, dict) for item in listed):
                    inexact = _document_numbers(given["fields"][-1])
                    fields = [_inline_field(item, inexact) for item in listed]
                    unread_key = _inline_key_problem(listed)
                    if unread_key is not None:
                        problems.append(unread_key)
                else:
                    problems.append("this control block writes fields as JSON that is not a list of objects, which this client does "
                                    "not read there, so what it sends is not known; it is not invoked")
        # destructiveHint and readOnlyHint are read as in a JSON-LD control: every value, failing closed.
        hints = {key: [v for v in values] for key, values in given.items() if local_name(key) in ("destructiveHint", "readOnlyHint")}
        destructive, read_only, hint_problems = _hint_flags(None, hints)
        problems.extend(hint_problems)
        duplicate = _duplicate_problem(fields)
        if duplicate:
            problems.append(duplicate)
        # No method is POST here as in a JSON-LD control, as the substrate's HyperMarkdown lift reads it.
        methods = [m for m in dict.fromkeys(_unquote(v).upper() for v in given.get("method", [])) if m]
        method = next((m for m in methods if m not in SAFE_METHODS), None) or (methods[0] if methods else "POST")
        control = Control(
            id=ident if ident.startswith("http") else f"{url}#{ident}",
            rel=rel, method=method,
            title=_text(data.get("title")) or short_rel(rel),
            description=_text(data.get("description")) or _text(data.get("whenToUse")),
            media_type=_text(data.get("mediaType")) or None, expects=_text(data.get("expects")) or None,
            returns=_text(data.get("returns")) or None, target=_text(data.get("target")) or None,
            fields=fields, source=url, destructive=destructive, read_only=read_only, conflict=problems[0] if problems else None,
            # A block never describes the shape it expects, so only its fields written in place are known.
            warning=_expects_warning(data["expects"], bool(fields)) if isinstance(data.get("expects"), str) and data["expects"] else None,
        )
        _charge_read(control, problems)
        _spend(FIELD_WORK * len(fields))
        controls.append(control)
    title_match = re.search(r"^#[ \t]+(.+)$", text, re.MULTILINE)
    title = title_match.group(1) if title_match else local_name(url) or url
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


# The answers fetch and urllib take as a redirect.
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
# The methods an invoke follows a redirect with, when its control is safe: a
# redirect keeps either as it is in fetch, and _WebOnlyRedirects keeps it so
# where urllib before Python 3.13 would not (a HEAD). Any other request,
# and every one a control listed with the writes sends, goes only to the address
# its dry run shows; urllib would turn a POST into a GET on a 301, 302 or 303,
# and fetch would also re-send a write, body and all, on a 307 or 308. The
# page's FOLLOWED is the same.
FOLLOWED_METHODS = frozenset({"GET", "HEAD"})


# fetch follows at most 20 redirects and fails on the next, as it fails at the
# network. urllib's own limits (ten, and four to one address) would instead
# answer with the last redirect, whose body a client could read as a document.
_REDIRECT_LIMIT = 20


def _redirect_url(from_url: str, location: str) -> str:
    """The address a GET's or HEAD's redirect sends it on to, written as fetch
    writes it, so the address it lands at is the page's res.url: the Location
    resolved against the address that answered, with no fragment and the
    characters a URL parser percent-encodes encoded (see _request_url). A
    non-ASCII byte in the Location, which http.client reads as ISO-8859-1, is
    percent-encoded as that byte, as urllib and a browser encode it. A Location
    that is not http or https, or that a URL parser reads otherwise than its
    text (a backslash, which a browser reads as a slash, a space or a control
    character, user information, a host written as a number), is refused, as
    hmc.py refuses such an address, and nothing is sent there; the page's
    browser follows it as its parser reads it."""
    given = "".join(ch if ord(ch) < 0x80 else "".join("%%%02X" % b for b in ch.encode("latin-1" if ord(ch) < 0x100 else "utf-8"))
                    for ch in location)
    joined = _resolve_iri(given, from_url)
    _require_web_url(joined, "refused a redirect to")
    problem = _request_url_problem(joined)
    if problem is None:
        try:
            return _request_url(joined)
        except ValueError:
            problem = "the address is not a URL"
    raise RuntimeError(f"hmc.py refused the redirect from {from_url} to {location}: {problem}; nothing was sent there")


class _WebOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a GET's or HEAD's redirect only to another http or https URL,
    to the address fetch would send it to (see _redirect_url), and no more
    than fetch follows, and notes where a 303 See Other was answered from. Any
    other method's redirect is the answer: nothing is sent to its Location.
    Each hop is the request fetch's HTTP-redirect fetch sends for a GET or
    HEAD (see redirect_request), sent once the redirect's headers are in."""

    max_repeats = max_redirections = _REDIRECT_LIMIT

    def __init__(self) -> None:
        super().__init__()
        self.see_other_from: str | None = None
        self.followed = 0
        self.started: str | None = None

    def http_error_302(self, req, fp, code, msg, headers):  # type: ignore[no-untyped-def]
        # The address the request was sent to, which a limit passed is named by:
        # by the 21st request `req` is the last hop's.
        self.started = self.started or req.full_url
        # Only a Location with something in it redirects, as a browser reads
        # one; urllib would also follow an empty one, to the address itself, and
        # a URI header. Without one the 3xx is the answer, which is not 2xx. And
        # only a GET or HEAD is sent on: urllib would send a POST's 301, 302 or
        # 303 on as a GET, so any other method's 3xx is the answer too.
        location = (headers.get("location") or "").strip(" \t")
        if not location or req.get_method() not in FOLLOWED_METHODS:
            return None
        # urllib would send the Location as it reads it, with a fragment, a
        # backslash or a brace as written; the request goes where fetch's would.
        newurl = _redirect_url(req.full_url, location)
        if self.followed >= _REDIRECT_LIMIT:
            raise RuntimeError(f"{self.started} was redirected more than {_REDIRECT_LIMIT} times, "
                               "more than fetch follows, so the request failed")
        self.followed += 1
        if code == 303 and self.see_other_from is None:
            self.see_other_from = req.full_url
        new = self.redirect_request(req, fp, code, msg, headers, newurl)
        if new is None:
            return None
        # A redirect's own body is not the answer, and fetch follows a redirect
        # on its headers. urllib reads that body first, which waits as long as
        # the host takes to send it, or until the request times out.
        fp.close()
        return self.parent.open(new, timeout=req.timeout)

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        # The same request on every hop, on a 301, 302, 303, 307 or 308 alike,
        # as fetch sends a GET or HEAD it follows: urllib before Python 3.13
        # sends a HEAD on as a GET, which asks for, and downloads, a body the
        # HEAD did not. The headers go with it (a GET or HEAD from hmc.py has
        # no body, content header, Authorization or Cookie), but not
        # Proxy-Authorization: urllib's ProxyHandler writes the proxy's
        # credentials into them, and writes them again for a hop through the
        # proxy, so a hop to a host the proxy is bypassed for would hand that
        # host the proxy's password. A browser never sends one to a host.
        method = req.get_method()
        if method not in FOLLOWED_METHODS:
            return None
        kept = {name: value for name, value in req.headers.items() if name.lower() != "proxy-authorization"}
        return urllib.request.Request(newurl, headers=kept, method=method,
                                      origin_req_host=req.origin_req_host, unverifiable=True)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302


def _web_opener(redirects: _WebOnlyRedirects | None) -> urllib.request.OpenerDirector:
    """urlopen's handlers without the file, ftp and data ones; a URL of another
    scheme reaches UnknownHandler and fails. With no redirect handler a
    redirect is not followed: it is the answer."""
    opener = urllib.request.OpenerDirector()
    for handler in (
        urllib.request.ProxyHandler(), urllib.request.UnknownHandler(),
        urllib.request.HTTPHandler(), urllib.request.HTTPSHandler(),
        urllib.request.HTTPDefaultErrorHandler(), redirects,
        urllib.request.HTTPErrorProcessor(),
    ):
        if handler is not None:
            opener.add_handler(handler)
    return opener


@dataclass
class Exchange:
    """A request's answer: its status, headers and body; `base`, the address
    the answer is the document at: the URL after any redirects, as JSON-LD
    takes a document's base from, except that a 303 See Other leaves it at the
    URL that answered 303; and `landed`, the address that gave it, after any
    redirects followed."""
    status: int
    headers: dict[str, str]
    body: bytes
    base: str
    landed: str


def http_exchange(url: str, method: str = "GET", headers: dict[str, str] | None = None,
                  data: bytes | None = None, timeout: int = 60, follow: bool = True,
                  limit: int | None = None, error_body: bool = True) -> Exchange:
    """Sends one request to the URL exactly as _request_url writes it. With
    `follow`, a GET's or HEAD's redirect is followed as fetch follows one (see
    _WebOnlyRedirects); without it, and for any other method, a redirect is
    the answer, on its headers: nothing is sent to its Location, and its body
    is not read, so the answer's body is empty. Without `error_body`, the body
    of an answer that is not 2xx is not read either. With `limit`, the body is
    read to one byte past it and no further, so a body longer than `limit` is
    `limit` + 1 bytes long. A body that ends short of the Content-Length its
    answer gave, the connection closed, raises IncompleteRead, as the page's
    fetch fails on it: the answer is not taken as whole."""
    def body_of(answer: Any) -> bytes:
        if limit is None:
            return answer.read()
        body = answer.read(limit + 1)
        # read(amt), unlike read(), stops where the connection closed without
        # saying so; what it left of the Content-Length says the body was cut.
        left = getattr(answer, "length", None)
        if len(body) <= limit and left:
            raise http.client.IncompleteRead(body, left)
        return body
    _require_web_url(url)
    url = _request_url(url)
    req_headers = {"User-Agent": USER_AGENT}
    if headers:
        req_headers.update(headers)
    request = urllib.request.Request(url, data=data, headers=req_headers, method=method.upper())
    redirects = _WebOnlyRedirects() if follow else None
    try:
        with _web_opener(redirects).open(request, timeout=timeout) as resp:
            landed = resp.geturl() or url
            see_other = redirects.see_other_from if redirects else None
            return Exchange(resp.getcode() or 200, _header_values(resp.headers.items()), body_of(resp), see_other or landed, landed)
    except urllib.error.HTTPError as exc:
        if (not follow and exc.code in REDIRECT_STATUSES) or not error_body:
            # A redirect not followed is the answer on its headers: the page's
            # fetch, with redirect: "manual", gets an opaque redirect, which
            # has no body. Its body is not read, so one that never ends does
            # not hold the request until it times out; nor is the body of an
            # answer the caller reads only for its status.
            exc.close()
            body = b""
        else:
            body = body_of(exc.fp) if exc.fp else b""
        landed = exc.geturl() or url
        see_other = redirects.see_other_from if redirects else None
        return Exchange(exc.code, _header_values(exc.headers.items() if exc.headers else []), body, see_other or landed, landed)


def invoke_done(url: str, status: int, landed: str) -> tuple[bool, str]:
    """Whether an invoke that got an answer is done, and what to say of it:
    only a 2xx is done, and any other answer, a 3xx included, is not a
    success. The page's answerOutcome says the same."""
    via = "" if landed == url else f"was redirected to {landed}, which "
    if 200 <= status < 300:
        return True, f"Done: {url} {via}answered {status}."
    return False, f"Not a success: {url} {via}answered {status}; only a 2xx answer is a success."


def invoke_not_followed(method: str, url: str, status: int, location: str | None) -> str:
    """What to say when the address a request was sent to answered with a
    redirect the request does not follow. The page's notFollowed says the
    same, and, since a browser shows it neither, without the status and the
    Location of an opaque redirect."""
    answered = (f"answered {status}, a redirect to {location}" if location
                else f"answered {status}, a redirect with no Location")
    # fetch would turn a POST into a GET on a 301 or 302, and anything but a
    # GET or HEAD on a 303; urllib would turn a POST into one on any of them.
    as_get = method not in FOLLOWED_METHODS and (status == 303 or (method == "POST" and status in (301, 302)))
    return (f"Not done: {url} {answered}. The {method} was not re-sent{', or turned into a GET' if as_get else ''}: "
            f"a request goes only to the address its dry run shows. Whether {url} acted on it is not known.")


def _header_values(items: Any) -> dict[str, str]:
    """Response headers by lower-case name, as fetch's Headers.get reads one: a
    name given more than once is its values joined by ", ", so two Content-Type
    headers are read as the page reads them, not as the last of them."""
    out: dict[str, str] = {}
    for key, value in items:
        name = key.lower()
        out[name] = f"{out[name]}, {value}" if name in out else value
    return out


def _body_text(body: bytes) -> str:
    """A response body as fetch's res.text() reads it: UTF-8, with a leading
    byte order mark dropped and bytes that are not UTF-8 replaced."""
    return body.decode("utf-8-sig", errors="replace")


def _with_format(url: str, fmt: str) -> str:
    """The address with its "format" parameter set to `fmt`, as the page's
    withFormat has URLSearchParams set it: the first "format" takes the value
    and any other goes, every other parameter stays where it is, repeated ones
    included, and a missing "format" is added last."""
    parts = urllib.parse.urlsplit(url)
    pairs: list[tuple[str, str]] = []
    placed = False
    for key, val in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        if key == "format":
            if not placed:
                pairs.append((key, fmt))
                placed = True
            continue
        pairs.append((key, val))
    if not placed:
        pairs.append(("format", fmt))
    query = urllib.parse.urlencode(pairs, quote_via=_form_quote)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def _strip_fragment(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))


# What String.prototype.trim takes from the ends of a string: ECMAScript's
# WhiteSpace (tab, VT, FF, space, NBSP, U+FEFF and Unicode's space separators)
# and LineTerminator (LF, CR, U+2028, U+2029). str.strip() would also take
# U+001C to U+001F and U+0085, and leave U+FEFF.
_JS_TRIM = "\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def classify_payload(text: str, content_type: str) -> str | None:
    """"jsonld", "turtle" or "markdown" for a body read as one, or None; the
    page's classifyPayload is the same, its spaces those trim takes."""
    ct = (content_type or "").split(";")[0].strip(_JS_TRIM).lower()
    sample = text.strip(_JS_TRIM)[:240]
    if "ld+json" in ct or ct == "application/json":
        return "jsonld" if sample[:1] in ("{", "[") else None
    if "turtle" in ct or ct == "text/ttl":
        return "turtle"
    if "markdown" in ct or ct == "text/plain":
        if ":::control" in text or sample.startswith("---"):
            return "markdown"
    if sample[:1] in ("{", "["):
        # Whether it is JSON at all, as the page's JSON.parse decides it; a
        # repeated key is refused when the document is read, and so is JSON
        # nested too deep, which is JSON the reader refuses by name.
        try:
            _page_json(text)
            return "jsonld"
        except _TooDeep:
            return "jsonld"
        except ValueError:
            pass
    if sample.startswith("@prefix") or sample.startswith("PREFIX") or sample.startswith("<http"):
        return "turtle"
    if ":::control" in text:
        return "markdown"
    return None


def _reads_turtle() -> bool:
    """Whether rdflib, which hmc.py reads Turtle with, is installed."""
    try:
        import rdflib  # type: ignore  # noqa: F401
    except ImportError:
        return False
    return True


def fetch_authority(url: str) -> list[tuple[str, str, str]]:
    """The answers to read for a descriptor address, each as (the address it
    landed at, its content type, its text), in the order to read them. The
    page's fetchAuthority is the same:

    - The address as given is asked first. A request that gets no answer (the
      connection fails or closes, its body included, a redirect is refused or
      there are more than fetch follows, or it times out) ends the load, and
      its problem is named.
    - An answer counts when its status is 2xx, as fetch's res.ok has it, and
      its body, read to RESPONSE_MAX bytes and no further, is one
      classify_payload reads. The body of an answer that is not 2xx is not
      read, since it does not count whatever it holds, and one longer than
      RESPONSE_MAX bytes does not count. One that is not JSON-LD is asked
      for again as ?format=jsonld, unless the address names a format hmc.py
      reads (Turtle only with rdflib, as the page never reads it). That retry
      is optional: its answer comes first when it is JSON-LD, and the first
      answer after it, so a retry that gets no answer, or one that is not 2xx
      JSON-LD, leaves the first answer to be read as if it had not been asked.
      JSON-LD it answers that is then refused is the authority refused, and
      load_descriptor names it with the first answer (_authority_refused).
    - When the address names no format and its answer does not count,
      ?format=jsonld, turtle and markdown are asked in turn until one does; a
      request among them that gets no answer ends the load, named. When none
      counts and one was longer than RESPONSE_MAX bytes, the first such is
      named (_document_too_large)."""
    url = _strip_fragment(url)
    accept = "application/ld+json, application/json;q=0.9, text/turtle;q=0.8, text/markdown;q=0.4, */*;q=0.1"
    tried: list[str] = []
    too_large: list[str] = []
    # The address names a format when any "format" parameter in it has a value, as the page's fetchAuthority reads it.
    existing = any(key == "format" and val for key, val in urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query, keep_blank_values=True))

    def attempt(candidate: str) -> tuple[str, tuple[str, str, str]] | None:
        tried.append(candidate)
        # The address the text came from is where it landed after redirects,
        # which its relative IRIs resolve against: /dir answered by /dir/ puts
        # "items" at /dir/items. The page's fetchAuthority does the same.
        # The body of an answer that is not 2xx is not read; a 2xx one is read
        # as an invoke's response is, to RESPONSE_MAX bytes and no further, and
        # past that it does not count. The page's fetchText does the same.
        answer = http_exchange(candidate, headers={"Accept": accept}, limit=RESPONSE_MAX, error_body=False)
        status, headers, body, landed = answer.status, answer.headers, answer.body, answer.base
        if not 200 <= status < 300:
            return None
        if len(body) > RESPONSE_MAX:
            too_large.append(candidate)
            return None
        text = _body_text(body)
        content_type = headers.get("content-type", "")
        kind = classify_payload(text, content_type)
        return (kind, (landed, content_type, text)) if kind else None

    got = attempt(url)
    if got:
        kind, answer = got
        if kind == "jsonld" or (existing and (kind != "turtle" or _reads_turtle())):
            return [answer]
        jsonld = _with_format(url, "jsonld")
        try:
            alt = attempt(jsonld) if _request_url(jsonld) != _request_url(url) else None
        except Exception:  # noqa: BLE001 - an optional retry's failure leaves the answer in hand
            alt = None
        if alt and alt[0] == "jsonld":
            return [alt[1], answer]
        return [answer]
    if not existing:
        for fmt in ("jsonld", "turtle", "markdown"):
            got = attempt(_with_format(url, fmt))
            if got:
                return [got[1]]
    if too_large:
        raise RuntimeError(_document_too_large(too_large[0]))
    raise RuntimeError(f"Could not fetch a JSON-LD, Turtle, or HyperMarkdown descriptor from {url} (tried {tried})")


# How rdflib's Turtle parser ends a prefix's name, and a word: a prefixed
# name, a number, a keyword or a blank node's label (a backslash in one escapes
# the character after it). _turtle_charges reads Turtle with them.
_TURTLE_NAME_STOP = frozenset("\t\r\n !\"#$&'()*,+/;<=>?@[\\]^`{|}~:")
_TURTLE_WORD_STOP = _TURTLE_NAME_STOP - {":"}
_TURTLE_SPACE = frozenset(" \t\r\n")
# What each term of Turtle costs to read beyond the IRIs it expands to: a word,
# an IRI, a string, and each "[", "(", "!" and "^", of which rdflib makes a
# node or a triple, and keeps them, before this client reads a byte.
TURTLE_TERM_WORK = 256


def _turtle_skip(text: str, i: int) -> int:
    """Where the next token starts, as rdflib's parser skips space: spaces,
    tabs, line breaks, and comments, each to the line feed after it."""
    n = len(text)
    while i < n:
        if text[i] in _TURTLE_SPACE:
            i += 1
        elif text[i] == "#":
            end = text.find("\n", i)
            i = n if end < 0 else end + 1
        else:
            break
    return i


def _turtle_word_end(text: str, i: int, stop: frozenset[str]) -> int:
    """Where a run of characters rdflib reads as one name ends: at the first
    character of `stop`, a backslash escaping the character after it."""
    n = len(text)
    while i < n:
        if text[i] == "\\":
            i += 2
        elif text[i] in stop:
            break
        else:
            i += 1
    return min(i, n)


def _turtle_string_end(text: str, i: int) -> int:
    """Where the string that starts at `i` ends, as rdflib's parser reads it:
    a backslash escapes the character after it, a short string ends at its
    quote, and a long one at three, four or five of them; -1 where rdflib
    stops reading, at the end of the text or a line break in a short string."""
    quote = text[i]
    long = text.startswith(quote * 3, i)
    j = i + (3 if long else 1)
    stops = re.compile(r"[\\" + quote + "]" if long else r"[\\\r\n" + quote + "]")
    while True:
        found = stops.search(text, j)
        if found is None:
            return -1
        j = found.start()
        ch = text[j]
        if ch == "\\":
            j += 2
        elif ch != quote:
            return -1
        elif not long:
            return j + 1
        else:
            for run in (5, 4, 3):
                if text.startswith(quote * run, j):
                    return j + run
            j += 1


def _turtle_absolute(ref: str) -> bool:
    """Whether rdflib resolves an IRI as written, not against the base: a
    colon before any slash, and no escape that could put one before it."""
    colon = ref.find(":")
    slash = ref.find("/")
    return "\\" not in ref and colon >= 0 and (slash < 0 or colon < slash)


def _turtle_charges(text: str, base: str) -> None:
    """Charges what rdflib would make of Turtle beyond its text before rdflib
    reads it, as JSON-LD's IRIs are charged as they are read (_Budget): each
    prefixed name its prefix's expansion, each relative IRI the base it is
    resolved against, and each prefix and base declared what it resolves to,
    against IRI_BUDGET_PER_UNIT units for each of the text's and
    IRI_BUDGET_FIXED, refused past it with EXPANSION_PROBLEM; and each term
    TURTLE_TERM_WORK units of the step's work (_spend). The text is read as
    rdflib's parser reads it, comments, strings and IRIs whole, and each
    charge is at least what rdflib makes: a prefixed name, the longest
    expansion of any prefix declared so far; a relative IRI, the longest base
    so far; a declaration, all its text could resolve to. So a prefix or base
    written once and long, or declared again and again, is refused before
    rdflib expands it, and nothing is read."""
    budget = _Budget(_utf16_length(text))
    n = len(text)
    base_len = _utf16_length(base)
    longest = 0

    def declared(i: int, prefix: bool) -> None:
        # The prefix or base a keyword ending at i declares, read as rdflib's
        # parser reads one: a prefix's name and colon, then an IRI or a prefixed name.
        nonlocal base_len, longest
        j = _turtle_skip(text, i)
        if prefix:
            j = _turtle_word_end(text, j, _TURTLE_NAME_STOP)
            if j >= n or text[j] != ":":
                return
            j = _turtle_skip(text, _turtle_word_end(text, j + 1, _TURTLE_WORD_STOP))
        if j < n and text[j] == "<":
            end = text.find(">", j + 1)
            if end < 0:
                return
            ref = text[j + 1:end]
            length = _utf16_length(ref) if _turtle_absolute(ref) else base_len + _utf16_length(ref) + 2
            written = _turtle_absolute(ref)
        else:
            colon = _turtle_word_end(text, j, _TURTLE_NAME_STOP)
            if colon >= n or text[colon] != ":":
                return
            length = longest + _utf16_length(text[colon + 1:_turtle_word_end(text, colon + 1, _TURTLE_WORD_STOP)])
            written = False
        if not written:
            budget.expanded(length)
        if prefix:
            longest = max(longest, length)
        else:
            base_len = max(base_len, length)

    i = 0
    while i < n:
        c = text[i]
        if c in _TURTLE_SPACE or c == "#":
            i = _turtle_skip(text, i)
        elif c == "<":
            end = text.find(">", i + 1)
            if end < 0:
                break
            ref = text[i + 1:end]
            if not _turtle_absolute(ref):
                budget.expanded(base_len + _utf16_length(ref) + 2)
            _spend(TURTLE_TERM_WORK)
            i = end + 1
        elif c in "\"'":
            i = _turtle_string_end(text, i)
            if i < 0:
                break
            _spend(TURTLE_TERM_WORK)
        elif c == "@":
            j = i + 1
            while j < n and (text[j].isascii() and (text[j].isalnum() or text[j] == "-")):
                j += 1
            keyword = text[i + 1:j].lower()
            for name in ("prefix", "base"):
                if keyword.startswith(name):
                    declared(i + 1 + len(name), name == "prefix")
            i = j
        elif c == "?":
            # A variable, which rdflib makes an IRI of from the base.
            budget.expanded(base_len + 1)
            i += 1
        elif c in "[(!^":
            _spend(TURTLE_TERM_WORK)
            i += 1
        elif c in _TURTLE_WORD_STOP:
            i += 1
        else:
            j = _turtle_word_end(text, i, _TURTLE_WORD_STOP)
            word = text[i:j]
            colons = word.count(":")
            if colons:
                budget.expanded(colons * longest + _utf16_length(word))
            # A statement's closing "." is no term.
            if word.strip("."):
                _spend(TURTLE_TERM_WORK)
            last = word.rsplit(".", 1)[-1].lower()
            if last in ("prefix", "base"):
                declared(j, last == "prefix")
            i = j


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
    # rdflib's own output; parse_descriptor reads it again with _strict_json.
    return json.loads(graph.serialize(format="json-ld"))


def parse_descriptor(text: str, content_type: str, url: str, fetched_from: str | None = None, size: int | None = None) -> Descriptor:
    """The descriptor a text holds, read in one step of work (_working) that
    its size in bytes, as received, sets; Turtle is charged what rdflib would
    make of it (_turtle_charges), then read as the JSON-LD rdflib writes, in
    the same step. The page's parseDescriptor is the same, but for Turtle,
    which it does not read."""
    size = _utf8_length(text) if size is None else size
    kind = classify_payload(text, content_type)
    with _working(size):
        if kind == "turtle":
            # rdflib expands Turtle's IRIs and builds its triples before this
            # client reads them, so what it would make is charged first.
            _turtle_charges(text, fetched_from or url)
            text = json.dumps(parse_turtle_via_rdflib(text, fetched_from or url))
            kind, content_type = "jsonld", "application/ld+json"
        if kind == "jsonld":
            document = _strict_json(text)
            index = NodeIndex(document, url, fetched_from, _document_numbers(text), _utf16_length(text))
            title, types, description, see_also = descriptor_meta(index, url, content_type)
            descriptor = Descriptor(
                url=url, title=title, types=types, description=description,
                content_type=content_type, controls=extract_controls(index, url),
                see_also=see_also, raw=document, context=index.ctx, index=index,
            )
        elif kind == "markdown":
            descriptor = parse_markdown_descriptor(text, url, content_type)
        else:
            raise RuntimeError(f"Unrecognized descriptor representation ({content_type})")
    descriptor.size = size
    return descriptor


def load_descriptor(url: str) -> Descriptor:
    """The descriptor at an address, which is checked as it is given, before
    urlsplit, which drops a tab, a line break and spaces at its start, reads
    it. The page's loadDescriptorUrl checks a link's address the same way."""
    uri = _iri_to_uri(url)
    problem = _address_text_problem(uri)
    if problem:
        raise ValueError(f"{problem}; nothing is sent to {uri}")
    # The first answer read is the descriptor. When none is, the problem named
    # is the first's: the JSON-LD a retry asked for, when it answered. When
    # that JSON-LD is refused and the first answer is read after it, the first
    # answer is not read as safe (_authority_refused). The page's
    # loadDescriptorUrl reads its answers the same way.
    unread: Exception | None = None
    for fetched_from, content_type, text in fetch_authority(url):
        try:
            descriptor = parse_descriptor(text, content_type, _strip_fragment(url), fetched_from)
        except Exception as exc:  # noqa: BLE001
            unread = unread or exc
            continue
        descriptor.content_type = content_type
        if unread is not None:
            with _working(descriptor.size):
                _authority_refused(descriptor, _request_url(_with_format(_strip_fragment(url), "jsonld")),
                                   classify_payload(text, content_type), unread)
        return descriptor
    raise unread or RuntimeError(f"No descriptor was read from {url}")


def _authority_refused(descriptor: Descriptor, jsonld_url: str, kind: str | None, problem: Exception) -> None:
    """Marks a descriptor read from a first answer after the JSON-LD a retry
    answered, the authority for it, was refused whole. The answer is kept,
    since the retry was optional, but not read as safe: what that JSON-LD says
    of each control (a hint, a method, a target) is not known, so the
    descriptor names the refusal, and every control is listed with the writes
    and refused, naming it. The page's authorityRefused is the same."""
    name = "Turtle" if kind == "turtle" else "HyperMarkdown"
    descriptor.problem = (f"The JSON-LD answer to {jsonld_url} is refused, so the controls read from the {name} "
                          f"answer are listed and none is invoked: {problem}")
    for control in descriptor.controls:
        control.conflict = (f"the JSON-LD answer to {jsonld_url} is refused, and what it says of this control is not "
                            f"known, so it is not invoked: {problem}")
        # Written for each control, so charged for each, as reading the document charges what it names (_charge_read).
        _spend(_utf16_length(control.conflict))



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
    if not math.isfinite(number):
        return "NaN" if math.isnan(number) else ("Infinity" if number > 0 else "-Infinity")
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
        return _request_json(value)
    if isinstance(value, float):
        return _js_number_text(value)
    return str(value)


_PCT_TRIPLET = re.compile(r"(%[0-9A-Fa-f]{2})")


def _template_encode(value: Any, op: str) -> str:
    """A value as an expression writes it. A reserved expansion ({+x}, {#x})
    passes a percent-encoded triplet through as it is (RFC 6570, section
    3.2.3); every other expansion encodes its "%". The page's templateEncode
    is the same."""
    text = _template_scalar(value)
    if op not in ("+", "#"):
        return urllib.parse.quote(text, safe=_COMPONENT_SAFE)
    safe = _RESERVED_SAFE if op == "+" else _FRAGMENT_SAFE
    return "".join(part if i % 2 else urllib.parse.quote(part, safe=safe) for i, part in enumerate(_PCT_TRIPLET.split(text)))


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


def _form_parts(name: str, explode: bool, value: Any, enc_op: str, made: Callable[[str], str]) -> list[str]:
    """The parts a form-style variable ({?x}, {&x}, {;x}) writes, each
    charged as it is made (`made`): an exploded list writes its name once for
    each value. The page's templateFormParts is the same."""
    if isinstance(value, dict):
        pairs = [(key, item) for key, item in value.items() if _template_defined(item)]
        if explode:
            return [made(f"{_template_encode(key, enc_op)}={_template_encode(item, enc_op)}") for key, item in pairs]
        flat = [piece for key, item in pairs for piece in (_template_encode(key, enc_op), _template_encode(item, enc_op))]
        return [made(f"{name}={','.join(flat)}")]
    items = value if isinstance(value, list) else [value]
    encoded = [_template_encode(item, enc_op) for item in items if item is not None and item != ""]
    if explode:
        return [made(f"{name}={item}") for item in encoded]
    return [made(f"{name}={','.join(encoded)}")]


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
    """One template expression as RFC 6570 expands it, charged its length
    (_spend): each variable's part as it is made, before any is joined, so an
    expression that names one variable many times, or an exploded list that
    writes a long name once for each value, stops where what it has made
    passes the request's budget; and what joins them once it is written. The
    page's expandTemplateExpr is the same."""
    charged = [0]

    def made(part: str) -> str:
        units = _utf16_length(part)
        charged[0] += units
        _spend(units)
        return part

    out = _expand_expr_text(expr, values, made)
    _spend(_utf16_length(out) - charged[0])
    return out


def _expand_expr_text(expr: str, values: dict[str, Any], made: Callable[[str], str]) -> str:
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
            parts.extend(_form_parts(name, explode, _prefixed(values[name], limit), enc_op, made))
        if op == ";":
            return "".join(f";{part}" for part in parts)
        return ("&" if op == "&" else "?") + "&".join(parts)
    rendered = [made(_path_value(explode, _prefixed(values[name], limit), op, enc_op)) for name, explode, limit in specs]
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


# XSD datatypes whose values are numbers, by their name in the XSD namespace. A value
# outside the range a type implies, such as unsignedByte's 0 to 255, is refused (_INTEGER_RANGES).
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
    never NaN or inf. Text is read as written: an integer past 2^53 - 1 is
    refused, as the page, whose JSON number cannot carry it exactly, refuses
    it, so both give one verdict.
    A JSON number (a default, or an enum entry) is the double the page reads,
    as JavaScript writes it, so 2.0 is 2. A decimal is sent as a float, so one whose
    float's shortest text, which is what is sent, writes another decimal is
    refused. A double or float is the double nearest its text, which is the
    value XSD gives that text."""
    text = (value if isinstance(value, str) else _scalar_text(value)).strip(_SPACES)
    if kind == "integer":
        if not _INTEGER_LEXICAL.fullmatch(text):
            raise ValueError("not an integer")
        # More than 16 digits is past 2^53 - 1, and is not handed to int(), which reads only so many.
        if len(text.lstrip("+-").lstrip("0")) > 16 or abs(int(text)) > _MAX_SAFE_INTEGER:
            raise ValueError("integer too large to send exactly")
        return int(text)
    if not _DECIMAL_LEXICAL.fullmatch(text):
        raise ValueError("not a number")
    number = float(text)
    if not math.isfinite(number):
        raise ValueError("not a finite number")
    if kind == "decimal" and _decimal_key(text) != _decimal_key(repr(number)):
        raise ValueError("decimal cannot be sent exactly")
    # A whole number is sent as JavaScript sends it, 2 and not 2.0, in a URL and in JSON alike. Past
    # 2^53 - 1 it stays the double, which _js_number_text writes as the page does
    # (123456789012345680000), never as the double's exact integer (123456789012345683968).
    return int(number) if number.is_integer() and abs(number) <= _MAX_SAFE_INTEGER else number


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class _FieldFacts:
    """What a field's checks read of its sh:hasValue and its bounds, read once
    however many values they check, so a long constraint costs its length once
    and not once per value: the sh:hasValue's text, the number it is in a
    number field, the key of the JSON it holds in an rdf:JSON field
    (_json_key), and whether it holds a number reading JSON may have rounded
    (_rounded_entry); and each bound as (kind, its number or None for none,
    its text, whether that number may not be the one written: _inexact_bound).
    The page's fieldFacts is the same."""

    def __init__(self, fld: Field, numeric: str | None) -> None:
        self.rdf_json = _is_rdf_json(fld.datatype)
        self.has_value: tuple[str, Any, str | None, Any, str] | None = None
        entry = fld.has_value
        if entry is not None:
            number = None
            key = None
            if numeric and (_is_number(entry) or isinstance(entry, str)):
                try:
                    # A JSON 2.0 is 2 here as on the page.
                    number = _coerce_number(numeric, entry)
                except ValueError:
                    pass
            if self.rdf_json:
                try:
                    key = _json_key(entry if not isinstance(entry, str) else _strict_json(entry))
                except ValueError:
                    pass
            # Its text, which a value of no number field matches, and its name, which a problem names it by.
            self.has_value = (_text(entry), number, key, _rounded_entry(fld, entry),
                              _named_text(entry, fld.inexact) if _is_number(entry) else _text(entry))
        self.bounds = [(kind, _bound_number(bound), _bound_text(bound, fld.inexact), _inexact_bound(bound, fld.inexact))
                       for kind, bound in (("minInclusive", fld.min_inclusive), ("maxInclusive", fld.max_inclusive),
                                           ("minExclusive", fld.min_exclusive), ("maxExclusive", fld.max_exclusive))
                       if bound is not None]


def _has_value_matches(facts: _FieldFacts, numeric: str | None, typed: Any) -> bool:
    """Whether a value of a field a shape gives (SHACL, Hydra, a template or a
    HyperMarkdown block) is its sh:hasValue, an RDF term read as its text (a
    typed literal's datatype is not kept): a number field's value is the entry
    that, read as a number of the field's type, is the same number, so
    "1.0"^^xsd:decimal admits 1 and "+1" admits 1 in a long field; an rdf:JSON
    field's value is the entry whose text is the same JSON value; a node value
    (a JSON object or array) is no entry, since no IRI or literal is a node;
    and any other value is the entry whose text is its text, as _ShapeChoices
    reads a sh:in entry. The page's hasValueMatches is the same."""
    assert facts.has_value is not None
    text, number, key = facts.has_value[:3]
    if numeric and _is_number(typed):
        return number is not None and number == typed
    if facts.rdf_json:
        return key is not None and key == _json_key(typed)
    if isinstance(typed, (dict, list)):
        return False
    return text == (typed if isinstance(typed, str) else _scalar_text(typed))


def _holds_unsafe_integer(value: Any) -> bool:
    """Whether a JSON value holds, at any depth, a number that is an integer
    past 2^53, which reading JSON (JSON.parse, and _json_int alike) may have
    rounded: the document may have written another. A walk with a stack. The
    page's holdsUnsafeInteger is the same."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, float):
            if math.isfinite(item) and item.is_integer() and abs(item) > _MAX_SAFE_INTEGER:
                return True
        elif isinstance(item, int) and not isinstance(item, bool):
            if abs(item) > _MAX_SAFE_INTEGER:
                return True
        elif isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return False


# A number of a JSON text, found by passing over each string by its escapes.
# The page's NUMBER_TOKEN is the same.
_NUMBER_TOKEN = re.compile(r'"(?:[^"\\]+|\\.)*"?|-?[0-9][0-9.eE+-]*')


def _changed_numbers(text: str, first: bool = False) -> list[tuple[str, float]]:
    """The numbers a JSON text writes whose double, the number reading the
    text gives, writes another number (an integer past 2^53, or a fraction
    with more digits than a double keeps, such as 0.30000000000000000001),
    each as (the number written, its double), in the order written, or the
    first alone when `first` is set. A number past every double is left to
    _past_double. The text has been read as JSON. The page's changedNumbers is
    the same."""
    out: list[tuple[str, float]] = []
    for match in _NUMBER_TOKEN.finditer(text):
        written = match.group()
        if written[0] == '"':
            continue
        number = float(written)
        if math.isfinite(number) and _decimal_key(written) != _decimal_key(repr(number)):
            out.append((written, number))
            if first:
                break
    return out


class _Numbers(set):  # type: ignore[type-arg]
    """The doubles of the numbers a document writes with digits their doubles
    drop (_changed_numbers), whose every reading may have been rounded; and,
    as `written`, the texts each of those doubles, and each infinity, is
    written with in the document, up to three of other values, so a problem
    names a number as the document writes it (_named_text), never as the
    double reading it gave. The page's documentNumbers makes the same."""
    written: dict[float, dict[str, str]]


def _document_numbers(text: str) -> _Numbers:
    """A JSON text's _Numbers, from two passes over its numbers: the doubles
    that changed, then every text written of one of them or of an infinity,
    each value once, by its _decimal_key. The page's documentNumbers is the
    same."""
    numbers = _Numbers()
    numbers.written = {}
    tokens: list[tuple[str, float]] = []
    for match in _NUMBER_TOKEN.finditer(text):
        written = match.group()
        if written[0] != '"':
            tokens.append((written, float(written)))
    numbers.update(number for written, number in tokens
                   if math.isfinite(number) and _decimal_key(written) != _decimal_key(repr(number)))
    for written, number in tokens:
        if number in numbers or not math.isfinite(number):
            texts = numbers.written.setdefault(number, {})
            key = _decimal_key(written)
            if key not in texts and len(texts) < 3:
                texts[key] = written
    return numbers


def _number_name(number: Any, written: dict[float, dict[str, str]]) -> str | None:
    """How a problem names a number its document writes otherwise than its
    double: the one text it is written with, two joined by "or", or two of
    three or more and "or another"; None for one written as its double."""
    texts = list(written.get(number, {}).values()) if not isinstance(number, bool) else []
    if not texts:
        return None
    if len(texts) == 1:
        return texts[0]
    return f"{texts[0]} or {texts[1]}" if len(texts) == 2 else f"{texts[0]}, {texts[1]} or another"


def _named_text(value: Any, numbers: Any) -> str:
    """A value as a problem names it (_entry_text), each number in it that
    its document writes otherwise than its double, or past every double,
    named as written (_Numbers.written): an entry 9007199254740993 is not
    named 9007199254740992, nor 1e400 null. The page's namedText is the
    same."""
    written = getattr(numbers, "written", None)
    if not written or value is None or isinstance(value, (str, bool)):
        return _entry_text(value)
    if _is_number(value):
        name = _number_name(value, written)
        return name if name is not None else _entry_text(value)
    return _js_json(value, named=written)


def _changed_problem(name: str, written: str) -> str:
    """What JSON text given for a field, or written as its default, is refused
    with when it holds a number its double would change: the number as written."""
    return f"{name}: holds {written}, which a JSON number would change, so it is not sent"


class _ChangedNumber(ValueError):
    """A list's JSON array that holds a number its double would change."""

    def __init__(self, written: str) -> None:
        super().__init__(written)
        self.written = written


def _holds_rounded(value: Any, inexact: set[Any]) -> bool:
    """Whether a value holds, at any depth, a number reading JSON may have
    rounded: an integer past 2^53, or one of `inexact`, the doubles of the
    numbers its document writes with digits their doubles drop
    (_changed_numbers). A walk with a stack. The page's holdsRounded is the
    same."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, float):
            if math.isfinite(item) and ((item.is_integer() and abs(item) > _MAX_SAFE_INTEGER) or item in inexact):
                return True
        elif isinstance(item, int) and not isinstance(item, bool):
            if abs(item) > _MAX_SAFE_INTEGER or item in inexact:
                return True
        elif isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return False


def _rounded_default(fld: Field, inexact: set[Any]) -> bool:
    """Whether a field's default holds a number reading JSON may have rounded:
    then it is not surely what the document wrote, so it is refused rather
    than sent. A double or a float field takes the double nearest what was
    written, so its default is that double. The page's roundedDefault is the
    same."""
    return fld.default is not None and _numeric_kind(fld) != "double" and _holds_rounded(fld.default, inexact)


# What a default that holds a number reading JSON may have rounded
# (_rounded_default) is refused with, after the field's name. The page's
# ROUNDED_DEFAULT is the same.
_ROUNDED_DEFAULT = ": its default holds a number that reading JSON may have rounded, so it is not sent"


def _rounded_kind(value: Any, inexact: Any) -> str | None:
    """Whether a JSON value holds, at any depth, a number reading JSON may have
    rounded (_holds_rounded): "integer" for one that holds an integer past 2^53,
    "number" for one that holds another (one of `inexact`), or None."""
    if _holds_unsafe_integer(value):
        return "integer"
    return "number" if inexact and _holds_rounded(value, inexact) else None


def _rounded_entry(fld: Field, entry: Any) -> str | None:
    """Whether a shape's sh:in entry or sh:hasValue holds a number reading it
    may have rounded (_rounded_kind's kind, or None): a JSON number that is an
    integer past 2^53 or one its document writes with digits its double drops,
    or in an rdf:JSON field a number the JSON an entry's text holds whose
    double would change it (_changed_numbers). Other text is read as written.
    The page's roundedEntry is the same."""
    if _is_rdf_json(fld.datatype) and isinstance(entry, str):
        try:
            parsed = _strict_json(entry)
        except ValueError:
            return None
        if _holds_unsafe_integer(parsed):
            return "integer"
        return "number" if _changed_numbers(entry, True) else None
    return None if isinstance(entry, str) else _rounded_kind(entry, fld.inexact)


def _rounded_problem(at: str, entry: str, kind: str | None = "integer") -> str:
    """What a value is refused with when the only entry it matches holds a
    number reading JSON may have rounded: the entry may not be what the
    document wrote, so the match is not known to be one."""
    if kind == "integer":
        return f"{at}: matches only {entry}, which holds an integer past 2^53 that reading JSON may have rounded, so it is not sent"
    return f"{at}: matches only {entry}, which holds a number that reading JSON may have rounded, so it is not sent"


def _inexact_bound(bound: Any, inexact: Any) -> bool:
    """Whether a bound's number may not be the one the document writes, so it
    is not compared: a JSON number that is an integer past 2^53 or one its
    document writes with digits its double drops (_holds_rounded), or text
    whose double writes another decimal (more digits than a double keeps, as
    0.30000000000000000001 has). A bound past every double is an infinity,
    which bounds as the number written does. The page's inexactBound is the
    same."""
    if isinstance(bound, bool):
        return False
    if isinstance(bound, (int, float)):
        return math.isfinite(bound) and _holds_rounded(bound, inexact or ())
    number = _bound_number(bound)
    if number is None or not math.isfinite(number):
        return False
    return _decimal_key(bound.strip(_SPACES)) != _decimal_key(repr(number))


# What a value is refused with, after the field's name, when a bound named
# with its text may not be the number the document writes (_inexact_bound).
def _inexact_problem(name: str, label: str, text: str) -> str:
    return (f"{name}: its {label} {text} is a number a double may not hold exactly, which this client does not compare, so it is "
            "not sent")


def _same_json(a: Any, b: Any) -> bool:
    """Whether two JSON values are the same value, as JSON Schema compares an
    enum's or a const's: arrays item by item in order, objects by the same keys
    with the same values whatever their order, numbers by value (1.0 is 1, and
    -0.0 is 0), and a string, a boolean or null only the same of its kind, so
    True is not 1 and "1" is not 1. A walk with a stack, so a deep value costs
    no recursion. The page's sameJson is the same."""
    stack = [(a, b)]
    while stack:
        x, y = stack.pop()
        if isinstance(x, bool) or isinstance(y, bool):
            if not (isinstance(x, bool) and isinstance(y, bool) and x == y):
                return False
        elif _is_number(x) or _is_number(y):
            if not (_is_number(x) and _is_number(y) and x == y):
                return False
        elif isinstance(x, list) and isinstance(y, list):
            if len(x) != len(y):
                return False
            stack.extend(zip(x, y))
        elif isinstance(x, dict) and isinstance(y, dict):
            if len(x) != len(y) or any(key not in y for key in x):
                return False
            stack.extend((x[key], y[key]) for key in x)
        elif isinstance(x, str) and isinstance(y, str):
            if x != y:
                return False
        elif not (x is None and y is None):
            return False
    return True


def _entry_text(value: Any) -> str:
    """A JSON value as a choice offers it and a problem names it: a string as
    it is, any other value as its JSON, so None is "null" and [1] is "[1]"."""
    return value if isinstance(value, str) else _js_json(value)


def _number_key(number: int | float) -> str:
    """A number's part of a _json_key: one key for each value, so 1 and 1.0
    share one, -0.0 is 0, and an integer no float holds is its digits."""
    if isinstance(number, float):
        return repr(number + 0.0)
    try:
        as_float = float(number)
    except OverflowError:
        return "i" + str(number)
    return repr(as_float) if as_float == number else "i" + str(number)


def _json_key(value: Any) -> str:
    """A key two JSON values share exactly when _same_json holds of them: an
    object's keys in sorted order, a number by its value (0 for -0.0), and a
    string, a boolean or None as its JSON, so that a set of an enumeration's
    keys answers whether a value is one of its entries at the cost of the
    value's size, not the enumeration's. A walk with a stack. The page's
    jsonKey is the same."""
    out: list[str] = []
    stack: list[tuple[bool, Any]] = [(False, value)]
    while stack:
        token, item = stack.pop()
        if token:
            out.append(item)
        elif _is_number(item):
            out.append("#" + _number_key(item))
        elif isinstance(item, list):
            out.append("[")
            stack.append((True, "]"))
            for i in range(len(item) - 1, -1, -1):
                stack.append((False, item[i]))
                if i:
                    stack.append((True, ","))
        elif isinstance(item, dict):
            keys = sorted(item)
            out.append("{")
            stack.append((True, "}"))
            for i in range(len(keys) - 1, -1, -1):
                stack.append((False, item[keys[i]]))
                stack.append((True, ("," if i else "") + json.dumps(keys[i]) + ":"))
        else:
            out.append(json.dumps(item))
    return "".join(out)


def _json_types_of(value: Any) -> list[str]:
    """The JSON Schema types a value is an instance of: a whole number is an integer and a number."""
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["boolean"]
    if isinstance(value, int):
        return ["integer", "number"]
    if isinstance(value, float):
        return ["integer", "number"] if value.is_integer() else ["number"]
    if isinstance(value, str):
        return ["string"]
    return ["array"] if isinstance(value, list) else ["object"]


def _bound_number(value: Any) -> int | float | None:
    """A bound as a number: a JSON number, or text that writes one. One past
    what a double holds is an infinity, which every number a value can be is
    still below (or above), so it bounds as the number written does. None for
    anything else. The page's boundNumber is the same."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return None if isinstance(value, float) and math.isnan(value) else value
    if not isinstance(value, str):
        return None
    text = value.strip(_SPACES)
    return float(text) if _DECIMAL_LEXICAL.fullmatch(text) else None


def _pointer_token(key: Any) -> str:
    """One key or index as a JSON Pointer writes it, after the field's name in a problem."""
    return str(key).replace("~", "~0").replace("/", "~1")


_SCHEMA_TYPE_NAMES = frozenset({"string", "number", "integer", "boolean", "object", "array", "null"})
# JSON Schema keywords that constrain a value and that neither client checks. A
# value given for a property whose schema holds one, at any depth, is refused
# with its name, never sent unchecked; uniqueItems false constrains nothing.
# The page's UNCHECKED_KEYWORDS is the same.
_UNCHECKED_KEYWORDS = (
    "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "multipleOf", "uniqueItems", "contains",
    "minContains", "maxContains", "prefixItems", "additionalItems", "unevaluatedItems", "unevaluatedProperties", "minProperties",
    "maxProperties", "patternProperties", "propertyNames", "dependencies", "dependentRequired", "dependentSchemas",
    "$ref", "$dynamicRef", "$recursiveRef",
)
_COUNT_KEYWORDS = ("minLength", "maxLength", "minItems", "maxItems")
# The keywords JSON Schema writes as a list of one schema or more, which
# neither client checks: an empty list, or anything but a list of schemas, is
# a form JSON Schema does not allow, never a constraint that is absent. The
# page's SCHEMA_LISTS is the same.
_SCHEMA_LISTS = ("allOf", "anyOf", "oneOf", "prefixItems")


def _read_schema(prop: Any, subject: str) -> tuple[list[str], list[str]]:
    """Reads a JSON Schema property's schema and each schema inside it (items,
    properties, additionalProperties): the problems, and the keywords it does
    not check. A keyword this client checks written in a form JSON Schema does
    not allow (a length or a bound written as text, which JSON Schema writes
    as a number, among them) is a problem, and the control is not invoked; a keyword it does
    not check (_UNCHECKED_KEYWORDS, items written as a list, or a JSON-LD
    keyword, such as an "@id" that makes a schema a reference to a node or a
    "@set" that wraps one) is named where it is, so a value given is refused.
    Keywords that only describe (title,
    description, default, examples, format, a pattern, which neither client
    runs) and keywords JSON Schema does not define are passed over, as JSON
    Schema passes over them. A walk with a stack, in the order the page's
    readSchema walks."""
    problems: list[str] = []
    unchecked: list[str] = []
    stack: list[tuple[Any, str]] = [(prop, "")]
    while stack:
        schema, at = stack.pop()

        def where(key: str) -> str:
            return f"{at}/{key}" if at else key

        def bad(key: str, what: str) -> None:
            problems.append(f"{subject} writes {key} as something other than {what}, which this client does not read, so what it "
                            "takes is not known; this control is not invoked")
        if isinstance(schema, bool):
            continue
        if not isinstance(schema, dict):
            bad(at or "its JSON Schema", "an object or a boolean")
            continue
        if "type" in schema:
            types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            if not types or not all(isinstance(t, str) and t in _SCHEMA_TYPE_NAMES for t in types):
                bad(where("type"), "a JSON Schema type name or a list of them")
        if "enum" in schema and not isinstance(schema["enum"], list):
            bad(where("enum"), "a list")
        if "required" in schema and not (isinstance(schema["required"], list) and all(isinstance(n, str) for n in schema["required"])):
            bad(where("required"), "a list of names")
        for key in _COUNT_KEYWORDS:
            if key in schema and not (_is_number(schema[key]) and _inty(schema[key]) is not None and _inty(schema[key]) >= 0):
                bad(where(key), "a whole number of zero or more")
        for key in ("minimum", "maximum"):
            if key in schema and not (_is_number(schema[key]) and _bound_number(schema[key]) is not None):
                bad(where(key), "a number")
        for key in ("exclusiveMinimum", "exclusiveMaximum"):
            if key in schema and not isinstance(schema[key], bool) and not (_is_number(schema[key]) and _bound_number(schema[key]) is not None):
                bad(where(key), "a number or a boolean")
        if "readOnly" in schema and not isinstance(schema["readOnly"], bool):
            bad(where("readOnly"), "a boolean")
        for key in _SCHEMA_LISTS:
            if key in schema and not (isinstance(schema[key], list) and schema[key]
                                      and all(isinstance(x, (bool, dict)) for x in schema[key])):
                bad(where(key), "a list of one or more schemas")
        for key in _UNCHECKED_KEYWORDS:
            if key in schema and not (key == "uniqueItems" and schema[key] is False):
                unchecked.append(where(key))
        # A JSON-LD keyword is no JSON Schema keyword: a schema written as a
        # reference to a node ("@id"), as $ref is to a schema, is not read,
        # since what the node holds is not this object's keys, and one that
        # wraps what it holds ("@set", "@list", "@graph", a "@value" and its
        # "@type", and every other) is not read as what it holds, so each is
        # named where it is.
        unchecked.extend(where(key) for key in schema if isinstance(key, str) and key.startswith("@"))
        nested: list[tuple[Any, str]] = []
        if "items" in schema:
            items = schema["items"]
            if isinstance(items, list):
                unchecked.append(where("items"))
            elif isinstance(items, (bool, dict)):
                nested.append((items, where("items")))
            else:
                bad(where("items"), "an object or a boolean")
        if "properties" in schema:
            props = schema["properties"]
            if not isinstance(props, dict):
                bad(where("properties"), "an object")
            else:
                nested.extend((props[key], where("properties/" + _pointer_token(key))) for key in _js_keys(props))
        if "additionalProperties" in schema:
            extra = schema["additionalProperties"]
            if isinstance(extra, (bool, dict)):
                nested.append((extra, where("additionalProperties")))
            else:
                bad(where("additionalProperties"), "an object or a boolean")
        stack.extend(reversed(nested))
    return problems, unchecked


def _offers(fld: Field, value: Any) -> bool:
    """Whether a JSON Schema field's input can give an entry: one its schema's
    type allows, and, in a number or a boolean field, a number or a boolean
    (or None). An entry that holds a number no double holds (1e400, which the
    page's JSON.parse reads as an infinity) is none, and so is an entry that
    is an integer past 2^53, in any field, which the page's JSON.parse, and so
    this client's reading, may have rounded: neither is surely the number the
    document wrote."""
    if _past_double(value):
        return False
    if _is_number(value) and float(value).is_integer() and abs(value) > _MAX_SAFE_INTEGER:
        return False
    # Nor is a number its document writes with digits its double drops, which
    # reading JSON gave this client in place of the number written.
    if _is_number(value) and fld.inexact and value in fld.inexact:
        return False
    if fld.schema_types is not None and not any(t in fld.schema_types for t in _json_types_of(value)):
        return False
    if _numeric_kind(fld) == "integer":
        return value is None or (_is_number(value) and float(value).is_integer() and abs(value) <= _MAX_SAFE_INTEGER)
    if _numeric_kind(fld):
        return value is None or _is_number(value)
    if _xsd_name(fld.datatype) == "boolean":
        return value is None or isinstance(value, bool)
    return True


def _schema_choices(fld: Field, problems: list[str], subject: str) -> list[tuple[str, Any]]:
    """The choices a JSON Schema field's select offers, as (text, entry): its
    enum's entries, or its const, or the entries of both that are the same,
    each its input can give, as _entry_text writes it. Entries that are the
    same value are offered once; two that are not but are written alike ("1"
    and 1, "true" and true) are a problem, since which one a choice means is
    not known. A field that takes JSON is typed as JSON and offers none. The
    page's schemaChoices is the same."""
    schema = fld.schema
    if not isinstance(schema, dict) or fld.json_kind:
        return []
    listed = schema["enum"] if isinstance(schema.get("enum"), list) else None
    if "const" in schema and listed is not None:
        # The const is keyed once, and each entry compared with its key at the
        # cost of the entry's size, never the const's (_json_key).
        const_key = _json_key(schema["const"])
        entries = [v for v in listed if _json_key(v) == const_key]
    elif "const" in schema:
        entries = [schema["const"]]
    else:
        entries = listed or []
    out: list[tuple[str, Any]] = []
    by_text: dict[str, Any] = {}
    for entry in entries:
        if not _offers(fld, entry):
            continue
        text = _entry_text(entry)
        if text in by_text:
            if _same_json(by_text[text], entry):
                continue
            problems.append(f"{subject} offers two choices written alike ({text}), so which one is meant is not known; this "
                            "control is not invoked")
            return out
        by_text[text] = entry
        out.append((text, entry))
    return out


class _ShapeChoices:
    """A shape field's sh:in, read once per field however many values it
    checks: the problem a value that is no entry gives, and whether a typed
    value is one, as _has_value_matches reads a sh:hasValue, looked up by each entry's
    number, JSON key or text. An entry that holds an integer past 2^53 as a
    JSON number (_rounded_entry) admits no value: one it alone would admit is
    refused naming it. The page's shapeChoices is the same."""

    def __init__(self, fld: Field, numeric: str | None, entries: list[Any]) -> None:
        self.name = fld.name
        self.numeric = numeric
        self.rdf_json = _is_rdf_json(fld.datatype)
        self.keys: set[str] = set()
        self.rounded: dict[str, tuple[str, str]] = {}
        for entry in entries:
            keys = ["t" + _text(entry)]
            if numeric and (_is_number(entry) or isinstance(entry, str)):
                try:
                    keys.append("n" + _number_key(_coerce_number(numeric, entry)))
                except ValueError:
                    pass
            if self.rdf_json:
                try:
                    keys.append("j" + _json_key(entry if not isinstance(entry, str) else _strict_json(entry)))
                except ValueError:
                    pass
            kind = _rounded_entry(fld, entry)
            if kind:
                for key in keys:
                    self.rounded.setdefault(key, (_named_text(entry, fld.inexact) if _is_number(entry) else _text(entry), kind))
            else:
                self.keys.update(keys)
        names = (_named_text(entry, fld.inexact) if _is_number(entry) else text for text, entry in _choices_of(fld))
        self.problem = f"{fld.name}: must be one of {', '.join(names)}"

    def problem_for(self, typed: Any) -> str | None:
        """None when a typed value is an entry, else the problem it gives."""
        if self.numeric and _is_number(typed):
            key: str | None = "n" + _number_key(typed)
        elif self.rdf_json:
            key = "j" + _json_key(typed)
        elif isinstance(typed, (dict, list)):
            key = None
        else:
            key = "t" + (typed if isinstance(typed, str) else _scalar_text(typed))
        if key is not None and key in self.keys:
            return None
        if key is not None and key in self.rounded:
            return _rounded_problem(self.name, *self.rounded[key])
        return self.problem


def _shape_choices(fld: Field, numeric: str | None) -> _ShapeChoices | None:
    """A shape field's _ShapeChoices, or None for one with no sh:in."""
    entries = [entry for entry in fld.enum if entry is not None]
    return _ShapeChoices(fld, numeric, entries) if entries else None


def _choices_of(fld: Field) -> list[tuple[str, Any]]:
    """The choices a field's select offers, as (text, entry): a JSON Schema
    field's are _schema_choices', each sent as the entry it names, None as a
    choice of its own; a shape's are its sh:in entries, each an IRI or a
    literal, as text (an RDF list holds no null). The page's choicesOf is the
    same."""
    if fld.choices is not None:
        return fld.choices
    return [(_text(entry), entry) for entry in fld.enum if entry is not None]


def _enum_keys(sch: dict[str, Any], enums: dict[int, Any], inexact: Any = None) -> dict[str, Any]:
    """A schema's enum and const as a check compares them, keyed once per
    schema for a whole check: each enum entry's key (_json_key), apart from
    those that hold a number reading JSON may have rounded (_rounded_kind),
    with the first entry of each such key and its kind, and the const's key
    and the kind of rounded number it holds, if any. The page's enumKeys is
    the same."""
    hit = enums.get(id(sch))
    if hit is not None and hit[0] is sch:
        return hit[1]
    sure: set[str] = set()
    rounded: dict[str, Any] = {}
    for entry in sch["enum"] if isinstance(sch.get("enum"), list) else []:
        kind = _rounded_kind(entry, inexact)
        if kind:
            rounded.setdefault(_json_key(entry), (entry, kind))
        else:
            sure.add(_json_key(entry))
    has_const = "const" in sch
    keyed = {"sure": sure, "rounded": rounded, "const_key": _json_key(sch["const"]) if has_const else None,
             "const_rounded": _rounded_kind(sch["const"], inexact) if has_const else None}
    enums[id(sch)] = (sch, keyed)
    return keyed


def _schema_at(at: Any) -> str:
    """Where in a value a part is, as a problem names it: the field's name, then
    a JSON Pointer to the part; a name that holds "/" is set apart from it
    ("d/x at /0")."""
    tokens: list[str] = []
    while isinstance(at, tuple):
        at, token = at
        tokens.append(str(token))
    if not tokens:
        return at
    tokens.reverse()
    return (f"{at} at /" if "/" in at else f"{at}/") + "/".join(tokens)


def _check_schema(schema: Any, value: Any, name: str, report: Any, enums: dict[int, Any] | None = None,
                  inexact: Any = None) -> None:
    """Checks a JSON Schema field's value against its schema, and each part of
    it against the schema inside (items, properties, additionalProperties),
    applying each keyword to the kinds of value JSON Schema applies it to: a
    type, an enum and a const to every value, compared as _same_json compares;
    a length only to a string, counted in code points; a bound only to a
    number; minItems, maxItems and items only to an array; and required,
    properties and additionalProperties only to an object. readOnly true
    refuses a value, as hydra:writable false does. A problem names where in
    the value it is, as a JSON Pointer after the field's name, and the first
    problem found is the one reported: the walk stops there, so a value with
    many bad parts costs no more than its size, and an enumeration's entries
    are named once. Each enum's entries and each const are keyed once
    (_enum_keys), so each part is compared with them at the cost of its own
    size. A walk with a stack. `enums` keys each enum once for a whole check of a control's
    values; a name that holds "/" is set apart from the pointer after it
    ("d/x at /0"). The page's schemaCheck is the same."""
    # Where each part is: the field's name, or the part it is in and its token,
    # written out (_schema_at) only for the problem reported, so a long name
    # is not copied once for each value of a list.
    stack: list[tuple[Any, Any, Any]] = [(schema, value, name)]
    enums = {} if enums is None else enums
    while stack:
        sch, val, at = stack.pop()
        if sch is False:
            report(f"{_schema_at(at)}: is not allowed by its schema")
            return
        if not isinstance(sch, dict):
            continue
        if sch.get("readOnly") is True:
            report(f"{_schema_at(at)}: is read-only (readOnly true), so it is not sent")
            return
        if "type" in sch:
            types = as_list(sch["type"])
            if not any(t in types for t in _json_types_of(val)):
                report(f"{_schema_at(at)}: must be a JSON {' or '.join(types)}")
                return
        # An enum with no entry allows no value, so none is compared with it.
        if isinstance(sch.get("enum"), list) and not sch["enum"]:
            report(f"{_schema_at(at)}: its schema allows no value (enum is empty), so it is not sent")
            return
        # An entry that holds an integer past 2^53 may not be what the document
        # wrote, so it admits no value: one that matches only it is refused
        # naming it. An enum's entries and a const are keyed once for the whole
        # check, so each value is compared with them at the cost of its own size.
        keyed = _enum_keys(sch, enums, inexact) if isinstance(sch.get("enum"), list) or "const" in sch else None
        key = _json_key(val) if keyed is not None else None
        if keyed is not None and isinstance(sch.get("enum"), list) and key not in keyed["sure"]:
            if key in keyed["rounded"]:
                entry, kind = keyed["rounded"][key]
                report(_rounded_problem(_schema_at(at), _named_text(entry, inexact), kind))
            else:
                report(f"{_schema_at(at)}: must be one of {', '.join(_named_text(entry, inexact) for entry in sch['enum'])}")
            return
        if keyed is not None and "const" in sch:
            if key != keyed["const_key"]:
                report(f"{_schema_at(at)}: must be {_named_text(sch['const'], inexact)}")
                return
            if keyed["const_rounded"]:
                report(_rounded_problem(_schema_at(at), _named_text(sch["const"], inexact), keyed["const_rounded"]))
                return
        problem = None
        if isinstance(val, str):
            n = len(val)
            if "minLength" in sch and n < _inty(sch["minLength"]):
                problem = f"{_schema_at(at)}: shorter than minLength {_inty(sch['minLength'])}"
            elif "maxLength" in sch and n > _inty(sch["maxLength"]):
                problem = f"{_schema_at(at)}: longer than maxLength {_inty(sch['maxLength'])}"
        if _is_number(val):
            # Draft 4 writes an exclusive bound as true beside minimum or maximum.
            low = _bound_number(sch["minimum"]) if "minimum" in sch else None
            high = _bound_number(sch["maximum"]) if "maximum" in sch else None
            xmin, xmax = sch.get("exclusiveMinimum"), sch.get("exclusiveMaximum")
            xlow = (low, sch.get("minimum")) if xmin is True else (
                (_bound_number(xmin), xmin) if "exclusiveMinimum" in sch and not isinstance(xmin, bool) else None)
            xhigh = (high, sch.get("maximum")) if xmax is True else (
                (_bound_number(xmax), xmax) if "exclusiveMaximum" in sch and not isinstance(xmax, bool) else None)
            # A bound whose number may not be the one written is not compared.
            unsure = next((key for key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum")
                           if key in sch and not isinstance(sch[key], bool) and _inexact_bound(sch[key], inexact)), None)
            if unsure is not None:
                problem = _inexact_problem(_schema_at(at), unsure, _bound_text(sch[unsure], inexact))
            elif low is not None and val < low:
                problem = f"{_schema_at(at)}: below minInclusive {_bound_text(sch['minimum'], inexact)}"
            elif high is not None and val > high:
                problem = f"{_schema_at(at)}: above maxInclusive {_bound_text(sch['maximum'], inexact)}"
            elif xlow and xlow[0] is not None and not val > xlow[0]:
                problem = f"{_schema_at(at)}: not above exclusiveMinimum {_bound_text(xlow[1], inexact)}"
            elif xhigh and xhigh[0] is not None and not val < xhigh[0]:
                problem = f"{_schema_at(at)}: not below exclusiveMaximum {_bound_text(xhigh[1], inexact)}"
        children: list[tuple[Any, Any, Any]] = []
        if isinstance(val, list):
            if "minItems" in sch and len(val) < _inty(sch["minItems"]):
                problem = f"{_schema_at(at)}: needs at least {_inty(sch['minItems'])} values, got {len(val)}"
            elif "maxItems" in sch and len(val) > _inty(sch["maxItems"]):
                problem = f"{_schema_at(at)}: takes at most {_inty(sch['maxItems'])} values, got {len(val)}"
            items = sch.get("items")
            if "items" in sch and isinstance(items, (bool, dict)):
                children.extend((items, item, (at, i)) for i, item in enumerate(val))
        elif isinstance(val, dict):
            if isinstance(sch.get("required"), list):
                missing = next((key for key in sch["required"] if isinstance(key, str) and key not in val), None)
                if missing is not None:
                    problem = f'{_schema_at(at)}: is missing the key "{missing}"'
            props = sch["properties"] if isinstance(sch.get("properties"), dict) else None
            extra = sch["additionalProperties"] if "additionalProperties" in sch else True
            children.extend((props[key] if props is not None and key in props else extra, val[key], (at, _pointer_token(key)))
                            for key in _js_keys(val))
        if problem is not None:
            report(problem)
            return
        stack.extend(reversed(children))


_IRI_EXCLUDED = re.compile('[\\x00-\\x20<>"{}|\\\\^`\\x7f]')


def _is_iri(text: str) -> bool:
    """Whether text is an absolute IRI, as sh:nodeKind sh:IRI asks of a value:
    a scheme, then no space, control character or other character RFC 3987
    leaves out of an IRI. The page's isIri is the same."""
    return _has_scheme(text) and not _IRI_EXCLUDED.search(text)


# The range of each XSD integer type narrower than xsd:integer.
_INTEGER_RANGES: dict[str, tuple[int | None, int | None]] = {
    "byte": (-128, 127), "short": (-32768, 32767), "int": (-2 ** 31, 2 ** 31 - 1), "long": (-2 ** 63, 2 ** 63 - 1),
    "unsignedByte": (0, 255), "unsignedShort": (0, 65535), "unsignedInt": (0, 2 ** 32 - 1), "unsignedLong": (0, 2 ** 64 - 1),
    "nonNegativeInteger": (0, None), "positiveInteger": (1, None), "nonPositiveInteger": (None, 0), "negativeInteger": (None, -1),
}
# The XSD 1.1 (Part 2) date and time datatypes, each checked against its
# lexical grammar by hand, and against its value constraints: a year of four
# digits or more (no leading zero past four, a "-" before it, 0000 allowed), a
# month from 01 to 12, a day no later than its month's last (29 February only
# in a leap year of the proleptic Gregorian calendar, or in a gMonthDay), an
# hour from 00 to 23, or 24:00:00 exactly, minutes and seconds from 00 to 59, a
# fraction of a second of one digit or more, a timezone of Z or of +hh:mm or
# -hh:mm no more than 14:00 from UTC (one an xsd:dateTimeStamp must have), and
# a duration of one part or more, in the order Y M D, then T and H M S, a
# fraction only on the seconds, and T only before a part of the time. Digits
# are ASCII digits. The page's TEMPORAL and xsdTemporal are the same, step for
# step.
_TEMPORAL = frozenset({"date", "dateTime", "dateTimeStamp", "time", "gYear", "gYearMonth", "gMonth", "gDay", "gMonthDay",
                       "duration", "yearMonthDuration", "dayTimeDuration"})


def _char(s: str, i: int) -> str:
    return s[i] if 0 <= i < len(s) else ""


def _digits_at(s: str, i: int) -> int:
    j = i
    while j < len(s) and "0" <= s[j] <= "9":
        j += 1
    return j - i


def _two_at(s: str, i: int, low: int, high: int) -> int:
    """The two digits at i, as a number from low to high, or -1."""
    if _digits_at(s, i) < 2:
        return -1
    n = int(s[i:i + 2])
    return n if low <= n <= high else -1


def _year_at(s: str, i: int) -> tuple[int, int] | None:
    """A year at i: (where it ends, its last four digits), or None."""
    if _char(s, i) == "-":
        i += 1
    n = _digits_at(s, i)
    if n < 4 or (n > 4 and s[i] == "0"):
        return None
    return i + n, int(s[i + n - 4:i + n])


def _month_days(month: int, leap: bool) -> int:
    return (29 if leap else 28) if month == 2 else (30 if month in (4, 6, 9, 11) else 31)


def _leap_year(last4: int) -> bool:
    """Whether a year whose last four digits these are is a leap year: 4, 100 and 400 all divide 10,000."""
    return last4 % 400 == 0 or (last4 % 4 == 0 and last4 % 100 != 0)


def _date_at(s: str, i: int) -> int:
    """A date at i, year-month-day: where it ends, or -1."""
    year = _year_at(s, i)
    if year is None or _char(s, year[0]) != "-":
        return -1
    month = _two_at(s, year[0] + 1, 1, 12)
    if month < 0 or _char(s, year[0] + 3) != "-":
        return -1
    day = _two_at(s, year[0] + 4, 1, 31)
    return -1 if day < 0 or day > _month_days(month, _leap_year(year[1])) else year[0] + 6


def _time_at(s: str, i: int) -> int:
    """A time at i, hh:mm:ss and a fraction: where it ends, or -1. 24:00:00 is the end of a day, exactly."""
    hour = _two_at(s, i, 0, 24)
    minute = _two_at(s, i + 3, 0, 59) if _char(s, i + 2) == ":" else -1
    second = _two_at(s, i + 6, 0, 59) if minute >= 0 and _char(s, i + 5) == ":" else -1
    if hour < 0 or second < 0:
        return -1
    end = i + 8
    zero = True
    if _char(s, end) == ".":
        n = _digits_at(s, end + 1)
        if not n:
            return -1
        zero = all(c == "0" for c in s[end + 1:end + 1 + n])
        end += 1 + n
    return -1 if hour == 24 and (minute != 0 or second != 0 or not zero) else end


def _zone_at(s: str, i: int) -> int:
    """What is at i, to the end: nothing (0), a timezone (1), or anything else (-1)."""
    if i == len(s):
        return 0
    if _char(s, i) == "Z":
        return 1 if i + 1 == len(s) else -1
    if _char(s, i) not in ("+", "-") or _char(s, i + 3) != ":" or i + 6 != len(s):
        return -1
    hour = _two_at(s, i + 1, 0, 14)
    minute = _two_at(s, i + 4, 0, 59)
    return -1 if hour < 0 or minute < 0 or (hour == 14 and minute != 0) else 1


def _duration_ok(kind: str, s: str) -> bool:
    """A duration: an optional "-", "P", then parts of digits and a letter, in
    the order Y M D, then T and H M S. A yearMonthDuration has only Y and M; a
    dayTimeDuration no Y and no M before T."""
    i = 1 if _char(s, 0) == "-" else 0
    if _char(s, i) != "P":
        return False
    i += 1
    units, last, parts, time_parts, used = "YMD", -1, 0, -1, ""
    while i < len(s):
        if s[i] == "T":
            if time_parts >= 0:
                return False
            time_parts, units, last = 0, "HMS", -1
            i += 1
            continue
        n = _digits_at(s, i)
        if not n:
            return False
        j = i + n
        fraction = False
        if _char(s, j) == ".":
            f = _digits_at(s, j + 1)
            if not f:
                return False
            j += 1 + f
            fraction = True
        at = units.find(s[j]) if j < len(s) else -1
        if at <= last or (fraction and not (time_parts >= 0 and s[j] == "S")):
            return False
        last = at
        parts += 1
        if time_parts >= 0:
            time_parts += 1
        else:
            used += s[j]
        i = j + 1
    if not parts or time_parts == 0:
        return False
    if kind == "yearMonthDuration":
        return time_parts < 0 and "D" not in used
    if kind == "dayTimeDuration":
        return "Y" not in used and "M" not in used
    return True


def _xsd_temporal(kind: str, s: str) -> bool:
    """Whether text is a value of the XSD date or time datatype named."""
    if kind == "date":
        end = _date_at(s, 0)
        return end >= 0 and _zone_at(s, end) >= 0
    if kind in ("dateTime", "dateTimeStamp"):
        end = _date_at(s, 0)
        if end < 0 or _char(s, end) != "T":
            return False
        end = _time_at(s, end + 1)
        zone = -1 if end < 0 else _zone_at(s, end)
        return zone >= 0 if kind == "dateTime" else zone == 1
    if kind == "time":
        end = _time_at(s, 0)
        return end >= 0 and _zone_at(s, end) >= 0
    if kind == "gYear":
        year = _year_at(s, 0)
        return year is not None and _zone_at(s, year[0]) >= 0
    if kind == "gYearMonth":
        year = _year_at(s, 0)
        return (year is not None and _char(s, year[0]) == "-" and _two_at(s, year[0] + 1, 1, 12) >= 0
                and _zone_at(s, year[0] + 3) >= 0)
    if kind == "gMonth":
        return s.startswith("--") and _two_at(s, 2, 1, 12) >= 0 and _zone_at(s, 4) >= 0
    if kind == "gDay":
        return s.startswith("---") and _two_at(s, 3, 1, 31) >= 0 and _zone_at(s, 5) >= 0
    if kind == "gMonthDay":
        month = _two_at(s, 2, 1, 12) if s.startswith("--") else -1
        day = _two_at(s, 5, 1, 31) if month >= 0 and _char(s, 4) == "-" else -1
        return day >= 0 and day <= _month_days(month, True) and _zone_at(s, 7) >= 0
    return _duration_ok(kind, s)


# The datatypes whose values this client checks: text, an IRI, a number, a
# boolean, a date or a time, and rdf:JSON. A field of any other names its
# datatype here, and a value given for it is refused, since its form (a
# language tag's, say) is not checked. The page's uncheckedDatatype is the same.
_CHECKED_XSD = frozenset({"string", "anyURI", "boolean", "decimal"}) | _XSD_INTEGERS | _XSD_DOUBLES | _TEMPORAL


def _unchecked_datatype(fld: Field) -> str | None:
    dt = _text(fld.datatype)
    if not dt or fld.json_kind or _is_rdf_json(dt):
        return None
    local = _xsd_name(dt)
    if local is None:
        return dt
    return None if local in _CHECKED_XSD else "xsd:" + local


_NODE_KIND_WORDS = {"IRI": "an IRI", "Literal": "a literal", "BlankNode": "a blank node", "BlankNodeOrIRI": "a blank node or an IRI",
                    "IRIOrLiteral": "an IRI or a literal"}


def _address_leaves(value: Any, in_template: bool) -> bool:
    """Whether a value, put in an address, would be left out of it in part or
    whole: None and "" are, and so is a list with no items or with a None or ""
    in it, which the query and RFC 6570 both drop; in a template, also any
    value RFC 6570 reads as undefined, such as {} or [[]], and an object with a
    member it drops. A query writes an object as its JSON, whole. The page's
    addressLeaves is the same."""
    if value is None or value == "":
        return True
    if isinstance(value, list):
        return not value or any(item is None or item == "" for item in value) or (in_template and not _template_defined(value))
    if isinstance(value, dict):
        return in_template and (not _template_defined(value) or any(not _template_defined(item) for item in value.values()))
    return False


def coerce_value(fld: Field, value: Any) -> Any:
    """A field's value typed by the field, or a ValueError whose message is
    the problem, the field named in it, as the page's coerceValue words it. A
    value that is not text is read as its text, as the page's String() writes
    it (a JSON true as true, 2.0 as 2). A value given is never empty text
    here, which is no value; a default of empty text is a value, and is read
    as one: as text, or refused by name where the field reads no value in it
    (a number, a boolean or JSON)."""
    if value is None:
        return None
    if fld.json_kind:
        parsed = value
        if not isinstance(value, (dict, list)):
            # Read as a document is: NaN, Infinity and a repeated key are
            # refused, as the page refuses them, and never reach a request.
            try:
                parsed = _strict_json(value if isinstance(value, str) else _scalar_text(value))
            except _TooDeep as exc:
                raise ValueError(f"{fld.name}{_DEEP_VALUE}") from exc
            except _RepeatedKey as exc:
                raise ValueError(f'{fld.name} repeats the key "{exc.key}" in one object, so which value it means is not '
                                 "known") from exc
            except ValueError as exc:
                raise ValueError(f"{fld.name} must be JSON") from exc
            # A number the double reading it gives would change is refused,
            # never sent changed; a body sent whole is sent as written, so its
            # numbers are not.
            changed = [] if fld.raw_body else _changed_numbers(value if isinstance(value, str) else _scalar_text(value), True)
            if changed:
                raise ValueError(_changed_problem(fld.name, changed[0][0]))
        # A JSON Schema whose type names null takes it, whatever else it takes.
        if parsed is None and fld.nullable:
            return None
        if fld.json_kind == "object" and not isinstance(parsed, dict):
            raise ValueError(f"{fld.name} must be a JSON object")
        if fld.json_kind == "array" and not isinstance(parsed, list):
            raise ValueError(f"{fld.name} must be a JSON array")
        return parsed
    numeric = _numeric_kind(fld)
    if numeric:
        try:
            return _coerce_number(numeric, value)
        except ValueError as exc:
            raise ValueError(f"{fld.name}: {exc}") from exc
    if _xsd_name(fld.datatype) == "boolean":
        # XSD's four forms, true, false, 1 and 0, trimmed of space, tab, CR and LF, as a number is, and
        # of nothing else: a value given is read as a default is, so "yes" and "TRUE" are no boolean.
        text = (value if isinstance(value, str) else _scalar_text(value)).strip(_SPACES)
        if text in {"true", "1"}:
            return True
        if text in {"false", "0"}:
            return False
        raise ValueError(f"{fld.name} must be a boolean")
    return value


def _bound_text(bound: Any, numbers: Any) -> str:
    """A bound as a problem names it: a number as its document writes it
    (_named_text), text as it is. The page's boundText is the same."""
    return _named_text(bound, numbers) if _is_number(bound) else _scalar_text(bound)


def _scalar_text(value: Any) -> str:
    """A typed value as text, as the page's String() writes it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return _js_number_text(value)
    return "" if value is None else str(value)


def _unpaired_surrogate(value: Any) -> bool:
    """Whether a value holds an unpaired UTF-16 surrogate, in a string or in an
    object's key. That is not Unicode text: UTF-8 cannot carry it (encoding
    the request would fail), I-JSON (RFC 7493) forbids it, and the page's
    URLSearchParams would write U+FFFD in its place, so a value that holds one
    is not sent. A Python string holds a surrogate only unpaired: json.loads
    joins an escaped pair into one character. A walk with a stack. The page's
    unpaired is the same."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            if _SURROGATE.search(item):
                return True
        elif isinstance(item, dict):
            for key, one in item.items():
                if isinstance(key, str) and _SURROGATE.search(key):
                    return True
                stack.append(one)
        elif isinstance(item, list):
            stack.extend(item)
    return False


def _multi_items(value: Any) -> list[Any]:
    """A list field's values: a list as given (a repeated --field, or the
    defaults), or text, read as a JSON array when it is one and otherwise as one
    value per line, with blank values and lines dropped. The page's multiItems
    is the same. NaN and Infinity are not JSON, so "[NaN]" is a line of text.
    A repeated key takes its last value here, as in JSON.parse: it can only be
    in an object, and no object is a list field's value; validate_fields
    refuses each one, whatever its keys. A JSON array that holds a number its
    double would change is refused, the number named (_ChangedNumber), never
    read as that double."""
    def kept(item: Any) -> bool:
        return item is not None and not (isinstance(item, str) and not item.strip(_SPACES))
    if isinstance(value, list):
        return [item for item in value if kept(item)]
    text = str(value)
    if text.strip(_SPACES).startswith("["):
        try:
            parsed = _page_json(text)
        except _TooDeep:
            raise
        except ValueError:
            parsed = None
        if isinstance(parsed, list):
            changed = _changed_numbers(text, True)
            if changed:
                raise _ChangedNumber(changed[0][0])
            return [item for item in parsed if kept(item)]
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return [line for line in lines if line.strip(_SPACES)]


def _check_value(fld: Field, found: Any, numeric: str | None, report: Any, choices: _ShapeChoices | None,
                 from_default: bool, enums: dict[int, Any] | None = None, facts: _FieldFacts | None = None) -> Any:
    """One value of a field, typed and checked; each problem goes to `report`,
    which keeps it once. Returns the value to send. A value given for a field
    with a constraint this client does not check is refused, with the
    constraint named. A JSON Schema field's value is the choice it names, if
    it names one, unless it is the field's default (`from_default`), which is
    checked as the document gives it, never as the choice its text names; it
    is checked by _check_schema. Any other field's value is checked by its
    facets, its sh:in by `choices` (_shape_choices, read once per field). A
    field that takes no value (sh:maxCount 0, or an empty sh:in, sh:or,
    sh:xone or sh:languageIn), or a template variable a closed shape does not
    name, refuses any; a default is first checked to be of the
    kind its field takes, and a JSON Schema field's default is the value the
    document gives, never trimmed, read as a number or a boolean, or parsed as
    JSON: its schema checks it as it is. `enums` keys each enum once for a
    whole check, and `facts` (_FieldFacts) holds the field's sh:hasValue and
    bounds, read once for all its values. The page's checkValue is the same."""
    facts = facts if facts is not None else _FieldFacts(fld, numeric)
    if fld.unchecked:
        report(f"{fld.name}: has a constraint this client does not check ({', '.join(fld.unchecked)}), so it is not sent")
        return None
    if fld.not_writable:
        report(f"{fld.name}: is not writable (hydra:writable false), so it is not sent")
        return None
    if fld.closed_out:
        report(f"{fld.name}: is not allowed by its shape, which is closed (sh:closed true), so it is not sent")
        return None
    # A list of allowed values that is empty allows none; a JSON Schema's enum is its schema's to check, at any depth.
    if fld.empty and not fld.json_schema:
        report(f"{fld.name}: {_empty_text(fld)}, so it is not sent")
        return None
    if not fld.multi and fld.max_count == 0 and fld.max_items is None:
        report(f"{fld.name}: takes at most 0 values, got 1")
        return None
    unread_type = None if fld.json_schema else _unchecked_datatype(fld)
    if unread_type:
        report(f"{fld.name}: takes {unread_type}, whose form this client does not check, so it is not sent")
        return None
    wrong_kind = _default_kind_problem(fld, found) if from_default else None
    if wrong_kind:
        report(wrong_kind)
        return None
    as_given = from_default and fld.json_schema
    if numeric and isinstance(found, str) and not as_given:
        found = found.strip(_SPACES)
    choice = (next((c for c in _choices_of(fld) if c[0] == found), None)
              if fld.json_schema and not from_default and isinstance(found, str) else None)
    if choice is not None:
        typed = choice[1]
    elif as_given:
        typed = found
    else:
        try:
            typed = coerce_value(fld, found)
        except (TypeError, ValueError) as exc:
            report(str(exc))
            return None
    # A number no double holds (JSON's 1e400, a descriptor's default of it, or
    # an integer past the largest double) cannot be sent: json.dumps would
    # write Infinity, which is not JSON, and the page's JSON.stringify null. A
    # number field's value is checked by its type instead, and an integer
    # there, up to 2^53 - 1, is sent exactly.
    if (not numeric or as_given) and _past_double(typed):
        report(f"{fld.name}: holds a number too large to send")
        return None
    if _unpaired_surrogate(typed):
        report(f"{fld.name}: holds an unpaired surrogate, which is not Unicode text")
        return None
    if fld.json_schema:
        # An integer past 2^53 is not looked up in an enum's or a const's
        # entries, which are the doubles both clients read, perhaps rounded.
        if (numeric and _is_number(typed) and float(typed).is_integer() and abs(typed) > _MAX_SAFE_INTEGER
                and isinstance(fld.schema, dict) and ("enum" in fld.schema or "const" in fld.schema)):
            report(f"{fld.name}: integer too large to send exactly")
            return None
        _check_schema(fld.schema, typed, fld.name, report, enums, fld.inexact)
        return typed
    structured = isinstance(typed, (dict, list))
    # A JSON array holds as many values as it has items, and a field that takes
    # one object holds one; a field's min_items and max_items bound that count.
    count = len(typed) if isinstance(typed, list) else (1 if isinstance(typed, dict) and fld.json_kind == "object" else None)
    if count is not None and fld.min_items is not None and count < fld.min_items:
        report(f"{fld.name}: needs at least {fld.min_items} values, got {count}")
    if count is not None and fld.max_items is not None and count > fld.max_items:
        report(f"{fld.name}: takes at most {fld.max_items} values, got {count}")
    local = _xsd_name(fld.datatype)
    bounds_of_type = _INTEGER_RANGES.get(local or "") if numeric == "integer" and _is_number(typed) else None
    if bounds_of_type and ((bounds_of_type[0] is not None and typed < bounds_of_type[0]) or
                           (bounds_of_type[1] is not None and typed > bounds_of_type[1])):
        report(f"{fld.name}: out of the range of xsd:{local}")
    # A float is a double here, but one past the largest float is none.
    if local == "float" and _is_number(typed):
        try:
            struct.pack("<f", typed)
        except OverflowError:
            report(f"{fld.name}: out of the range of xsd:float")
    # A date or a time is text in its datatype's lexical form, sent as typed.
    if local in _TEMPORAL and isinstance(typed, str) and not _xsd_temporal(local, typed):
        report(f"{fld.name}: not an xsd:{local}")
    # A length facet measures text: SHACL counts the text of a literal or an
    # IRI. A body sent whole is measured as it is sent. A JSON value in a field
    # (a node, or rdf:JSON) has no one text a length facet measures, so it is
    # refused.
    json_valued = bool(fld.json_kind) and not fld.raw_body
    if json_valued and (fld.min_length is not None or fld.max_length is not None):
        report(f"{fld.name}: holds JSON, which a length facet does not measure, so it is not sent")
    elif not json_valued:
        text = found if fld.raw_body and isinstance(found, str) else (typed if isinstance(typed, str) else _scalar_text(typed))
        if fld.min_length is not None and len(text) < fld.min_length:
            report(f"{fld.name}: shorter than minLength {fld.min_length}")
        if fld.max_length is not None and len(text) > fld.max_length:
            report(f"{fld.name}: longer than maxLength {fld.max_length}")
    # A field's pattern is reported by `describe` and never run: a remote
    # regular expression can take time exponential in the input, and the
    # server that receives the value is the one that enforces it.
    choice_problem = choices.problem_for(typed) if choices is not None else None
    if choice_problem is not None:
        report(choice_problem)
    if facts.has_value is not None and not fld.multi:
        if not _has_value_matches(facts, numeric, typed):
            report(f"{fld.name}: must be {facts.has_value[4]}")
        elif facts.has_value[3]:
            report(_rounded_problem(fld.name, facts.has_value[4], facts.has_value[3]))
    # A bound is compared with a number: a value that is none (text, or a node)
    # is an error, not a pass, as SHACL has a comparison it cannot make. A bound
    # that is no number, such as a date, is not compared, so a value is refused;
    # nor is one on a field that takes no number (text, a date, JSON), which
    # SHACL would compare with the value's own datatype, never with the number
    # it reads as.
    bounds = facts.bounds
    unread_bound = next((b for b in bounds if b[1] is None), None)
    if unread_bound:
        report(f"{fld.name}: its sh:{unread_bound[0]} {unread_bound[2]} is not a number, which this client does not "
               "compare, so it is not sent")
    elif bounds and not numeric:
        report(f"{fld.name}: its sh:{bounds[0][0]} {bounds[0][2]} bounds a field that takes no number, which this client "
               "does not compare, so it is not sent")
    elif any(b[3] for b in bounds):
        unsure = next(b for b in bounds if b[3])
        report(_inexact_problem(fld.name, "sh:" + unsure[0], unsure[2]))
    elif bounds:
        number = None if structured else _lexical_number(typed)
        if number is None:
            report(f"{fld.name}: not a number")
        else:
            for kind, limit, text, _ in bounds:
                if kind == "minInclusive" and number < limit:
                    report(f"{fld.name}: below minInclusive {text}")
                if kind == "maxInclusive" and number > limit:
                    report(f"{fld.name}: above maxInclusive {text}")
                if kind == "minExclusive" and not number > limit:
                    report(f"{fld.name}: not above minExclusive {text}")
                if kind == "maxExclusive" and not number < limit:
                    report(f"{fld.name}: not below maxExclusive {text}")
    # A text value is an IRI or a literal as the shape asks; a JSON value is a
    # node, each item of one a field holds as a JSON array of its values is one
    # value, and an rdf:JSON value is a literal, whatever JSON it holds.
    if fld.node_kind and fld.node_kind != "BlankNodeOrLiteral":
        literal = _is_rdf_json(fld.datatype)

        def meets(value: Any) -> bool:
            iri = not literal and isinstance(value, str) and _is_iri(value)
            node = not literal and isinstance(value, (dict, list))
            return {"IRI": iri, "Literal": not node, "BlankNode": node, "BlankNodeOrIRI": node or iri,
                    "IRIOrLiteral": not node}[fld.node_kind]
        nodes = typed if fld.json_kind == "array" and isinstance(typed, list) else [typed]
        if not all(meets(value) for value in nodes):
            report(f"{fld.name}: must be {_NODE_KIND_WORDS[fld.node_kind]}")
    # A JSON request body is sent as it was written, once it parses.
    return found if fld.raw_body and fld.json_kind and isinstance(found, str) else typed


def _default_kind_problem(fld: Field, value: Any) -> str | None:
    """A default is of the kind its field takes when the field is neither JSON
    Schema's (whose schema checks its default) nor JSON: text, or for a number
    or a boolean that value or its text, a boolean's being XSD's (true, false,
    1 or 0). One of another kind is refused by name, never sent as another
    kind of JSON nor changed into its text. The page's defaultKindProblem is
    the same."""
    if fld.json_schema or fld.json_kind:
        return None
    kind = "number" if _numeric_kind(fld) else ("boolean" if _xsd_name(fld.datatype) == "boolean" else None)
    # A boolean's text is XSD's, true, false, 1 or 0, with the spaces XSD
    # collapses around it: "yes" is a value a form may take, never a default.
    if isinstance(value, str) and not (kind == "boolean" and value.strip(_SPACES) not in ("true", "false", "1", "0")):
        return None
    if kind == "number" and _is_number(value) or kind == "boolean" and isinstance(value, bool):
        return None
    word = {"number": "a number", "boolean": "a boolean"}.get(kind or "", "text")
    # Empty text is named as its JSON, "", so the problem shows it.
    shown = '""' if value == "" else _entry_text(value)
    return f"{fld.name}: its default {shown} is not {word}, which this field takes, so it is not sent"


def _field_value(fld: Field, found: Any, report: Any, enums: dict[int, Any]) -> tuple[Any, bool]:
    """One field's value from what was given for it, typed and checked, as
    (the value, whether it is one to send); each problem goes to `report`.
    Nothing given (None, "" or an empty list) is the field's default as the
    document gives it, whether a flag gave nothing or none was given, as the
    page reads a link's empty value, a cleared input and an untouched form. A
    list field takes several values (a repeated --field, a JSON array, or one
    per line) and is checked against its sh:minCount and sh:maxCount; a list
    given is checked as it was given, and one that reads as no values is
    refused, never replaced by the default; a default is sent with every value
    it holds or refused, never without a blank one. A field that takes one
    value takes the last one given; a JSON Schema default of null is that
    value, sent where its schema allows null. `enums` keys each enum once for
    the whole check. The page's fieldValue is the same."""
    problems = 0

    def note(message: str) -> None:
        nonlocal problems
        problems += 1
        report(message)
    # Each field checked, and below each of a list's values, is charged (_spend).
    _spend(1)
    numeric = _numeric_kind(fld)
    required = fld.required or (fld.min_count or 0) >= 1
    facts = _FieldFacts(fld, numeric)
    if isinstance(found, str) and found == "":
        found = None
    if fld.multi:
        given = found is not None and found != []
        try:
            items = _multi_items(found) if found is not None else []
        except _TooDeep:
            note(f"{fld.name}{_DEEP_VALUE}")
            return None, False
        except _ChangedNumber as exc:
            note(_changed_problem(fld.name, exc.written))
            return None, False
        if not items and given:
            note(f"{fld.name}: was given no values")
            return None, False
        from_default = not items and fld.default is not None
        if from_default:
            listed = fld.default if isinstance(fld.default, list) else [fld.default]
            items = _multi_items(listed)
            # A default is read as a value given is: one with entries that are all blank holds no values,
            # which is the default's problem, not a value given.
            if not items and any(x is not None for x in listed):
                note(f"{fld.name}: its default holds no values, so it is not sent")
                return None, False
            # One with a blank entry among others is sent as the document gives it or not at all: never without it.
            if len(items) != len(listed):
                note(f"{fld.name}: its default holds a blank value, which this client neither drops nor sends, so it is not sent")
                return None, False
            if fld.rounded_default:
                note(f"{fld.name}{_ROUNDED_DEFAULT}")
                return None, False
        if not items:
            if required:
                note(f"missing required field '{fld.name}'")
            return None, False
        if fld.min_count and len(items) < fld.min_count:
            note(f"{fld.name}: needs at least {fld.min_count} values, got {len(items)}")
        if fld.max_count is not None and len(items) > fld.max_count:
            note(f"{fld.name}: takes at most {fld.max_count} values, got {len(items)}")
        # The values are checked in order, and the check stops at the first
        # one with a problem, which is the one named: a long list with many bad
        # values costs its length once, and names one problem of them.
        typed_items = []
        choices = _shape_choices(fld, numeric)
        stopped = False
        _spend(len(items))
        for item in items:
            before = problems
            if isinstance(item, (dict, list)):
                note(f"{fld.name}: each value is one {local_name(fld.datatype) or 'text'} value, not JSON")
            else:
                wrong_kind = _default_kind_problem(fld, item) if from_default else None
                if wrong_kind:
                    note(wrong_kind)
                else:
                    # A JSON number stays one in a number field, so one past 2^53 is not read as the text of its double.
                    typed_items.append(_check_value(fld, item if isinstance(item, str) or numeric else _scalar_text(item), numeric,
                                                    note, choices, False, enums, facts))
            if problems > before:
                stopped = True
                break
        # sh:hasValue asks that one of a list's values be the one it names.
        if facts.has_value is not None and not stopped:
            if not any(v is not None and _has_value_matches(facts, numeric, v) for v in typed_items):
                note(f"{fld.name}: must include {facts.has_value[4]}")
            elif facts.has_value[3]:
                note(_rounded_problem(fld.name, facts.has_value[4], facts.has_value[3]))
        return typed_items, problems == 0
    if isinstance(found, list):
        found = found[-1] if found else None
    from_default = False
    # A JSON Schema default of null is sent as null where the schema allows null, and refused where it does not.
    if (found is None or found == "") and (fld.default is not None or fld.null_default):
        found = fld.default
        from_default = True
    if from_default and fld.rounded_default:
        note(f"{fld.name}{_ROUNDED_DEFAULT}")
        return None, False
    # Spaces around a number are not part of it; a number field given only
    # spaces holds no number, which is refused, not filled with the default,
    # and a default of only spaces is refused as one given is. A JSON Schema
    # default is checked by its schema as it is.
    if numeric and isinstance(found, str) and not (from_default and fld.json_schema):
        spaced = found != ""
        found = found.strip(_SPACES)
        if found == "" and spaced:
            try:
                _coerce_number(numeric, found)
            except ValueError as exc:
                note(f"{fld.name}: {exc}")
            return None, False
    # A default of empty text is a value, sent as the document gives it or refused by name; empty text given is none.
    if (found is None or (found == "" and not from_default)) and not (from_default and fld.null_default):
        if required:
            note(f"missing required field '{fld.name}'")
        return None, False
    value = _check_value(fld, found, numeric, note, None if fld.json_schema else _shape_choices(fld, numeric), from_default, enums,
                         facts)
    return value, problems == 0


def validate_fields(control: Control, supplied: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The values to send, each typed by its field (_field_value), and every
    problem with them. A name that is no field's is a problem, not something
    silently dropped, and so are values given under two names of one field.
    The page's validateFields is the same."""
    if control.problem:
        return {}, [control.problem]
    errors: list[str] = []
    values: dict[str, Any] = {}
    # Each problem is kept once, looked up in a set beside the list.
    seen: set[str] = set()

    def report(message: str) -> None:
        if message not in seen:
            seen.add(message)
            errors.append(message)
    enums: dict[int, Any] = {}
    incoming = dict(supplied)
    known: set[str] = set()
    for fld in control.fields:
        aliases = _aliases(fld)
        known.update(aliases)
        # A value is given under one of a field's names; values under two of
        # them are a problem, never one of them taken and the other dropped.
        named = [alias for alias in aliases if alias in incoming and incoming[alias] is not None and incoming[alias] != ""]
        found = incoming.pop(named[0]) if named else None
        if len(named) > 1:
            report(f"{fld.name}: values were given under more than one of its names ({', '.join(named)})")
            for alias in named[1:]:
                incoming.pop(alias)
        value, ok = _field_value(fld, found, report, enums)
        if ok:
            values[fld.name] = value
    for name in incoming:
        if name not in known:
            report(f"no input field is named '{name}'")
    # A value that goes in the address (a template's variable, or any value of
    # a safe method, which sends no body) is refused where the address would
    # leave it out, whole or in part, so what is sent is what was checked.
    in_template = _template_variables(control.template) if control.template else set()
    safe = (control.method or "POST") in SAFE_METHODS
    for fld in control.fields:
        if fld.raw_body or fld.name not in values or not (safe or fld.name in in_template):
            continue
        if _address_leaves(values[fld.name], fld.name in in_template):
            report(f'{fld.name}: holds a value an address leaves out (null, "", [] or {{}}, alone or inside it), so it is not sent')
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
    # In the order the page's Object.keys gives them: array indexes first.
    keys = [key for key in _js_keys(params) if params[key] is not None and params[key] != ""]
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
            keep.append((key, _request_json(val)))
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
    """The request a control's values make. A value holding NaN or an
    infinity, which no JSON or address carries, or an unpaired surrogate,
    which UTF-8 cannot carry, raises UnsendableValue naming its field;
    validate_fields refuses one first."""
    for name, value in values.items():
        if _past_double(value, integers=False):
            raise UnsendableValue(f"{name}: holds NaN or an infinity, which is not JSON, so nothing is sent")
        if _unpaired_surrogate(value):
            raise UnsendableValue(f"{name}: holds an unpaired surrogate, which is not Unicode text, so nothing is sent")
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
        raw_text = raw_value if isinstance(raw_value, str) else _request_json(raw_value)
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
            body_text = _request_json(values, indent=2)
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
            body_text = _request_json(values, indent=2)
            headers.setdefault("Content-Type", "application/json")
    # An address that is sent is shown exactly as it is sent; one that is not
    # (a template that does not give http or https) in its URI form.
    if url:
        url = _request_url(url) if is_web_url(url) else _iri_to_uri(url)
    # What the request holds is charged: its address and its body.
    _spend(_utf16_length(url or "") + _utf16_length(body_text or ""))
    return RequestPlan(control=control, transport=transport, method=method, url=url,
                       headers=headers, body=body, body_text=body_text, fields=values,
                       mcp=mcp, notes=notes)


# A response is read up to RESPONSE_MAX bytes and no further: past that the read
# stops, and nothing of the response is shown, named (TOO_LARGE), whatever its
# status says of the request. A descriptor's 2xx answer is read so too, and past
# it does not count; a load that ends with none that counts names the first such
# (_document_too_large). The page's RESPONSE_MAX, TOO_LARGE and documentTooLarge
# are the same.
RESPONSE_MAX = 8 * 1024 * 1024
TOO_LARGE = f"This response is larger than {RESPONSE_MAX} bytes, so it was not read, and nothing of it is shown."


def _document_too_large(url: str) -> str:
    return f"The answer to {url} is larger than {RESPONSE_MAX} bytes, so it was not read."


# What a response is shown as grows at most linearly with its size. Its text is
# written as received; indenting its JSON may add _LAYOUT_PER_BYTE characters
# for each of its bytes, and _LAYOUT_FLOOR at least. Past that it is shown as its
# text, after a note naming why (_json_as_text), so JSON's depth does not set
# what is written. The page's LAYOUT_PER_BYTE, LAYOUT_FLOOR, indentSize and
# jsonAsText are the same; the page also lays a SPARQL result out as a table,
# within a bound of its own, where hmc.py writes it as the JSON it is. Past the
# table's bound the page shows the result as JSON, as hmc.py does, indented by
# the same rule, and past that as its text, after a note of its own first
# (tableAsJson). JSON shown is the text the page shows (_json_shown).
_LAYOUT_PER_BYTE = 8
_LAYOUT_FLOOR = 10000


def _layout_bound(size: int) -> int:
    return max(_LAYOUT_FLOOR, _LAYOUT_PER_BYTE * size)


def _json_as_text(added: int, size: int) -> str:
    return (f"This JSON, indented, would add {added} characters, more than a response of {size} bytes is shown as; "
            "it is shown as text.")


def _indent_size(value: Any) -> int:
    """The characters indenting JSON by two spaces adds to it, as the page's
    JSON.stringify(value, null, 2) writes it beyond JSON.stringify(value), and
    json.dumps(indent=2) alike: each member of a list or object that has one on
    a line of its own, one level deeper, an object's ": " for ":", and the
    closing bracket on a line of its own. A walk with a stack, linear in the
    value. The page's indentSize is the same."""
    total = 0
    stack: list[tuple[Any, int]] = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        if isinstance(item, dict):
            members = list(item.values())
        elif isinstance(item, (list, tuple)):
            members = list(item)
        else:
            continue
        if not members:
            continue
        total += len(members) * (2 * depth + 3) + (len(members) if isinstance(item, dict) else 0) + 2 * depth + 1
        stack.extend((member, depth + 1) for member in members)
    return total


def _json_shown(value: Any, limit: int | None = None) -> str:
    """What text mode writes of a response it shows as JSON, before it cuts
    it to 8,000 characters: the text the page shows, its JSON.stringify(value,
    null, 2), character for character (_js_json), so text past ASCII is
    written as it is, each number as JavaScript writes it, and an object's
    keys in JavaScript's order. json.dumps wrote "caf\\u00e9", 1.0 and 1e+20
    where the page shows "café", 1 and 100000000000000000000. Its control
    characters are then shown as escapes, as in all remote text (tty_safe).
    With `limit`, only the text's start is written, `limit` characters of it
    at least (_js_json), so text mode costs what it writes, not the response."""
    return _js_json(value, 2, limit=limit)


def _json_written(value: Any, size: int) -> str:
    """What list --json, describe and invoke write of a value of their own (a
    listing, a control, a request and its outcome): JSON indented by two spaces
    while that adds no more than a document of `size` bytes allows
    (_layout_bound), and unindented past it, so the depth of a value a document
    or a person gives does not set how much is written. The page shows a
    request so."""
    return _json_out(value, 2 if _indent_size(value) <= _layout_bound(size) else None)


def invoke_plan(plan: RequestPlan, *, confirm: bool = False, dry_run: bool | None = None) -> dict[str, Any]:
    """Sends a plan's request, or shows it, and says how it ended. `done` is
    true only for a 2xx answer, and `outcome` says what happened in words, as
    the page shows it. A request goes only to the address its dry run shows:
    one a safe control sends with GET or HEAD follows a redirect as a
    descriptor load does, and any other is sent without following one, so a
    redirect it is answered with is not done, and `redirect` names it."""
    unsafe = plan.control.unsafe
    if dry_run is None:
        dry_run = unsafe and not confirm
    result: dict[str, Any] = {"dryRun": dry_run, "unsafe": unsafe, "done": False, "request": plan.to_public()}
    if dry_run:
        result["message"] = "Dry run. Unsafe operations default to showing the exact request without sending it. Pass --confirm to execute."
        return result
    if unsafe and not confirm:
        raise RuntimeError("Refusing to execute an unsafe operation without --confirm")
    if plan.url:
        _require_web_url(plan.url)
    if plan.transport != "http" or not plan.url:
        result["message"] = ("No plain-HTTP transport is available for this control, so nothing was sent. "
                             "Use the Interego relay MCP call documented in request.mcp.")
        result["blocked"] = "mcp-required"
        return result
    data = None
    if plan.method not in SAFE_METHODS:
        if plan.body_text is not None:
            data = plan.body_text.encode("utf-8")
        elif plan.body is not None and not isinstance(plan.body, (str, bytes)):
            data = _request_json(plan.body).encode("utf-8")
    follow = not unsafe and plan.method in FOLLOWED_METHODS
    answer = http_exchange(plan.url, method=plan.method, headers=plan.headers, data=data, follow=follow, limit=RESPONSE_MAX)
    content_type = answer.headers.get("content-type", "")
    size = len(answer.body)
    # Past RESPONSE_MAX bytes nothing of the response is shown, and its text is null.
    text = None if size > RESPONSE_MAX else _body_text(answer.body)
    note = TOO_LARGE if text is None else None
    parsed = None
    if text is not None and ("json" in content_type or text.lstrip()[:1] in "{["):
        # Shown, never sent, so read as leniently as the page's JSON.parse
        # reads it: a repeated key takes its last value. NaN and Infinity are
        # not JSON there either, so such a body is shown as its text.
        try:
            parsed = _page_json(text)
        except ValueError:
            parsed = None
    if isinstance(parsed, (dict, list)):
        # JSON whose indenting would add more than its size allows is shown as
        # its text, after a note, and `body` is null: --json would indent it too.
        added = _indent_size(parsed)
        if added > _layout_bound(size):
            note = _json_as_text(added, size)
            parsed = None
    result["response"] = {"status": answer.status, "headers": answer.headers, "contentType": content_type,
                          "bodyText": text, "body": parsed, "url": plan.url, "landed": answer.landed}
    # `note` is given only with a note, so a response shown as it is reads as it did before there were notes.
    if note is not None:
        result["response"]["note"] = note
    if not follow and answer.status in REDIRECT_STATUSES:
        # Only a Location with something in it is one, as _WebOnlyRedirects
        # reads it; it is named as resolved against the address it came from.
        given = (answer.headers.get("location") or "").strip(" \t")
        location = urllib.parse.urljoin(plan.url, given) if given else None
        result["redirect"] = {"status": answer.status, "location": location}
        result["outcome"] = invoke_not_followed(plan.method, plan.url, answer.status, location)
    else:
        result["done"], result["outcome"] = invoke_done(plan.url, answer.status, answer.landed)
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
    """Prints what list writes of a descriptor (_control_table)."""
    print(_control_table(descriptor))


def _control_table(descriptor: Descriptor) -> str:
    """What list writes of a descriptor, built whole before any of it is
    written, each line charged as it is built (_spend): within one step of
    work, list writes the whole table or, past it, nothing."""
    lines: list[str] = []

    def say(text: Any = "") -> None:
        line = tty_safe(text)
        _spend(_utf16_length(line) + 1)
        lines.append(line)
    say(descriptor.title)
    say(descriptor.url)
    if descriptor.types:
        say("types: " + ", ".join(local_name(t) or t for t in descriptor.types))
    if descriptor.description:
        say(textwrap.fill(descriptor.description, 100))
    if descriptor.problem:
        say(f"note: {descriptor.problem}")
    say()
    built = {id(control): whole for control, whole in zip(descriptor.controls, descriptor.listing())}
    safe = [c for c in descriptor.controls if not c.unsafe]
    unsafe = [c for c in descriptor.controls if c.unsafe]
    # The names of a field list several controls share are written once, with
    # the first control that has it, and so are a template's fields; each other
    # names that control. A control that is not invoked has its problem
    # written, not its fields.
    first_with: dict[tuple[int, ...], str] = {}
    keyed: dict[int, tuple[Any, tuple[int, ...]]] = {}

    def key_of(items: Any) -> tuple[int, ...]:
        hit = keyed.get(id(items))
        if hit is None or hit[0] is not items:
            hit = keyed[id(items)] = (items, tuple(id(fld) for fld in items))
        return hit[1]

    def names(items: Any) -> str:
        # * marks a required field, [] one that takes a list of values.
        return ", ".join(("*" if f.required or (f.min_count or 0) >= 1 else "") + f.name + ("[]" if f.multi else "") for f in items)
    tied: list[Any] = []
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
            if not built[id(control)]:
                say("         fields: not listed, since listing every control's would cost more than the document's size; "
                    "describe it to see them")
                if control.__dict__.get("conflict"):
                    say(f"         note: {control.__dict__['conflict']}")
                continue
            fields = None if control.problem else control.fields
            if fields:
                own = fields.own if isinstance(fields, _Joined) else fields
                shared = fields.template.fields if isinstance(fields, _Joined) else None
                key = key_of(own) + ((-1,) + key_of(shared) if shared is not None else ())
                hit = first_with.get(key)
                tied.append(fields)
                if hit is not None:
                    say(f"         fields: as listed for {hit}")
                elif shared is not None and (-2,) + key_of(shared) in first_with:
                    first_with[key] = control.rel
                    lead = names(own) + ", and the" if own else "the"
                    say(f"         fields: {lead} template's variables as listed for {first_with[(-2,) + key_of(shared)]}")
                else:
                    first_with[key] = control.rel
                    if shared is not None:
                        first_with[(-2,) + key_of(shared)] = control.rel
                    say("         fields: " + names(fields))
            for note in (control.problem, control.warning):
                if note:
                    say(f"         note: {note}")
        say()
    return "\n".join(lines)


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
    # Listing is one step of work: past its budget nothing is written, and the document is refused by name.
    with _working(descriptor.size):
        text = _json_written(descriptor.to_public(), descriptor.size) if args.json else _control_table(descriptor)
    print(text)
    return 0


def _find_control(descriptor: Descriptor, rel: str) -> Control:
    found = descriptor.matches(rel)
    if len(found) > 1:
        raise SystemExit(tty_safe(f"More than one control matches {rel!r}: {', '.join(c.rel for c in found)}. "
                                  "Name one by its full IRI; nothing was sent."))
    if not found:
        known = ", ".join(short_rel(c.rel) for c in descriptor.controls[:20])
        raise SystemExit(tty_safe(f"No control matching {rel!r}. Known (sample): {known}"))
    return found[0]


def _open_control(descriptor: Descriptor, control: Control) -> str | None:
    """Opens a control as the page does when it is selected, in one step of
    work: builds its fields and charges what showing it costs (_charge_shown).
    The problem that refuses it when that passes its document's budget
    (_work_problem), or None. describe writes no fields of a control so
    refused, and invoke sends nothing, as the page shows it no form."""
    try:
        with _working(descriptor.size):
            _charge_shown(control)
    except WorkExceeded as exc:
        return str(exc)
    return None


def _given_size(supplied: dict[str, Any]) -> int:
    """The bytes of the names and values given for a request (--field), as
    UTF-8 writes them, which add to what checking them may cost."""
    return sum(_utf8_length(name) + sum(_utf8_length(value) for value in as_list(given) if isinstance(value, str))
               for name, given in supplied.items())


def _sent_size(values: dict[str, Any]) -> int:
    """The bytes of the values a request sends, as JSON writes them (as the
    page's JSON.stringify), which add to what building it may cost."""
    return _utf8_length(_js_json(values))


def cmd_describe(args: argparse.Namespace) -> int:
    descriptor = load_descriptor(args.url)
    control = _find_control(descriptor, args.rel)
    refused = _open_control(descriptor, control)
    public = control.to_public(with_fields=refused is None)
    if refused is not None:
        public["problem"] = refused
        public["fields"] = None
    public["transport"] = classify_transport(control, descriptor.url)
    print(_json_written(public, descriptor.size))
    return 0


def cmd_invoke(args: argparse.Namespace) -> int:
    descriptor = load_descriptor(args.url)
    control = _find_control(descriptor, args.rel)
    supplied = parse_field_args(args.field or [])
    # Opened as the page opens it before it invokes, then its values checked
    # and its request built, each one step of work: the check's budget counts
    # the bytes given too, and the request's the bytes of the values it sends.
    refused = _open_control(descriptor, control)
    errors = [refused] if refused is not None else []
    sent_size = descriptor.size
    if not errors:
        try:
            with _working(descriptor.size + _given_size(supplied)):
                values, errors = validate_fields(control, supplied)
            if not errors:
                sent_size = descriptor.size + _sent_size(values)
                with _working(sent_size):
                    plan = resolve_plan(control, values, descriptor.url)
                result = invoke_plan(plan, confirm=args.confirm, dry_run=True if args.dry_run else None)
        except (UnsendableValue, WorkExceeded) as exc:
            errors = [str(exc)]
    if errors:
        say("Validation failed:", file=sys.stderr)
        for err in errors:
            say("  - " + err, file=sys.stderr)
        return 2
    # The same exit in text and --json mode: 0 for a dry run or a 2xx answer, 3
    # when the control has no plain-HTTP transport and nothing was sent, and 4
    # for any other answer. A refused address is 1 and a refused value 2.
    code = 0 if result.get("dryRun") or result.get("done") else 3 if result.get("blocked") else 4
    if args.json:
        # The response's text counts toward what may be written of it.
        print(_json_written(result, sent_size + _utf8_length((result.get("response") or {}).get("bodyText") or "")))
        return code
    req = result["request"]
    say(f"{req['method']} {req.get('url') or '(no HTTP URL)'}")
    say(f"transport: {req['transport']}")
    for note in req.get("notes") or []:
        say(f"note: {note}")
    if req.get("mcp"):
        say("mcp:")
        say(textwrap.indent(_json_written(req["mcp"], sent_size), "  "))
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
    say(result["outcome"])
    if result.get("redirect"):
        # A redirect's body is not the answer to the request, as the page shows none.
        return code
    if resp.get("note"):
        say(resp["note"])
    body = resp.get("body")
    text = resp.get("bodyText")
    if isinstance(body, (dict, list)):
        # Built only as far as the 8,000 characters shown: at least that many, all the cut below needs.
        pretty = _json_shown(body, 8001)
        say(pretty if len(pretty) < 8000 else pretty[:8000] + "\n…")
    elif text is not None:
        say(text if len(text) < 8000 else text[:8000] + "\n…")
    return code


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


# What a command that runs out of memory is refused with: a MemoryError names nothing itself.
MEMORY_PROBLEM = "This needs more memory than this process has, so it was stopped."


def main(argv: list[str] | None = None) -> int:
    # A character the output cannot encode (Windows output sent to a file or a pipe, in cp1252; a
    # Latin-1 locale; PYTHONIOENCODING), or a lone surrogate in remote text, which no output can, is
    # written as a backslash escape, as a control character is (tty_safe), not raised after a
    # request was sent and answered, which would exit 1. An output that cannot be set so (closed
    # or detached by a caller in this process) is left as it is, and fails, if it does, as it did.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(errors="backslashreplace")
            except (ValueError, OSError, TypeError):
                pass
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001
        say(f"error: {MEMORY_PROBLEM if isinstance(exc, MemoryError) else exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
