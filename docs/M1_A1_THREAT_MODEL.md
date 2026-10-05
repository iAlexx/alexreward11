# M1-A.1 Threat model — Secure first-Owner bootstrap (Option C)

**Status:** DESIGN (F1–F3 + P1/P2 + channel-binding + FinalCredReq).
**Label:** `DESIGN READY — TRUST ESTABLISHMENT BLOCKED`.

## Assets

- Right to be sole control-plane Owner.
- Offline bootstrap private key.
- Ceremony seal (external root) + derivative trust store.
- Endpoint TLS identity (chain + hostname + Owner CA; optional SPKI add-on).
- Challenge state / enrollment tickets (after PoP).
- Ephemeral enrollment-channel private key (`channel_sk`, process-memory only).
- Password verifiers, TOTP seeds, session tokens.
- M0 seat integrity.
- Unconsumed grant files (sensitive but **insufficient alone**).

## Adversaries

| ID | Adversary | Goal |
| --- | --- | --- |
| T1 | Internet attacker | Public OWNER registration |
| T2 | App operator | Enroll without OOB key |
| T3 | Least-priv DB role | SQL insert OWNER |
| T4 | DB superuser | Direct mutation |
| T5 | Thief of **grant file only** | Redeem before Owner (F1) |
| T5b | Thief of PoP response / ticket | Register credentials from another channel |
| T5c | Race winner with stolen PoP, no channel key | Obtain ticket / complete enroll |
| T5d | Substitutes password/TOTP/identity under captured ticket+sig | Activate with attacker-chosen credentials |
| T6 | Thief of offline private key | Mint grants + PoP |
| T7 | MITM on DB link | Redirect to attacker DB |
| T8 | Deploy operator | Replace trust store **and** local checksum |

## Controls

| Threat | Control |
| --- | --- |
| T1 | No public OWNER route; default-deny |
| T2 | Grant sig + **PoP challenge** + seal-matched pin + channel binding |
| T3 | Least-privilege roles |
| T4 | Infrastructure privileged-access controls (crypto cannot fully stop) |
| T5 | **F1:** redemption Ed25519 PoP over verifier challenge; grant possession insufficient |
| T5b / T5c | **P1 channel-binding:** ephemeral `channel_sk`; `channel_fp` in Owner bytes; `sig_channel_pop`; ticket bound to `channel_fp` |
| T5d | **FinalCredReq:** `sig_channel_cred` over JCS header + password/TOTP tails; verifier reconstructs; substitution fails closed |
| T6 | Offline custody; revocation; witnessed seal |
| T7 | **P2:** mandatory TLS chain + hostname + Owner trust anchor; optional SPKI add-on only; fail closed; no SPKI-for-chain substitute; no downgrade |
| T8 | Dual-channel seal match; fail closed if Channel B unsatisfied |

## Explicit non-controls (do not mistake for claimant auth)

Grant expiry, nonce uniqueness, M0 seat locking, email, `subject_display`,
Telegram id, DB name, cluster id, ops confirm literal, ticket possession without
channel private key.

## Residual protocol risks (accurate)

- Stolen **complete PoP** first-use race → attempt DoS to `VERIFIED`, **not**
  unauthorized Owner activation (still needs FinalCredReq / `channel_sk`).
- Stolen **complete final credential request** first-use race → may activate with
  captured credentials. Client `nonce32` uniqueness does **not** prevent that
  race; it only blocks post-accept replay.
- Production superuser compromise and dual-channel failure modes require Owner
  acceptance before state **D** (operational enrollment).
