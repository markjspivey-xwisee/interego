# Python verifier — proof-of-portability for Interego audit artifacts

Minimal Python reference implementation that verifies a
`SignedBudgetAuditLog` artifact produced by the TS substrate. Ships
as a demonstration that Interego's audit artifacts are
language-portable: a regulator or auditor running Python tooling can
re-verify the audit chain without depending on the operator's TS
runtime.

This is the "second-language implementation" item from `STATUS.md`'s
"Honest remaining work" list, scoped to the slice that's truly
session-fit: ECDSA signature verification over a canonical
serialization. A full Python port of the substrate is multi-month
multi-person work, properly tracked separately; this script proves the
audit interface is interoperable today.

## What it verifies

A `SignedBudgetAuditLog` is the v3.3 audit artifact: an operator's
cumulative ε-budget snapshot signed by their wallet so a regulator
can confirm:

1. The signature recovers an address that appears in the claimed
   `signerDid`.
2. The consumption log entries sum to `snapshot.spent` (within 1e-9
   rounding tolerance).
3. `snapshot.spent <= snapshot.maxEpsilon`.

These are exactly the checks the TS `verifyBudgetAuditLog` runs. The
canonical serialization is byte-for-byte identical between the two
implementations.

## Dependencies

```
pip install eth-account
```

That's it. `eth-account` handles ECDSA over secp256k1 and the EIP-191
personal-sign envelope. No other dependencies — pure standard library
for everything else.

## Usage

```bash
# Verify a JSON-serialized SignedBudgetAuditLog file
python3 verify_budget_audit.py path/to/audit-log.json
```

Or programmatically:

```python
from verify_budget_audit import verify_signed_budget_audit_log
import json

with open('audit-log.json') as f:
    signed = json.load(f)

result = verify_signed_budget_audit_log(signed)
print(result)  # {'valid': True, 'recovered_address': '0x...'}
```

## Cross-implementation contract

The canonical message format MUST match the TS implementation
exactly. From [`applications/_shared/aggregate-privacy/index.ts`](../../applications/_shared/aggregate-privacy/index.ts):

```
interego/v1/aggregate/budget-audit|cohortIri=...|maxEpsilon=...|spent=...|log=[{queryDescription=...,epsilon=...,consumedAt=...},...]
```

If the TS canonicalization changes, this Python script needs the
same change, or signature recovery will fail. The TS contract tests
in [`applications/_shared/tests/aggregate-privacy.test.ts`](../../applications/_shared/tests/aggregate-privacy.test.ts) pin
the canonicalization format; treat them as the source of truth.
