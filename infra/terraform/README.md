# Terraform

Production Terraform remains reserved for later phases. Phase 9 does **not** auto-apply cloud
resources from this repository.

## Phase 9 — Testnet signer spike IAM shape (documentation only)

When the Owner provisions a TEST/SPIKE AWS environment for the formal KMS gate:

1. Create a non-exportable KMS key:
   - KeySpec: `ECC_NIST_EDWARDS25519`
   - KeyUsage: `SIGN_VERIFY`
   - No Mainnet payout key; spike/test only
2. Attach an IAM task role used **only** by `apps/signer` with least privilege:
   - `kms:Sign`
   - `kms:GetPublicKey`
   - `kms:DescribeKey`
   - Resource: the exact spike key ARN
3. Deny / omit `kms:Sign` on API, Bot, Admin, Worker, Mini App, and payout-dispatcher roles.
4. Signer service networking:
   - private service (no public load-balancer route to `/v1/sign-withdrawal-attempt`)
   - workload auth (mTLS / equivalent) in staging+; bearer token only for local/test compatibility
5. Database:
   - dedicated read-only login inheriting `alex_rewards_signer_ro`
   - no INSERT/UPDATE/DELETE on financial tables
6. Egress:
   - PostgreSQL read endpoint
   - AWS KMS endpoint
   - approved observability
   - **no** TON RPC / broadcast egress

Do not commit real AWS account IDs or production ARNs into this repo. Pass spike values via
environment / secret store at execution time:

```bash
SIGNER_AWS_REGION=...
SIGNER_KMS_KEY_ARN=arn:aws:kms:region:account:key/uuid
pnpm spike:kms
```
