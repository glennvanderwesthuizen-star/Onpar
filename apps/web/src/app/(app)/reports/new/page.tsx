'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PRIORITIES, PRIORITY_LABELS, REPORT_CATEGORIES } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, Field, useLoad } from '@/components/ui';
import { TrafficLight } from '@/components/reports';

export default function NewReportPage() {
  const router = useRouter();
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const [f, setF] = useState({ siteId: '', category: '', priority: 'green', description: '' });
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = error instanceof ApiError ? error.errors : {};

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('data', JSON.stringify(f));
    if (photo) form.set('photo', photo);
    try {
      const r = await api<{ id: string }>('/reports', { method: 'POST', body: form });
      router.replace(`/reports/${r.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <Link href="/reports" className="mute small">
            ← Reports
          </Link>
          <h1>New report</h1>
          <p className="mute">Officers report from the post device. Use this for things you see or are told about yourself.</p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <form className="card" onSubmit={submit}>
        <div className="grid g3">
          <Field label="Site" error={errors.siteId}>
            <select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}>
              <option value="">Choose…</option>
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category" error={errors.category}>
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">Choose…</option>
              {Object.entries(REPORT_CATEGORIES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority" error={errors.priority}>
            <div className="row" style={{ marginTop: 6 }}>
              {PRIORITIES.map((p) => (
                <label key={p} className="row">
                  <input type="radio" checked={f.priority === p} onChange={() => setF({ ...f, priority: p })} /> <TrafficLight priority={p} />{' '}
                  {PRIORITY_LABELS[p]}
                </label>
              ))}
            </div>
          </Field>
        </div>
        <Field label="What happened" error={errors.description}>
          <textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Photo (optional)">
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </Field>
        <p className="mute small">Red reports also go to the site manager.</p>
        <button className="btn" disabled={busy}>
          {busy ? 'Sending…' : 'Send report'}
        </button>
      </form>
    </>
  );
}
