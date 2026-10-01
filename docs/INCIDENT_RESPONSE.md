# Incident response (Phase 18)

Semantic markers: PHASE18_INCIDENT_RESPONSE, FINANCIAL_AMBIGUITY_CONTAINMENT, NO_AUTO_UNPAUSE, NO_BLIND_RESEND.

Phase 1 placeholder language is retired. Financial procedures are active for containment and Owner-gated recovery.
Do not invent response-time SLAs. Where numeric on-call/SLA policy is unset: `OWNER_POLICY_REQUIRED` (see `docs/PHASE_18_OWNER_POLICY_REGISTER.md`).

## Global financial ambiguity rule

When financial state is ambiguous:

1. Pause payouts via the authoritative Feature Flags ceremony (`PAYOUT_DISPATCH_PAUSE=true`).
2. Do not blind resend withdrawals or Outbox financial events.
3. Do not edit ledger history.
4. Do not auto-unpause (`AUTO_UNPAUSE=false`).
5. Owner review is required before resume.

No incident playbook may instruct agents to `UPDATE feature_flags` directly, call signer, or broadcast TON as a shortcut.

---

## Playbook A — PostgreSQL unavailable / corruption suspected

- Detection: readiness UNAVAILABLE; Admin `POSTGRES` UNAVAILABLE; connection errors; restore-drill failures.
- Immediate containment: stop write-path deploys; ensure `PAYOUT_DISPATCH_PAUSE=true`.
- Financial freeze: required.
- Evidence: timestamps, health snapshots, Railway Postgres status (no credentials in tickets).
- Reconciliation: required after recovery before resume.
- Authority: Owner + infra operator.
- Resume: Owner only after healthy Postgres + reconciliation gate.

## Playbook B — Redis unavailable

- Detection: readiness Redis probe fail; Admin `REDIS` UNAVAILABLE.
- Immediate containment: treat session/rate features degraded; keep payouts paused if freeze already active.
- Financial freeze: if payout/session ambiguity appears, pause payouts.
- Evidence: probe errors, deploy/instance identity.
- Reconciliation: not ledger-primary; verify no duplicate side effects after restore.
- Authority: Owner / infra.
- Resume: Owner after Redis healthy and confirmation no financial ambiguity.

## Playbook C — Temporal unavailable / workflow visibility unavailable

- Detection: Admin `TEMPORAL` UNAVAILABLE; restore-drill Temporal query FAIL; worker saturation signals.
- Immediate containment: pause payouts; do not start/replay/signal workflows as recovery shortcuts.
- Financial freeze: required for withdrawal-path ambiguity.
- Evidence: Temporal address/namespace names only; workflow id digests if needed (no secrets).
- Reconciliation: DB expected workflows vs Temporal visibility after recovery.
- Authority: Owner.
- Resume: Owner after Temporal visibility PASS and withdrawal reconcile clean.

## Playbook D — Telegram bot unavailable

- Detection: bot health fail; Admin `TELEGRAM_BOT` UNKNOWN/UNAVAILABLE.
- Immediate containment: user messaging degraded; do not invent heartbeat DB rows.
- Financial freeze: only if payout UX would create ambiguity; prefer pause if unsure.
- Evidence: bot process health, Railway service status.
- Reconciliation: none unless bot-triggered financial side effects exist.
- Authority: Owner.
- Resume: Owner after bot healthy.

## Playbook E — Ads/provider outage or no-fill spike

- Detection: `PROVIDER_HEALTH` degraded/unavailable; AdsGram console.
- Immediate containment: do not override provider hard limits; do not enable monetary AdsGram as workaround.
- Financial freeze: if reward issuance ambiguity, pause payouts and halt monetary campaigns.
- Evidence: provider_health_snapshots, campaign ids (no API keys).
- Reconciliation: provider settlement/reporting after recovery.
- Authority: Owner.
- Resume: Owner after provider healthy + settlement review.

## Playbook F — Provider reporting / settlement discrepancy

- Detection: `PROVIDER_SETTLEMENT` disputed/degraded; Phase 10 reconcile findings.
- Immediate containment: FINANCIAL_AMBIGUITY_CONTAINMENT; pause payouts.
- Financial freeze: required.
- Evidence: settlement digests, import status codes (no raw credentials).
- Reconciliation: required; no blind resend.
- Authority: Owner.
- Resume: Owner after mismatch resolved or explicitly accepted.

## Playbook G — Suspected duplicate or unauthorized payout

- Detection: unexpected outgoing chain transfer; reconcile danger categories; Hot Wallet monitor anomalies.
- Immediate containment: pause payouts immediately; do not broadcast further.
- Financial freeze: required.
- Evidence: withdrawal/attempt digests, chain observation window bounds (no wallet plaintext in public tickets if avoidable).
- Reconciliation: required one-to-one against expected CONFIRMED payouts.
- Authority: Owner.
- Resume: Owner only after reconcile PASS and ceremony.

## Playbook H — Ledger invariant failure

- Detection: `checkLedgerInvariants` critical findings; Admin reconciliation DANGER.
- Immediate containment: pause payouts; stop reward issuance if needed.
- Financial freeze: required.
- Evidence: invariant finding codes (no forged balancing entries).
- Reconciliation: required; never rewrite historical ledger as “fix”.
- Authority: Owner.
- Resume: Owner after invariants PASS.

## Playbook I — Withdrawal UNKNOWN / RECONCILE_REQUIRED

- Detection: Phase 10 restore reconcile / Admin withdrawal states.
- Immediate containment: pause payouts; NO_BLIND_RESEND.
- Financial freeze: required until classified.
- Evidence: attempt lineage digests, outbox pending/failed counts.
- Reconciliation: mandatory before any resend consideration.
- Authority: Owner.
- Resume: Owner after classification and clean reconcile.

## Playbook J — Hot Wallet / signer compromise

- Detection: unexpected signing, custody anomalies, unauthorized broadcasts.
- Immediate containment: pause payouts; stop signer; revoke exposure per `docs/TON_SIGNER.md`.
- Financial freeze: required.
- Evidence: signer fingerprints, Hot Wallet identity transition audit (no plaintext keys).
- Reconciliation: old/new wallet chain state.
- Authority: Owner.
- Resume: Owner after rotation/retirement procedure completes + reconcile.

## Playbook K — TON primary/secondary disagreement

- Detection: provider disagreement in chain validation; Admin RPC components UNKNOWN/DEGRADED.
- Immediate containment: pause payouts; do not prefer a single provider silently.
- Financial freeze: required for payout path.
- Evidence: agreement digests, window bounds.
- Reconciliation: required with dual-provider read-only evidence.
- Authority: Owner.
- Resume: Owner after agreement restored or explicit acceptance.

## Playbook L — Outbox backlog / dead-letter financial event

- Detection: `OUTBOX_LAG` / FAILED / DEAD_LETTER; restore-drill outbox OWNER_REVIEW.
- Immediate containment: pause payouts if financial events present; do not auto-replay.
- Financial freeze: required for financial outbox classes.
- Evidence: pending/failed/dead-letter counts (no payload secrets).
- Reconciliation: required before any manual replay.
- Authority: Owner.
- Resume: Owner after backlog cleared under controlled procedure.

## Playbook M — Review Queue backlog

- Detection: `REVIEW_QUEUE_BACKLOG` policy-gated alert; Admin Review Queue.
- Immediate containment: do not auto-resolve cases; do not clear fraud flags as shortcut.
- Financial freeze: if backlog implies payout ambiguity, pause payouts.
- Evidence: open case counts/ages (thresholds OWNER_POLICY_REQUIRED).
- Reconciliation: case-by-case Owner/admin process.
- Authority: Owner / authorized Admin.
- Resume: payouts only if freeze was applied and Owner clears financial risk.

## Playbook N — Reward budget / Founder bonus budget exhaustion

- Detection: `REWARD_BUDGET_EXPOSURE` / `FOUNDER_BONUS_BUDGET_EXPOSURE` DANGER on exact exhaustion; near-exhaustion OWNER_POLICY_REQUIRED.
- Immediate containment: stop further issuance paths; do not override budgets.
- Financial freeze: pause payouts if withdrawal exposure is coupled.
- Evidence: budget version ids / exposure codes (no forged grants).
- Reconciliation: ledger vs budget policy versions.
- Authority: Owner / Policy Center.
- Resume: Owner after policy adjustment under existing Control Center authority.

## Playbook O — Restore / DR incident

- Detection: PITR/restore failure; restore-drill FAIL; source/target isolation break.
- Immediate containment: do not cut over apps to sibling; keep pause true; do not delete sibling during investigation.
- Financial freeze: required.
- Evidence: restore target timestamp, host distinctness, drill report filenames.
- Reconciliation: FULL_STEP2B gate required before any resume consideration.
- Authority: Owner.
- Resume: Owner only after `fullRestoreGatePass=true` and ceremony (still `PAYOUT_RESUME_ALLOWED=false` until Owner sets resume).

## Playbook P — Secret / token compromise

- Detection: leaked bot token, DB URL, provider key, signer passphrase exposure.
- Immediate containment: rotate credential under Owner procedure; pause payouts; revoke leaked material.
- Financial freeze: required until blast radius known.
- Evidence: which secret class leaked (never paste secret values into tickets/docs).
- Reconciliation: audit access logs / unexpected financial activity.
- Authority: Owner.
- Resume: Owner after rotation verified and financial ambiguity cleared.
