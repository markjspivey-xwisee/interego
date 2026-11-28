## 2026-11-28 — Interego sign-in for Workbench learning records

Adds an opt-in, short-lived Interego sign-in grant for the Workbench to read the signed-in account’s Foxxi xAPI statements without a wallet. An isolated check with two fictional accounts verifies that each can list and open its own statements but cannot open the other account’s statements.

The route stays disabled unless configured. This change does not activate the production route or migrate learning records.
