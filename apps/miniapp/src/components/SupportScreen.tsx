'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError } from '../lib/api/client';
import { formatServerTimestamp } from '../lib/profile/profile-display';
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

function ticketStateLabel(
  state: string,
  t: ReturnType<typeof useTranslations<'profile'>>,
): string {
  if (state in TICKET_STATE_KEYS) {
    return t(TICKET_STATE_KEYS[state as keyof typeof TICKET_STATE_KEYS]);
  }
  return t('stateUnknown', { state });
}

/**
 * Support list + create ticket.
 * Uses GET /v1/support/tickets and POST /v1/support/tickets only.
 */
export function SupportScreen() {
  const t = useTranslations('profile');
  const common = useTranslations('common');
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const tickets = useQuery({
    queryKey: queryKeys.supportTickets,
    queryFn: () => api.listSupportTickets(),
  });

  const createTicket = useMutation({
    mutationFn: () => {
      const trimmedSubject = subject.trim();
      const trimmedBody = body.trim();
      return api.createSupportTicket({
        subject: trimmedSubject,
        category: 'GENERAL',
        ...(trimmedBody === '' ? {} : { body: trimmedBody }),
      });
    },
    onSuccess: async () => {
      setSubject('');
      setBody('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.supportTickets });
    },
  });

  return (
    <div className="alex-stack lootra-support">
      <AppLink href="/profile" className="alex-chip-link">
        ← {common('back')}
      </AppLink>

      <header className="lootra-support-hero">
        <div className="lootra-support-hero__copy">
          <h1 className="alex-title">{t('support')}</h1>
          <p className="alex-muted">{t('supportHelp')}</p>
        </div>
        <div className="lootra-support-hero__visual" aria-hidden="true">
          <span className="lootra-support-hero__orbit" />
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand accent */}
          <img
            className="lootra-support-hero__art"
            src="/brand/lootra/bot-hero.png"
            alt=""
            width={160}
            height={160}
          />
        </div>
      </header>

      <section className="lootra-profile-card" aria-labelledby="lootra-new-ticket">
        <h2 id="lootra-new-ticket" className="alex-title-sm">
          {t('supportNewTicket')}
        </h2>
        <label className="alex-field">
          <span>{t('supportSubject')}</span>
          <input
            type="text"
            value={subject}
            maxLength={200}
            onChange={(event) => {
              setSubject(event.target.value);
            }}
          />
        </label>
        <label className="alex-field">
          <span>{t('supportBody')}</span>
          <textarea
            value={body}
            maxLength={4000}
            rows={3}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="lootra-btn lootra-btn--primary"
          disabled={createTicket.isPending || subject.trim() === ''}
          onClick={() => {
            createTicket.mutate();
          }}
        >
          {createTicket.isPending ? t('supportSubmitting') : t('supportSubmit')}
        </button>
        {createTicket.isSuccess ? (
          <p className="alex-banner alex-banner--ok" role="status" aria-live="polite">
            {t('supportCreated', { publicId: createTicket.data.ticket.publicId })}
          </p>
        ) : null}
        {createTicket.isError ? (
          <p className="alex-banner alex-banner--warn" role="alert">
            {t('supportError')}
          </p>
        ) : null}
      </section>

      <section className="lootra-profile-card" aria-labelledby="lootra-ticket-history">
        <h2 id="lootra-ticket-history" className="alex-title-sm">
          {t('supportTicketsTitle')}
        </h2>
        {tickets.isLoading ? <DomainStateView state="LOADING" /> : null}
        {tickets.isError ? (
          <DomainStateView state="ERROR" onRetry={() => void tickets.refetch()} />
        ) : null}
        {tickets.data !== undefined && tickets.data.tickets.length === 0 ? (
          <DomainStateView state="EMPTY" emptyTitle={t('supportTicketsEmpty')} />
        ) : null}
        {tickets.data !== undefined && tickets.data.tickets.length > 0 ? (
          <ul className="lootra-ticket-list">
            {tickets.data.tickets.map((ticket) => (
              <li key={ticket.id}>
                <AppLink
                  href={`/profile/support/${encodeURIComponent(ticket.id)}`}
                  className="lootra-ticket-link"
                >
                  <span className="lootra-ticket-id" dir="ltr">
                    {ticket.publicId}
                  </span>
                  <span className="lootra-ticket-subject">{ticket.subject}</span>
                  <span className="alex-muted">{ticketStateLabel(ticket.state, t)}</span>
                  {ticket.category !== null ? (
                    <span className="alex-meta">{ticket.category}</span>
                  ) : null}
                  <span className="alex-meta">
                    {formatServerTimestamp(ticket.updatedAt)}
                  </span>
                </AppLink>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
