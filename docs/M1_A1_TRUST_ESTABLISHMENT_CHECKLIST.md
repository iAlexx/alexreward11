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

## Forbidden until D

Operational enrollment; real ops grants; ops private keys in any archive;
broad default-deny disable.
