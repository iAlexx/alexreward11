# Phase 21 — 50-Withdrawal Acceptance Campaign

**Spec §178 gate:** at least **50** confirmed real withdrawals before expansion review.

**Required counter semantics:**

```text
CONFIRMED + RECONCILED + LEDGER_INVARIANT_PASS
```

**Never count:**

- `UNKNOWN` / ambiguous broadcast results
- Reconciliation pending / unexplained differences
- Duplicate payout suspicion
- Ledger mismatch / chain mismatch

**Expansion:**

- At 50 clean confirmed: `READY_FOR_POST_MICRO_LAUNCH_REVIEW` only
- Expansion is **NEVER automatic**
- Owner review remains required
- Do not auto-increase limits/funding after payout #50

Implementation: `evaluatePhase21ExpansionGate` in `packages/withdrawals/src/phase21-expansion-gate.ts`.

Evidence fields per counted payout (later campaign tooling):

- withdrawal ID
- approval evidence
- payout attempt
- signed message hash
- broadcast evidence
- chain transaction evidence
- amount / destination
- ledger transaction linkage
- reconciliation result
- duplicate-payout check
- final confirmed state

Never store private keys/secrets in campaign evidence.

**Step 1 status:** campaign model/gate foundation only; `PHASE21_CONFIRMED_WITHDRAWAL_COUNT=0`; no live Mainnet campaign.
