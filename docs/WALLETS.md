# Wallet ownership (Phase 6)

Phase 6 proves **TON wallet ownership only**. It does not send money, create withdrawal
quotes, move Available → Reserved, or dispatch Hot Wallet / Jetton transfers.

Authority: `docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.2.md`
§26–§29.

## Packages

| Package                 | Responsibility                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@alex-rewards/ton`     | Official TON Connect `ton_proof` message construction, Ed25519 verify, StateInit pubkey extraction (known wallets only), address canonicalization |
| `@alex-rewards/wallets` | Challenge lifecycle, network authority, verified wallet upsert, primary wallet + 24h cooldown, audit/outbox                                       |

## Challenge lifecycle

1. Authenticated session user is authoritative (`authenticatedUserId` from Phase 3 session — never client `userId`).
2. `createTonProofChallenge` draws **32 CSPRNG bytes** (`base64url`), returns the raw challenge **once**.
3. Only `sha256(rawChallenge)` is persisted in `user_wallet_proof_nonces.nonce_hash`.
4. Challenge is bound to `(user_id, network_id)` with `issued_at` / `expires_at`.
5. TTL is config-controlled (`challengeTtlSeconds`). Staging/production must not silently inherit unsafe localhost/test-only domain or long TTL policy.
6. Successful verification **consumes** the nonce (`consumed_at`, `consumed_wallet_id`).
7. Primary-wallet change **security-invalidates** outstanding open challenges (`invalidated_at`, `invalidation_reason = PRIMARY_WALLET_CHANGED`) via migration `0016`.

Raw nonce is never logged and never placed in audit/outbox payloads.

## ton_proof verification

Library/algorithm (official TON Connect):

```text
message = utf8("ton-proof-item-v2/")
        ++ workchain_be32
        ++ address_hash_32
        ++ domain_len_le32
        ++ domain_utf8
        ++ timestamp_le64
        ++ payload

digest = sha256(0xffff ++ utf8("ton-connect") ++ sha256(message))
Ed25519.verify(digest, signature, publicKey)
```

Additional server checks:

- expected domain is **server-configured** (`expectedTonProofDomain`) — never Host/Origin/Telegram URL;
- domain `lengthBytes` must equal UTF-8 byte length of `domain.value`;
- proof timestamp within `maxProofAgeSeconds` / `maxFutureSkewSeconds`;
- payload must match the server-issued challenge (located by hash);
- signature length/encoding;
- StateInit hash must equal account address hash;
- public key extracted from known Wallet V3R2 / V4 / V5R1 StateInit only — unknown code **FAIL CLOSED** (`INVALID_WALLET`);
- optional client-claimed public key must match extracted key;
- declared TON Connect network (`-239` / `-3`) must match server-selected accepted network.

## Network validation

`ton_proof` does **not** cryptographically bind TON network. Network acceptance is separate:

- resolve `networks` by deployment `acceptedNetworkCode`;
- require `chain = TON`, `status = ACTIVE`, environment allowed for this deployment;
- require configured `global_chain_identifier`;
- map identifier → TON Connect network id (`ton:testnet` → `-3`, `ton:mainnet` → `-239`);
- account.network must equal that id.

Never infer MAINNET/TESTNET solely from friendly-address flags.

## Address canonicalization

Server derives deterministic:

- `raw_address` = `workchain:hex` (lowercase)
- `friendly_address` = bounceable URL-safe form

Bounceable / non-bounceable / URL-safe / base64 variants of the same account must not create duplicate logical wallets (`UNIQUE (user_id, network_id, raw_address)`).

## Primary wallet lifecycle

- First verified wallet on a network may become primary atomically (user row locked). This is **not** a wallet change — no 24h cooldown.
- Changing primary A → B requires a **fresh** ton_proof for B.
- Inside one PostgreSQL transaction: lock user; verify B; demote A; promote B; set `users.primary_wallet_changed_at`; set `users.withdrawal_cooldown_until = now + 24h`; consume nonce; invalidate open challenges; append `PRIMARY_WALLET_CHANGED` audit + outbox; commit.
- Re-proof of the current primary refreshes verification only — does **not** restart cooldown.
- Membership (STANDARD / FOUNDER_LIFETIME / future premium) never bypasses proof, nonce, domain, network, replay protection, or cooldown.

## Concurrency

Real PostgreSQL tests prove:

- concurrent same nonce → one success, other `REPLAY`;
- concurrent same wallet → one row;
- concurrent first-wallet proofs → one primary;
- concurrent primary changes → one active primary;
- failed switch rolls back wallet/cooldown/nonce/audit together.

## Redis

Redis may throttle challenge/verify abuse. Redis is **never** wallet ownership authority. Redis loss must not turn an invalid proof into an accepted proof.

## Non-goals (Phase 7+)

Withdrawal quotes, Available→Reserved, fees/limits/approvals, Temporal payout, fake chain, Jetton transfer, signer/KMS, Hot Wallet dispatch.
