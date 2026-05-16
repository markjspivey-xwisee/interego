#!/usr/bin/env python3
"""
Python verifier for Interego SignedBudgetAuditLog artifacts.

Proof-of-portability for the v3.3 audit chain — regulators with
Python tooling can re-verify an operator's signed cumulative-ε log
without depending on the TS runtime.

Implements the same three checks as the TS verifyBudgetAuditLog:
    1. Signature recovers an address present in signerDid.
    2. Log entries sum to snapshot.spent (within 1e-9 rounding).
    3. snapshot.spent <= snapshot.maxEpsilon.

The canonical message format MUST match the TS canonicalizeBudgetForSigning
exactly — they are byte-for-byte interoperable.

Usage:
    python3 verify_budget_audit.py <path-to-json>
    # or import verify_signed_budget_audit_log() programmatically

Dependencies: eth-account (pip install eth-account). No other deps.
"""

from __future__ import annotations

import json
import sys
from typing import Any

try:
    from eth_account.messages import encode_defunct
    from eth_account import Account
except ImportError:
    sys.stderr.write(
        "verify_budget_audit.py requires `eth-account`. Install with:\n"
        "    pip install eth-account\n"
    )
    sys.exit(2)


def canonicalize_budget_for_signing(snap: dict[str, Any]) -> str:
    """Mirror of the TS canonicalizeBudgetForSigning. Byte-for-byte
    interoperable with the TS implementation in
    applications/_shared/aggregate-privacy/index.ts.

    Format:
        interego/v1/aggregate/budget-audit|cohortIri=...|maxEpsilon=...|spent=...|log=[{...},...]
    """
    log_canon = ",".join(
        "{{queryDescription={qd},epsilon={eps},consumedAt={t}}}".format(
            qd=json.dumps(entry["queryDescription"], ensure_ascii=False),
            eps=_canon_number(entry["epsilon"]),
            t=entry["consumedAt"],
        )
        for entry in snap["log"]
    )
    return (
        "interego/v1/aggregate/budget-audit"
        f"|cohortIri={snap['cohortIri']}"
        f"|maxEpsilon={_canon_number(snap['maxEpsilon'])}"
        f"|spent={_canon_number(snap['spent'])}"
        f"|log=[{log_canon}]"
    )


def _canon_number(n: Any) -> str:
    """Match TS Number-to-string (JS toString) for canonical signing.

    JavaScript Number.prototype.toString:
      - integers: no decimal point (1.0 → "1")
      - non-integers: shortest decimal that round-trips
    Python's str() agrees for most non-pathological cases. JSON parse
    delivers ints or floats; reproduce JS toString accordingly.
    """
    if isinstance(n, int):
        return str(n)
    # Mirror JS: if the float is integer-valued, render as "1" not "1.0".
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return repr(n) if isinstance(n, float) else str(n)


def verify_signed_budget_audit_log(signed: dict[str, Any]) -> dict[str, Any]:
    """Auditor-side check. Returns a dict with `valid`, optional
    `reason`, and optional `recovered_address` on success.

    Mirrors the TS verifyBudgetAuditLog return shape.
    """
    snap = signed.get("snapshot")
    signer_did = signed.get("signerDid")
    signature = signed.get("signature")
    if not snap or not signer_did or not signature:
        return {"valid": False, "reason": "missing required fields (snapshot, signerDid, signature)"}

    canon = canonicalize_budget_for_signing(snap)
    message = encode_defunct(text=canon)
    try:
        recovered = Account.recover_message(message, signature=signature)
    except Exception as err:
        return {"valid": False, "reason": f"signature recovery failed: {err}"}

    did_lower = signer_did.lower()
    recovered_lower = recovered.lower()
    if recovered_lower not in did_lower:
        return {
            "valid": False,
            "reason": f"recovered address {recovered} not present in signerDid {signer_did}",
            "recovered_address": recovered,
        }

    # Internal consistency: log entries sum to spent (within 1e-9 rounding).
    log_sum = sum(float(entry["epsilon"]) for entry in snap.get("log", []))
    spent = float(snap.get("spent", 0))
    if abs(log_sum - spent) > 1e-9:
        return {
            "valid": False,
            "reason": f"log entries sum to {log_sum} but snapshot.spent is {spent}",
        }

    max_eps = float(snap.get("maxEpsilon", 0))
    if spent > max_eps:
        return {
            "valid": False,
            "reason": f"snapshot.spent ({spent}) exceeds maxEpsilon ({max_eps})",
        }

    return {"valid": True, "recovered_address": recovered}


def main() -> None:
    if len(sys.argv) != 2:
        sys.stderr.write("Usage: verify_budget_audit.py <path-to-json>\n")
        sys.exit(2)
    with open(sys.argv[1]) as f:
        signed = json.load(f)
    result = verify_signed_budget_audit_log(signed)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result.get("valid") else 1)


if __name__ == "__main__":
    main()
