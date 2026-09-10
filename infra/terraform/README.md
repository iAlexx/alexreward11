# Terraform

Production Terraform remains reserved for later phases. This repository does **not** auto-apply
cloud resources for signer custody.

## Signer custody (v1.3) — self-hosted encrypted

Owner decision: AWS as production Hot Wallet signing custody is **OWNER REJECTED**. Production
target is `apps/signer` + self-hosted encrypted Ed25519 (`FALLBACK_ENCRYPTED`). Historical AWS
KMS Ed25519 compatibility evidence remains non-authoritative only.

**No signer-custody migration required** for infrastructure that already models
`FALLBACK_ENCRYPTED`.

When provisioning a signer host (documentation only — no committed cloud ARNs):

1. Dedicated signer compute with no public ingress to `/v1/sign-withdrawal-attempt`.
2. Workload auth (mTLS / equivalent) in staging+; bearer token only for local/test compatibility.
3. Encrypted key bundle file on a restricted path (`SIGNER_KEY_BUNDLE_PATH`); dual offline
   encrypted backups outside the live host.
4. Database: dedicated read-only login inheriting `alex_rewards_signer_ro` (no financial writes).
5. Egress: PostgreSQL read endpoint + approved observability; **no** TON RPC / broadcast egress;
   **no** AWS KMS requirement on the production path.
6. Future HSM/Vault: implement behind `SignPort` / `LockableSignPort` without widening trust to
   API/bot/worker.

Do not commit real account IDs, passphrase material, or plaintext seeds into this repo.
