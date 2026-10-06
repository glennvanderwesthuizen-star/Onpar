'use client';

import { useState } from 'react';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, Field } from './ui';

/** Change your own password. Used after a temporary password, and from My account. */
export function ChangePassword({ email, onDone, path = '/auth/password' }: { email: string; onDone: () => void; path?: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const problem = next ? passwordProblem(next, email) : null;
  const mismatch = again && again !== next ? 'The two new passwords are not the same.' : null;
  const errors = error instanceof ApiError ? error.errors : {};

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (problem || mismatch || !next) return;
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', json: { currentPassword: current, newPassword: next } });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <ErrorBanner error={error} />
      <Field label="Current or temporary password" error={errors.currentPassword}>
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" error={problem ?? errors.newPassword} hint={`At least ${MIN_PASSWORD_LENGTH} characters. A short sentence works well, for example "green gate at dawn".`}>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </Field>
      <Field label="New password again" error={mismatch ?? undefined}>
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
      </Field>
      <button className="btn" disabled={busy || !!problem || !!mismatch || !next || !again}>
        {busy ? 'Saving…' : 'Save new password'}
      </button>
    </form>
  );
}
