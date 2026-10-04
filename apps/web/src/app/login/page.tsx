'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ErrorBanner, Field } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [forgot, setForgot] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', json: { email, password } });
      // Only a path on this site, never another address.
      const next = new URLSearchParams(window.location.search).get('next') ?? '';
      router.replace(next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="card">
        <img src="/tsf-logo.png" alt="The Security Franchise" />
        <div className="logo" style={{ marginTop: 10 }}>
          On<i>Par</i>
        </div>
        <p className="mute small">Management sign-in</p>
        <form onSubmit={submit}>
          <ErrorBanner error={error} />
          <Field label="Email">
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <button className="btn" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <button type="button" className="linkish small" style={{ marginTop: 12 }} onClick={() => setForgot(!forgot)} aria-expanded={forgot}>
          Forgot your password?
        </button>
        {forgot && (
          <div className="small" style={{ textAlign: 'left', marginTop: 8 }}>
            <p style={{ marginTop: 0 }}>
              Ask your company&apos;s system administrator to reset it. They open <b>Users</b>, choose your name and press{' '}
              <b>Reset password</b>. You get a temporary password, sign in with it once, then choose your own.
            </p>
            <p style={{ marginBottom: 0 }}>
              If you are the only administrator, whoever looks after your On Par server can reset it with the server&apos;s{' '}
              <b>password</b> command. After too many wrong tries, sign-in pauses for 15 minutes; a reset also lifts that pause.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
