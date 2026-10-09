'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, Field, formatDateTime, useLoad } from '@/components/ui';

type Counts = { selfies: number; patrolPhotos: number; visitorPhotos: number; visitorRecords: number; recordPhotos: number; staffSnapshots: number; boloMedia: number };
interface Retention {
  settings: { enabled: boolean; selfieMonths: number; patrolPhotoMonths: number; boloMediaDays: number; visitorMonths: number; recordPhotoMonths: number; staffSnapshotDays: number };
  wouldRemoveNow: Counts;
  removed: Counts & { last: string | null };
}

/** The counts in words, leaving out what is nil. */
function countsText(c: Counts) {
  const parts = (
    [
      [c.selfies, 'selfies'],
      [c.patrolPhotos, 'patrol photos'],
      [c.visitorPhotos, 'visitor photos'],
      [c.staffSnapshots, 'domestic staff snapshots'],
      [c.recordPhotos, 'task, report and Wire photos'],
      [c.boloMedia, 'BOLO photos, videos and voice notes'],
      [c.visitorRecords, 'visitor details to anonymise'],
    ] as [number, string][]
  ).filter(([n]) => n > 0);
  return parts.length ? parts.map(([n, w]) => `${n} ${w}`).join(', ') : 'nothing';
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
        The periods below are set as you decided (9 Oct 2026: 12 months, domestic staff snapshots 30 days). They are not legal advice: have your POPIA adviser
        confirm them. Removed photos cannot be brought back, except from a backup.
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
              <Field label="BOLO photos, videos and voice notes (days)" error={errors.boloMediaDays} hint="They record members of the public. 90 days proposed; confirm with the POPIA specialist.">
                <input type="number" min={7} max={3650} value={v.boloMediaDays ?? 90} onChange={(e) => setV({ ...v, boloMediaDays: Number(e.target.value) })} />
              </Field>
              <Field label="Visitors at the gates (months)" error={errors.visitorMonths} hint="Visitor and document photos are removed, and a visitor not seen for this long is anonymised; the visit still counts.">
                <input type="number" min={1} max={120} value={v.visitorMonths} onChange={(e) => setV({ ...v, visitorMonths: Number(e.target.value) })} />
              </Field>
              <Field label="Domestic staff entry snapshots (days)" error={errors.staffSnapshotDays} hint="When the photos clearly matched. A snapshot that was in doubt is kept with the visitor photos; the first-day reference photo is kept.">
                <input type="number" min={1} max={3650} value={v.staffSnapshotDays} onChange={(e) => setV({ ...v, staffSnapshotDays: Number(e.target.value) })} />
              </Field>
              <Field label="Photos on tasks, reports and Wire notes (months)" error={errors.recordPhotoMonths} hint="Only once the report is closed or the note decided. Certificates, HR notices and disciplinary files are never removed.">
                <input type="number" min={1} max={120} value={v.recordPhotoMonths} onChange={(e) => setV({ ...v, recordPhotoMonths: Number(e.target.value) })} />
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
              <b>{countsText(data.wouldRemoveNow)}</b>.
            </p>
            <p className="mute small">Removed so far:</p>
            <p>
              <b>{countsText(data.removed)}</b>
              {data.removed.last ? `, last on ${formatDateTime(data.removed.last)}` : ''}.
            </p>
            <p className="mute small">
              Other periods proposed in the brief (attendance, tasks and performance events 3 years; audit log 5 years; training while employed plus 3 years;
              registration photos while employed plus an agreed period) are not removed automatically yet. They run into years, and need legal confirmation first.
            </p>
          </div>
        </div>
      )}
      <FaceMatching />
    </>
  );
}

/** Automatic face matching (D-36 stage 2): a company switch, off until someone turns it on with a reason. */
function FaceMatching() {
  const { data, error, reload } = useLoad(() => api<{ enabled: boolean; results: Record<string, number> }>('/privacy/face-matching'));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  async function toggle() {
    if (!data) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api('/privacy/face-matching', { method: 'PUT', json: { enabled: !data.enabled, reason } });
      setReason('');
      reload();
    } catch (e) {
      setSaveError(e);
    } finally {
      setBusy(false);
    }
  }
  const r = data?.results ?? {};
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>Automatic face matching</h2>
      <ErrorBanner error={error ?? saveError} />
      <p>
        When this is on, On Par compares each guard&apos;s enrolment face photo with his ID document and PSIRA card, and
        every Duty On and Duty From selfie with his enrolment photo. It runs on your own On Par server: no photo or face
        data is sent anywhere, and only the result is kept (how alike, and a verdict), never a face template.
      </p>
      <p>
        A possible mismatch only appears under <b>Attendance, Selfie checks</b> for a supervisor or manager to look at. It never
        blocks a guard, changes his score or starts a warning by itself.
      </p>
      <div className="banner warn">
        Face data is biometric, which POPIA treats as special personal information. The owner&apos;s approach (D-35) is to
        design on what is reasonable and have the POPIA adviser review the whole design at the end (P-5). Tell your
        guards that face matching is used.
      </div>
      {data && (
        <>
          <p>
            Face matching is <b>{data.enabled ? 'on' : 'off'}</b>.
            {(r.match || r.uncertain || r.no_match || r.no_face) &&
              ` Results so far: ${r.match ?? 0} likely the same, ${r.uncertain ?? 0} uncertain, ${r.no_match ?? 0} possibly different, ${r.no_face ?? 0} with no clear face.`}
          </p>
          <div className="row">
            <input style={{ flex: 1, minWidth: 220 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (kept in the audit log)" />
            <button className="btn" disabled={busy || reason.trim().length < 3} onClick={toggle}>
              {data.enabled ? 'Switch off' : 'Switch on'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
