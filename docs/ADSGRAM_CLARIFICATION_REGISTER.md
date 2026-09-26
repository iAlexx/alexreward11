# AdsGram clarification register

**AdsGram production monetary issuance is BLOCKED.** This register is the auditable list of the
unresolved provider questions that keep it blocked. It is not documentation of a future intent:
the rows below exist in `provider_clarification_items`, the monetary gate counts them, and while
the count is non-zero the gate refuses money with `OPEN_CLARIFICATION_ITEMS`.

Authoritative data, seeded by migration `0030_phase11_adsgram_foundation.sql`:

| Field                        | Value                                |
| ---------------------------- | ------------------------------------ |
| Provider code                | `ADSGRAM`                            |
| `production_monetary_status` | `BLOCKED`                            |
| `policy_status`              | `BLOCKED_PENDING_CLARIFICATION`      |
| Open clarification items     | 6                                    |
| Reward URL authenticity      | none (`authenticationMethod = NONE`) |
| Custom nonce echo            | not supported                        |

## Open items

| #   | Item code                     | Question                                                                                    | Why it blocks money                                                                                                     |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | `REWARD_URL_AUTHENTICITY`     | Is the Reward URL cryptographically signed, and with what scheme and key rotation?          | An unsigned callback is an unauthenticated internet request; anyone who learns the URL shape could assert a completion. |
| 2   | `SESSION_CORRELATION`         | Does the provider return an unambiguous per-impression identity we can bind to one session? | Without it, evidence cannot be tied to exactly one quote, so issuance could pay the wrong session.                      |
| 3   | `RETRY_SEMANTICS`             | What are the documented retry and idempotency guarantees for Reward URL delivery?           | Undocumented retries make replay indistinguishable from a second legitimate reward.                                     |
| 4   | `DELIVERY_WINDOW`             | What delivery window and ordering guarantees apply to server signals?                       | Late or out-of-order signals arriving after expiry cannot be safely priced.                                             |
| 5   | `PROVIDER_SIDE_REQUEST_LIMIT` | Is request counting authoritative provider-side, and how is it proven to us?                | Browser-asserted request counts are client evidence, which carries no authority.                                        |
| 6   | `MODERATION_COMPLIANCE`       | What is the evidence for Adult/Gambling disablement and moderation approval?                | Compliance posture must be evidenced before cash-equivalent rewards fund the inventory.                                 |

## What Phase 11 does instead

Phase 11 makes AdsGram fully observable without paying for it. Sessions authorize, the official
SDK plays real inventory, and the Reward URL is ingested, stored and correlated — as
`UNVERIFIED` evidence that credits nothing. `phase11-certification.test.ts` TEST 14 asserts this
directly: a complete, correlated AdsGram session with full evidence is still refused, reporting
all five applicable gate reason codes and writing a `MONETARY_GATE_BLOCKED` signal, with zero
ledger transactions.

## Unblocking procedure

Approval is a data change reviewed by the Owner, never a code change:

1. Obtain written provider answers and attach them to each item.
2. Set the items to `RESOLVED` (or `WAIVED` with a recorded Owner decision).
3. Update `ad_provider_capabilities` to reflect the confirmed authentication and correlation
   capabilities.
4. Set `policy_status` and `production_monetary_status` to the Owner-approved values.
5. Re-run the certification harness; `productionMonetaryApprovalRecommended` must be true on
   evidence, with no skipped mandatory case.

Until every step above is complete, the gate refuses. Nothing in the application needs to be
changed to keep it refusing — that is the point.
