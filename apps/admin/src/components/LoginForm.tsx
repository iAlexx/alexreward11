'use client';

import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { strings } from '../lib/strings';
import { useAdminSession } from '../providers/AdminSessionProvider';

type AuthMode = 'webauthn' | 'password' | 'recovery';

export function LoginForm() {
  const { status, api, setSessionFromLogin } = useAdminSession();
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>('webauthn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'AUTHENTICATED') {
      router.replace('/overview');
    }
  }, [status, router]);

  async function handleWebAuthn() {
    setBusy(true);
    setError(null);
    try {
      const trimmed = email.trim();
      const begun = await api.webauthnLoginOptions(
        trimmed === '' ? {} : { email: trimmed },
      );
      const assertion = await startAuthentication({
        optionsJSON: begun.options as unknown as PublicKeyCredentialRequestOptionsJSON,
      });
      const issued = await api.webauthnLoginVerify({
        ...(trimmed === '' ? {} : { email: trimmed }),
        ...(begun.adminUserId === undefined ? {} : { adminUserId: begun.adminUserId }),
        response: assertion as never,
      });
      void issued;
      await setSessionFromLogin();
      router.replace('/overview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordTotp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const issued = await api.loginPasswordTotp({
        email: email.trim(),
        password,
        totpCode,
      });
      setPassword('');
      setTotpCode('');
      void issued;
      await setSessionFromLogin();
      router.replace('/overview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password+TOTP sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleRecovery(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmed = email.trim();
      const issued = await api.recoveryConsume({
        ...(trimmed === '' ? {} : { email: trimmed }),
        recoveryCode,
      });
      setRecoveryCode('');
      void issued;
      await setSessionFromLogin();
      router.replace('/overview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recovery sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'LOADING' || status === 'AUTHENTICATED') {
    return (
      <div className="admin-state" role="status">
        <p className="admin-muted">{strings.loading}</p>
      </div>
    );
  }

  return (
    <div className="admin-login">
      <section className="admin-login__card" aria-labelledby="admin-login-title">
        <p className="admin-brand">{strings.appName}</p>
        <h1 id="admin-login-title" className="admin-title">
          {strings.signIn}
        </h1>
        <p className="admin-muted">{strings.webauthnHint}</p>

        <div className="admin-tabs" role="tablist" aria-label="Sign-in method">
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
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'recovery'}
            className={mode === 'recovery' ? 'is-active' : undefined}
            onClick={() => setMode('recovery')}
          >
            Recovery
          </button>
        </div>

        <label className="admin-field">
          <span>{strings.email}</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        {mode === 'webauthn' ? (
          <div className="admin-stack">
            <button
              type="button"
              className="admin-button admin-button--primary"
              disabled={busy}
              onClick={() => void handleWebAuthn()}
            >
              {busy ? strings.loading : strings.webauthnPrimary}
            </button>
          </div>
        ) : null}

        {mode === 'password' ? (
          <form className="admin-stack" onSubmit={(e) => void handlePasswordTotp(e)}>
            <p className="admin-meta">{strings.passwordFallback}</p>
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
            <button type="submit" className="admin-button" disabled={busy}>
              {busy ? strings.loading : strings.signIn}
            </button>
          </form>
        ) : null}

        {mode === 'recovery' ? (
          <form className="admin-stack" onSubmit={(e) => void handleRecovery(e)}>
            <p className="admin-meta">{strings.recoveryPath}</p>
            <label className="admin-field">
              <span>{strings.recoveryCode}</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="admin-button" disabled={busy}>
              {busy ? strings.loading : strings.signIn}
            </button>
          </form>
        ) : null}

        {error !== null ? (
          <p className="admin-banner admin-banner--error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
