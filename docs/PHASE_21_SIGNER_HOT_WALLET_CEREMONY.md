# Phase 21 - Signer / Hot Wallet Ceremony (later Owner steps)

**PRODUCTION_SIGNER_SERVICE:** `NOT_PROVISIONED`
**PRODUCTION_HOT_WALLET_STATUS:** `NOT_CREATED`
**REAL_PRODUCTION_KEY_GENERATED:** `NO` (Step 3 forbids generation/execution)
**SIGNER_HOSTING:** `DEDICATED_CONTROLLED_HOST`
**CEREMONY_EXECUTED:** `NO`

This document prepares the later Owner ceremony. It does **not** authorize execution in Step 3.

---

## Custody model (unchanged)

- `SIGNER_KEY_MODE=self_hosted_encrypted`
- No plaintext seed / mnemonic / private key / passphrase in env
- Encrypted key bundle only; decrypted key only in signer process memory
- Signer signs only; never broadcasts
- Restart returns LOCKED
- API / Bot / Admin / Worker must not receive decrypted signing material
- Hosting: **DEDICATED_CONTROLLED_HOST** (locked decision)

Phase 21 Mainnet config (when explicitly enabled later):

```text
PHASE21_MAINNET_ENABLED=true
SIGNER_NETWORK_CODE=TON_MAINNET
SIGNER_NETWORK_GLOBAL_ID=-239
SIGNER_KEY_MODE=self_hosted_encrypted
SIGNER_WALLET_VERSION=v5R1
```

---

## Offline Mainnet CLI reference (NOT EXECUTED in Step 3)

Owner ceremony will use offline / controlled-host CLI paths (exact flags may evolve; values below are reference only):

```text
# Offline on controlled host - DO NOT RUN in Step 3
# 1) Generate Wallet V5 R1 seed offline
# 2) Derive Mainnet identity with Phase21 allow-path:
#      networkCode=TON_MAINNET  networkGlobalId=-239  phase21MainnetEnabled=true
# 3) Encrypt authenticated key bundle (self_hosted_encrypted)
# 4) Dual offline encrypted backups; destroy plaintext
# 5) Install ciphertext on DEDICATED_CONTROLLED_HOST
# 6) Boot signer LOCKED; verify fingerprint/address
# 7) Unlock briefly only for authorized sign window; relock
```

Step 3 documents this reference only. **No key generation, encrypt, deploy, unlock, or funding is performed.**

---

## Later Owner ceremony sequence (not executed now)

1. Generate fresh Wallet V5 R1 seed **offline**
2. Derive **Mainnet** wallet address (`networkGlobalId=-239`) with Phase21 allow-path
3. Encrypt authenticated key bundle
4. Make **two** offline encrypted backups
5. Record only public fingerprint + address (no secrets in Git)
6. Destroy plaintext seed
7. Install ciphertext on dedicated controlled signer host
8. Boot signer **LOCKED**
9. Verify expected fingerprint / address against Hot Wallet registration
10. Unlock briefly only for an authorized sign window
11. Relock immediately

---

## Railway suitability note

Railway cannot satisfy loopback unlock / no-passphrase-in-env custody without redesign.
Owner decision is locked: **DEDICATED_CONTROLLED_HOST**. Do not fake Railway compatibility.

---

## Current Railway inventory (no signer)

Observed application services (no signer):

- Postgres, Redis
- admin-staging, api-staging, miniapp-staging
- temporal-staging, worker-staging, bot-staging
- Phase 18 retained restore sibling

Step 3 does not create a Railway signer service.

---

## Future DB rows (docs only - no INSERT in Step 3)

Owner ceremony will require aligned rows (IDs assigned at ceremony time; not invented here):

### networks

- code: TON_MAINNET
- chain: TON
- environment: MAINNET
- global_chain_identifier: ton:mainnet
- status: ACTIVE

### assets

- symbol: USDT
- network_id: (FK to TON_MAINNET network row)
- contract_identity: Owner-approved Mainnet USDT Jetton master (`TON_MAINNET_USDT_JETTON_MASTER`)
- decimals: 6
- is_native: false

### hot_wallets

- address / friendly_address: derived Wallet V5 R1 Mainnet (`networkGlobalId=-239`)
- version: v5R1
- signer_type: FALLBACK_ENCRYPTED
- signer_reference: SHA-256 public key fingerprint hex (matches encrypted bundle)
- payout_jetton_wallet_address: Owner-verified Mainnet USDT jetton wallet for hot wallet
- status: ACTIVE

Native gas asset remains ledger-compatible with legacy identifiers (`HOT_WALLET_TON_ASSET`) while display/canonical native = Gram/GRAM.

See `docs/PHASE_21_SIGNER_HOSTING_DECISION.md` and `docs/PHASE_21_PROVISIONING_CEREMONY_PREFLIGHT.md`.
