/**
 * Phase 21 Step 4B.2 - strict APPLY readiness gate over the authenticated read-only preflight.
 * The CLI must stop BEFORE any mutation unless every field below holds.
 */
import { AuthDomainError } from '../errors.js';
import type { ProductionOwnerBootstrapPreflightOnlyResult } from './production-preflight-only.js';

export const APPLY_PREFLIGHT_NOT_READY = 'APPLY_PREFLIGHT_NOT_READY';

export function listApplyPreflightBlockers(
  result: ProductionOwnerBootstrapPreflightOnlyResult,
): string[] {
  const blockers: string[] = [];
  if (result.trustAuthenticated !== true) blockers.push('trustAuthenticated');
  if (result.tlsEndpointVerified !== true) blockers.push('tlsEndpointVerified');
  if (result.schemaReady !== true) blockers.push('schemaReady');
  if (result.ownerSeatReady !== true) blockers.push('ownerSeatReady');
  if (result.targetAdminReady !== true) blockers.push('targetAdminReady');
  if (result.targetAdminSecurityState !== 'CLEAN') blockers.push('targetAdminSecurityState');
  if (result.ownerKeyBackupsReady !== true) blockers.push('ownerKeyBackupsReady');
  if (result.readyForOwnerBootstrapApply !== true) blockers.push('readyForOwnerBootstrapApply');
  if (result.refuseCode !== null) blockers.push('refuseCode');
  if (result.operationalDbMutation !== false) blockers.push('operationalDbMutation');
  return blockers;
}

/** Throws APPLY_PREFLIGHT_NOT_READY (no mutation has happened) unless fully READY. */
export function assertApplyPreflightReady(
  result: ProductionOwnerBootstrapPreflightOnlyResult,
): void {
  const blockers = listApplyPreflightBlockers(result);
  if (blockers.length > 0) {
    throw new AuthDomainError(
      'FORBIDDEN',
      `${APPLY_PREFLIGHT_NOT_READY}: ${blockers.join(',')}${
        result.refuseCode !== null ? ` (refuse=${result.refuseCode})` : ''
      }`,
    );
  }
}
