/**
 * Authenticated user support ticket contracts (Phase 12 remediation P12-03).
 *
 * Ownership isolation only: a user may create, list, read, and message their own tickets.
 * Account deletion is a review request (support ticket + append-only event), never ledger deletion.
 */

export type SupportTicketStateDto =
  'OPEN' | 'WAITING_USER' | 'WAITING_SUPPORT' | 'RESOLVED' | 'CLOSED';

export type SupportMessageAuthorTypeDto = 'USER' | 'ADMIN' | 'SYSTEM';

/** Reserved category for account deletion review requests. */
export const ACCOUNT_DELETION_REQUEST_CATEGORY = 'ACCOUNT_DELETION_REQUEST' as const;

export interface SupportTicketSummaryDto {
  readonly id: string;
  readonly publicId: string;
  readonly subject: string;
  readonly category: string | null;
  readonly state: SupportTicketStateDto;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastMessageAt: string | null;
}

export interface SupportMessageDto {
  readonly id: string;
  readonly authorType: SupportMessageAuthorTypeDto;
  readonly body: string;
  readonly createdAt: string;
}

export interface SupportTicketDetailDto extends SupportTicketSummaryDto {
  readonly messages: readonly SupportMessageDto[];
}

export interface CreateSupportTicketRequest {
  readonly subject: string;
  readonly category?: string | null;
  /** Optional opening message body; stored as a USER support_message when non-empty. */
  readonly body?: string | null;
}

export interface CreateSupportTicketResponse {
  readonly ticket: SupportTicketSummaryDto;
  readonly created: boolean;
}

export interface SupportTicketsListResponse {
  readonly tickets: readonly SupportTicketSummaryDto[];
}

export interface PostSupportMessageRequest {
  readonly body: string;
}

export interface PostSupportMessageResponse {
  readonly message: SupportMessageDto;
}

/**
 * Account deletion review request.
 * Requires an explicit confirmation ceremony; does not anonymize or mutate balances.
 */
export interface AccountDeletionRequestBody {
  /** Must be exactly `true` after the UI confirmation ceremony. */
  readonly confirmed: true;
}

export interface AccountDeletionRequestResponse {
  readonly ticket: SupportTicketSummaryDto;
  /** `true` when a new open request was created; `false` when an existing open request was returned. */
  readonly created: boolean;
}
