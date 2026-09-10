# Disaster recovery

Phase 1 local data is disposable development data. Production backup, restore, dispatch-pause,
and mandatory reconciliation procedures remain governed by the Master Spec and must be
implemented and drilled before production/mainnet. No Phase 1 mechanism may be presented as
production recovery.

## Hot Wallet / signer custody (v1.3)

Production signing uses **self-hosted encrypted Ed25519 (`FALLBACK_ENCRYPTED`)** under
`apps/signer`. AWS KMS compatibility is historical evidence only; AWS is **not** the production
custody backend. **No signer-custody migration required.**

### Encrypted bundle recovery

1. Keep **two offline encrypted backups** of the Hot Wallet key bundle (ciphertext only).
2. After host loss: restore bundle to a clean signer host, set `SIGNER_KEY_BUNDLE_PATH`, unlock
   via loopback with Owner-held passphrase, verify fingerprint/address, then resume only after
   reconciliation gates pass.
3. Passphrase is never stored in process environment; plaintext seeds are never archived.

### Hot Wallet compromise

1. Pause payout dispatch; hold ambiguous withdrawals.
2. Disable signer unlock / revoke encrypted-bundle access on compromised hosts (and revoke any
   residual historical KMS permission if somehow still present — not part of the production path).
3. Rotate: new Hot Wallet identity + new encrypted bundle + dual offline backups.
4. Update audited Hot Wallet configuration; reconcile ledger vs chain vs funding.
5. Resume dispatch only after Owner approval and mandatory post-restore reconciliation
   (dispatch starts PAUSED after database restore).

### Future providers

HSM or Vault-backed adapters may implement the same `SignPort` / `LockableSignPort` boundary later.
They must not return signing permission to general workers.

See `docs/TON_SIGNER.md` and `docs/OPERATIONS_RUNBOOK.md`.
