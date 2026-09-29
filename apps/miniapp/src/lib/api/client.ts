import type {
  AccountDeletionRequestResponse,
  CreateSupportTicketRequest,
  CreateSupportTicketResponse,
  EarnSummaryResponse,
  HomeSummaryResponse,
  PatchUserSettingsRequest,
  PostSupportMessageRequest,
  PostSupportMessageResponse,
  ReferralsSummaryResponse,
  ReferralCodeResponse,
  SupportTicketDetailDto,
  SupportTicketsListResponse,
  TasksListResponse,
  TonProofBindRequest,
  TonProofBindResponse,
  TonProofChallengeResponse,
  UserBalancesResponse,
  UserSettingsResponse,
  WalletSummaryResponse,
} from '@alex-rewards/contracts';

import type { AuthSession, AuthUser } from '../auth/session-store';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export type ApiClientOptions = {
  readonly baseUrl: string;
  readonly getAccessToken: () => string | null;
  readonly onUnauthorized?: () => void;
  readonly refreshSession?: () => Promise<string | null>;
};

export interface TelegramAuthResponse {
  readonly user: AuthUser;
  readonly session: AuthSession;
}

export interface RefreshResponse {
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly sessionId: string;
}

export interface MembershipViewResponse {
  readonly active: boolean;
  readonly planCode: string | null;
  readonly status: string | null;
  readonly isFounder: boolean;
  readonly founderNumber: number | null;
  readonly source: string | null;
  readonly grantedAt: string | null;
  readonly claimedAt: string | null;
  readonly userStatus: string;
  readonly withdrawalStatus: string;
  readonly securityBypass: false;
  readonly entitlements: ReadonlyArray<{
    readonly code: string;
    readonly name: string;
    readonly valueType: string;
    readonly securityClassification: string;
    readonly description: string | null;
  }>;
}

export interface EntitlementsResponse {
  readonly entitlements: MembershipViewResponse['entitlements'];
  readonly securityBypass: false;
}

export interface FounderClaimResponse {
  readonly membershipId: string;
  readonly planCode: string;
  readonly founderNumber: number;
  readonly status: string;
  readonly claimedAt: string;
  readonly moneyIssued: false;
  readonly ledgerPostings: 0;
}

export interface AuthorizeAdSessionRequest {
  readonly providerCode: string;
  readonly assetId: string;
  readonly budgetPeriodId: string;
  readonly adUnitId?: string;
  readonly countryCode?: string;
}

export interface AuthorizeAdSessionResponse {
  readonly adSessionId: string;
  readonly rewardQuoteId: string;
  readonly providerId: string;
  readonly providerCode: string;
  readonly state: string;
  readonly expiresAt: string;
  readonly quotedAmountAtomic: string;
  readonly baseAmountAtomic: string;
  readonly membershipBonusAmountAtomic: string;
  readonly effectiveRequestLimit: number;
  readonly effectiveSuccessLimit: number;
}

export interface AttemptVerifyResponse {
  readonly adSessionId: string;
  readonly state: string;
  readonly issued: boolean;
  readonly alreadyRewarded: boolean;
  readonly monetary: {
    readonly eligible: boolean;
    readonly status: string;
    readonly reasonCodes: readonly string[];
  } | null;
  readonly reasonCodes: readonly string[];
  readonly baseAmountAtomic: string | null;
  readonly membershipBonusAmountAtomic: string | null;
  readonly pendingUntil: string | null;
}

export interface WithdrawalListItem {
  readonly id: string;
  readonly publicId: string;
  readonly userId: string;
  readonly quoteId: string;
  readonly state: string;
  readonly requestedAmountAtomic: string;
  readonly feeAmountAtomic: string;
  readonly netAmountAtomic: string;
  readonly priorityReview: boolean;
  readonly riskDecision: string | null;
  readonly workflowId: string | null;
}

export interface WithdrawalsListResponse {
  readonly withdrawals: readonly WithdrawalListItem[];
}

/** Server-authored withdrawal quote (fees/net/expiry — never computed in the Mini App). */
export interface WithdrawalQuoteResponse {
  readonly id: string;
  readonly userId: string;
  readonly assetId: string;
  readonly networkId: string;
  readonly primaryWalletId: string;
  readonly requestedAmountAtomic: string;
  readonly feeAmountAtomic: string;
  readonly netAmountAtomic: string;
  readonly basePlatformFeeAtomic: string;
  readonly membershipFeeDiscountBps: number;
  readonly feeRuleId: string;
  readonly feeRuleVersion: number;
  readonly limitRuleId: string;
  readonly limitRuleVersion: number;
  readonly priorityReview: boolean;
  readonly status: string;
  /** ISO-8601 string after JSON serialization. */
  readonly expiresAt: string;
}

export interface CreateWithdrawalRequest {
  readonly quoteId: string;
  readonly idempotencyKey: string;
}

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

export function createApiClient(options: ApiClientOptions) {
  const base = resolveBaseUrl(options.baseUrl);
  let refreshInFlight: Promise<string | null> | null = null;

  async function request<T>(
    path: string,
    init: RequestInit & { readonly auth?: boolean; readonly retryOnUnauthorized?: boolean } = {},
  ): Promise<T> {
    const { auth = true, retryOnUnauthorized = true, headers, ...rest } = init;
    const headerBag = new Headers(headers);
    if (!headerBag.has('Accept')) headerBag.set('Accept', 'application/json');
    if (rest.body !== undefined && !headerBag.has('Content-Type')) {
      headerBag.set('Content-Type', 'application/json');
    }
    if (auth) {
      const token = options.getAccessToken();
      if (token !== null && token.trim() !== '') {
        headerBag.set('Authorization', `Bearer ${token}`);
      }
    }

    const response = await fetch(`${base}${path}`, { ...rest, headers: headerBag });
    if (response.status === 401 && auth && retryOnUnauthorized && options.refreshSession) {
      if (refreshInFlight === null) {
        refreshInFlight = options.refreshSession().finally(() => {
          refreshInFlight = null;
        });
      }
      const nextToken = await refreshInFlight;
      if (nextToken !== null) {
        return request<T>(path, { ...init, retryOnUnauthorized: false });
      }
      options.onUnauthorized?.();
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const body = await parseJson(response);
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      throw new ApiError(
        response.status,
        errorCodeFromBody(body),
        errorMessageFromBody(body, `Request failed (${response.status})`),
        body,
      );
    }
    return body as T;
  }

  return {
    authTelegram(initData: string): Promise<TelegramAuthResponse> {
      return request<TelegramAuthResponse>('/v1/auth/telegram', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ initData }),
      });
    },

    refresh(refreshToken: string): Promise<RefreshResponse> {
      return request<RefreshResponse>('/v1/auth/refresh', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ refreshToken }),
      });
    },

    logout(): Promise<void> {
      return request<void>('/v1/auth/logout', { method: 'POST' });
    },

    getBalances(): Promise<UserBalancesResponse> {
      return request<UserBalancesResponse>('/v1/me/balances');
    },

    getHome(): Promise<HomeSummaryResponse> {
      return request<HomeSummaryResponse>('/v1/me/home');
    },

    getSettings(): Promise<UserSettingsResponse> {
      return request<UserSettingsResponse>('/v1/me/settings');
    },

    patchSettings(body: PatchUserSettingsRequest): Promise<UserSettingsResponse> {
      return request<UserSettingsResponse>('/v1/me/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },

    getMembership(): Promise<MembershipViewResponse> {
      return request<MembershipViewResponse>('/v1/membership');
    },

    getEntitlements(): Promise<EntitlementsResponse> {
      return request<EntitlementsResponse>('/v1/membership/entitlements');
    },

    claimFounder(claimCode: string): Promise<FounderClaimResponse> {
      // claimCode is never logged — only sent once in the request body.
      return request<FounderClaimResponse>('/v1/membership/founder/claim', {
        method: 'POST',
        body: JSON.stringify({ claimCode }),
      });
    },

    getEarnSummary(provider = 'ADSGRAM'): Promise<EarnSummaryResponse> {
      const query = new URLSearchParams({ provider });
      return request<EarnSummaryResponse>(`/v1/ads/earn-summary?${query.toString()}`);
    },

    authorizeAdSession(body: AuthorizeAdSessionRequest): Promise<AuthorizeAdSessionResponse> {
      return request<AuthorizeAdSessionResponse>('/v1/ads/sessions/authorize', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    attemptVerifyAdSession(adSessionId: string): Promise<AttemptVerifyResponse> {
      return request<AttemptVerifyResponse>(`/v1/ads/sessions/${adSessionId}/attempt-verify`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },

    getTasks(): Promise<TasksListResponse> {
      return request<TasksListResponse>('/v1/tasks');
    },

    claimTask(progressId: string): Promise<import('@alex-rewards/contracts').TaskClaimResponse> {
      return request(`/v1/tasks/${encodeURIComponent(progressId)}/claim`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },

    getReferralsSummary(): Promise<ReferralsSummaryResponse> {
      return request<ReferralsSummaryResponse>('/v1/referrals/summary');
    },

    getReferralCode(): Promise<ReferralCodeResponse> {
      return request<ReferralCodeResponse>('/v1/referrals/code');
    },

    getWallets(): Promise<WalletSummaryResponse> {
      return request<WalletSummaryResponse>('/v1/wallets');
    },

    createTonProofChallenge(): Promise<TonProofChallengeResponse> {
      return request<TonProofChallengeResponse>('/v1/wallets/ton-proof/challenge', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },

    bindTonProofWallet(body: TonProofBindRequest): Promise<TonProofBindResponse> {
      return request<TonProofBindResponse>('/v1/wallets/ton-proof/bind', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    getWithdrawals(): Promise<WithdrawalsListResponse> {
      return request<WithdrawalsListResponse>('/v1/withdrawals');
    },

    getWithdrawal(id: string): Promise<WithdrawalListItem> {
      return request<WithdrawalListItem>(`/v1/withdrawals/${encodeURIComponent(id)}`);
    },

    createWithdrawalQuote(amountAtomic: string): Promise<WithdrawalQuoteResponse> {
      return request<WithdrawalQuoteResponse>('/v1/withdrawals/quote', {
        method: 'POST',
        body: JSON.stringify({ amountAtomic }),
      });
    },

    cancelWithdrawalQuote(id: string): Promise<WithdrawalQuoteResponse> {
      return request<WithdrawalQuoteResponse>(
        `/v1/withdrawal-quotes/${encodeURIComponent(id)}/cancel`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
    },

    createWithdrawal(body: CreateWithdrawalRequest): Promise<WithdrawalListItem> {
      return request<WithdrawalListItem>('/v1/withdrawals', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    listSupportTickets(): Promise<SupportTicketsListResponse> {
      return request<SupportTicketsListResponse>('/v1/support/tickets');
    },

    createSupportTicket(body: CreateSupportTicketRequest): Promise<CreateSupportTicketResponse> {
      return request<CreateSupportTicketResponse>('/v1/support/tickets', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    getSupportTicket(ticketId: string): Promise<SupportTicketDetailDto> {
      return request<SupportTicketDetailDto>(`/v1/support/tickets/${ticketId}`);
    },

    postSupportMessage(
      ticketId: string,
      body: PostSupportMessageRequest,
    ): Promise<PostSupportMessageResponse> {
      return request<PostSupportMessageResponse>(`/v1/support/tickets/${ticketId}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    requestAccountDeletion(): Promise<AccountDeletionRequestResponse> {
      return request<AccountDeletionRequestResponse>('/v1/support/account-deletion-requests', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
