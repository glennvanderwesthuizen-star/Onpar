'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { api, imageUrl } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, formatDateTime, useLoad } from '@/components/ui';
import { time } from '@/components/attendance';
import { PatrolState } from '@/components/patrols';

interface Detail {
  id: string;
  state: string;
  typeName: string;
  typeCode: string;
  employeeName: string;
  startedAt: string | null;
  finishedAt: string | null;
  windowStart: string;
  windowEnd: string;
  deadline: string | null;
  maxDurationMinutes: number;
  pointsEarned: number;
  partialReason: string | null;
  review: string | null;
  reviewNote: string | null;
  points: { id: string; name: string; scannedAt: string | null; doneAt: string | null }[];
  scans: { id: string; result: string; label: string; at: string; receivedAt: string; lateSynced: boolean; distanceM: number | null; accuracyM: number | null; pointName: string | null }[];
  visits: { pointId: string; pointName: string; scannedAt: string; doneAt: string | null; note: string; hasPhoto: boolean }[];
  readings: { pointId: string; label: string; kind: string; value: number | null; ok: boolean | null; unit: string | null; outOfLimit: boolean; reportId: string | null; reportNumber: number | null }[];
  alert: null | { raisedAt: string; acknowledgedAt: string | null; escalatedAt: string | null; clearedAt: string | null; clearReason: string | null };
}

export default function PatrolDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data: p, error, reload } = useLoad(() => api<Detail>(`/patrols/${id}`), [id]);
  if (error) return <ErrorBanner error={error} />;
  if (!p) return <p className="mute">Loading…</p>;

  return (
    <>
      <div className="head">
        <div>
          <Link href="/patrols" className="mute small">
            ← Patrols
          </Link>
          <h1>
            {p.typeName} ({p.typeCode})
          </h1>
          <p className="mute">
            {p.employeeName} · window {time(p.windowStart)}–{time(p.windowEnd)}
            {p.startedAt && ` · started ${time(p.startedAt)}, allowed ${p.maxDurationMinutes} minutes`}
            {p.finishedAt && ` · finished ${time(p.finishedAt)}`}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <PatrolState state={p.state} review={p.review} />
          {p.pointsEarned > 0 && <div className="small">+{p.pointsEarned.toFixed(2)} patrol points</div>}
        </div>
      </div>

      {p.alert && (
        <div className="banner warn">
          <b>Overdue alert</b> raised {formatDateTime(p.alert.raisedAt)}
          {p.alert.escalatedAt && `, escalated to the control room ${time(p.alert.escalatedAt)}`}
          {p.alert.acknowledgedAt && `, acknowledged ${time(p.alert.acknowledgedAt)}`}
          {p.alert.clearedAt ? `. Cleared ${time(p.alert.clearedAt)}: ${p.alert.clearReason}` : '. Still open.'}
        </div>
      )}

      <div className="grid g2">
        <div className="card">
          <h2>Points</h2>
          {p.state === 'missed' && <p className="mute">No patrol was done in this window.</p>}
          {p.points.map((pt) => {
            const v = p.visits.find((x) => x.pointId === pt.id);
            const readings = p.readings.filter((r) => r.pointId === pt.id);
            return (
              <div key={pt.id} style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
                <b>{pt.name}</b> {pt.doneAt ? '✓' : pt.scannedAt ? '(scanned, checks not saved)' : <span className="mute">not visited</span>}
                {v && (
                  <div className="mute small">
                    Scanned {time(v.scannedAt)}
                    {v.doneAt && v.doneAt !== v.scannedAt && `, checks saved ${time(v.doneAt)}`}
                  </div>
                )}
                {readings.map((r) => (
                  <div key={r.label} className="small" style={{ color: r.outOfLimit ? 'var(--red)' : undefined }}>
                    {r.label}: {r.kind === 'number' ? `${r.value} ${r.unit ?? ''}` : r.kind === 'ok_problem' ? (r.ok ? 'OK' : 'Problem') : 'photo'}
                    {r.outOfLimit && (
                      <>
                        {' '}
                        · outside the limit ·{' '}
                        {r.reportId && <Link href={`/reports/${r.reportId}`}>Report #{r.reportNumber}</Link>}
                      </>
                    )}
                  </div>
                ))}
                {v?.note && <div className="small">Note: {v.note}</div>}
                {v?.hasPhoto && <PointPhoto patrolId={p.id} pointId={pt.id} name={pt.name} />}
              </div>
            );
          })}
        </div>
        <div className="card scroll">
          <h2>Every scan</h2>
          {!p.scans.length && <p className="mute">No scans.</p>}
          <table>
            <tbody>
              {p.scans.map((s) => (
                <tr key={s.id}>
                  <td>{time(s.at)}</td>
                  <td>{s.pointName ?? 'Unknown code'}</td>
                  <td style={{ color: s.result.startsWith('rejected') ? 'var(--red)' : undefined }}>
                    {s.label}
                    <div className="mute small">
                      {s.distanceM != null && `${s.distanceM} m from the point`}
                      {s.accuracyM != null && ` · GPS ±${Math.round(s.accuracyM)} m`}
                      {s.lateSynced && ` · sent ${time(s.receivedAt)}`}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {p.state === 'partial' && <Review patrol={p} canReview={can('patrols.alerts')} onDone={reload} />}
    </>
  );
}

function PointPhoto({ patrolId, pointId, name }: { patrolId: string; pointId: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    imageUrl(`/patrols/${patrolId}/points/${pointId}/photo`).then((x) => setUrl((u = x))).catch(() => undefined);
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [patrolId, pointId]);
  return url ? <img src={url} alt={`Photo at ${name}`} style={{ maxWidth: 220, borderRadius: 8, marginTop: 4 }} /> : null;
}

function Review({ patrol: p, canReview, onDone }: { patrol: Detail; canReview: boolean; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async (decision: string) => {
    setBusy(true);
    try {
      await api(`/patrols/${p.id}/review`, { method: 'POST', json: { decision, note } });
      onDone();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>Ended early</h2>
      <p>
        Reason given: <b>{p.partialReason}</b>
      </p>
      {p.review ? (
        <p>
          {p.review === 'accepted' ? 'Reason accepted' : 'Reason not accepted (counts as a missed patrol)'}: {p.reviewNote}
        </p>
      ) : canReview ? (
        <>
          <p className="mute small">No penalty until you review it. Not accepting the reason counts it as a missed patrol.</p>
          <ErrorBanner error={error} />
          <Field label="Note">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="row">
            <button className="btn" disabled={busy || note.trim().length < 3} onClick={() => send('accepted')}>
              Accept the reason
            </button>
            <button className="btn ghost" disabled={busy || note.trim().length < 3} onClick={() => send('not_accepted')}>
              Do not accept
            </button>
          </div>
        </>
      ) : (
        <p className="mute">Waiting for a supervisor to review.</p>
      )}
    </div>
  );
}
