'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AuthPhoto } from './AuthPhoto';
import { ErrorBanner } from './ui';

/** The armed response company's logo, shown on its button on the post phone's emergency panel. */
export function SiteArmedLogo({ siteId, initial }: { siteId: string; initial: boolean }) {
  const { can } = useSession();
  const [has, setHas] = useState(initial);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const edit = can('sites.edit');
  if (!edit && !has) return null;

  const run = async (work: () => Promise<unknown>, after: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setHas(after);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const upload = (file: File) => {
    const form = new FormData();
    form.append('logo', file);
    return run(() => api(`/sites/${siteId}/armed-response-logo`, { method: 'POST', body: form }), true);
  };

  return (
    <div className="card">
      <h2>Armed response logo</h2>
      <p className="mute small">Shown on the Armed response button on the post phone, so the guard knows it at a glance. A small JPEG or PNG, up to 1 MB. The phone picks it up within a few minutes.</p>
      <ErrorBanner error={error} />
      {has ? <AuthPhoto key={version} path={`/sites/${siteId}/armed-response-logo`} alt="Armed response company logo" width={160} /> : <p className="mute">No logo yet. The button shows the company name only.</p>}
      {edit && (
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <label className="btn ghost" style={{ cursor: 'pointer' }}>
            {busy ? 'Working…' : has ? 'Replace the logo' : 'Choose a logo'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void upload(f);
              }}
            />
          </label>
          {has && (
            <button className="btn ghost" disabled={busy} onClick={() => run(() => api(`/sites/${siteId}/armed-response-logo`, { method: 'DELETE' }), false)}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
