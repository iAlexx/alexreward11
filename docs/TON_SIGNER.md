# TON Testnet Signer Spike (Phase 9)

Authority: `docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.2.md`

## Boundary

- Only `apps/signer` may import `@aws-sdk/client-kms` and invoke `kms:Sign`.
- Domain logic lives in `@alex-rewards/signing` (no AWS SDK import).
- Caller may send **only** `withdrawalAttemptId`.
- Signer independently loads `signer_withdrawal_attempt_signing_v` and reconstructs canonical Wallet V5 R1 / TEP-74 intent.
- Signer has **no** financial DB writes, **no** public ingress, **no** TON RPC/broadcast.

## KMS message bytes

KMS signs the **32-byte Cell hash** of the Wallet V5 R1 external signing message:

- SigningAlgorithm: `ED25519_SHA_512`
- MessageType: `RAW`
- KeySpec: `ECC_NIST_EDWARDS25519`

Local verification uses `@ton/crypto` `verify(hash, signature, publicKey)`.

## Config

- `SIGNER_KMS_MODE=aws|local_ephemeral` (`local_ephemeral` is local/test only; does **not** satisfy formal gate)
- `SIGNER_KMS_KEY_ARN` exact key ARN (no `AWS_KMS_KEY_ID` aliases)
- `SIGNER_NETWORK_GLOBAL_ID=-3` (TESTNET). MAINNET `-239` rejected.

## Jetton wallet identity

`hot_wallets.payout_jetton_wallet_address` is a deployment-controlled snapshot. Signer never derives it via TON RPC.

## Phase 7 fake attempts

`canonical_message_hash` values starting with `fake-hash:` are **rejected**.

## Formal KMS spike

If you have AWS credentials but no spike key yet:

```bash
SIGNER_AWS_REGION=... pnpm provision:kms-spike-key
# prints SIGNER_KMS_KEY_ARN for a TEST/SPIKE ECC_NIST_EDWARDS25519 key (not Mainnet)
```

Then run the formal spike:

```bash
SIGNER_AWS_REGION=... SIGNER_KMS_KEY_ARN=arn:aws:kms:...:key/... pnpm spike:kms
```

Owner/CI-manual (repository secrets + workflow dispatch):

1. Configure GitHub secrets: `SIGNER_AWS_REGION`, `SIGNER_KMS_KEY_ARN`,
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (optional `AWS_SESSION_TOKEN`).
2. Run workflow **Phase 9 KMS Spike** against the exact candidate SHA
   (`7d8cb06e18f319271750d9378dc7cb5a5a9f8178` while that tip remains the CI-green candidate).
3. Evidence artifact: redacted `kms-spike-report.json` (no credentials).

If AWS credentials/key are unavailable:

`PHASE 9 BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE`

## §34.2 split

Completed in Phase 9 (compatibility/signing boundary): public key retrieval, Wallet V5 R1 derivation, canonical bytes, KMS sign + local verify (when real spike runs).

Deferred to Phase 10: broadcast, chain watcher, crash-after-broadcast, Jetton confirmation runs, provider reconciliation.
