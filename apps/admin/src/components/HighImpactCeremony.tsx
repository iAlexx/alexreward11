'use client';

import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import type { AdminDiffField } from '../lib/admin-api/types';
import { strings } from '../lib/strings';
import { useAdminSession } from '../providers/AdminSessionProvider';
import { useReauth } from '../providers/ReauthProvider';

/**
 * High-impact ceremony: old/new diff, required reason, reauth, and server-issued
 * second confirmation. Client phrase matching alone does NOT authorize (P13-01).
 *
 * Prepare runs only after the Owner supplies a reason so the server-stored payload
 * digest includes the same reason the final mutation will consume.
 */
export function HighImpactCeremony({
  title,
  diffs,
  actionType,
  resourceType,
  resourceId,
  expectedVersion,
  payload,
  requiresReauth = true,
  submitLabel,
  onConfirm,
  children,
}: {
  readonly title: string;
  readonly diffs: readonly AdminDiffField[];
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
  readonly payload: Record<string, unknown>;
  readonly requiresReauth?: boolean;
  readonly submitLabel?: string;
  readonly onConfirm: (input: {
    reason: string;
    confirmationId: string;
    payloadDigest: string;
  }) => Promise<void>;
  readonly children?: ReactNode;
}) {
  const { api } = useAdminSession();
  const { requestReauth } = useReauth();
  const reasonId = useId();
  const confirmId = useId();
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<{
    confirmationId: string;
    confirmationPhrase: string;
    payloadDigest: string;
    reason: string;
  } | null>(null);

  const exactMatch = useMemo(
    () =>
      prepared !== null && confirmText.trim() === prepared.confirmationPhrase,
    [confirmText, prepared],
  );

  async function handlePrepare() {
    setError(null);
    const trimmedReason = reason.trim();
    if (trimmedReason === '') {
      setError('Reason is required before preparing confirmation.');
      return;
    }
    setPreparing(true);
    try {
      if (requiresReauth) {
        await requestReauth();
      }
      const next = await api.prepareConfirmation({
        actionType,
        resourceType,
        resourceId,
        expectedVersion,
        payload: { ...payload, reason: trimmedReason },
      });
      setPrepared({
        confirmationId: next.confirmationId,
        confirmationPhrase: next.confirmationPhrase,
        payloadDigest: next.payloadDigest,
        reason: trimmedReason,
      });
      setConfirmText('');
    } catch (err) {
      setPrepared(null);
      setError(err instanceof Error ? err.message : 'Failed to prepare confirmation');
    } finally {
      setPreparing(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (prepared === null) {
      setError('Prepare a server confirmation first.');
      return;
    }
    if (reason.trim() !== prepared.reason) {
      setError('Reason changed after prepare — prepare again.');
      setPrepared(null);
      return;
    }
    if (!exactMatch) {
      setError('Confirmation phrase must match exactly.');
      return;
    }
    setBusy(true);
    try {
      if (requiresReauth) {
        await requestReauth();
      }
      await api.confirmConfirmation(prepared.confirmationId, {
        confirmationPhrase: confirmText.trim(),
      });
      await onConfirm({
        reason: prepared.reason,
        confirmationId: prepared.confirmationId,
        payloadDigest: prepared.payloadDigest,
      });
      setReason('');
      setConfirmText('');
      setPrepared(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ceremony failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-ceremony" aria-labelledby={`${reasonId}-title`}>
      <h2 id={`${reasonId}-title`} className="admin-title-sm">
        {title}
      </h2>
      {children}
      <div className="admin-diff" role="table" aria-label="Proposed change diff">
        <div className="admin-diff__head" role="row">
          <span role="columnheader">Field</span>
          <span role="columnheader">{strings.oldValue}</span>
          <span role="columnheader">{strings.newValue}</span>
        </div>
        {diffs.map((diff) => (
          <div className="admin-diff__row" role="row" key={diff.path}>
            <span role="cell" className="admin-mono">
              {diff.path}
            </span>
            <span role="cell" className="admin-mono">
              {formatDiffValue(diff.oldValue)}
            </span>
            <span role="cell" className="admin-mono">
              {formatDiffValue(diff.newValue)}
            </span>
          </div>
        ))}
      </div>
      <p className="admin-meta">
        Payload digest:{' '}
        <code className="admin-mono">{prepared?.payloadDigest ?? 'not prepared'}</code>
      </p>
      <form className="admin-stack" onSubmit={(e) => void handleSubmit(e)}>
        <label className="admin-field" htmlFor={reasonId}>
          <span>{strings.reasonRequired}</span>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (prepared !== null) setPrepared(null);
            }}
            required
            rows={3}
            data-testid="ceremony-reason"
          />
        </label>
        {prepared === null ? (
          <button
            type="button"
            className="admin-button admin-button--ghost"
            disabled={preparing || reason.trim() === ''}
            onClick={() => void handlePrepare()}
            data-testid="ceremony-prepare"
          >
            {preparing ? strings.loading : 'Prepare server confirmation'}
          </button>
        ) : (
          <label className="admin-field" htmlFor={confirmId}>
            <span>
              {strings.secondConfirmLabel}:{' '}
              <code className="admin-mono" data-testid="ceremony-phrase">
                {prepared.confirmationPhrase}
              </code>
            </span>
            <input
              id={confirmId}
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
              data-testid="ceremony-confirm-input"
            />
          </label>
        )}
        {error !== null ? (
          <p className="admin-banner admin-banner--error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="admin-button"
          disabled={busy || prepared === null || !exactMatch}
          data-testid="ceremony-submit"
        >
          {busy ? strings.loading : (submitLabel ?? strings.confirmCeremony)}
        </button>
      </form>
    </section>
  );
}

function formatDiffValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
