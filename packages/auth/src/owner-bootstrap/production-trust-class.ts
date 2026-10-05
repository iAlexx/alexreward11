/**
 * Production Owner-bootstrap trust class (Phase 21 Step 4A).
 * Must never be inferred from NODE_ENV / DB name / Railway env alone.
 */
export const PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS = 'production_sealed_v1' as const;
export type ProductionOwnerBootstrapTrustClass =
  typeof PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS;

export const ISOLATED_OWNER_BOOTSTRAP_TRUST_CLASS = 'ephemeral_isolated_test_only' as const;