'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, formatDateTime } from '@/components/ui';
import { ago, clock, tel } from '@/lib/supervisor';
import { EmergencyCall, emergencyCallText } from '@/components/PanicBanner';

interface Panic {
  id: string;
  siteName: string;
  postName: string;
  raisedAt: string;
  lateSynced: boolean;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  locationMock: boolean;
  callStarted: boolean;
  emergencyCalls: EmergencyCall[];
  guard: string | null;
  employeeNumber: string | null;
  guardCell: string | null;
  controlRoom: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  canManage: boolean;
}

/** Supervisor app, one panic: where, who, when, the numbers to call, then acknowledge and resolve. */
export default function MobilePanic() {
  const { id } = useParams<{ id: string }>();
  const [p, setP] = useState<Panic | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = () =>
    api<Panic>(`/supervisor/panic/${id}`)
      .then((x) => (setP(x), setError(null)))
      .catch(setError);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function act(path: string, json: unknown = {}) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', json });
      await load();
      window.dispatchEvent(new Event('onpar:alerts'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!p) {
    return (
      <>
        <ErrorBanner error={error} />
        {!error && <p className="mute">Loading…</p>}
        <p className="m-foot">
          <Link href="/m/alerts">Back to open alerts</Link>
        </p>
      </>
    );
  }

  const open = !p.resolvedAt;
  return (
    <>
      <div className={`m-panic-head${open ? '' : ' done'}`} role={open ? 'alert' : undefined}>
        <b>{open ? 'PANIC' : 'Panic, resolved'}</b>
        <span className="where">{p.siteName}</span>
        <span>{p.postName}</span>
      </div>
      <ErrorBanner error={error} />

      <div className="card">
        <div className="line">
          <span>Raised</span>
          <b>
            {clock(p.raisedAt)} · {ago(p.raisedAt)}
          </b>
        </div>
        <div className="line">
          <span>Guard</span>
          <b>{p.guard ? `${p.guard}${p.employeeNumber ? ` (${p.employeeNumber})` : ''}` : 'Nobody was signed in on the phone'}</b>
        </div>
        {p.callStarted && (
          <div className="line">
            <span>Phone’s call to the control room</span>
            <b>Started</b>
          </div>
        )}
        <div className="line">
          <span>Who the guard phoned from the emergency panel</span>
          <b>{p.emergencyCalls.length ? p.emergencyCalls.map((c) => `${emergencyCallText(c)} ${clock(c.calledAt)}`).join(', ') : 'Nobody yet'}</b>
        </div>
        <div className="line">
          <span>Location at that moment</span>
          <b>
            {p.lat != null && p.lng != null ? (
              <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer">
                Open in Maps{p.accuracyM != null ? ` (within ${Math.round(p.accuracyM)} m)` : ''}
              </a>
            ) : (
              'Not available'
            )}
          </b>
        </div>
        {p.locationMock && <div className="banner warn" style={{ marginTop: 10 }}>The phone reported a fake-location app. Do not rely on this location.</div>}
        {p.lateSynced && <div className="banner warn" style={{ marginTop: 10 }}>This panic was pressed while the phone had no signal and arrived late. Raised at {formatDateTime(p.raisedAt)}.</div>}
      </div>

      <div className="m-actions tall">
        {p.guardCell && (
          <a className="btn" href={tel(p.guardCell)}>
            Call {p.guard?.split(' ')[0] ?? 'guard'}
          </a>
        )}
        {p.controlRoom && (
          <a className="btn ghost" href={tel(p.controlRoom)}>
            Call control room
          </a>
        )}
      </div>

      <div className="card">
        <h2>Response</h2>
        <p>{p.acknowledgedAt ? `Acknowledged by ${p.acknowledgedBy ?? 'someone'} at ${clock(p.acknowledgedAt)}.` : 'Nobody has acknowledged this panic yet.'}</p>
        {!open && (
          <>
            <p>
              Resolved by {p.resolvedBy ?? 'someone'} at {clock(p.resolvedAt)}.
            </p>
            <p className="mute">{p.resolutionNote}</p>
          </>
        )}
        {open && p.canManage && (
          <>
            {!p.acknowledgedAt && (
              <button className="btn danger m-wide" disabled={busy} onClick={() => act(`/panic/${p.id}/acknowledge`)}>
                {busy ? 'Saving…' : 'Acknowledge: I am dealing with it'}
              </button>
            )}
            <form
              className="m-form"
              onSubmit={(e) => {
                e.preventDefault();
                act(`/panic/${p.id}/resolve`, { note });
              }}
            >
              <label className="f">
                <span>When it is over: what happened?</span>
                <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: false alarm, guard confirmed safe by phone" minLength={3} required />
              </label>
              <button className="btn ghost m-wide" disabled={busy || note.trim().length < 3}>
                Resolve this panic
              </button>
            </form>
          </>
        )}
      </div>
      <p className="m-foot">
        <Link href="/m/alerts">Back to open alerts</Link>
      </p>
    </>
  );
}
