'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, formatDateTime, useLoad } from '@/components/ui';
import { AuthPhoto } from '@/components/AuthPhoto';
import { AuthMedia } from '@/components/AuthMedia';

interface Bolo {
  id: string;
  note: string;
  reportedAt: string;
  lateSynced: boolean;
  hasPhoto: boolean;
  hasVoice: boolean;
  hasVideo: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  awardedPoints: string | number | null;
  employeeId: string | null;
  siteName: string | null;
  deviceLabel: string;
  postName: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
}

/** "Be on the lookout": photos, videos, voice notes and notes from the post phones, as alerts to action. */
export default function BoloPage() {
  const [status, setStatus] = useState('open');
  const [siteId, setSiteId] = useState('');
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const { data, error, reload } = useLoad(() => api<Bolo[]>(`/bolos?status=${status}${siteId ? `&siteId=${siteId}` : ''}`), [status, siteId]);

  return (
    <>
      <div className="head">
        <div>
          <h1>BOLO: be on the lookout</h1>
          <p className="mute">Sent from the post phones. Acknowledge each one, then close it with what was done.</p>
        </div>
        <div className="row">
          <Link className="btn ghost" href="/reports">
            Back to reports
          </Link>
          <div style={{ width: 220 }}>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Site">
              <option value="">All my sites</option>
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[
          ['open', 'Open'],
          ['all', 'All'],
        ].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={status === k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorBanner error={error} />
      {data && !data.length && <div className="card mute">{status === 'open' ? 'No open BOLOs.' : 'No BOLOs yet.'}</div>}
      <div className="bolo-grid">
        {data?.map((b) => <BoloCard key={b.id} b={b} onDone={reload} />)}
      </div>
    </>
  );
}

function BoloCard({ b, onDone }: { b: Bolo; onDone: () => void }) {
  const { can } = useSession();
  const [note, setNote] = useState('');
  const [points, setPoints] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const act = async (path: string, json?: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/bolos/${b.id}/${path}`, { method: 'POST', json });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const open = !b.resolvedAt;
  return (
    <div className="card" style={open ? { borderColor: '#c25e00', borderWidth: 2 } : undefined}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{[b.siteName, b.postName].filter(Boolean).join(' · ') || b.deviceLabel}</b>
        {b.resolvedAt ? <Pill tone="green">Closed</Pill> : b.acknowledgedAt ? <Pill tone="amber">Seen</Pill> : <Pill tone="red">New</Pill>}
      </div>
      <div className="small mute">
        {formatDateTime(b.reportedAt)}
        {b.lateSynced && ' · sent late (the phone was offline)'} · {b.employeeName ? `${b.employeeName} (${b.employeeNumber})` : 'Nobody was signed in'}
      </div>
      {b.note && <p style={{ whiteSpace: 'pre-wrap' }}>{b.note}</p>}
      {b.hasPhoto && <AuthPhoto path={`/bolos/${b.id}/photo`} alt={b.note || 'BOLO photo'} width={360} />}
      {b.hasVideo && (
        <div style={{ marginTop: 8 }}>
          <div className="small mute">Video</div>
          <AuthMedia path={`/bolos/${b.id}/video`} kind="video" />
        </div>
      )}
      {b.hasVoice && (
        <div style={{ marginTop: 8 }}>
          <div className="small mute">Voice note</div>
          <AuthMedia path={`/bolos/${b.id}/voice`} kind="audio" />
        </div>
      )}
      {b.acknowledgedAt && (
        <p className="small mute" style={{ marginBottom: 0 }}>
          Seen by {b.acknowledgedBy}, {formatDateTime(b.acknowledgedAt)}.
        </p>
      )}
      {b.resolvedAt && (
        <p className="small" style={{ marginBottom: 0 }}>
          Closed by {b.resolvedBy}, {formatDateTime(b.resolvedAt)}: {b.resolutionNote}
        </p>
      )}
      <ErrorBanner error={err} />
      {open && can('panic.manage') && (
        <div style={{ marginTop: 10 }}>
          {!b.acknowledgedAt && (
            <button className="btn" style={{ background: '#c25e00', borderColor: '#c25e00' }} disabled={busy} onClick={() => act('acknowledge')}>
              I have seen it
            </button>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <input style={{ flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done, e.g. SAPS informed" />
            <button className="btn ghost" disabled={busy || note.trim().length < 3} onClick={() => act('resolve', { note })}>
              Close
            </button>
          </div>
        </div>
      )}
      {b.employeeId && can('scores.award') && (
        <div className="row small" style={{ marginTop: 10 }}>
          {b.awardedPoints != null ? (
            <Pill tone="green">+{Number(b.awardedPoints)} points awarded</Pill>
          ) : (
            <>
              <span>Useful BOLO? Award</span>
              <select style={{ width: 70 }} value={points} onChange={(e) => setPoints(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((p) => (
                  <option key={p} value={p}>
                    +{p}
                  </option>
                ))}
              </select>
              <button className="btn ghost sm" disabled={busy} onClick={() => act('award', { points })}>
                Award points
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
