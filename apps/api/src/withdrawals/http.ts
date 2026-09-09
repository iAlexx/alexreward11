import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { WithdrawalDomainError } from '@alex-rewards/withdrawals';

export function mapWithdrawalError(error: unknown): HttpException {
  if (error instanceof WithdrawalDomainError) {
    const body = { error: error.code, message: error.publicMessage };
    switch (error.code) {
      case 'UNAUTHORIZED':
        return new UnauthorizedException(body);
      case 'ACCOUNT_BLOCKED':
        return new ForbiddenException(body);
      case 'IDEMPOTENCY_CONFLICT':
      case 'STATE_CONFLICT':
      case 'TRANSITION_FORBIDDEN':
        return new ConflictException(body);
      case 'QUOTE_NOT_FOUND':
      case 'QUOTE_NOT_OPEN':
      case 'QUOTE_EXPIRED':
      case 'QUOTE_CONSUMED':
      case 'VALIDATION':
      case 'LIMIT_EXCEEDED':
      case 'LIMIT_RULE_NOT_FOUND':
      case 'LIMIT_RULE_AMBIGUOUS':
      case 'INSUFFICIENT_AVAILABLE':
      case 'WALLET_INELIGIBLE':
      case 'COOLDOWN_ACTIVE':
      case 'PAUSED':
      case 'FEE_RULE_NOT_FOUND':
      case 'FEE_RULE_AMBIGUOUS':
      case 'ENTITLEMENT_AMBIGUOUS':
        return new BadRequestException(body);
      case 'CONFIG':
      case 'INTERNAL':
      case 'RECONCILE_REQUIRED':
      default:
        return new HttpException(
          { error: 'INTERNAL', message: 'Request failed' },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
    }
  }
  return new HttpException(
    { error: 'INTERNAL', message: 'Request failed' },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** Prefer domain mapping; expose generic not-found when callers need IDOR-safe 404. */
export function withdrawalNotFound(): NotFoundException {
  return new NotFoundException({
    error: 'NOT_FOUND',
    message: 'Withdrawal not found',
  });
}
