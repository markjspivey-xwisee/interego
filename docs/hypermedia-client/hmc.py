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
import json
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
    "seeAlso": P_SEEALSO,
}


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


class Context:
    def __init__(self) -> None:
        self.prefixes: dict[str, str] = dict(WELL_KNOWN_PREFIXES)
        self.terms: dict[str, str] = dict(TERM_FALLBACKS)

    def absorb(self, ctx: Any) -> None:
        for item in as_list(ctx):
            if not isinstance(item, dict):
                continue
            for key, val in item.items():
                if key.startswith("@"):
                    continue
                iri = None
                if isinstance(val, str):
                    iri = val
                elif isinstance(val, dict) and "@id" in val:
                    iri = val["@id"]
                if not iri:
                    continue
                expanded = self.expand(iri)
                if expanded.endswith("#") or expanded.endswith("/"):
                    self.prefixes[key] = expanded
                self.terms[key] = expanded
                if expanded.endswith("#") or expanded.endswith("/"):
                    self.prefixes[key] = expanded

    def expand(self, value: Any) -> str:
        if value is None:
            return ""
        text = str(value)
        if text.startswith(("_:", "http://", "https://", "urn:", "@")):
            return text
        if ":" in text and not text.startswith("{"):
            prefix, local = text.split(":", 1)
            if prefix in self.prefixes and not local.startswith("//"):
                return self.prefixes[prefix] + local
        if text in self.terms:
            return self.terms[text]
        return self.prefixes.get(text, text)

    def expand_key(self, key: str) -> str:
        if key.startswith(("@", "http://", "https://")):
            return key
        if key in self.terms:
            return self.terms[key]
        return self.expand(key)


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

    def to_public(self) -> dict[str, Any]:
        return {
            "name": self.name, "path": self.path, "datatype": self.datatype,
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
        }


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

    def find(self, rel: str) -> Control | None:
        rel = (rel or "").strip()
        if not rel:
            return None
        exact = [c for c in self.controls if c.rel == rel or c.id == rel]
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
    def __init__(self, document: Any, base: str) -> None:
        self.ctx = Context()
        self.base = base
        self.nodes: dict[str, dict[str, Any]] = {}
        self.order: list[dict[str, Any]] = []
        self.root: dict[str, Any] | None = None
        self._ingest_document(document)

    def _ingest_document(self, document: Any) -> None:
        if isinstance(document, list):
            for item in document:
                if isinstance(item, dict):
                    self.ctx.absorb(item.get("@context"))
                    self._add(item)
            return
        if not isinstance(document, dict):
            return
        self.ctx.absorb(document.get("@context"))
        graph = document.get("@graph")
        extras = {k: v for k, v in document.items() if k not in {"@context", "@graph"}}
        if extras:
            root = dict(extras)
            if "@id" not in root:
                root["@id"] = self.base
            self.root = self._add(root)
        if isinstance(graph, list):
            for item in graph:
                if isinstance(item, dict):
                    node = self._add(item)
                    if self.root is None:
                        self.root = node
        elif self.root is None:
            self.root = self._add(document if extras else {"@id": self.base})
        for node in list(self.order):
            self._harvest_embedded(node)

    def _add(self, node: dict[str, Any]) -> dict[str, Any]:
        node_id = node.get("@id")
        if not node_id:
            action = literal(self.get(node, P_ACTION)) or node.get("action")
            node_id = str(action) if action else f"_:n{len(self.order)}"
            node = dict(node)
            node["@id"] = node_id
        existing = self.nodes.get(node_id)
        if existing is None:
            self.nodes[node_id] = node
            self.order.append(node)
            return node
        for key, val in node.items():
            if key not in existing:
                existing[key] = val
        return existing

    def _harvest_embedded(self, node: dict[str, Any]) -> None:
        for key, val in list(node.items()):
            pred = self.ctx.expand_key(key)
            lname = local_name(pred)
            if pred not in {P_AFFORDANCE, P_CONTROL, P_SUPOP, P_SUPCLASS} and lname not in {
                "affordance", "affordances", "control", "supportedOperation", "supportedClass",
            }:
                continue
            for item in as_list(val):
                if isinstance(item, dict) and (
                    "@id" in item or "action" in item or "method" in item or "@type" in item
                ):
                    added = self._add(item)
                    self._harvest_embedded(added)

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
        if not iri:
            return None
        found = self.nodes.get(str(iri))
        if found:
            return found
        if isinstance(ident, dict) and any(k != "@id" for k in ident):
            return ident
        return None

    def types_of(self, node: dict[str, Any] | None) -> list[str]:
        return [self.ctx.expand(x) for x in literals(self.get(node, P_TYPE) or (node or {}).get("@type"))]

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



def _inty(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(str(value))
    except (TypeError, ValueError):
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


def _field_name(name: str | None, path: str | None, variable: str | None) -> str:
    if variable:
        return variable
    raw = name or local_name(path) or "value"
    match = re.match(r"(?:rest-param-.+-)?(.+)$", raw)
    return match.group(1) if match else raw


def _shape_fields(index: NodeIndex, shape_ref: Any) -> list[Field]:
    fields: list[Field] = []
    if isinstance(shape_ref, dict) and "properties" in shape_ref and P_SH_PROP not in shape_ref:
        required = set(as_list(shape_ref.get("required") or []))
        type_map = {
            "string": XSD + "string", "integer": XSD + "integer",
            "number": XSD + "decimal", "boolean": XSD + "boolean",
        }
        for name, prop in (shape_ref.get("properties") or {}).items():
            prop = prop if isinstance(prop, dict) else {}
            fields.append(Field(
                name=str(name), path=str(name),
                datatype=type_map.get(str(prop.get("type") or ""), XSD + "string"),
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
        if index.get(shape, P_SH_DT) or index.get(shape, P_SH_MINLEN) or index.get(shape, P_SH_MAXLEN):
            label = str(literal(index.get(shape, P_LABEL)) or "")
            name = "query" if ("query" in label.lower() or "sparql" in label.lower()) else "body"
            fields.append(Field(
                name=name,
                path=shape.get("@id") if isinstance(shape, dict) else None,
                datatype=str(literal(index.get(shape, P_SH_DT)) or XSD + "string"),
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
        enum: list[Any] = []
        if enum_raw is not None:
            head = literal(enum_raw)
            if isinstance(head, str) and (str(head).startswith("_:") or index.node(head)):
                enum = index.rdf_list(head)
            else:
                enum = literals(enum_raw)
        min_count = _inty(literal(index.get(node, P_SH_MIN)))
        fields.append(Field(
            name=_field_name(str(name) if name else None, path, None),
            path=path or None,
            datatype=str(literal(index.get(node, P_SH_DT)) or "") or None,
            min_count=min_count, max_count=_inty(literal(index.get(node, P_SH_MAX))),
            pattern=str(literal(index.get(node, P_SH_PAT)) or "") or None,
            default=literal(index.get(node, P_SH_DEF)),
            max_length=_inty(literal(index.get(node, P_SH_MAXLEN))),
            min_length=_inty(literal(index.get(node, P_SH_MINLEN))),
            description=str(literal(index.get(node, P_SH_DESC)) or literal(index.get(node, P_COMMENT)) or literal(index.get(node, P_DESC)) or "") or None,
            enum=enum,
            min_inclusive=literal(index.get(node, P_SH_MINI)),
            max_inclusive=literal(index.get(node, P_SH_MAXI)),
            required=(min_count or 0) >= 1,
        ))
    return fields


def _template_of(index: NodeIndex, node: dict[str, Any]) -> tuple[str | None, list[dict[str, Any]]]:
    def read_template_node(tmpl: dict[str, Any] | None) -> tuple[str | None, list[dict[str, Any]]]:
        if not tmpl:
            return None, []
        template = literal(index.get(tmpl, P_TEMPLATE))
        found = []
        for item in as_list(index.get(tmpl, P_MAPPING)):
            mn = index.node(item) or (item if isinstance(item, dict) else None)
            if not mn:
                continue
            found.append({
                "variable": literal(index.get(mn, P_VARIABLE)),
                "property": literal(index.get(mn, P_PROPERTY)),
                "required": truthy(literal(index.get(mn, P_REQUIRED))),
            })
        return (str(template) if template else None), found

    direct = literal(index.get(node, P_TEMPLATE))
    if isinstance(direct, str) and "{" in direct:
        _, mappings = read_template_node(node)
        return direct, mappings
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
                return template, mappings
    return (str(direct) if direct else None), []


def _merge_mapping_fields(fields: list[Field], mappings: list[dict[str, Any]]) -> list[Field]:
    by_path = {f.path: f for f in fields if f.path}
    by_name = {f.name: f for f in fields}
    for mapping in mappings:
        variable = mapping.get("variable")
        prop = mapping.get("property")
        required = mapping.get("required")
        if not variable:
            continue
        match = None
        if prop and prop in by_path:
            match = by_path[prop]
        elif variable in by_name:
            match = by_name[variable]
        else:
            match = next((item for item in fields if item.path and local_name(item.path) == variable), None)
        if match:
            match.variable = str(variable)
            match.name = str(variable)
            if required:
                match.required = True
                if not match.min_count:
                    match.min_count = 1
        else:
            fields.append(Field(
                name=str(variable), path=str(prop) if prop else None,
                variable=str(variable), required=bool(required),
                min_count=1 if required else 0, max_count=1,
            ))
    return fields


def control_from_node(index: NodeIndex, node: dict[str, Any], source: str) -> Control:
    rel = literal(index.get(node, P_ACTION)) or literal(index.get(node, P_REL)) or node.get("@id") or ""
    method = str(literal(index.get(node, P_METHOD)) or "GET").upper()
    title = literal(index.get(node, P_TITLE)) or literal(index.get(node, P_DCTITLE)) or literal(index.get(node, P_LABEL)) or short_rel(str(rel))
    description = literal(index.get(node, P_DESC)) or literal(index.get(node, P_DCDESC)) or literal(index.get(node, P_COMMENT)) or ""
    media = literal(index.get(node, P_RETURNS_CT)) or literal(index.get(node, P_MEDIA))
    expects_raw = index.get(node, P_EXPECTS)
    expects = None
    if isinstance(expects_raw, dict) and "properties" in expects_raw:
        expects = None
    elif isinstance(expects_raw, dict) and "@id" in expects_raw:
        expects = expects_raw["@id"]
    else:
        expects = literal(expects_raw)
    returns = literal(index.get(node, P_RETURNS))
    target = literal(index.get(node, P_TARGET)) or literal(index.get(node, P_HMDTARGET))
    template, mappings = _template_of(index, node)
    fields: list[Field] = []
    inline = node.get("fields")
    if isinstance(inline, list) and inline and isinstance(inline[0], dict) and (
        "name" in inline[0] or "path" in inline[0] or "datatype" in inline[0]
    ):
        for item in inline:
            fields.append(Field(
                name=_field_name(item.get("name"), item.get("path"), None),
                path=item.get("path"), datatype=item.get("datatype"),
                min_count=_inty(item.get("minCount")), max_count=_inty(item.get("maxCount")),
                pattern=item.get("pattern"), default=item.get("defaultValue"),
                max_length=_inty(item.get("maxLength")), min_length=_inty(item.get("minLength")),
                description=item.get("description"),
                required=(_inty(item.get("minCount")) or 0) >= 1,
            ))
    elif expects_raw is not None:
        shape_ref = expects_raw[0] if isinstance(expects_raw, list) else expects_raw
        fields = _shape_fields(index, shape_ref)
    fields = _merge_mapping_fields(fields, mappings)
    return Control(
        id=str(node.get("@id") or rel), rel=str(rel), method=method,
        title=str(title or ""), description=str(description or ""),
        media_type=str(media) if media else None,
        expects=str(expects) if expects else None,
        returns=str(returns) if returns else None,
        target=str(target) if target else None, template=template, fields=fields,
        read_only=truthy(literal(index.get(node, P_READONLY))),
        idempotent=truthy(literal(index.get(node, P_IDEMPOTENT))),
        destructive=truthy(literal(index.get(node, P_DESTRUCTIVE))),
        types=index.types_of(node), source=source,
    )


def extract_controls(index: NodeIndex, source: str) -> list[Control]:
    found: dict[str, Control] = {}
    candidates: list[dict[str, Any]] = []

    def add_candidate(node: dict[str, Any] | None) -> None:
        if node and node not in candidates:
            candidates.append(node)

    for node in index.order:
        for pred in (P_AFFORDANCE, P_CONTROL, P_SUPOP):
            for item in as_list(index.get(node, pred)):
                add_candidate(index.node(item) or (item if isinstance(item, dict) else None))
        for item in as_list(index.get(node, P_SUPCLASS)):
            cls = index.node(item)
            if cls:
                for op in as_list(index.get(cls, P_SUPOP)):
                    add_candidate(index.node(op) or (op if isinstance(op, dict) else None))
        if _looks_like_operation(index, node):
            add_candidate(node)
    for node in candidates:
        if not node:
            continue
        control = control_from_node(index, node, source)
        key = control.rel or control.id
        if key and key not in found:
            found[key] = control
    controls = list(found.values())
    controls.sort(key=lambda c: (0 if not c.unsafe else 1, c.method, (c.title or c.rel).lower()))
    return controls


def descriptor_meta(index: NodeIndex, url: str, content_type: str) -> tuple[str, list[str], str, list[str]]:
    root = index.root or index.nodes.get(url) or (index.order[0] if index.order else None)
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
            rel=rel, method=str(data.get("method") or "GET").upper(),
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


def http_request(url: str, method: str = "GET", headers: dict[str, str] | None = None,
                 data: bytes | None = None, timeout: int = 60) -> tuple[int, dict[str, str], bytes]:
    req_headers = {"User-Agent": USER_AGENT}
    if headers:
        req_headers.update(headers)
    request = urllib.request.Request(url, data=data, headers=req_headers, method=method.upper())
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return resp.getcode() or 200, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as exc:
        body = exc.read() if exc.fp else b""
        return exc.code, {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}, body


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
        status, headers, body = http_request(candidate, headers={"Accept": accept})
        if status >= 400:
            return None
        text = body.decode("utf-8", errors="replace")
        kind = classify_payload(text, headers.get("content-type", ""))
        if kind:
            return candidate, headers.get("content-type", ""), text
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


def parse_descriptor(text: str, content_type: str, url: str) -> Descriptor:
    kind = classify_payload(text, content_type)
    if kind == "jsonld":
        document = json.loads(text)
        index = NodeIndex(document, url)
        title, types, description, see_also = descriptor_meta(index, url, content_type)
        return Descriptor(
            url=url, title=title, types=types, description=description,
            content_type=content_type, controls=extract_controls(index, url),
            see_also=see_also, raw=document,
        )
    if kind == "turtle":
        return parse_descriptor(json.dumps(parse_turtle_via_rdflib(text, url)), "application/ld+json", url)
    if kind == "markdown":
        return parse_markdown_descriptor(text, url, content_type)
    raise RuntimeError(f"Unrecognized descriptor representation ({content_type})")


def load_descriptor(url: str) -> Descriptor:
    _final, content_type, text = fetch_authority(url)
    descriptor = parse_descriptor(text, content_type, _strip_fragment(url))
    descriptor.content_type = content_type
    return descriptor



def expand_uri_template(template: str, values: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        expr = match.group(1)
        op = ""
        if expr and expr[0] in "+#./;?&":
            op, expr = expr[0], expr[1:]
        names = [part.split("*", 1)[0].split(":", 1)[0] for part in expr.split(",")]
        pairs = [(n, str(values[n])) for n in names if n in values and values[n] not in (None, "")]
        if not pairs:
            return ""
        if op == "":
            return ",".join(urllib.parse.quote(val, safe="") for _, val in pairs)
        if op == "+":
            return ",".join(urllib.parse.quote(val, safe=":/?#[]@!$&'()*+,;=") for _, val in pairs)
        if op == "#":
            return "#" + ",".join(urllib.parse.quote(val, safe=":/?[]@!$&'()*+,;=") for _, val in pairs)
        if op == "?":
            return "?" + "&".join(f"{n}={urllib.parse.quote(v, safe='')}" for n, v in pairs)
        if op == "&":
            return "&" + "&".join(f"{n}={urllib.parse.quote(v, safe='')}" for n, v in pairs)
        if op == "/":
            return "/" + "/".join(urllib.parse.quote(v, safe="") for _, v in pairs)
        if op == ".":
            return "." + ".".join(urllib.parse.quote(v, safe="") for _, v in pairs)
        if op == ";":
            return "".join(f";{n}={urllib.parse.quote(v, safe='')}" for n, v in pairs)
        return ""
    return re.sub(r"\{([^{}]+)\}", replace, template)


def coerce_value(fld: Field, value: Any) -> Any:
    if value is None or value == "":
        return None
    dt = fld.datatype or ""
    if dt.endswith("#integer") or dt.endswith("#int"):
        return int(str(value))
    if dt.endswith(("#decimal", "#double", "#float")):
        return float(str(value))
    if dt.endswith("#boolean"):
        text = str(value).strip().lower()
        if text in {"true", "1", "yes"}:
            return True
        if text in {"false", "0", "no"}:
            return False
        raise ValueError(f"{fld.name} must be a boolean")
    return value


def validate_fields(control: Control, supplied: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    values: dict[str, Any] = {}
    incoming = dict(supplied)
    for fld in control.fields:
        aliases = {fld.name, fld.variable, local_name(fld.path) if fld.path else None}
        aliases = {a for a in aliases if a}
        found = None
        used = None
        for alias in aliases:
            if alias in incoming:
                found = incoming[alias]
                used = alias
                break
        if (found is None or found == "") and fld.default is not None:
            found = fld.default
        required = fld.required or (fld.min_count or 0) >= 1
        if found is None or found == "":
            if required:
                errors.append(f"missing required field '{fld.name}'")
            continue
        try:
            typed = coerce_value(fld, found)
        except (TypeError, ValueError) as exc:
            errors.append(f"{fld.name}: {exc}")
            continue
        text = "" if typed is None else str(typed)
        if fld.min_length is not None and len(text) < fld.min_length:
            errors.append(f"{fld.name}: shorter than minLength {fld.min_length}")
        if fld.max_length is not None and len(text) > fld.max_length:
            errors.append(f"{fld.name}: longer than maxLength {fld.max_length}")
        if fld.pattern:
            try:
                if not re.search(fld.pattern, text):
                    errors.append(f"{fld.name}: does not match pattern {fld.pattern}")
            except re.error as exc:
                errors.append(f"{fld.name}: invalid pattern ({exc})")
        if fld.enum and text not in {str(x) for x in fld.enum}:
            errors.append(f"{fld.name}: must be one of {sorted(str(x) for x in fld.enum)}")
        try:
            if fld.min_inclusive is not None and float(typed) < float(fld.min_inclusive):
                errors.append(f"{fld.name}: below minInclusive {fld.min_inclusive}")
            if fld.max_inclusive is not None and float(typed) > float(fld.max_inclusive):
                errors.append(f"{fld.name}: above maxInclusive {fld.max_inclusive}")
        except (TypeError, ValueError):
            pass
        values[fld.name] = typed
        if used:
            incoming.pop(used, None)
    return values, errors


def is_junction_target(target: str | None, descriptor_url: str, control_id: str) -> bool:
    if not target:
        return False
    if target.startswith("#"):
        return True
    if target == control_id:
        return True
    base = _strip_fragment(descriptor_url)
    if target.startswith(base + "#"):
        frag = target[len(base) + 1:]
        # HyperMarkdown projects each control as a fragment on the descriptor.
        # Those fragments are action junctions, not HTTP endpoints.
        if frag.startswith("control-") or target == control_id:
            return True
    return False


def is_mcp_tool_url(target: str | None) -> bool:
    if not target:
        return False
    parts = urllib.parse.urlsplit(target)
    host = (parts.hostname or "").lower()
    return (parts.path or "").startswith("/tool/") and "interego" in host


def classify_transport(control: Control, descriptor_url: str) -> str:
    if control.template:
        return "http"
    if is_mcp_tool_url(control.target):
        return "mcp"
    if is_junction_target(control.target, descriptor_url, control.id):
        return "junction"
    if control.target and control.target.startswith(("http://", "https://")):
        return "http"
    if control.rel:
        return "mcp"
    return "unknown"


def add_query_params(url: str, params: dict[str, Any]) -> str:
    parts = urllib.parse.urlsplit(url)
    current = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    for key, val in params.items():
        if val not in (None, ""):
            current[key] = str(val)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(current), parts.fragment))


def resolve_plan(control: Control, values: dict[str, Any], descriptor_url: str) -> RequestPlan:
    notes: list[str] = []
    transport = classify_transport(control, descriptor_url)
    method = control.method or "GET"
    headers = {"User-Agent": USER_AGENT, "Accept": control.media_type or "*/*"}
    body: Any = None
    body_text: str | None = None
    url: str | None = None
    raw_body_field = next((f for f in control.fields if f.raw_body), None)
    if raw_body_field and raw_body_field.name in values:
        body_text = str(values[raw_body_field.name])
        body = body_text

    if control.template:
        url = expand_uri_template(control.template, values)
        transport = "http"
        notes.append(f"Expanded hydra:IriTemplate {control.template}")
        used: set[str] = set()
        for match in re.finditer(r"\{[+#./;?&]?([^{}]+)\}", control.template):
            used.update(part.split("*", 1)[0].split(":", 1)[0] for part in match.group(1).split(","))
        leftover = {k: v for k, v in values.items() if k not in used and not (raw_body_field and k == raw_body_field.name)}
        if leftover and method in SAFE_METHODS:
            url = add_query_params(url, leftover)
    elif transport == "http" and control.target:
        url = control.target
        if method in SAFE_METHODS and values and not raw_body_field:
            url = add_query_params(url, values)
            notes.append("Appended fields as query parameters on hydra:target")
        elif method not in SAFE_METHODS and raw_body_field:
            headers["Content-Type"] = control.media_type or "text/plain"
        elif method not in SAFE_METHODS:
            body = values
            body_text = json.dumps(values, indent=2)
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
    if url and method not in SAFE_METHODS and body is None and not raw_body_field and values:
        body = values
        body_text = json.dumps(values, indent=2)
        headers.setdefault("Content-Type", "application/json")
    if raw_body_field and body_text is not None and url:
        headers["Content-Type"] = control.media_type or "application/sparql-query"
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
    status, headers, body = http_request(plan.url, method=plan.method, headers=plan.headers, data=data)
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



def print_control_table(descriptor: Descriptor) -> None:
    print(descriptor.title)
    print(descriptor.url)
    if descriptor.types:
        print("types: " + ", ".join(local_name(t) or t for t in descriptor.types))
    if descriptor.description:
        print(textwrap.fill(descriptor.description, 100))
    print()
    safe = [c for c in descriptor.controls if not c.unsafe]
    unsafe = [c for c in descriptor.controls if c.unsafe]
    for label, group in (("Safe (GET / read)", safe), ("Unsafe (writes and non-GET)", unsafe)):
        print(f"== {label} ({len(group)}) ==")
        if not group:
            print("  (none)\n")
            continue
        for control in group:
            transport = classify_transport(control, descriptor.url)
            target = control.template or control.target or ""
            print(f"  {control.method:<6} {short_rel(control.rel):<42} {transport:<8} {control.title}")
            print(f"         rel: {control.rel}")
            if target:
                print(f"         target: {target}")
            if control.media_type:
                print(f"         media: {control.media_type}")
            if control.fields:
                names = ", ".join(("*" if f.required or (f.min_count or 0) >= 1 else "") + f.name for f in control.fields)
                print(f"         fields: {names}")
        print()


def parse_field_args(items: list[str]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for item in items:
        if "=" not in item:
            raise SystemExit(f"--field expects k=v, got {item!r}")
        key, val = item.split("=", 1)
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
        raise SystemExit(f"No control matching {args.rel!r}. Known (sample): {known}")
    public = control.to_public()
    public["transport"] = classify_transport(control, descriptor.url)
    print(json.dumps(public, indent=2))
    return 0


def cmd_invoke(args: argparse.Namespace) -> int:
    descriptor = load_descriptor(args.url)
    control = descriptor.find(args.rel)
    if not control:
        known = ", ".join(short_rel(c.rel) for c in descriptor.controls[:20])
        raise SystemExit(f"No control matching {args.rel!r}. Known (sample): {known}")
    supplied = parse_field_args(args.field or [])
    values, errors = validate_fields(control, supplied)
    if errors:
        print("Validation failed:", file=sys.stderr)
        for err in errors:
            print("  - " + err, file=sys.stderr)
        return 2
    plan = resolve_plan(control, values, descriptor.url)
    result = invoke_plan(plan, confirm=args.confirm, dry_run=True if args.dry_run else None)
    if args.json:
        print(json.dumps(result, indent=2))
        return 0
    req = result["request"]
    print(f"{req['method']} {req.get('url') or '(no HTTP URL)'}")
    print(f"transport: {req['transport']}")
    for note in req.get("notes") or []:
        print(f"note: {note}")
    if req.get("mcp"):
        print("mcp:")
        print(textwrap.indent(json.dumps(req["mcp"], indent=2), "  "))
    if req.get("bodyText"):
        print("body:")
        print(textwrap.indent(str(req["bodyText"]), "  "))
    if result.get("dryRun"):
        print(result.get("message", "Dry run."))
        return 0
    if result.get("blocked"):
        print(result.get("message"))
        return 3
    resp = result.get("response") or {}
    print(f"HTTP {resp.get('status')}  {resp.get('contentType')}")
    body = resp.get("body")
    text = resp.get("bodyText") or ""
    if isinstance(body, (dict, list)):
        pretty = json.dumps(body, indent=2)
        print(pretty if len(pretty) < 8000 else pretty[:8000] + "\n…")
    else:
        print(text if len(text) < 8000 else text[:8000] + "\n…")
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
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
