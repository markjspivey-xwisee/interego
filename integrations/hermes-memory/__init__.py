"""
Interego memory provider for Hermes Agent.

A Hermes external memory provider that backs the agent's memory with an
Interego pod — alongside the local ``MEMORY.md`` / ``state.db`` Hermes
already keeps. What that buys a new Hermes bot the moment it is enabled:

  * Verifiable     — every memory write is a signed, provenance-attributed
                     ``cg:ContextDescriptor``. Who wrote it, when, on whose
                     behalf: cryptographically, not by convention.
  * Federated      — memories live on a pod, not one ``~/.hermes`` dir. Two
                     Hermes bots — or a Hermes bot + a Claude Code agent +
                     a Cursor agent — can share the same context.
  * Portable       — the agent's biography is pod-rooted. Switch Hermes
                     backends, change machines, or move off Hermes entirely;
                     the memory and identity come with you.
  * Non-destructive — "forget" is a Counterfactual supersession, not a
                     delete. The audit trail survives.

Hermes' own promise is "the agent that grows with you." This provider
makes the thing it grows — the memory and the model of who you are —
something you *own and can take anywhere*, not something locked to one
``~/.hermes`` directory on one machine.

Design: this is a *translator*, not an extension. It maps Hermes' memory
hooks onto Interego's existing ``publish_context`` / ``discover_context``
primitives, reached over the Interego MCP relay's REST surface. No
Interego substrate code is duplicated here — the relay (running
``@interego/core``) does the descriptor construction, signing, and
``cg:supersedes`` chaining. The memory-graph shape written here is
deliberately identical to the OpenClaw memory bridge's shape
(``cgh:AgentMemory``), so memories written by a Hermes bot and an
OpenClaw agent on the same pod are mutually discoverable.

Local-first note: ``relay_url`` can point at the hosted Interego relay
*or* at a relay you run yourself (or a local personal-bridge). Hermes'
"all data stays on your machine" property is preserved when you point it
local — the pod is just storage you control.

Honest scoping: written against the documented Hermes ``MemoryProvider``
plugin contract (developer-guide/memory-provider-plugin). Exact method
signatures may shift with the live SDK — match them at integration time.
The relay REST contract (``POST /tool/publish_context``,
``POST /tool/discover_context``) is stable.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# The live Hermes SDK exposes MemoryProvider from agent.memory_provider.
# Fall back to a minimal stub so this file stays importable / inspectable
# without Hermes installed (e.g. for CI lint, or reading the contract).
try:  # pragma: no cover - exercised only inside a Hermes install
    from agent.memory_provider import MemoryProvider  # type: ignore
except ImportError:  # pragma: no cover
    class MemoryProvider:  # type: ignore
        """Stub base — the real one ships with Hermes Agent."""


# ── Interego vocabulary (mirrors integrations/openclaw-memory/src/bridge.ts) ──
_CG = "https://markjspivey-xwisee.github.io/interego/ns/cg#"
_CGH = "https://markjspivey-xwisee.github.io/interego/ns/harness#"
_PROV = "http://www.w3.org/ns/prov#"
_DCT = "http://purl.org/dc/terms/"
_MEMORY_TYPE = f"{_CGH}AgentMemory"

# Hosted relay — zero-setup evaluation default. Point at a relay you run
# (or a local personal-bridge) to keep everything on your own machine.
_DEFAULT_RELAY = "https://interego-mcp-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io"


def _escape_lit(s: str) -> str:
    """Escape Turtle-active chars in a single-line literal — mirrors bridge.ts escapeLit."""
    return (
        s.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )


def _escape_multi(s: str) -> str:
    """Escape every quote in a triple-quoted literal body — mirrors bridge.ts escapeMulti."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


class InteregoMemoryProvider(MemoryProvider):
    """Backs Hermes memory with an Interego pod over the MCP relay's REST surface."""

    # ── identity ────────────────────────────────────────────────────────
    @property
    def name(self) -> str:
        return "interego"

    def __init__(self) -> None:
        self._relay_url: str = _DEFAULT_RELAY
        self._pod_url: str = ""
        self._bearer: str = ""
        self._agent_id: str = ""
        self._owner_webid: str = ""
        self._session_id: str = ""
        self._hermes_home: str = ""
        self._queued_query: str | None = None

    # ── lifecycle ───────────────────────────────────────────────────────
    def is_available(self) -> bool:
        """True when configured enough to publish. No network call (per contract)."""
        return bool(self._read_bearer() and self._load_saved_config().get("relay_url", _DEFAULT_RELAY))

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Called once at agent startup. kwargs includes hermes_home (str)."""
        self._session_id = session_id
        self._hermes_home = kwargs.get("hermes_home", str(Path.home() / ".hermes"))
        cfg = self._load_saved_config()
        self._relay_url = (cfg.get("relay_url") or _DEFAULT_RELAY).rstrip("/")
        self._pod_url = (cfg.get("pod_url") or "").rstrip("/")
        if self._pod_url:
            self._pod_url += "/"
        self._agent_id = cfg.get("agent_id", "")
        self._owner_webid = cfg.get("owner_webid", "")
        self._bearer = self._read_bearer()

    def shutdown(self) -> None:
        """Process exit. HTTP is stateless — nothing to close."""
        return None

    # ── configuration ───────────────────────────────────────────────────
    def get_config_schema(self) -> list[dict[str, Any]]:
        """Field descriptors for `hermes memory setup`."""
        return [
            {
                "key": "relay_url",
                "description": "Interego MCP relay base URL. Use the hosted relay to evaluate, "
                "or your own relay / local personal-bridge to keep data on your machine.",
                "secret": False,
                "required": False,
                "default": _DEFAULT_RELAY,
                "url": "https://github.com/markjspivey-xwisee/interego",
            },
            {
                "key": "pod_url",
                "description": "Full URL of the pod that holds this agent's memories "
                "(e.g. https://your-host/your-pod/). Used for recall.",
                "secret": False,
                "required": True,
            },
            {
                "key": "agent_bearer",
                "description": "Interego identity bearer token for this agent. "
                "Run `hermes interego setup` or enroll at the identity server.",
                "secret": True,
                "required": True,
                "env_var": "INTEREGO_AGENT_BEARER",
            },
            {
                "key": "agent_id",
                "description": "Optional. This agent's DID / URN. If omitted, the relay "
                "fills it from the authenticated identity.",
                "secret": False,
                "required": False,
            },
            {
                "key": "owner_webid",
                "description": "Optional. WebID of the human the agent acts on behalf of. "
                "If omitted, the relay fills it from the authenticated identity.",
                "secret": False,
                "required": False,
            },
        ]

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        """Persist non-secret config to <hermes_home>/interego.json. Secrets go to .env."""
        non_secret = {k: v for k, v in values.items() if k != "agent_bearer" and v}
        path = Path(hermes_home) / "interego.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(non_secret, indent=2), encoding="utf-8")

    def _load_saved_config(self) -> dict[str, Any]:
        home = self._hermes_home or str(Path.home() / ".hermes")
        path = Path(home) / "interego.json"
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {}
        return {}

    @staticmethod
    def _read_bearer() -> str:
        return os.environ.get("INTEREGO_AGENT_BEARER", "")

    # ── system prompt ───────────────────────────────────────────────────
    def system_prompt_block(self) -> str:
        """Tell the agent what kind of memory it has — so it uses it well."""
        return (
            "Memory backend: Interego pod (verifiable, federated, portable).\n"
            "- Every memory you save is a signed, provenance-attributed record — "
            "it carries who saved it, when, and on whose behalf.\n"
            "- Memories are pod-rooted, not tied to this machine. They survive a "
            "backend switch or a move off Hermes, and can be shared with other agents.\n"
            "- 'Forgetting' supersedes rather than deletes — the prior record stays "
            "auditable. Prefer correcting (replace) over wiping when a fact changes.\n"
            "Save durable facts, preferences, decisions, and corrections; the substrate "
            "keeps the full history so you do not have to."
        )

    # ── recall (prefetch) ───────────────────────────────────────────────
    def prefetch(self, query: Any) -> str:
        """Before each API call: return a recall block for the system prompt."""
        q = self._query_text(query)
        hits = self._recall(q, limit=8)
        if not hits:
            return ""
        lines = ["Relevant memories from your Interego pod:"]
        for h in hits:
            modal = h.get("modalStatus", "Asserted")
            lines.append(f"- ({modal}) {h.get('text', '').strip()}")
        return "\n".join(lines)

    def queue_prefetch(self, query: Any) -> None:
        """After each turn: remember the query to pre-warm next turn's prefetch."""
        self._queued_query = self._query_text(query)

    # ── persistence ─────────────────────────────────────────────────────
    def sync_turn(self, user_content: str, assistant_content: str) -> None:
        """After a completed turn: persist it. MUST be non-blocking — daemon thread."""
        if not self.is_available():
            return
        body = (
            f"User: {user_content}\n\nAssistant: {assistant_content}"
        ).strip()
        if not body:
            return
        threading.Thread(
            target=self._safe_store,
            args=(body, "observation", ["hermes:turn", f"session:{self._session_id}"]),
            daemon=True,
        ).start()

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Mirror Hermes' built-in MEMORY.md / USER.md edits onto the pod.

        add → publish; replace → publish (the relay's auto-supersede links
        the prior record); remove → publish a Counterfactual retraction.
        Runs inline (these are infrequent, unlike sync_turn).
        """
        if not self.is_available():
            return
        kind = "preference" if target.lower().startswith("user") else "fact"
        if action == "remove":
            self._safe_store(
                f"[FORGET] {target}: {content}",
                "observation",
                [f"hermes:{target}", "retraction"],
                modal_status="Counterfactual",
            )
        else:
            self._safe_store(content, kind, [f"hermes:{target}", f"action:{action}"])

    def on_pre_compress(self, messages: Any) -> None:
        """Before context compression: nothing extra — turns were already synced."""
        return None

    def on_session_end(self, messages: Any) -> None:
        """Conversation ends: turns were synced live; no final flush needed."""
        return None

    # ── agent-facing tool ───────────────────────────────────────────────
    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """Expose an explicit federated-recall tool the agent can call by name."""
        return [
            {
                "name": "interego_recall",
                "description": "Search this agent's Interego pod memory (verifiable, "
                "federated). Returns matching memories with their modal status.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What to search for."},
                        "limit": {"type": "integer", "description": "Max results (default 8)."},
                    },
                    "required": ["query"],
                },
            }
        ]

    def handle_tool_call(self, name: str, args: dict[str, Any]) -> str:
        if name != "interego_recall":
            return json.dumps({"error": f"unknown tool: {name}"})
        hits = self._recall(str(args.get("query", "")), limit=int(args.get("limit", 8)))
        return json.dumps({"memories": hits})

    # ── internals ───────────────────────────────────────────────────────
    @staticmethod
    def _query_text(query: Any) -> str:
        if isinstance(query, str):
            return query
        if isinstance(query, dict):
            return str(query.get("query") or query.get("text") or "")
        return str(query or "")

    def _safe_store(
        self,
        text: str,
        kind: str,
        tags: list[str],
        modal_status: str = "Asserted",
    ) -> None:
        """Publish one memory; swallow transport errors (memory is best-effort, never blocks the agent)."""
        try:
            self._store(text, kind, tags, modal_status)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError):
            # Best-effort: a flaky relay must not break the agent loop.
            # Hermes' built-in MEMORY.md still holds the local copy.
            pass

    def _store(self, text: str, kind: str, tags: list[str], modal_status: str) -> dict[str, Any]:
        text = text.strip()
        if not text:
            raise ValueError("cannot store an empty memory")
        content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        memory_id = content_hash[:16]
        memory_iri = f"urn:cg:memory:{kind}:{memory_id}"
        graph_iri = f"urn:graph:cg:memory:{memory_id}"

        owner = self._owner_webid or self._agent_id
        attributed = f"<{owner}>" if owner else '""'
        generated = f"<{self._agent_id}>" if self._agent_id else '""'
        tag_line = (
            f"    <{_DCT}subject> "
            + " , ".join(f'"{_escape_lit(t)}"' for t in tags)
            + " ;\n"
            if tags
            else ""
        )
        graph_content = (
            f"<{memory_iri}> a <{_MEMORY_TYPE}> , <{_PROV}Entity> ;\n"
            f'    <{_DCT}type> "{_escape_lit(kind)}" ;\n'
            f"{tag_line}"
            f'    <{_DCT}description> """{_escape_multi(text)}""" ;\n'
            f'    <{_CG}contentHash> "{content_hash}" ;\n'
            f"    <{_PROV}wasAttributedTo> {attributed} ;\n"
            f"    <{_PROV}wasGeneratedBy> {generated} .\n"
        )
        args: dict[str, Any] = {
            "descriptor_id": memory_iri,
            "graph_iri": graph_iri,
            "graph_content": graph_content,
            "modal_status": modal_status,
            "confidence": 0.85 if modal_status == "Asserted" else 0.5,
        }
        if self._agent_id:
            args["agent_id"] = self._agent_id
        if self._owner_webid:
            args["owner_webid"] = self._owner_webid
        # pod_name / agent_id / owner_webid are auto-filled by the relay from
        # the authenticated bearer when omitted.
        return self._call_tool("publish_context", args, auth=True)

    def _recall(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        """Discover memory descriptors on the pod, then keyword-filter their graphs.

        Substrate-side recall is structural (modal status + keyword). Hermes'
        own FTS5 / vector layer ranks on top — this returns the candidate pool.
        """
        if not self._pod_url:
            return []
        try:
            result = self._call_tool(
                "discover_context", {"pod_url": self._pod_url}, auth=False
            )
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError):
            return []
        entries = result.get("entries", []) if isinstance(result, dict) else []
        q = query.strip().lower()
        hits: list[dict[str, Any]] = []
        for entry in entries:
            describes = entry.get("describes", []) or []
            if not any(str(d).startswith("urn:cg:memory:") for d in describes):
                continue
            if entry.get("modalStatus") not in (None, "Asserted"):
                continue  # default recall = Asserted ground truth only
            graph_url = str(entry.get("descriptorUrl", "")).replace(".ttl", "-graph.trig")
            text = self._fetch_memory_text(graph_url)
            if text is None:
                continue
            if q and q not in text.lower():
                continue
            hits.append(
                {
                    "memoryIri": (describes[0] if describes else entry.get("descriptorUrl")),
                    "text": text,
                    "modalStatus": entry.get("modalStatus", "Asserted"),
                    "confidence": entry.get("confidence", 0.5),
                    "recordedAt": entry.get("validFrom", ""),
                }
            )
            if len(hits) >= limit:
                break
        return hits

    def _fetch_memory_text(self, graph_url: str) -> str | None:
        """Pull the dct:description body out of a memory graph. Tolerant, never raises."""
        try:
            req = urllib.request.Request(
                graph_url, headers={"Accept": "application/trig, text/turtle"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 - configured URL
                trig = resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, OSError):
            return None
        marker = f"<{_DCT}description>"
        idx = trig.find(marker)
        if idx == -1:
            return None
        rest = trig[idx + len(marker):].lstrip()
        if rest.startswith('"""'):
            end = rest.find('"""', 3)
            return rest[3:end] if end != -1 else None
        if rest.startswith('"'):
            end = rest.find('"', 1)
            return rest[1:end] if end != -1 else None
        return None

    def _call_tool(self, tool: str, args: dict[str, Any], auth: bool) -> dict[str, Any]:
        """POST /tool/<name> on the Interego MCP relay."""
        url = f"{self._relay_url}/tool/{tool}"
        data = json.dumps(args).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if auth:
            if not self._bearer:
                raise ValueError("INTEREGO_AGENT_BEARER not set — run `hermes interego setup`")
            headers["Authorization"] = f"Bearer {self._bearer}"
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - configured URL
            return json.loads(resp.read().decode("utf-8"))


def register(ctx: Any) -> None:
    """Entry point — called by the Hermes memory-plugin discovery system."""
    ctx.register_memory_provider(InteregoMemoryProvider())
