'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { AlertSettings } from '@/components/AlertSettings';
import { ChangePassword } from '@/components/ChangePassword';
import { ErrorBanner, Field } from '@/components/ui';
import { useCustomer } from '@/lib/customer';

/** Customer app, My account: alerts on this phone, the numbers the gate phones, password, sign out. */
export default function CustomerAccount() {
  const { me, refresh, signOut } = useCustomer();
  const [v, setV] = useState({ phone: me.phone, secondContactName: me.secondContactName, secondContactPhone: me.secondContactPhone });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [changed, setChanged] = useState(false);
  const errors = error instanceof ApiError ? error.errors : {};

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('/customer/contact', { method: 'PUT', json: v });
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="m-h1">My account</h1>
      <p className="mute small" style={{ marginTop: -8 }}>
        {me.fullName} · {me.email}
      </p>
      <AlertSettings accountId={me.id} />

      <div className="card">
        <h2>How the gate reaches you</h2>
        <p className="mute small">If you do not answer an alert, the gate phones your number, then your second contact.</p>
        <form onSubmit={save}>
          <ErrorBanner error={error} />
          {saved && (
            <div className="banner ok" role="status">
              Saved.
            </div>
          )}
          <Field label="Your number" error={errors.phone}>
            <input type="tel" autoComplete="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} required />
          </Field>
          <Field label="Second contact: name (optional)" error={errors.secondContactName}>
            <input value={v.secondContactName} onChange={(e) => setV({ ...v, secondContactName: e.target.value })} />
          </Field>
          <Field label="Second contact: number (optional)" error={errors.secondContactPhone}>
            <input type="tel" value={v.secondContactPhone} onChange={(e) => setV({ ...v, secondContactPhone: e.target.value })} />
          </Field>
          <button className="btn m-wide" disabled={busy}>
            {busy ? 'Saving…' : 'Save numbers'}
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Change password</h2>
        {changed ? <div className="banner ok">Your password has been changed.</div> : <ChangePassword email={me.email} path="/customer/password" onDone={() => setChanged(true)} />}
      </div>

      <p className="m-foot">
        <button className="btn ghost" style={{ minHeight: 44 }} onClick={signOut}>
          Sign out
        </button>
      </p>
    </>
  );
}
