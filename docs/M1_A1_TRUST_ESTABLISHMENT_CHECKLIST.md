# M1-A.1 Trust establishment checklist

**Overall:** `DESIGN READY — TRUST ESTABLISHMENT BLOCKED`

## A — Design complete

- [x] Option C grant: RFC 8785/JCS, strict schema, hard `exp`, iat skew (F2)
- [x] Stolen-grant defense: Owner-bound redemption PoP (F1)
- [x] Challenge lifecycle + enrollment ticket + final short TX (P1)
- [x] Enrollment-channel key binding across attempt / PoP / credentials (P1)
- [x] Final credential-request binding (FinalCredReq; anti-substitution) (P1)
- [x] External seal root + dual-channel provenance (F3)
- [x] TLS: mandatory chain + hostname + Owner CA; optional SPKI add-on only (P2)
- [x] Default-deny vs narrow redeem path documented
- [x] Local test-only keys ≠ production trust establishment (clarified)
- [ ] Independent design review acceptance of FinalCredReq remediation

## B — Trust anchor independently established (BLOCKED)

- [x] Owner confirms Option C
- [ ] Witnessed ceremony + offline keypair
- [ ] Ceremony **seal** recorded (pubkey + profile digest + witnesses)
- [ ] Dual-channel production provenance installed
- [ ] Private key absent from git/CI/app/review ZIPs
- [ ] Owner-approved TLS CA trust anchor + `tls_server_name` recorded
- [x] Optional SPKI add-on decided (yes/no); never as chain/hostname substitute — **NO for v1** (Owner 2026-09-22)
- [ ] Infra privileged-DB controls acknowledged
- [ ] PoP redeem + channel-bound ticket procedure drilled (paper)

## C — Local implementation ready (Stage B — local only)

May be **separately authorized** using **ephemeral disposable test-only keys** on
isolated DBs. Completing C **must not** check any **B** or **D** box.

- [x] Explicit Owner text authorizing Stage B local implementation
- [x] Code + migrations + adversarial tests (incl. F1/P1 channel-binding / FinalCredReq)
- [x] JCS/parser/time/PoP/TLS/channel vectors green (isolated_test)
- [x] M0 / Owner-auth regressions green (Stage B evidence)
- [ ] Independent review acceptance of Stage B local implementation

## D — Operational enrollment separately authorized

- [ ] Production seal derivatives installed
- [ ] Explicit Owner go-live for first redeem
- [ ] Separate approval to lift general Owner-auth default-deny for login
- [ ] Owner-approved operational application of migrations **0024–0028** (not
      authorized by local Stage B or by isolated rehearsal alone)

### D.1 — Mandatory preflight before operational migration **0028**

Before any future **Owner-authorized** operational apply of
`0028_owner_bootstrap_attempt_nonce_attempt_wide`, run this **read-only**
duplicate check on the target operational database (Owner-approved connection
only; this checklist item does **not** authorize that connection by itself):

```sql
SELECT attempt_id, nonce_hex, count(*) AS purposes
FROM owner_bootstrap_attempt_nonces
GROUP BY attempt_id, nonce_hex
HAVING count(*) > 1;
```

**Decision rule (Owner must approve the outcome before migrate):**

| Result | Rule |
| --- | --- |
| **ZERO ROWS** | Nonce-conflict preflight **passes**. This does **not** authorize migration 0028 by itself — separate Owner migrate authorization and the rest of Checklist **D** remain required. |
| **ONE OR MORE ROWS** | **BLOCK** migration 0028. Require a **separate** Owner-approved investigation and resolution procedure. |

**Forbidden:** never automatically delete, rewrite, or deduplicate existing
`owner_bootstrap_attempt_nonces` rows to force 0028 to apply.

**Isolated rehearsal evidence (non-operational; 2026-09-22):** disposable
PostgreSQL 18 rehearsal only — **operational database was not touched.**

- Clean upgrade path **0023 → 0028:** **PASS**
- Legacy synthetic cross-purpose duplicate nonces (pre-0028 PK): **expected
  migration failure** (`23505` / could not create unique index)
- Failed 0028 attempt on that legacy fixture: schema remained at **0027** head
  (transactional; no partial 0028 apply)

## Forbidden until D

Operational enrollment; real ops grants; ops private keys in any archive;
broad default-deny disable; operational migrate of 0024–0028 without Owner
authorization and (for 0028) without a passing D.1 preflight decision.

## Phase 21 Step 4A update

Source scaffolding for `production_sealed_v1` is present. Checklist items for witnessed production seal, Owner CA, Channel B install, and Layer C/D provenance auth remain **OPEN / BLOCKED** for operational go-live.
