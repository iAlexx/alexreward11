/**
 * Phase 21 operational ceremony APPLY gates.
 *
 * PLAN is read-only and does not require these gates.
 * APPLY requires ALL of:
 *   - DEPLOYMENT_ENV=production (staging refuses APPLY)
 *   - PHASE21_OPERATIONAL_CEREMONY_ENABLED=true
 *   - tool-specific APPLY=1 env
 *   - PHASE21_CEREMONY_REQUIRED_DATABASE_NAME matches current_database()
 *   - PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER matches pg_control_system()
 *
 * Never accept a forceApply argument. Tests set process.env (and restore).
 */
export const PHASE21_CEREMONY_REQUIRED_DATABASE_NAME_ENV =
  'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME' as const;

export const PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER_ENV =
  'PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER' as const;

export const PHASE21_OPERATIONAL_CEREMONY_ENABLED_ENV =
  'PHASE21_OPERATIONAL_CEREMONY_ENABLED' as const;

export type Phase21CeremonyApplyTool =
  | 'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY'
  | 'PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY'
  | 'PHASE21_HOT_WALLET_REGISTER_APPLY';

export interface Phase21CeremonyApplyGateClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface Phase21CeremonyApplyGateResult {
  readonly ok: true;
  readonly deploymentEnv: 'production';
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly toolApplyEnv: Phase21CeremonyApplyTool;
}

export class Phase21CeremonyApplyGateError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21CeremonyApplyGateError';
    this.code = code;
    this.details = details;
  }
}

function readEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return '';
  return raw.trim();
}

/**
 * Verify APPLY env gates + exact DB identity.
 * Throws Phase21CeremonyApplyGateError on refuse.
 */
export async function assertPhase21CeremonyApplyGates(
  client: Phase21CeremonyApplyGateClient,
  toolApplyEnv: Phase21CeremonyApplyTool,
): Promise<Phase21CeremonyApplyGateResult> {
  const deploymentEnv = readEnv('DEPLOYMENT_ENV').toLowerCase();
  if (deploymentEnv === 'staging') {
    throw new Phase21CeremonyApplyGateError(
      'STAGING_APPLY_FORBIDDEN',
      'Phase 21 ceremony APPLY is forbidden when DEPLOYMENT_ENV=staging',
      { deploymentEnv },
    );
  }
  if (deploymentEnv !== 'production') {
    throw new Phase21CeremonyApplyGateError(
      'DEPLOYMENT_ENV_NOT_PRODUCTION',
      'Phase 21 ceremony APPLY requires DEPLOYMENT_ENV=production',
      { deploymentEnv: deploymentEnv === '' ? null : deploymentEnv },
    );
  }

  if (readEnv(PHASE21_OPERATIONAL_CEREMONY_ENABLED_ENV) !== 'true') {
    throw new Phase21CeremonyApplyGateError(
      'OPERATIONAL_CEREMONY_GATE_REQUIRED',
      'Phase 21 ceremony APPLY requires PHASE21_OPERATIONAL_CEREMONY_ENABLED=true',
      { operationalCeremonyEnabled: false },
    );
  }

  if (readEnv(toolApplyEnv) !== '1') {
    throw new Phase21CeremonyApplyGateError(
      'TOOL_APPLY_GATE_REQUIRED',
      `Phase 21 ceremony APPLY requires ${toolApplyEnv}=1`,
      { toolApplyEnv, value: readEnv(toolApplyEnv) || null },
    );
  }

  const required = readEnv(PHASE21_CEREMONY_REQUIRED_DATABASE_NAME_ENV);
  if (required.length === 0) {
    throw new Phase21CeremonyApplyGateError(
      'REQUIRED_DATABASE_NAME_MISSING',
      'Phase 21 ceremony APPLY requires PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
      {},
    );
  }

  const result = await client.query<{ name: string }>(`SELECT current_database() AS name`);
  const current = result.rows[0]?.name;
  if (current === undefined || current.trim() === '') {
    throw new Phase21CeremonyApplyGateError(
      'CURRENT_DATABASE_UNAVAILABLE',
      'current_database() returned no row',
      {},
    );
  }
  if (current !== required) {
    throw new Phase21CeremonyApplyGateError(
      'DATABASE_IDENTITY_MISMATCH',
      'connected database does not match PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
      { required, current },
    );
  }

  const requiredSid = readEnv(PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER_ENV);
  if (requiredSid.length === 0) {
    throw new Phase21CeremonyApplyGateError(
      'REQUIRED_SYSTEM_IDENTIFIER_MISSING',
      'Phase 21 ceremony APPLY requires PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER',
      {},
    );
  }

  const sidResult = await client.query<{ sid: string }>(
    `SELECT system_identifier::text AS sid FROM pg_control_system()`,
  );
  const currentSid = sidResult.rows[0]?.sid;
  if (currentSid === undefined || currentSid.trim() === '') {
    throw new Phase21CeremonyApplyGateError(
      'SYSTEM_IDENTIFIER_UNAVAILABLE',
      'pg_control_system() returned no system_identifier',
      {},
    );
  }
  if (currentSid !== requiredSid) {
    throw new Phase21CeremonyApplyGateError(
      'SYSTEM_IDENTIFIER_MISMATCH',
      'cluster system_identifier does not match PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER',
      { required: requiredSid, current: currentSid },
    );
  }

  return {
    ok: true,
    deploymentEnv: 'production',
    databaseName: current,
    systemIdentifier: currentSid,
    toolApplyEnv,
  };
}

/**
 * @internal Test-only: set env gates; never a production forceApply argument.
 * Caller must restore previous env in afterEach.
 */
export function __phase21TestSetApplyEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}
