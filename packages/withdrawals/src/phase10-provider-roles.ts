/**
 * Compatibility re-exports for the authoritative Phase 10 live provider-role
 * resolver (implemented in phase10-live-probes.ts alongside fingerprinting).
 */

export {
  parsePhase10AcceptanceCutoff,
  resolvePhase10LiveProviderRoles,
  type Phase10LiveProviderKind,
  type Phase10LiveProviderRoleEndpointInput,
  type Phase10LiveProviderRolesResolveResult,
  type Phase10ResolvedLiveProviderRole,
  type Phase10ResolvedLiveProviderRoles,
} from './phase10-live-probes.js';
