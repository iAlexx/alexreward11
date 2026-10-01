# Phase 20 Step 4B — Owner Policy Approval Record

**PHASE20_GATE:** HOLD  
**Branch:** `phase20-closed-beta`  
**Approval context:** Owner explicitly approved the Closed Beta Risk / Trust / Eligibility profile after Steps 4A / 4A.1 / 4A.2 semantics corrections.  
**Source commit used for approval baseline:** `3f4a849617a31cec1c35dad0d7be6410200c94f2`  
**Canonical artifact:** `packages/fraud/policy/phase20-closed-beta-owner-approved.json`  
**Artifact status:** `OWNER_APPROVED_STAGING_CANDIDATE`  
**activationAuthorized:** `false`

---

## Explicit non-authorizations

This approval does **not** authorize:

- staging or operational DB policy mutation / ACTIVE activation
- Railway deploy or Railway variable changes
- production monetary enablement
- AdsGram production monetary enablement
- payout resume / pause changes
- TON broadcast / signer operations
- Mainnet
- mission/referral content activation (`P20-GAP-017` remains OPEN)

Staging activation requires a **separate** Owner-gated ceremony after independent review.

---

## Exact approved Risk config

```json
{
  "thresholds": { "lowMax": 20, "mediumMax": 50, "highMax": 75 },
  "signalWeights": {
    "OPEN_HIGH_FRAUD_FLAG": 55,
    "OPEN_CRITICAL_FRAUD_FLAG": 80,
    "CONFIRMED_FRAUD_FLAG": 60,
    "SHARED_PAYOUT_WALLET": 35,
    "SHARED_DEVICE_SIGNAL": 25,
    "SHARED_NETWORK_SIGNAL": 20,
    "NETWORK_COUNTRY_CHANGED": 15
  },
  "signalParams": {},
  "actions": {
    "LOW": "MANUAL_REVIEW",
    "MEDIUM": "MANUAL_REVIEW",
    "HIGH": "HELD",
    "CRITICAL": "WITHDRAWAL_BLOCKED"
  }
}
```

Omitted for initial Phase 20: `AD_REVERSED_REWARD_HISTORY`, `REFERRAL_REJECTED_EDGE_HISTORY`.

Risk labels never auto-ban / auto-freeze / auto-approve payout / mutate ledger.

---

## Exact approved Trust config

```json
{
  "signals": {
    "ACCOUNT_AGE": { "weight": 25, "minDays": 1 },
    "VERIFIED_PRIMARY_WALLET_AGE": { "weight": 25, "minDays": 1 },
    "REWARDED_AD_HISTORY": { "weight": 25, "minCount": 1 },
    "CONFIRMED_PAYOUT_HISTORY": { "weight": 25, "minCount": 1 }
  },
  "stateThresholds": {
    "basicMin": 25,
    "establishedMin": 50,
    "trustedMin": 75
  }
}
```

Trust is observational — not an Eligibility gate. Does not override Risk / pause / wallet / ledger / signer.

---

## Exact approved Eligibility config

```json
{
  "actions": {
    "WITHDRAWAL_REQUEST": {
      "requiredGates": ["ACCOUNT_STATE", "RISK_POLICY", "FEATURE_FLAG"],
      "precedence": ["RISK_POLICY", "ACCOUNT_STATE", "FEATURE_FLAG"],
      "riskAllowedActions": ["ALLOW", "EXTEND_PENDING", "MANUAL_REVIEW"]
    },
    "AD_SESSION_START": {
      "requiredGates": ["ACCOUNT_STATE", "RISK_POLICY"],
      "precedence": ["RISK_POLICY", "ACCOUNT_STATE"],
      "riskAllowedActions": ["ALLOW", "EXTEND_PENDING", "MANUAL_REVIEW"]
    },
    "MISSION_CLAIM": {
      "requiredGates": ["ACCOUNT_STATE", "FEATURE_FLAG"],
      "precedence": ["ACCOUNT_STATE", "FEATURE_FLAG"]
    },
    "TASK_CLAIM": {
      "requiredGates": ["ACCOUNT_STATE"],
      "precedence": ["ACCOUNT_STATE"]
    }
  }
}
```

Omitted actions: `REFERRAL_ACTIVATION`, `MEMBERSHIP_CLAIM`.

Semantics retained from 4A.1 / 4A.2: withdrawal-scoped ACCOUNT_STATE; FEATURE_FLAG explicit bindings only.

---

## Rollback semantics (when a later activation exists)

1. Append-only SUPERSEDE / REVOKED transitions — do not silently edit ACTIVE JSON in place.  
2. Prefer fail-closed (no ACTIVE) over permissive emergency open.  
3. Independent kill switches remain: payout pause, AdsGram BLOCKED, Mainnet OFF.

---

## Gap status

`P20-GAP-009` → `OPEN / OWNER_APPROVED / READY_FOR_STAGING_ACTIVATION`  
Still blocks Closed Beta until staging activation + controlled validation complete.  
`P20-GAP-017` unchanged OPEN for content approval.