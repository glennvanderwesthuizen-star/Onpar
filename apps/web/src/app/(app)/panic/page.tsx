'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, formatDateTime, useLoad } from '@/components/ui';
import { PanicAlert, emergencyCallText, panicPlace } from '@/components/PanicBanner';

export default function PanicPage() {
  const { can } = useSession();
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useLoad(() => api<PanicAlert[]>(`/panic?status=${status}`), [status]);
  // Keep the list fresh while the page is open.
  useEffect(() => {
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <>
      <div className="head">
        <div>
          <h1>Panic alerts</h1>
          <p className="mute">
            Raised by holding the PANIC button on a post phone. The phone also calls the site&apos;s control room. Its location is taken once, at the moment of the panic.
          </p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[
          ['open', 'Open'],
          ['all', 'Last 30 days'],
        ].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={status === k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorBanner error={error} />
      {data && !data.length && <div className="card mute">{status === 'open' ? 'No open panic alerts.' : 'No panic alerts in the last 30 days.'}</div>}
      {data?.map((p) => <PanicCard key={p.id} p={p} canManage={can('panic.manage')} onDone={reload} />)}
    </>
  );
}

function PanicCard({ p, canManage, onDone }: { p: PanicAlert; canManage: boolean; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const act = async (path: string, json?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/panic/${p.id}/${path}`, { method: 'POST', json });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const open = !p.resolvedAt;
  return (
    <div className={open ? 'alert-card' : 'card'}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: 0 }}>{panicPlace(p)}</h3>
          <div className="small">
            {formatDateTime(p.raisedAt)}
            {p.lateSynced && ' · sent late (the phone was offline)'}
          </div>
          <div className="small">{p.employeeName ? `${p.employeeName} (${p.employeeNumber})` : 'Nobody was signed in on the phone'}</div>
          <div className="small">{p.callStarted ? 'The phone started a call to the control room.' : 'The phone could not start a call.'}</div>
          {!!p.emergencyCalls?.length && (
            <div className="small">
              Then phoned: {p.emergencyCalls.map((c) => `${emergencyCallText(c)} at ${formatDateTime(c.calledAt)}`).join('; ')}.
            </div>
          )}
          <div className="small">
            {p.lat != null && p.lng != null ? (
              <>
                Location: <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer">open on a map</a>
                {p.accuracyM != null && ` (within about ${Math.round(p.accuracyM)} m)`}
                {p.locationMock && <Pill tone="red">Location may be faked</Pill>}
              </>
            ) : (
              'No location: the phone could not get one in time.'
            )}
          </div>
        </div>
        <div>
          {p.resolvedAt ? <Pill tone="green">Resolved</Pill> : p.acknowledgedAt ? <Pill tone="amber">Acknowledged</Pill> : <Pill tone="red">Not acknowledged</Pill>}
        </div>
      </div>
      {p.acknowledgedAt && (
        <p className="small mute" style={{ marginBottom: 0 }}>
          Acknowledged by {p.acknowledgedBy} at {formatDateTime(p.acknowledgedAt)}.
        </p>
      )}
      {p.resolvedAt && (
        <p className="small" style={{ marginBottom: 0 }}>
          Resolved by {p.resolvedBy} at {formatDateTime(p.resolvedAt)}: {p.resolutionNote}
        </p>
      )}
      <ErrorBanner error={error} />
      {open && !canManage && (
        <p className="small mute" style={{ marginBottom: 0 }}>
          Only a company manager, site manager or site supervisor can acknowledge and resolve a panic. Sign in with one of those accounts.
        </p>
      )}
      {open && canManage && (
        <div style={{ marginTop: 10 }}>
          {!p.acknowledgedAt && (
            <button className="btn danger" disabled={busy} onClick={() => act('acknowledge')}>
              Acknowledge: I am dealing with it
            </button>
          )}
          <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
            <label style={{ flex: 1 }}>
              <span className="small">What happened? (needed to resolve)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: armed response attended, false alarm" />
            </label>
            <button className="btn" disabled={busy || note.trim().length < 3} onClick={() => act('resolve', { note })}>
              Resolve
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
