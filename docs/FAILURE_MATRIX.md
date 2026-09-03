# Phase 1 failure matrix

| Failure                                      | Expected behavior                                                | Verification            |
| -------------------------------------------- | ---------------------------------------------------------------- | ----------------------- |
| Missing/invalid environment value            | Process exits before listening                                   | Config unit tests       |
| PostgreSQL unavailable                       | API readiness is `503`; liveness remains responsive              | Docker smoke/fault test |
| Redis unavailable                            | API readiness is `503`; liveness remains responsive              | Docker smoke/fault test |
| Temporal unavailable                         | API/Worker readiness is `503`; no financial fallback exists      | Docker smoke/fault test |
| Telegram token absent in disabled local mode | Bot boots explicitly disabled                                    | Bot tests and smoke     |
| Telegram token absent in enabled mode        | Bot fails before listening                                       | Config unit tests       |
| KMS configuration supplied to Phase 1 Signer | Signer fails before listening                                    | Config unit tests       |
| OTLP collector unavailable                   | Application continues; telemetry export reports non-secret error | Unit/smoke checks       |
| Shutdown signal                              | Listener closes and clients/workers drain                        | Lifecycle tests/smoke   |
| Secret-like material committed               | CI secret scan fails                                             | Security job            |
| Forbidden app/package dependency             | CI boundary check fails                                          | Architecture job        |
