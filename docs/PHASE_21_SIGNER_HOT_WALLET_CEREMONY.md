# Phase 21 — Signer / Hot Wallet Ceremony (later Owner steps)

**PRODUCTION_SIGNER_SERVICE:** `NOT_PROVISIONED`
**PRODUCTION_HOT_WALLET_STATUS:** `NOT_CREATED`
**REAL_PRODUCTION_KEY_GENERATED:** `NO` (Step 1 forbids generation)

This document prepares the later Owner ceremony. It does **not** authorize execution in Step 1.

---

## Custody model (unchanged)

- `SIGNER_KEY_MODE=self_hosted_encrypted`
- No plaintext seed / mnemonic / private key / passphrase in env
- Encrypted key bundle only; decrypted key only in signer process memory
- Signer signs only; never broadcasts
- Restart returns LOCKED
- API / Bot / Admin / Worker must not receive decrypted signing material

Phase 21 Mainnet config (when explicitly enabled later):

```text
PHASE21_MAINNET_ENABLED=true
SIGNER_NETWORK_CODE=TON_MAINNET
SIGNER_NETWORK_GLOBAL_ID=-239
SIGNER_KEY_MODE=self_hosted_encrypted
SIGNER_WALLET_VERSION=v5R1
```

---

## Later Owner ceremony sequence (not executed now)

1. Generate fresh Wallet V5 R1 seed **offline**
2. Derive **Mainnet** wallet address (`networkGlobalId=-239`) with Phase21 allow-path
3. Encrypt authenticated key bundle
4. Make **two** offline encrypted backups
5. Record only public fingerprint + address (no secrets in Git)
6. Destroy plaintext seed
7. Install ciphertext on signer host
8. Boot signer **LOCKED**
9. Verify expected fingerprint / address against Hot Wallet registration
10. Unlock briefly only for an authorized sign window
11. Relock immediately

---

## Railway suitability note (honest architectural limitation)

Current production custody assumes:

- Encrypted bundle on a controlled host filesystem
- Loopback-oriented unlock / least public exposure (`SIGNER_LISTEN_HOST` defaults to `127.0.0.1` for self_hosted_encrypted bare-metal safety)
- Operator-present passphrase unlock (not stored in env)

Railway-hosted signer creates real tension with that model:

| Concern | Why it matters |
| --- | --- |
| Public / shared ingress | Signer HTTP must not be unnecessarily internet-exposed |
| Loopback unlock | Container platforms often cannot use operator loopback unlock the same way as bare metal |
| Bundle persistence | Encrypted bundle needs durable, access-controlled volume; ephemeral disks risk loss or mis-mount |
| Passphrase delivery | Injecting unlock passphrase via platform secrets reintroduces plaintext-secret risk the model forbids in env |
| Co-tenancy / blast radius | Shared PaaS increases exposure vs dedicated signing host |

**Conclusion for Step 1:** Railway may be a **potential blocker** for hosting the production encrypted signer under the current loopback-unlock / no-passphrase-in-env model. Owner must decide later among:

1. Dedicated controlled host / VM for signer (preferred fit to current model)
2. Explicit architecture change (Owner-approved) before Railway signer hosting
3. Defer production signer until hosting model is decided

Do **not** fake Railway compatibility in Step 1.

---

## Current Railway inventory (no signer)

Observed application services (no signer):

- Postgres, Redis
- admin-staging, api-staging, miniapp-staging
- temporal-staging, worker-staging, bot-staging
- Phase 18 retained restore sibling

Step 1 does not create a Railway signer service.
