'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner } from '@/components/ui';
import { useSession } from '@/lib/session';
import { ago, ALERT_TONE, clock, OpenAlert, tel, useHome } from '@/lib/supervisor';

const KIND: Record<OpenAlert['type'], string> = { panic: 'Panic', post_uncovered: 'Post uncovered', patrol_overdue: 'Patrol overdue', bolo: 'BOLO', red_report: 'Red report' };

/** Supervisor app, Alerts: everything open across the supervisor's sites, with what can be done about each. */
export default function MobileAlerts() {
  const { can } = useSession();
  const { data, error, stale, reload } = useHome();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [safeFor, setSafeFor] = useState<string | null>(null);
  const [note, setNote] = useState('');

  async function act(id: string, path: string, json: unknown = {}) {
    setBusy(id);
    setActionError(null);
    try {
      await api(path, { method: 'POST', json });
      setSafeFor(null);
      setNote('');
      await reload();
      window.dispatchEvent(new Event('onpar:alerts'));
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1 className="m-h1">Open alerts</h1>
      {stale && <div className="banner warn">No connection. Showing the last update{data ? ` from ${clock(data.now)}` : ''}.</div>}
      {!data && <ErrorBanner error={error} />}
      <ErrorBanner error={actionError} />
      {!data && !error && <p className="mute">Loading…</p>}
      {data && data.alerts.length === 0 && (
        <div className="m-allclear">
          <b>Nothing is open.</b>
          <span className="mute small">Checked at {clock(data.now)}.</span>
        </div>
      )}
      {data?.alerts.map((a) => (
        <article key={`${a.type}:${a.id}`} className={`card m-alert ${ALERT_TONE[a.type]}`}>
          <div className="m-alert-head">
            <span className={`pill ${ALERT_TONE[a.type]}`}>{KIND[a.type]}</span>
            <span className="mute small">
              {clock(a.at)} · {ago(a.at)}
            </span>
          </div>
          <h3>{a.title}</h3>
          {a.detail && <p>{a.detail}</p>}
          {a.type !== 'post_uncovered' && a.type !== 'red_report' && (
            <p className="mute small">{a.acknowledgedAt ? `Acknowledged by ${a.acknowledgedBy ?? 'someone'} at ${clock(a.acknowledgedAt)}` : 'Not yet acknowledged'}</p>
          )}

          <div className="m-actions">
            {a.type === 'panic' && (
              <Link className="btn danger" href={a.url}>
                Open panic
              </Link>
            )}
            {a.type === 'post_uncovered' && (
              <Link className="btn" href={a.url}>
                See guards on duty
              </Link>
            )}
            {a.type === 'red_report' && (
              <Link className="btn" href={a.url}>
                Open report
              </Link>
            )}
            {a.type === 'bolo' && (
              <>
                <Link className="btn" href={a.url}>
                  Open BOLO
                </Link>
                {!a.acknowledgedAt && can('panic.manage') && (
                  <button className="btn ghost" disabled={busy === a.id} onClick={() => act(a.id, `/bolos/${a.id}/acknowledge`)}>
                    Acknowledge
                  </button>
                )}
              </>
            )}
            {a.type === 'patrol_overdue' && can('patrols.alerts') && (
              <>
                {!a.acknowledgedAt && (
                  <button className="btn" disabled={busy === a.id} onClick={() => act(a.id, `/patrols/alerts/${a.id}/acknowledge`)}>
                    Acknowledge
                  </button>
                )}
                <button className="btn ghost" disabled={busy === a.id} onClick={() => (setSafeFor(safeFor === a.id ? null : a.id), setNote(''))}>
                  Guard is safe
                </button>
              </>
            )}
            {a.guardCell && (
              <a className="btn ghost" href={tel(a.guardCell)}>
                Call guard
              </a>
            )}
          </div>

          {safeFor === a.id && (
            <form
              className="m-form"
              onSubmit={(e) => {
                e.preventDefault();
                act(a.id, `/patrols/alerts/${a.id}/safe`, { note });
              }}
            >
              <label className="f">
                <span>How did you confirm the guard is safe?</span>
                <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: spoke to him by phone at 22:14" required minLength={3} />
              </label>
              <button className="btn" disabled={busy === a.id || note.trim().length < 3}>
                {busy === a.id ? 'Saving…' : 'Confirm and close the alert'}
              </button>
            </form>
          )}
        </article>
      ))}
      <p className="m-foot">
        <Link href="/alerts">All alerts sent to you</Link>
      </p>
    </>
  );
}
