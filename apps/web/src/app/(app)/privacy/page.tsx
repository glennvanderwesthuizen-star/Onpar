'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, Field, formatDateTime, useLoad } from '@/components/ui';

interface Retention {
  settings: { enabled: boolean; selfieMonths: number; patrolPhotoMonths: number };
  wouldRemoveNow: { selfies: number; patrolPhotos: number };
  removed: { selfies: number; patrolPhotos: number; last: string | null };
}

export default function PrivacyPage() {
  const { data, error, reload } = useLoad(() => api<Retention>('/privacy/retention'));
  const [v, setV] = useState<Retention['settings'] | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setV(data.settings);
  }, [data]);
  const errors = saveError instanceof ApiError ? saveError.errors : {};

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!v) return;
    if (v.enabled && !data?.settings.enabled && !confirm('Switch on photo removal? Photos older than the periods set will be deleted for good each day. The records stay.')) return;
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api('/privacy/retention', { method: 'PUT', json: { ...v, reason } });
      setReason('');
      setSaved(true);
      reload();
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <h1>Privacy</h1>
          <p className="mute">How long On Par keeps photos (POPIA). Records are kept; only the images are removed.</p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="banner warn">
        The periods below are the brief&apos;s <b>proposals</b>, not legal advice. Confirm them with your POPIA adviser before switching removal on. Removed photos
        cannot be brought back, except from a backup.
      </div>
      {data && v && (
        <div className="grid g2">
          <form className="card" onSubmit={save}>
            <h2>Photo retention</h2>
            <ErrorBanner error={saveError} />
            {saved && <div className="banner ok">Saved.</div>}
            <label className="row" style={{ gap: 6, marginBottom: 10 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} />
              <b>Remove photos once they pass their period</b>
            </label>
            <div className="grid g2">
              <Field label="Duty On and Duty From selfies (months)" error={errors.selfieMonths}>
                <input type="number" min={1} max={120} value={v.selfieMonths} onChange={(e) => setV({ ...v, selfieMonths: Number(e.target.value) })} />
              </Field>
              <Field label="Patrol photos (months)" error={errors.patrolPhotoMonths}>
                <input type="number" min={1} max={120} value={v.patrolPhotoMonths} onChange={(e) => setV({ ...v, patrolPhotoMonths: Number(e.target.value) })} />
              </Field>
            </div>
            <Field label="Why the change (kept in the audit log)" error={errors.reason}>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: periods confirmed by our POPIA adviser" />
            </Field>
            <button className="btn" disabled={busy || reason.trim().length < 3}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </form>
          <div className="card">
            <h2>Status</h2>
            <p>
              Removal is <b>{data.settings.enabled ? 'on' : 'off'}</b>. The server checks once a day.
            </p>
            <p className="mute small">With the saved periods, removal would take away now:</p>
            <p>
              <b>{data.wouldRemoveNow.selfies}</b> selfies and <b>{data.wouldRemoveNow.patrolPhotos}</b> patrol photos.
            </p>
            <p className="mute small">Removed so far:</p>
            <p>
              <b>{data.removed.selfies}</b> selfies and <b>{data.removed.patrolPhotos}</b> patrol photos
              {data.removed.last ? `, last on ${formatDateTime(data.removed.last)}` : ''}.
            </p>
            <p className="mute small">
              Other periods proposed in the brief (attendance, tasks and performance events 3 years; audit log 5 years; training while employed plus 3 years;
              registration photos while employed plus an agreed period) are not removed automatically yet. They run into years, and need legal confirmation first.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
