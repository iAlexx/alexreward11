'use client';

import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { strings } from '../lib/strings';
import { useAdminSession } from './AdminSessionProvider';

type ReauthResolver = {
  resolve: () => void;
  reject: (error: Error) => void;
};

type ReauthContextValue = {
  readonly requestReauth: () => Promise<void>;
};

const ReauthContext = createContext<ReauthContextValue | null>(null);

export function ReauthProvider({ children }: { readonly children: ReactNode }) {
  const { api, refreshSession } = useAdminSession();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'webauthn' | 'password'>('webauthn');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<ReauthResolver | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const close = useCallback((ok: boolean, err?: Error) => {
    setOpen(false);
    setPassword('');
    setTotpCode('');
    setError(null);
    setBusy(false);
    const resolver = pending.current;
    pending.current = null;
    if (resolver === null) return;
    if (ok) resolver.resolve();
    else resolver.reject(err ?? new Error('Reauthentication cancelled'));
  }, []);

  const requestReauth = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject };
      setMode('webauthn');
      setOpen(true);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) {
      dialog.showModal();
    }
  }, [open]);

  const runWebAuthn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const begun = await api.reauthWebAuthnOptions();
      const assertion = await startAuthentication({
        optionsJSON: begun.options as unknown as PublicKeyCredentialRequestOptionsJSON,
      });
      await api.reauthWebAuthnVerify({ response: assertion as never });
      await refreshSession();
      dialogRef.current?.close();
      close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'WebAuthn reauth failed');
      setBusy(false);
    }
  }, [api, close, refreshSession]);

  const runPasswordTotp = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.reauthPasswordTotp({ password, totpCode });
      await refreshSession();
      dialogRef.current?.close();
      close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password+TOTP reauth failed');
      setBusy(false);
    }
  }, [api, close, password, refreshSession, totpCode]);

  const value = useMemo(() => ({ requestReauth }), [requestReauth]);

  return (
    <ReauthContext.Provider value={value}>
      {children}
      {open ? (
        <dialog
          ref={dialogRef}
          className="admin-dialog"
          aria-labelledby="admin-reauth-title"
          onCancel={(event) => {
            event.preventDefault();
            dialogRef.current?.close();
            close(false);
          }}
        >
          <form
            className="admin-dialog__panel"
            method="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              if (mode === 'webauthn') void runWebAuthn();
              else void runPasswordTotp();
            }}
          >
            <h2 id="admin-reauth-title">{strings.reauthTitle}</h2>
            <p className="admin-muted">{strings.reauthBody}</p>
            <div className="admin-tabs" role="tablist" aria-label="Reauthentication method">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'webauthn'}
                className={mode === 'webauthn' ? 'is-active' : undefined}
                onClick={() => setMode('webauthn')}
              >
                Passkey
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'password'}
                className={mode === 'password' ? 'is-active' : undefined}
                onClick={() => setMode('password')}
              >
                Password + TOTP
              </button>
            </div>
            {mode === 'password' ? (
              <div className="admin-stack-sm">
                <label className="admin-field">
                  <span>{strings.password}</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </label>
                <label className="admin-field">
                  <span>{strings.totp}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    required
                  />
                </label>
              </div>
            ) : (
              <p className="admin-muted">{strings.webauthnHint}</p>
            )}
            {error !== null ? (
              <p className="admin-banner admin-banner--error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="admin-actions">
              <button
                type="button"
                className="admin-button admin-button--ghost"
                onClick={() => {
                  dialogRef.current?.close();
                  close(false);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="submit" className="admin-button" disabled={busy}>
                {busy ? strings.loading : strings.reauthTitle}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
    </ReauthContext.Provider>
  );
}

export function useReauth(): ReauthContextValue {
  const ctx = useContext(ReauthContext);
  if (ctx === null) {
    throw new Error('useReauth must be used within ReauthProvider');
  }
  return ctx;
}
