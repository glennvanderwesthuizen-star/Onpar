'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ErrorBanner, Field } from '@/components/ui';

/** Sign in to the portal, or open it the first time with the code from HR. */
export default function PortalLogin() {
  const router = useRouter();
  const [first, setFirst] = useState(false);
  const [login, setLogin] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [made, setMade] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (first) {
        if (password !== again) throw new Error('The two passwords are not the same.');
        const r = await api<{ login: string }>('/portal/activate', { method: 'POST', json: { code, password } });
        setMade(r.login);
      } else {
        await api('/portal/login', { method: 'POST', json: { login, password } });
        router.replace('/p');
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (made) {
    return (
      <main className="login">
        <div className="card">
          <img src="/tsf-logo.png" alt="The Security Franchise" />
          <h2 style={{ marginTop: 10 }}>You are in</h2>
          <p>
            Next time, sign in with <b style={{ fontSize: 20 }}>{made}</b> and the password you chose. Write the sign-in name down.
          </p>
          <button className="btn" onClick={() => router.replace('/p')}>
            Open my messages
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="login">
      <div className="card">
        <img src="/tsf-logo.png" alt="The Security Franchise" />
        <div className="logo" style={{ marginTop: 10 }}>
          On<i>Par</i>
        </div>
        <p className="mute small">My messages: your own, private page. Not for the post phone.</p>
        <form onSubmit={submit}>
          <ErrorBanner error={error} />
          {first ? (
            <Field label="The code from HR">
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="one-time-code" required />
            </Field>
          ) : (
            <Field label="Sign-in name (your TSF number)">
              <input value={login} onChange={(e) => setLogin(e.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="username" required />
            </Field>
          )}
          <Field label={first ? 'Choose a password (at least 8 characters)' : 'Password'}>
            <input type="password" autoComplete={first ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {first && (
            <Field label="The same password again">
              <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
            </Field>
          )}
          <button className="btn" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Please wait…' : first ? 'Open my page' : 'Sign in'}
          </button>
        </form>
        <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => { setFirst(!first); setError(null); }}>
          {first ? 'I already have a password' : 'First time? Use the code from HR'}
        </button>
        <p className="mute small" style={{ marginTop: 12 }}>Forgot your password? Ask HR for a new code.</p>
      </div>
    </main>
  );
}
