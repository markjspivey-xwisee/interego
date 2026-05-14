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

# ── HATEOAS affordances — how the agent reaches "all of Interego" without
#    60 tool schemas bloating its context ───────────────────────────────
#
# The agent's tool surface is *fixed and tiny*: three schemas
# (interego_recall / interego_discover / interego_act). The substrate's
# capability surface is *unbounded* — and it travels as DATA. Every
# descriptor / memory the agent receives is decorated with the
# affordances available on it: self-describing {action, tool, args}
# records. To act, the agent follows one through interego_act. New
# substrate capability = a new affordance verb in the decoration; zero
# new tool schemas, zero extra context cost. This is HATEOAS: the server
# hands the client its next moves; the client never hardcodes the API.
#
# _AFFORDANCE_DISPATCH is the one place an affordance verb maps to a
# relay tool. It mirrors the canonical verb set in
# src/affordance/types.ts (AffordanceAction), narrowed to verbs this
# integration can dispatch over the relay's REST surface. interego_act
# stays a near-pure executor because each affordance it receives already
# names its tool.
_AFFORDANCE_DISPATCH: dict[str, str] = {
    "read": "get_descriptor",       # perceive the descriptor's Turtle
    "derive": "publish_context",    # publish a successor (auto-supersedes the target)
    "retract": "publish_context",   # mark no-longer-valid (Counterfactual successor)
    "challenge": "publish_context", # publish an independent counter-descriptor
    "annotate": "publish_context",  # attach a Hypothetical note referencing the target
    "forward": "publish_context",   # re-share to other agents (share_with)
    "subscribe": "subscribe_to_pod",# watch the pod for changes
}

# Delegation scope -> permitted verbs. Mirrors SCOPE_PERMISSIONS in
# src/affordance/compute.ts, narrowed to the dispatchable set above. The
# decoration step gates each result's affordances by the agent's scope —
# the agent is only ever handed actions it is actually allowed to take.
_SCOPE_VERBS: dict[str, tuple[str, ...]] = {
    "ReadWrite": ("read", "derive", "retract", "challenge", "annotate", "forward", "subscribe"),
    "ReadOnly": ("read", "subscribe"),
    "PublishOnly": ("read", "derive", "annotate"),
    "DiscoverOnly": ("read", "subscribe"),
}


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
        self._scope: str = "ReadWrite"
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
        self._scope = cfg.get("scope", "ReadWrite")
        if self._scope not in _SCOPE_VERBS:
            self._scope = "ReadWrite"
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
            {
                "key": "scope",
                "description": "Delegation scope — gates which affordances are offered on "
                "discovered descriptors. One of ReadWrite, ReadOnly, PublishOnly, DiscoverOnly.",
                "secret": False,
                "required": False,
                "default": "ReadWrite",
                "choices": list(_SCOPE_VERBS.keys()),
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
        """Tell the agent what memory it has AND how to reach the whole substrate.

        The HATEOAS contract is stated here so the model knows it does not
        need — and will not get — a flat list of substrate tools. It has
        three: interego_recall, interego_discover, interego_act. Every
        result those return is decorated with `affordances` — the actions
        available on that item. To act, follow one through interego_act.
        """
        return (
            "Memory backend: Interego pod (verifiable, federated, portable).\n"
            "- Every memory you save is a signed, provenance-attributed record — "
            "it carries who saved it, when, and on whose behalf.\n"
            "- Memories are pod-rooted, not tied to this machine. They survive a "
            "backend switch or a move off Hermes, and can be shared with other agents.\n"
            "- 'Forgetting' supersedes rather than deletes — the prior record stays "
            "auditable. Prefer correcting (derive) over wiping when a fact changes.\n"
            "\n"
            "Reaching the substrate (HATEOAS — no flat tool list):\n"
            "- You have exactly three Interego tools: interego_recall, "
            "interego_discover, interego_act. That is the whole fixed surface.\n"
            "- Every memory or descriptor you receive carries an `affordances` "
            "list — the actions you may take on it ({action, tool, args}). The "
            "capability surface travels WITH the data, not as preloaded tools.\n"
            "- To act, pass one affordance to interego_act. You do not need to "
            "know substrate tool names — discover capability at runtime by "
            "following the affordances you are handed.\n"
            "- Entry-point affordances (not tied to a descriptor): "
            "{action:'register_agent',tool:'register_agent'}, "
            "{action:'verify_agent',tool:'verify_agent'}, "
            "{action:'discover_all',tool:'discover_all'} — pass these to "
            "interego_act with the needed args to reach federation + identity.\n"
            "Save durable facts, preferences, decisions, and corrections; the "
            "substrate keeps the full history so you do not have to."
        )

    # ── recall (prefetch) ───────────────────────────────────────────────
    def prefetch(self, query: Any) -> str:
        """Before each API call: return a recall block for the system prompt.

        Each line carries its affordances inline so the agent can act on a
        recalled memory without a second discovery round-trip.
        """
        q = self._query_text(query)
        hits = self._recall(q, limit=8)
        if not hits:
            return ""
        lines = ["Relevant memories from your Interego pod (each shows what you can do with it):"]
        for h in hits:
            modal = h.get("modalStatus", "Asserted")
            verbs = ",".join(a["action"] for a in h.get("affordances", []))
            lines.append(f"- ({modal}) {h.get('text', '').strip()}  [affordances: {verbs}]")
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

    # ── agent-facing tools (the fixed 3-schema HATEOAS surface) ──────────
    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """Three tools, fixed forever — recall, discover, act.

        This is the bloat fix. Interego has ~15 relay tools (and ~60 in
        the full MCP server); surfacing them flat would swamp the agent's
        context. Instead the agent gets THREE schemas. interego_recall and
        interego_discover return items decorated with `affordances`;
        interego_act follows any affordance (or any entry-point affordance
        from the system prompt). New substrate capability shows up as a new
        affordance verb in the data — never a new tool schema.
        """
        return [
            {
                "name": "interego_recall",
                "description": "Search this agent's Interego pod memory (verifiable, "
                "federated). Returns memories, each decorated with the `affordances` "
                "you can follow on it via interego_act.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What to search for."},
                        "limit": {"type": "integer", "description": "Max results (default 8)."},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "interego_discover",
                "description": "Discover context descriptors on the pod (or across the "
                "federation). Returns descriptors, each decorated with `affordances`. "
                "Use this to navigate the substrate — you do not need to know tool names.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Optional keyword filter."},
                        "federated": {
                            "type": "boolean",
                            "description": "Search across all known pods (discover_all) "
                            "instead of just this one. Default false.",
                        },
                        "limit": {"type": "integer", "description": "Max results (default 12)."},
                    },
                },
            },
            {
                "name": "interego_act",
                "description": "Follow an affordance — the single way to act on the "
                "substrate. Pass an affordance object you were handed (it names its "
                "own `tool` and base `args`); supply `content` for derive/annotate/"
                "challenge and `params` for anything extra. This is HATEOAS: the "
                "result told you what you could do; this does it.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "affordance": {
                            "type": "object",
                            "description": "An {action, tool, args} record from a "
                            "result's `affordances` list, or an entry-point affordance "
                            "from the system prompt.",
                        },
                        "content": {
                            "type": "string",
                            "description": "New memory text — for derive / annotate / challenge.",
                        },
                        "params": {
                            "type": "object",
                            "description": "Extra args merged into the affordance's args "
                            "(e.g. share_with recipients, pod_url, agent_id).",
                        },
                    },
                    "required": ["affordance"],
                },
            },
        ]

    def handle_tool_call(self, name: str, args: dict[str, Any]) -> str:
        try:
            if name == "interego_recall":
                hits = self._recall(str(args.get("query", "")), limit=int(args.get("limit", 8)))
                return json.dumps({"memories": hits})
            if name == "interego_discover":
                items = self._discover(
                    query=str(args.get("query", "")),
                    federated=bool(args.get("federated", False)),
                    limit=int(args.get("limit", 12)),
                )
                return json.dumps({"descriptors": items})
            if name == "interego_act":
                return json.dumps(
                    self._act(
                        affordance=args.get("affordance") or {},
                        content=args.get("content"),
                        params=args.get("params") or {},
                    )
                )
            return json.dumps({"error": f"unknown tool: {name}"})
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
            return json.dumps({"error": str(exc)})

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
        """Publish one memory. pod_name / agent_id / owner_webid are auto-filled
        by the relay from the authenticated bearer when omitted."""
        args = self._build_memory_args(text, kind, tags, modal_status)
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
            descriptor_url = str(entry.get("descriptorUrl", ""))
            subject_iri = str(describes[0] if describes else descriptor_url)
            hits.append(
                {
                    "memoryIri": subject_iri,
                    "text": text,
                    "modalStatus": entry.get("modalStatus", "Asserted"),
                    "confidence": entry.get("confidence", 0.5),
                    "recordedAt": entry.get("validFrom", ""),
                    # HATEOAS: the actions available on this memory travel
                    # with it — the agent follows one via interego_act.
                    "affordances": self._affordances_for(descriptor_url, subject_iri),
                }
            )
            if len(hits) >= limit:
                break
        return hits

    # ── HATEOAS: decoration + navigation + execution ────────────────────
    def _affordances_for(self, descriptor_url: str, subject_iri: str) -> list[dict[str, Any]]:
        """Decorate a result with the affordances the agent may follow on it.

        Each affordance is self-describing: {action, tool, args}. interego_act
        executes it as-is (merging any agent-supplied content/params), so the
        agent never hardcodes a substrate tool name. Gated by the agent's
        delegation scope — it is only handed actions it is allowed to take.
        """
        out: list[dict[str, Any]] = []
        for verb in _SCOPE_VERBS.get(self._scope, _SCOPE_VERBS["ReadWrite"]):
            tool = _AFFORDANCE_DISPATCH[verb]
            args: dict[str, Any] = {}
            if verb == "read":
                args = {"descriptor_url": descriptor_url}
            elif verb == "subscribe":
                args = {"pod_url": self._pod_url}
            else:
                # publish_context family — the relay auto-supersedes a prior
                # descriptor for the same graph_iri, so derive/retract that
                # target by reusing its graph IRI. challenge/annotate get a
                # fresh graph IRI (independent counter / note).
                args = {"_target": subject_iri}
                if verb in ("derive", "retract"):
                    args["_reuse_graph_of"] = subject_iri
                if verb == "retract":
                    args["modal_status"] = "Counterfactual"
                if verb == "challenge":
                    args["modal_status"] = "Counterfactual"
                if verb == "annotate":
                    args["modal_status"] = "Hypothetical"
            out.append({"action": verb, "tool": tool, "args": args})
        return out

    def _discover(self, query: str, federated: bool, limit: int) -> list[dict[str, Any]]:
        """Discover descriptors on the pod (or the federation), each affordance-decorated."""
        if not self._pod_url and not federated:
            return []
        tool = "discover_all" if federated else "discover_context"
        call_args = {} if federated else {"pod_url": self._pod_url}
        try:
            result = self._call_tool(tool, call_args, auth=False)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError):
            return []
        entries = result.get("entries", []) if isinstance(result, dict) else []
        q = query.strip().lower()
        items: list[dict[str, Any]] = []
        for entry in entries:
            descriptor_url = str(entry.get("descriptorUrl", ""))
            describes = entry.get("describes", []) or []
            subject_iri = str(describes[0] if describes else descriptor_url)
            if q and q not in descriptor_url.lower() and not any(q in str(d).lower() for d in describes):
                continue
            items.append(
                {
                    "descriptorUrl": descriptor_url,
                    "describes": describes,
                    "modalStatus": entry.get("modalStatus", ""),
                    "validFrom": entry.get("validFrom", ""),
                    "affordances": self._affordances_for(descriptor_url, subject_iri),
                }
            )
            if len(items) >= limit:
                break
        return items

    def _act(
        self,
        affordance: dict[str, Any],
        content: str | None,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        """Follow an affordance — the single substrate-acting path (HATEOAS engine).

        The affordance names its own `tool` and base `args`; this merges in
        the agent's content/params and POSTs. Any relay tool is reachable
        this way — including entry-point affordances (register_agent,
        verify_agent, discover_all) that are not tied to a descriptor — so
        the agent reaches *all* of Interego through one tool, with three
        schemas total in its context.
        """
        action = str(affordance.get("action", ""))
        tool = str(affordance.get("tool", ""))
        if not tool:
            return {"error": "affordance is missing a `tool` — pass one handed to you by recall/discover"}
        base = dict(affordance.get("args") or {})
        target = base.pop("_target", None)
        reuse_graph_of = base.pop("_reuse_graph_of", None)

        if tool == "publish_context":
            # derive / retract / challenge / annotate — build a memory graph
            # from the supplied content and let the relay sign + supersede.
            body = content or (f"[{action.upper()}] {target}" if target else "")
            if not body.strip():
                return {"error": f"`{action}` needs `content` (the new memory text)"}
            kind = "observation"
            modal = str(base.get("modal_status", "Asserted"))
            built = self._build_memory_args(body, kind, [f"affordance:{action}"], modal)
            if reuse_graph_of:
                # Reuse the target's graph IRI so the relay auto-supersedes it.
                gid = str(reuse_graph_of).rsplit(":", 1)[-1]
                built["graph_iri"] = f"urn:graph:cg:memory:{gid}"
            built.update({k: v for k, v in params.items() if v is not None})
            result = self._call_tool("publish_context", built, auth=True)
            return {"ok": True, "action": action, "result": result}

        # read / subscribe / register_agent / verify_agent / discover_all /
        # any other relay tool — pass base args + params straight through.
        call_args = {**base, **{k: v for k, v in params.items() if v is not None}}
        needs_auth = tool not in ("get_descriptor", "discover_context", "discover_all",
                                  "get_pod_status", "list_known_pods", "resolve_webfinger")
        result = self._call_tool(tool, call_args, auth=needs_auth)
        return {"ok": True, "action": action, "result": result}

    def _build_memory_args(
        self, text: str, kind: str, tags: list[str], modal_status: str
    ) -> dict[str, Any]:
        """Shared memory-graph builder — used by _store and _act's publish path."""
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
        return args

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
