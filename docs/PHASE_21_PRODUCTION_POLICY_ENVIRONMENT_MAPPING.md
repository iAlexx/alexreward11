# Phase 21 — Production Policy Environment Mapping

**Status:** Audit of source scoping (accurate to Step 3A codebase)

## Feature flags

eature_flags rows are scoped by environment_name enum: LOCAL | DEV | STAGING | PRODUCTION.
Kill switches such as WITHDRAWAL_REQUESTS_PAUSE / PAYOUT_DISPATCH_PAUSE are evaluated against the
runtime deployment environment mapped from DEPLOYMENT_ENV.

Implication: a STAGING-scoped pause row does **not** protect a process running with
DEPLOYMENT_ENV=production. PRODUCTION baseline rows must exist before cutover.

## Risk / Trust / Eligibility policy versions

- 
isk_rule_versions, 	rust_rule_versions, and eligibility_policy_versions are **not**
  environment-column scoped. Resolvers select the single ACTIVE version by effective window.
- Eligibility evaluation **does** use serverContext.deploymentEnvironment when reading
  feature-flag bindings (e.g. pause / provider gates) — those bindings are environment-scoped.
- Therefore Risk/Trust ACTIVE policy content is global to the database, while flag-gated
  eligibility outcomes follow DEPLOYMENT_ENV.

## Wallet / network acceptance


esolveAcceptedTonNetwork uses deploymentEnvironment vs network.environment:

| DEPLOYMENT_ENV mapping | Allowed network.environment |
| --- | --- |
| LOCAL / DEV | TESTNET or MAINNET |
| STAGING | TESTNET only |
| PRODUCTION | MAINNET only |

## Withdrawal engine

Withdrawal engine config maps DEPLOYMENT_ENV local|test|staging|production to
LOCAL|DEV|STAGING|PRODUCTION for flag and pause checks.

## Cutover note

Changing only Railway service labels without changing DEPLOYMENT_ENV does not change policy
environment. Changing DEPLOYMENT_ENV without PRODUCTION flag rows fails closed for pauses
(Step 3A request-pause + existing payout-pause behavior).
