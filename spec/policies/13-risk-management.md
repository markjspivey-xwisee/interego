# Risk Management Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual + before significant change

## 1. Purpose

To identify, assess, prioritize, treat, and monitor risks to Interego's confidentiality, integrity, and availability commitments — and to make the risk posture queryable evidence rather than tribal knowledge.

## 2. Scope

All assets and processes in scope for the Information Security Policy ([`01-information-security.md`](01-information-security.md) §2).

## 3. Risk Categories

| Category | Examples |
|---|---|
| Cryptographic | Algorithm deprecation; key compromise; weak entropy |
| Identity | DID resolution failure; SIWE replay; auth-method tampering |
| Federation | Malicious pod manifest; cross-pod data leak; recipient resolution attack |
| Infrastructure | Region outage; vendor failure; DDoS; dependency compromise |
| Operational | Solo-operator unavailability; misconfiguration; manual deploy error |
| Compliance | Audit failure; regulatory change; signature backlog |
| Privacy | Accidental plaintext exposure; PII in logs; sensitive content publication |
| Supply chain | Malicious npm dep; compromised build environment |

## 4. Policy Statements

### 4.1 Risk register

- The operator MUST maintain a risk register on the operator's pod as compliance descriptors.
- Each identified risk is a descriptor with:
  - `cg:modalStatus Hypothetical` (potential risk) until materialized
  - `cg:modalStatus Asserted` (active risk requiring treatment)
  - `cg:modalStatus Counterfactual` (mitigated; supersedes the prior assertion)
- Risks carry: description, category, likelihood (low/medium/high), impact (low/medium/high), treatment plan, owner, target date.

### 4.2 Risk treatment

For each Asserted risk, the operator chooses one of:

- **Avoid** — change the system so the risk no longer applies
- **Mitigate** — implement controls to reduce likelihood or impact
- **Transfer** — shift via insurance, contract, or vendor commitment
- **Accept** — record acceptance with justification (operator approval required for high-impact)

Treatment decision MUST be recorded as a descriptor.

### 4.3 Risk assessment cadence

- Full register review: annually
- Triggered review: before any significant feature, vendor change, regulatory change, or post-incident
- Quarterly: review high-impact risks; confirm treatment progress

### 4.4 Significant change definition

A significant change is any of:

- New feature affecting trust, identity, encryption, or storage
- New vendor with access to customer data
- New jurisdiction (operator or customer)
- Material increase in scale (10x current load)
- Material change to the threat landscape (e.g., a primitive deprecation, a new known attack class)

### 4.5 Risk communication

- The Independent Advisor receives the full risk register quarterly.
- Material risks (high impact unmitigated) communicated within 5 business days of identification.
- Customers MUST be notified of risks that materially affect their data (e.g., cryptographic deprecation requiring action on their part).

### 4.6 Initial risk register (snapshot 2026-04-25)

The following risks are recorded as Asserted at policy effective date:

1. **Solo-operator availability** — operator incapacitation could leave service without admin response. Treatment: break-glass procedure with Advisor (compensating control).
2. **Single-region deployment** — eastus outage affects all production. Treatment: documented; cross-region redundancy as roadmap item.
3. **Cryptographic agility** — current secp256k1 + NaCl primitives are well-established but not future-proof. Treatment: monitor NIST PQC migration; plan secondary algorithm support.
4. **Vendor SOC 2 collection** — initial vendor reports not yet retrieved. Treatment: collect within 60 days.
5. **Auditor familiarity with RDF/ECDSA evidence** — auditors may request CSV/SIEM-style evidence. Treatment: build auditor onboarding doc + bridge tooling.
6. **No formal entity** — operator is sole individual, not incorporated. Treatment: incorporation roadmap before formal audit engagement.
7. **No automated CI deploy gate** — production deploy currently from workstation. Treatment: roadmap item; compensating control via signed deploys.

These will be tracked as descriptors as the policy is operationalized.

## 5. Procedures

### 5.1 Adding a risk

1. Identify risk via observation, threat model, audit finding, or external advisory
2. Classify category, likelihood, impact
3. Publish descriptor with `cg:modalStatus Hypothetical` (or Asserted if confirmed active)
4. Assign owner + target treatment date
5. Notify Advisor if high-impact

### 5.2 Closing a risk

1. Verify mitigation effective (test, audit)
2. Publish superseding descriptor with `cg:modalStatus Counterfactual` (mitigated)
3. Record evidence of mitigation

### 5.3 Annual risk review

In January each year:

1. Iterate through register
2. Re-assess each risk's likelihood + impact
3. Confirm treatment progress
4. Identify new risks
5. Publish review descriptor with `dct:conformsTo soc2:CC3.2`

## 6. Exceptions

Per [`01-information-security.md`](01-information-security.md) §6.

## 7. Mapping

- SOC 2: CC3.1 (risk identification), CC3.2 (risk analysis), CC3.3 (fraud risk consideration)
- ISO 27001 Annex A: A.6, Clause 6.1
