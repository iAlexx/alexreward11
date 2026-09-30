import type {
  AdminAdsProviderStatus,
  AdminAuthSessionIssued,
  AdminDomainEnvelope,
  AdminEconomicsSnapshot,
  AdminFeatureFlagsListData,
  AdminFraudEvidenceData,
  AdminHotWalletPublicView,
  AdminListPage,
  AdminListQuery,
  AdminOverviewSnapshot,
  AdminPolicyRuleSummary,
  AdminReauthResult,
  AdminSessionResponse,
  AdminSystemHealthData,
  AdminSystemHealthItem,
  AdminUserListItem,
  AdminWebAuthnOptionsResponse,
  AdminWithdrawalListItem,
  AuthenticationResponseJSON,
} from './types';

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export type AdminApiClientOptions = {
  readonly baseUrl: string;
  readonly getBearerToken: () => string | null;
  readonly onUnauthorized?: () => void;
};

function resolveBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function errorCodeFromBody(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const code = (body as { error?: unknown }).error;
    if (typeof code === 'string' && code.trim() !== '') return code;
  }
  return 'UNKNOWN';
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return fallback;
}

function toQuery(params: AdminListQuery | Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === '' ? '' : `?${qs}`;
}

/**
 * Map transport / parallel-API gaps to an honest UNAVAILABLE envelope.
 * Never invents empty monetary zeros.
 */
export function unavailableEnvelope<T>(
  reasonCode = 'ENGINE_NOT_ENABLED',
  message = 'Admin API not available yet',
): AdminDomainEnvelope<T> {
  return {
    status: 'UNAVAILABLE',
    data: null,
    reasonCode,
    message,
  };
}

function isDomainEnvelope(body: unknown): body is AdminDomainEnvelope<unknown> {
  if (body === null || typeof body !== 'object' || !('status' in body)) {
    return false;
  }
  const status = Reflect.get(body, 'status');
  return typeof status === 'string';
}

function wrapAsEnvelope<T>(body: unknown): AdminDomainEnvelope<T> {
  if (isDomainEnvelope(body)) {
    return body as AdminDomainEnvelope<T>;
  }
  return {
    status: 'READY',
    data: body as T,
  };
}

export function createAdminApiClient(options: AdminApiClientOptions) {
  const base = resolveBaseUrl(options.baseUrl);

  async function requestRaw(
    path: string,
    init: RequestInit & { readonly auth?: boolean } = {},
  ): Promise<{ response: Response; body: unknown }> {
    const { auth = true, headers, ...rest } = init;
    const headerBag = new Headers(headers);
    if (!headerBag.has('Accept')) headerBag.set('Accept', 'application/json');
    if (rest.body !== undefined && !headerBag.has('Content-Type')) {
      headerBag.set('Content-Type', 'application/json');
    }
    if (auth) {
      const token = options.getBearerToken();
      if (token !== null && token.trim() !== '') {
        headerBag.set('Authorization', `Bearer ${token}`);
      }
    }

    const response = await fetch(`${base}${path}`, {
      ...rest,
      headers: headerBag,
      credentials: 'include',
    });
    const body = await parseJson(response);
    return { response, body };
  }

  async function request<T>(
    path: string,
    init: RequestInit & { readonly auth?: boolean } = {},
  ): Promise<T> {
    const { response, body } = await requestRaw(path, init);
    if (response.status === 204) {
      return undefined as T;
    }
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      throw new AdminApiError(
        response.status,
        errorCodeFromBody(body),
        errorMessageFromBody(body, `Request failed (${response.status})`),
        body,
      );
    }
    return body as T;
  }

  /**
   * Read-model fetch: 404/501/503 and network failures → UNAVAILABLE.
   * Does not invent zero balances when the payload is missing.
   */
  async function fetchDomain<T>(
    path: string,
    init: RequestInit & { readonly auth?: boolean } = {},
  ): Promise<AdminDomainEnvelope<T>> {
    try {
      const { response, body } = await requestRaw(path, init);
      if (response.status === 401) {
        options.onUnauthorized?.();
        throw new AdminApiError(401, 'UNAUTHENTICATED', 'Admin session required', body);
      }
      if (response.status === 404 || response.status === 501 || response.status === 503) {
        return unavailableEnvelope<T>(
          response.status === 503 ? 'READ_FAILED' : 'ENGINE_NOT_ENABLED',
          errorMessageFromBody(body, 'Admin domain unavailable'),
        );
      }
      if (!response.ok) {
        throw new AdminApiError(
          response.status,
          errorCodeFromBody(body),
          errorMessageFromBody(body, `Request failed (${response.status})`),
          body,
        );
      }
      return wrapAsEnvelope<T>(body);
    } catch (error) {
      if (error instanceof AdminApiError) throw error;
      return unavailableEnvelope<T>('READ_FAILED', 'Network or transport failure');
    }
  }

  return {
    // —— Auth (implemented) ——
    webauthnLoginOptions(
      body: {
        readonly email?: string | undefined;
        readonly adminUserId?: string | undefined;
      } = {},
    ): Promise<AdminWebAuthnOptionsResponse> {
      return request<AdminWebAuthnOptionsResponse>('/v1/admin/auth/webauthn/login/options', {
        method: 'POST',
        auth: false,
        body: JSON.stringify(body),
      });
    },

    webauthnLoginVerify(body: {
      readonly email?: string | undefined;
      readonly adminUserId?: string | undefined;
      readonly response: AuthenticationResponseJSON;
    }): Promise<AdminAuthSessionIssued> {
      return request<AdminAuthSessionIssued>('/v1/admin/auth/webauthn/login/verify', {
        method: 'POST',
        auth: false,
        body: JSON.stringify(body),
      });
    },

    loginPasswordTotp(body: {
      readonly email?: string | undefined;
      readonly adminUserId?: string | undefined;
      readonly password: string;
      readonly totpCode: string;
    }): Promise<AdminAuthSessionIssued> {
      return request<AdminAuthSessionIssued>('/v1/admin/auth/login/password-totp', {
        method: 'POST',
        auth: false,
        body: JSON.stringify(body),
      });
    },

    recoveryConsume(body: {
      readonly email?: string | undefined;
      readonly adminUserId?: string | undefined;
      readonly recoveryCode: string;
    }): Promise<AdminAuthSessionIssued> {
      return request<AdminAuthSessionIssued>('/v1/admin/auth/recovery/consume', {
        method: 'POST',
        auth: false,
        body: JSON.stringify(body),
      });
    },

    reauthPasswordTotp(body: {
      readonly password: string;
      readonly totpCode: string;
    }): Promise<AdminReauthResult> {
      return request<AdminReauthResult>('/v1/admin/auth/reauth/password-totp', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    reauthWebAuthnOptions(): Promise<AdminWebAuthnOptionsResponse> {
      return request<AdminWebAuthnOptionsResponse>('/v1/admin/auth/reauth/webauthn', {
        method: 'POST',
        body: JSON.stringify({ phase: 'options' }),
        headers: { 'X-Admin-WebAuthn-Phase': 'options' },
      });
    },

    reauthWebAuthnVerify(body: {
      readonly response: AuthenticationResponseJSON;
    }): Promise<AdminReauthResult> {
      return request<AdminReauthResult>('/v1/admin/auth/reauth/webauthn', {
        method: 'POST',
        body: JSON.stringify({ phase: 'verify', response: body.response }),
        headers: { 'X-Admin-WebAuthn-Phase': 'verify' },
      });
    },

    getSession(): Promise<AdminSessionResponse> {
      return request<AdminSessionResponse>('/v1/admin/auth/session');
    },

    logout(): Promise<{ sessionId: string; revoked: boolean }> {
      return request<{ sessionId: string; revoked: boolean }>('/v1/admin/auth/logout', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },

    prepareConfirmation(body: {
      readonly actionType: string;
      readonly resourceType: string;
      readonly resourceId: string;
      readonly expectedVersion: string;
      readonly payload: unknown;
    }): Promise<{
      confirmationId: string;
      expiresAt: string;
      payloadDigest: string;
      confirmationPhrase: string;
    }> {
      return request('/v1/admin/confirmations/prepare', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    confirmConfirmation(
      confirmationId: string,
      body: { readonly confirmationPhrase: string },
    ): Promise<{
      confirmationId: string;
      confirmedAt: string;
      expiresAt: string;
      payloadDigest: string;
    }> {
      return request(`/v1/admin/confirmations/${encodeURIComponent(confirmationId)}/confirm`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    // —— Parallel Admin domains (graceful UNAVAILABLE) ——
    getOverview(): Promise<AdminDomainEnvelope<AdminOverviewSnapshot>> {
      return fetchDomain<AdminOverviewSnapshot>('/v1/admin/overview');
    },

    listUsers(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<AdminUserListItem>>> {
      return fetchDomain<AdminListPage<AdminUserListItem>>(`/v1/admin/users${toQuery(query)}`);
    },

    getUser(userId: string): Promise<AdminDomainEnvelope<AdminUserListItem>> {
      return fetchDomain<AdminUserListItem>(`/v1/admin/users/${encodeURIComponent(userId)}`);
    },

    listWithdrawals(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<AdminWithdrawalListItem>>> {
      return fetchDomain<AdminListPage<AdminWithdrawalListItem>>(
        `/v1/admin/withdrawals${toQuery(query)}`,
      );
    },

    getHotWallet(): Promise<AdminDomainEnvelope<AdminHotWalletPublicView>> {
      return fetchDomain<AdminHotWalletPublicView>('/v1/admin/hot-wallet');
    },

    listLedger(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/ledger${toQuery(query)}`);
    },

    getAdsStatus(): Promise<AdminDomainEnvelope<{ providers: readonly AdminAdsProviderStatus[] }>> {
      return fetchDomain('/v1/admin/ads');
    },

    getRewardEngine(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/reward-engine${toQuery(query)}`);
    },

    getFraud(
      query: { readonly userId?: string } = {},
    ): Promise<AdminDomainEnvelope<AdminFraudEvidenceData>> {
      return fetchDomain<AdminFraudEvidenceData>(`/v1/admin/fraud${toQuery(query)}`);
    },

    ensureFraudReview(body: {
      readonly userId: string;
      readonly reason: string;
      readonly expectedVersion: string;
      readonly confirmationId: string;
      readonly summary?: string;
    }): Promise<{
      readonly contractVersion: string;
      readonly reviewCase: AdminFraudEvidenceData['liveFraudReviewCases'][number];
      readonly createdOrReused: 'CREATED' | 'REUSED';
      readonly ledgerWrite: false;
    }> {
      return request(`/v1/admin/fraud/${encodeURIComponent(body.userId)}/ensure-review`, {
        method: 'POST',
        body: JSON.stringify({
          reason: body.reason,
          expectedVersion: body.expectedVersion,
          confirmationId: body.confirmationId,
          summary: body.summary,
        }),
      });
    },

    getReferral(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/referral${toQuery(query)}`);
    },

    getSupport(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/support${toQuery(query)}`);
    },

    getNotifications(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/notifications${toQuery(query)}`);
    },

    getAudit(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/audit${toQuery(query)}`);
    },

    getSystemHealth(): Promise<AdminDomainEnvelope<AdminSystemHealthData>> {
      return fetchDomain('/v1/admin/system').then((envelope) => {
        if (envelope.status !== 'READY' || envelope.data === null) {
          return envelope as AdminDomainEnvelope<AdminSystemHealthData>;
        }
        const raw = envelope.data as Record<string, unknown>;
        const legacyRaw = Array.isArray(raw.components) ? raw.components : [];
        const systemRaw = Array.isArray(raw.systemComponents) ? raw.systemComponents : [];
        const alertsRaw = Array.isArray(raw.alerts) ? raw.alerts : [];
        const components: AdminSystemHealthItem[] = legacyRaw.map((row) => {
          const item = row as Record<string, unknown>;
          // Prefer Phase 18 name/state; fall back to component/status shapes.
          const name =
            typeof item.name === 'string'
              ? item.name
              : typeof item.component === 'string'
                ? item.component
                : 'unknown';
          const state =
            typeof item.state === 'string'
              ? item.state
              : typeof item.status === 'string'
                ? item.status
                : null;
          const detail =
            typeof item.detail === 'string'
              ? item.detail
              : typeof item.reasonCode === 'string'
                ? item.reasonCode
                : null;
          return { component: name, status: state, detail };
        });
        const mapped: AdminSystemHealthData = {
          components,
          systemComponents: systemRaw as AdminSystemHealthData['systemComponents'],
          alerts: alertsRaw as AdminSystemHealthData['alerts'],
          payoutDispatchPause: (raw.payoutDispatchPause ?? {
            flagKey: 'PAYOUT_DISPATCH_PAUSE',
            environment: 'UNKNOWN',
            enabled: null,
            reasonCode: 'SIGNAL_NOT_CONFIGURED',
            observedAt: new Date(0).toISOString(),
            authoritativeSource: 'feature_flags',
            autoUnpause: false,
          }) as AdminSystemHealthData['payoutDispatchPause'],
          financialAuthority: false,
          observedAt:
            typeof raw.observedAt === 'string' ? raw.observedAt : new Date().toISOString(),
          ...(typeof raw.contractVersion === 'string'
            ? { contractVersion: raw.contractVersion }
            : {}),
        };
        return {
          ...envelope,
          data: mapped,
        };
      });
    },

    getSettings(): Promise<AdminDomainEnvelope<Record<string, unknown>>> {
      return fetchDomain('/v1/admin/settings');
    },

    getMemberships(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/memberships${toQuery(query)}`);
    },

    getPolicyCenter(): Promise<AdminDomainEnvelope<{ rules: readonly AdminPolicyRuleSummary[] }>> {
      return fetchDomain('/v1/admin/policy');
    },

    getProviders(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/providers${toQuery(query)}`);
    },

    getProviderContracts(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/provider-contracts${toQuery(query)}`);
    },

    getCapabilities(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/capabilities${toQuery(query)}`);
    },

    getLimits(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/limits${toQuery(query)}`);
    },

    getCertification(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/certification${toQuery(query)}`);
    },

    getCountryRules(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/country-rules${toQuery(query)}`);
    },

    getSettlement(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/settlement${toQuery(query)}`);
    },

    getEconomics(): Promise<AdminDomainEnvelope<AdminEconomicsSnapshot>> {
      return fetchDomain('/v1/admin/economics');
    },

    getExposure(): Promise<AdminDomainEnvelope<Record<string, unknown>>> {
      return fetchDomain('/v1/admin/exposure');
    },

    getReviewQueue(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/review-queue${toQuery(query)}`);
    },

    getFeatureFlags(): Promise<AdminDomainEnvelope<AdminFeatureFlagsListData>> {
      return fetchDomain('/v1/admin/feature-flags');
    },

    mutateFeatureFlag(body: {
      readonly flagKey: string;
      readonly environment: string;
      readonly enabled: boolean;
      readonly reason: string;
      readonly expectedVersion: string;
      readonly confirmationId: string;
    }): Promise<{
      readonly flagKey: string;
      readonly environment: string;
      readonly enabled: boolean;
      readonly version: number;
    }> {
      return request('/v1/admin/feature-flags', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    getMissions(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/missions${toQuery(query)}`);
    },

    getNotificationCampaigns(
      query: AdminListQuery = {},
    ): Promise<AdminDomainEnvelope<AdminListPage<Record<string, unknown>>>> {
      return fetchDomain(`/v1/admin/notification-campaigns${toQuery(query)}`);
    },
  };
}

export type AdminApiClient = ReturnType<typeof createAdminApiClient>;
