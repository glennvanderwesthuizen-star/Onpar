'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDateTime, useLoad } from './ui';
import { time } from './attendance';
import { everyWhileVisible } from '@/lib/poll';

export function PatrolState({ state, review }: { state: string; review?: string | null }) {
  switch (state) {
    case 'completed':
      return <Pill tone="green">Completed</Pill>;
    case 'active':
      return <Pill tone="blue">In progress</Pill>;
    case 'partial':
      return <Pill tone={review === 'accepted' ? 'blue' : review === 'not_accepted' ? 'red' : 'amber'}>Ended early{review ? (review === 'accepted' ? ' · accepted' : ' · not accepted') : ' · to review'}</Pill>;
    default:
      return <Pill tone="red">Missed</Pill>;
  }
}

/**
 * A printable checkpoint plate for a patrol point, laid out like the plates TSF already
 * uses: company logo, a large QR code, then checkpoint, site and customer. The code
 * printed small at the bottom can be typed in if the sticker is damaged.
 */
export function QrCard({ code, checkpoint, site, customer, patrol }: { code: string; checkpoint: string; site: string; customer?: string; patrol?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(code, { margin: 1, width: 600, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [code]);
  return (
    <div className="qr-plate">
      <img className="qr-logo" src="/tsf-logo.png" alt="" />
      <div className="qr-code">{src ? <img src={src} alt={`QR code for ${checkpoint}`} /> : null}</div>
      <div className="qr-lines">
        <div>
          Checkpoint: <b>{checkpoint}</b>
        </div>
        <div>Site: {site}</div>
        {customer && <div>Customer: {customer}</div>}
        {patrol && <div className="qr-patrol">Patrol: {patrol}</div>}
      </div>
      <div className="qr-foot">
        <span className="logo">
          On<i>Par</i>
        </span>
        <span className="qr-id">{code}</span>
      </div>
    </div>
  );
}

/** A plain QR code with a label, for the phone setup code on the Devices page. */
export function SimpleQr({ code, name, sub }: { code: string; name: string; sub?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(code, { margin: 1, width: 400, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [code]);
  return (
    <div className="qr">
      {src ? <img src={src} alt={`QR code for ${name}`} /> : <div style={{ width: 140, height: 140 }} />}
      <b>{name}</b>
      {sub && <div style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

interface Alert {
  id: string;
  patrolId: string;
  raisedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  escalatedAt: string | null;
  employeeName: string;
  employeeCell: string;
  siteName: string;
  typeName: string;
  typeCode: string;
  startedAt: string;
  maxDurationMinutes: number;
  controlRoom: string | null;
}

/** Open overdue-patrol alerts, with acknowledge and "guard is safe". Refreshes every 30 seconds. */
export function PatrolAlerts({ onChange }: { onChange?: () => void }) {
  const { can } = useSession();
  const { data, reload } = useLoad(() => api<Alert[]>('/patrols/alerts'));
  const [note, setNote] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const t = everyWhileVisible(reload, 30_000);
    return () => t();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data?.length) return null;
  const act = async (path: string, body?: unknown) => {
    setError(null);
    try {
      await api(path, { method: 'POST', json: body ?? {} });
      reload();
      onChange?.();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div role="alert">
      <ErrorBanner error={error} />
      {data.map((a) => (
        <div key={a.id} className={`alert-card ${a.escalatedAt ? 'escalated' : ''}`}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>
              ⚠ Patrol overdue: {a.employeeName}, {a.typeName} ({a.typeCode}) at {a.siteName}
            </b>
            {a.escalatedAt ? <Pill tone="red">Escalated to control room {time(a.escalatedAt)}</Pill> : <Pill tone="amber">Raised {time(a.raisedAt)}</Pill>}
          </div>
          <p className="small" style={{ margin: '4px 0' }}>
            Started {time(a.startedAt)}, should have finished within {a.maxDurationMinutes} minutes. Call the officer:{' '}
            <a href={`tel:${a.employeeCell}`}>{a.employeeCell}</a>
            {a.controlRoom && (
              <>
                {' '}
                · Control room: <a href={`tel:${a.controlRoom}`}>{a.controlRoom}</a>
              </>
            )}
            {a.acknowledgedAt && ` · Acknowledged by ${a.acknowledgedBy} at ${time(a.acknowledgedAt)}`}
          </p>
          {can('patrols.alerts') && (
            <div className="row">
              {!a.acknowledgedAt && (
                <button className="btn ghost sm" onClick={() => act(`/patrols/alerts/${a.id}/acknowledge`)}>
                  Acknowledge
                </button>
              )}
              <input
                style={{ maxWidth: 340 }}
                placeholder="How did you confirm the guard is safe?"
                value={note[a.id] ?? ''}
                onChange={(e) => setNote({ ...note, [a.id]: e.target.value })}
              />
              <button className="btn sm" disabled={(note[a.id] ?? '').trim().length < 3} onClick={() => act(`/patrols/alerts/${a.id}/safe`, { note: note[a.id] })}>
                Guard is safe
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** A small form helper: shows server field errors under inputs. */
export function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, errors: error instanceof ApiError ? error.errors : ({} as Record<string, string>), run };
}

export { Field, formatDateTime };
