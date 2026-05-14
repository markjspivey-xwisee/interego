"""
CLI commands for the Interego Hermes memory provider.

Registered via ``register_cli(subparser)`` at Hermes argparse setup time,
adding ``hermes interego <cmd>``:

  hermes interego status   — show config + check relay reachability
  hermes interego whoami   — show the agent identity / pod being written to

Stdlib-only, like the provider itself.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

_DEFAULT_RELAY = "https://interego-mcp-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io"


def _load_config() -> dict[str, Any]:
    path = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "interego.json"
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def _cmd_status(_args: Any) -> int:
    cfg = _load_config()
    relay = (cfg.get("relay_url") or _DEFAULT_RELAY).rstrip("/")
    pod = cfg.get("pod_url", "")
    bearer_set = bool(os.environ.get("INTEREGO_AGENT_BEARER"))

    print("Interego memory provider")
    print(f"  relay_url     : {relay}")
    print(f"  pod_url       : {pod or '(not set — recall disabled until set)'}")
    print(f"  agent_bearer  : {'set' if bearer_set else 'NOT set (run hermes memory setup)'}")
    print(f"  agent_id      : {cfg.get('agent_id') or '(relay auto-fills from bearer)'}")
    print(f"  owner_webid   : {cfg.get('owner_webid') or '(relay auto-fills from bearer)'}")

    # Reachability probe — /tools is unauthenticated.
    try:
        with urllib.request.urlopen(f"{relay}/tools", timeout=10) as resp:  # noqa: S310
            tools = json.loads(resp.read().decode("utf-8"))
        names = {t.get("name") for t in tools} if isinstance(tools, list) else set()
        ok = {"publish_context", "discover_context"} <= names
        print(f"  relay reachable: yes ({len(names)} tools; "
              f"publish_context+discover_context {'present' if ok else 'MISSING'})")
        return 0 if (bearer_set and ok) else 1
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        print(f"  relay reachable: NO ({exc})")
        return 1


def _cmd_whoami(_args: Any) -> int:
    cfg = _load_config()
    print(f"agent_id    : {cfg.get('agent_id') or '(resolved from bearer at runtime)'}")
    print(f"owner_webid : {cfg.get('owner_webid') or '(resolved from bearer at runtime)'}")
    print(f"pod_url     : {cfg.get('pod_url') or '(not set)'}")
    return 0


def register_cli(subparser: Any) -> None:
    """Called by Hermes at argparse setup — adds the `interego` subcommand group."""
    p = subparser.add_parser("interego", help="Interego memory provider commands")
    sub = p.add_subparsers(dest="interego_cmd")

    status = sub.add_parser("status", help="Show config + check relay reachability")
    status.set_defaults(func=_cmd_status)

    whoami = sub.add_parser("whoami", help="Show the agent identity / pod being written to")
    whoami.set_defaults(func=_cmd_whoami)
