# TON Testnet Signer (Phase 9) — Self-hosted encrypted custody

Authority: `docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.3.md`

## Owner custody decision

| Item                                         | Status                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| AWS KMS Ed25519 compatibility                | **TECHNICALLY PROVEN** (historical Phase 9 evidence only)                |
| AWS as production Hot Wallet signing custody | **OWNER REJECTED** (ops / vendor risk)                                   |
| Production target                            | **`apps/signer` + SELF-HOSTED ENCRYPTED Ed25519 (`FALLBACK_ENCRYPTED`)** |

**No signer-custody migration required.** `FALLBACK_ENCRYPTED` already exists in the Hot Wallet signer-type enum; migration `0020_signer_read_boundary.sql` is preserved.

Do **not** start Phase 11 from this document. Phase 10 broadcast foundation is documented in
`docs/PHASE_10_ACCEPTANCE_REPORT.md` (status: blocked on Owner Testnet resources).

## Boundary

- Only `apps/signer` may hold usable Hot Wallet private signing capability after unlock.
- Domain logic lives in `@alex-rewards/signing` (policy, Wallet V5 R1, encrypted bundle crypto).
- Product apps/packages must **not** import `@aws-sdk/client-kms` (CI boundary).
- Caller may send **only** `withdrawalAttemptId`.
- Signer independently loads `signer_withdrawal_attempt_signing_v` and reconstructs canonical Wallet V5 R1 / TEP-74 intent.
- Signer has **no** financial DB writes, **no** public ingress, **no** TON RPC/broadcast.
- Phase 10 additive: sign result may include `externalMessageBocBase64` for worker-side broadcast;
  the signer process still must never submit that BOC to the network.

## Signing message bytes

The signer signs the **32-byte Cell hash** of the Wallet V5 R1 external signing message with Ed25519 (same digest semantics as historical `ED25519_SHA_512` + `MessageType=RAW`).

Local verification uses `@ton/crypto` `verify(hash, signature, publicKey)`.

## Production custody — `FALLBACK_ENCRYPTED`

### Key generation

1. Generate a 32-byte Ed25519 seed via CSPRNG (`generateHotWalletSeed`).
2. Derive Wallet V5 R1 identity on TESTNET (`networkGlobalId = -3`). MAINNET (`-239`) is rejected in Phase 9.
3. Record public-key fingerprint (`sha256(publicKey)` hex) as `signer_reference` / `SIGNER_EXPECTED_SIGNER_REFERENCE`.
4. Encrypt the seed into an authenticated key bundle (below). Store **only** the ciphertext file on the signer host.
5. Never write seed/mnemonic/private key into repo, database, frontend, logs, or process environment.

### Encryption

- **KDF:** Argon2id (default ~64 MiB memory, 3 passes, parallelism 1, 32-byte derived key).
- **AEAD:** XChaCha20-Poly1305.
- No custom cryptography; implementation in `@alex-rewards/signing` (`encrypted-key-bundle`).

### Bundle format (v1)

Authenticated JSON file (path via `SIGNER_KEY_BUNDLE_PATH`), non-secret metadata + ciphertext:

- `formatVersion`, `kdf` (`argon2id`), `kdfParams`, `saltB64`
- `aead` (`xchacha20poly1305`), `nonceB64`, `ciphertextB64`
- `publicKeyFingerprint`, `networkGlobalId`, `walletVersion` (`v5R1`), `workchain`, `derivedAddressRaw`

Passphrase is **never** stored in env (`SIGNER_KEY_PASSPHRASE` and plaintext `SIGNER_PRIVATE_KEY` / `SIGNER_SEED` / `SIGNER_MNEMONIC` are forbidden).

### Unlock / lock / restart

- Process boots **LOCKED**; signing is unavailable until unlock.
- Local unlock: loopback-only `POST /v1/local-unlock` with passphrase (interactive ops).
- Relock: `POST /v1/local-relock` or process shutdown (`SIGTERM`/`SIGINT` best-effort scrub).
- Restart always returns to **LOCKED**; operator must unlock again.
- Self-hosted mode binds listen host to `127.0.0.1` for unlock safety.

### Config

- `SIGNER_KEY_MODE=local_ephemeral` — local/test only; does **not** satisfy production gate.
- `SIGNER_KEY_MODE=self_hosted_encrypted` — required outside local/test; needs `SIGNER_KEY_BUNDLE_PATH`.
- `SIGNER_EXPECTED_SIGNER_REFERENCE` — optional SHA-256 public-key fingerprint pin.
- `SIGNER_NETWORK_GLOBAL_ID=-3` (TESTNET). MAINNET `-239` rejected.

### Backup

Maintain **two offline encrypted backups** of the key bundle (same ciphertext format), stored separately from the live host, with passphrase held offline under Owner custody. Backups are ciphertext only — never plaintext seeds.

### Recovery / rotation / Hot Wallet replacement

1. Pause payout dispatch; do not unlock a suspect host.
2. Restore from an offline encrypted backup onto a clean signer host, or generate a **new** Hot Wallet and update audited Hot Wallet configuration.
3. Unlock only after identity checks (`publicKeyFingerprint`, derived address) match expected Hot Wallet rows.
4. Rotation = new seed + new encrypted bundle + Hot Wallet config change + dual offline backups; old material revoked/destroyed under Owner procedure.

### Compromise response

1. Pause dispatch / hold withdrawals.
2. Relock signer; revoke host access to bundle path and offline backup locations as needed.
3. Do **not** rely on “Disable KMS” — there is **no AWS dependency** on the production path.
4. Rotate Hot Wallet / replace encrypted bundle; reconcile ledger vs chain; resume only after Owner approval.

### Provider abstraction

`SignPort` / `LockableSignPort` (`SigningKeyProvider` shape) keep future HSM/Vault adapters possible without returning signing permission to general workers. AWS is not the production adapter.

## Jetton wallet identity

`hot_wallets.payout_jetton_wallet_address` is a deployment-controlled snapshot. Signer never derives it via TON RPC.

## Phase 7 fake attempts

`canonical_message_hash` values starting with `fake-hash:` are **rejected**.

## Historical AWS KMS spike (non-authoritative)

AWS `ECC_NIST_EDWARDS25519` compatibility was proven in Phase 9 engineering evidence. That spike is **not** a production custody requirement and **not** a mandatory production gate. Obsolete AWS helper scripts and `@aws-sdk/client-kms` have been removed from the product tree.

## §34.2 / §34.3 split

- **§34.2:** historical AWS checklist — evidence only.
- **§34.3 / production gate:** formally reviewed, Testnet-validated self-hosted encrypted signer (`FALLBACK_ENCRYPTED`).

**Deferred beyond Phase 9 signer:** chain watcher maturity, 100+ Testnet payout campaign,
provider reconciliation against live TON (see Phase 10 acceptance — currently blocked on Owner
Jetton master / providers). Broadcast foundation lives **outside** the signer (worker).
