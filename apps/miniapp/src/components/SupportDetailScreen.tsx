'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError } from '../lib/api/client';
import {
  canReplyToSupportTicket,
  formatServerTimestamp,
} from '../lib/profile/profile-display';
import { queryKeys } from '../lib/query/keys';
import { useAuth } from '../providers/AuthProvider';
import { AppLink } from './AppLink';
import { DomainStateView } from './DomainState';

const TICKET_STATE_KEYS = {
  OPEN: 'state_OPEN',
  WAITING_USER: 'state_WAITING_USER',
  WAITING_SUPPORT: 'state_WAITING_SUPPORT',
  RESOLVED: 'state_RESOLVED',
  CLOSED: 'state_CLOSED',
} as const;

/**
 * Support ticket detail + thread.
 * Uses GET /v1/support/tickets/:id and POST .../messages.
 * CLOSED / RESOLVED tickets cannot accept replies.
 */
export function SupportDetailScreen({ id }: { readonly id: string }) {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');

  const detail = useQuery({
    queryKey: queryKeys.supportTicket(id),
    queryFn: () => api.getSupportTicket(id),
  });

  const sendMessage = useMutation({
    mutationFn: (body: string) => api.postSupportMessage(id, { body }),
    onSuccess: async () => {
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.supportTicket(id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.supportTickets });
    },
  });

  if (detail.isLoading) {
    return (
      <div className="alex-stack lootra-support">
        <AppLink href="/profile/support" className="alex-chip-link">
          ← {common('back')}
        </AppLink>
        <DomainStateView state="LOADING" />
      </div>
    );
  }

  if (detail.isError) {
    const ownershipSafe =
      detail.error instanceof ApiError &&
      (detail.error.status === 404 ||
        detail.error.status === 403 ||
        detail.error.code === 'NOT_FOUND' ||
        detail.error.code === 'FORBIDDEN');
    return (
      <div className="alex-stack lootra-support">
        <AppLink href="/profile/support" className="alex-chip-link">
          ← {common('back')}
        </AppLink>
        <h1 className="alex-title">{t('supportDetailTitle')}</h1>
        {ownershipSafe ? (
          <p className="alex-banner alex-banner--warn" role="alert">
            {t('supportUnavailable')}
          </p>
        ) : (
          <DomainStateView state="ERROR" onRetry={() => void detail.refetch()} />
        )}
      </div>
    );
  }

  const ticket = detail.data;
  if (ticket === undefined) {
    return (
      <div className="alex-stack lootra-support">
        <AppLink href="/profile/support" className="alex-chip-link">
          ← {common('back')}
        </AppLink>
        <p className="alex-banner alex-banner--warn" role="alert">
          {t('supportUnavailable')}
        </p>
      </div>
    );
  }

  const stateLabel =
    ticket.state in TICKET_STATE_KEYS
      ? t(TICKET_STATE_KEYS[ticket.state as keyof typeof TICKET_STATE_KEYS])
      : t('stateUnknown', { state: ticket.state });
  const canReply = canReplyToSupportTicket(ticket.state);

  return (
    <div className="alex-stack lootra-support">
      <AppLink href="/profile/support" className="alex-chip-link">
        ← {common('back')}
      </AppLink>
      <h1 className="alex-title">{t('supportDetailTitle')}</h1>

      <section className="lootra-profile-card alex-stack-sm">
        <p className="lootra-ticket-id" dir="ltr">
          {ticket.publicId}
        </p>
        <p className="alex-title-sm">{ticket.subject}</p>
        <p className="alex-muted">{stateLabel}</p>
        <p className="alex-meta">{formatServerTimestamp(ticket.createdAt)}</p>
      </section>

      <section className="lootra-support-thread" aria-label={t('supportThread')}>
        {ticket.messages.length === 0 ? (
          <p className="alex-muted">{t('supportNoMessages')}</p>
        ) : (
          <ul className="lootra-support-messages">
            {ticket.messages.map((message) => (
              <li
                key={message.id}
                className={`lootra-support-message lootra-support-message--${message.authorType.toLowerCase()}`}
              >
                <p className="alex-meta">
                  {t(`author_${message.authorType}` as 'author_USER')} ·{' '}
                  {formatServerTimestamp(message.createdAt)}
                </p>
                <p className="lootra-support-message__body">{message.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canReply ? (
        <section className="lootra-profile-card" aria-labelledby="lootra-reply">
          <h2 id="lootra-reply" className="alex-title-sm">
            {t('supportReply')}
          </h2>
          <label className="alex-field">
            <span>{t('supportBody')}</span>
            <textarea
              value={draft}
              maxLength={4000}
              rows={3}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
          </label>
          <button
            type="button"
            className="lootra-btn lootra-btn--primary"
            disabled={sendMessage.isPending || draft.trim() === ''}
            onClick={() => {
              const text = draft.trim();
              if (text === '') return;
              sendMessage.mutate(text);
            }}
          >
            {sendMessage.isPending ? t('supportSending') : t('supportSend')}
          </button>
          {sendMessage.isError ? (
            <p className="alex-banner alex-banner--warn" role="alert">
              {t('supportError')}
            </p>
          ) : null}
        </section>
      ) : (
        <p className="alex-banner" role="status">
          {t('supportReplyDisabled')}
        </p>
      )}
    </div>
  );
}
