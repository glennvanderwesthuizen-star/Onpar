'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDateTime, useLoad } from './ui';

interface Person {
  key: string;
  kind: 'visitor' | 'staff' | 'guard';
  name: string;
  detail: string;
  headcount: number;
  leftAt: string | null;
  status: 'safe' | 'missing' | null;
  markedBy: string | null;
  markedAt: string | null;
}
interface Counts {
  people: number;
  safe: number;
  missing: number;
  left: number;
  waiting: number;
}
interface Call {
  id: string;
  reason: string;
  startedAt: string;
  startedBy: string;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string;
  people: Person[];
  counts: Counts;
}
interface Calls {
  current: Call | null;
  past: Omit<Call, 'people'>[];
}

const KIND = { visitor: 'Visitor', staff: 'Staff', guard: 'Guard' };

/**
 * The emergency roll-call (visitor specification): everyone on site, visitors with their
 * passengers and the guards on duty, ticked off at the assembly point. Made to be used on a
 * phone: big buttons, and the list refreshes itself every ten seconds.
 */
export function RollCall({ siteId, full = false }: { siteId: string; full?: boolean }) {
  const { can } = useSession();
  const allowed = can('visitors.view');
  const mayAct = can('visitors.exceptions');
  const { data, error, reload } = useLoad(() => (allowed ? api<Calls>(`/sites/${siteId}/roll-calls`) : Promise.resolve({ current: null, past: [] })), [siteId, allowed]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [current, setCurrent] = useState<Call | null>(null);
  useEffect(() => setCurrent(data?.current ?? null), [data]);
  useEffect(() => {
    if (!current) return;
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [current, reload]);
  if (!allowed) return null;

  async function act(path: string, json: unknown) {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api<Call>(path, { method: 'POST', json });
      setCurrent(r.closedAt ? null : r);
      if (r.closedAt) reload();
      return r;
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  if (!full) {
    // On the site page: a short card that leads to the full list.
    return (
      <div className="card">
        <h2>Emergency roll-call {current && <Pill tone="red">Going on</Pill>}</h2>
        <ErrorBanner error={error ?? problem} />
        {current ? (
          <p>
            Started {formatDateTime(current.startedAt)} by {current.startedBy}. {current.counts.safe} of {current.counts.people} safe, {current.counts.waiting} not yet ticked.{' '}
            <Link href={`/sites/${siteId}/roll-call`}>Open the list</Link>
          </p>
        ) : (
          <>
            <p className="mute small">Everyone on site (visitors with their passengers, staff and the guards on duty) on one list, to tick off at the assembly point. Everyone who looks after this site is alerted.</p>
            {mayAct && (
              <div className="row">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why, for example: fire alarm in block B" style={{ maxWidth: 360 }} />
                <button
                  className="btn"
                  style={{ background: 'var(--red, #b3261e)' }}
                  disabled={busy}
                  onClick={async () => {
                    const r = await act(`/sites/${siteId}/roll-calls`, { reason });
                    if (r) window.location.href = `/sites/${siteId}/roll-call`;
                  }}
                >
                  Start a roll-call
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <ErrorBanner error={error ?? problem} />
      {!data && <p className="mute">Loading…</p>}
      {data && !current && (
        <div className="card">
          <p>No roll-call is going on at this site.</p>
          {mayAct && (
            <div className="row">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why, for example: fire alarm in block B" />
              <button className="btn" style={{ background: 'var(--red, #b3261e)' }} disabled={busy} onClick={() => act(`/sites/${siteId}/roll-calls`, { reason })}>
                Start a roll-call
              </button>
            </div>
          )}
        </div>
      )}
      {current && (
        <>
          <div className="card">
            <h2>
              {current.counts.safe} of {current.counts.people} safe
            </h2>
            <p>
              {current.counts.waiting > 0 && <Pill tone="amber">{current.counts.waiting} not yet ticked</Pill>} {current.counts.missing > 0 && <Pill tone="red">{current.counts.missing} missing</Pill>}{' '}
              {current.counts.left > 0 && <Pill tone="grey">{current.counts.left} left the site since it started</Pill>}
            </p>
            <p className="mute small">
              Started {formatDateTime(current.startedAt)} by {current.startedBy}
              {current.reason ? `: ${current.reason}` : ''}. A vehicle counts its driver and passengers together. Anyone who comes in now joins the list.
            </p>
          </div>
          {current.people.map((p) => (
            <div key={p.key} className="card" style={{ padding: 12, borderLeft: `6px solid ${p.status === 'safe' ? '#0c4a34' : p.status === 'missing' ? '#b3261e' : p.leftAt ? '#999' : '#b86e00'}` }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b style={{ fontSize: 18 }}>{p.name}</b> <span className="mute small">{KIND[p.kind]}</span>
                  {p.headcount > 1 && <Pill tone="blue">{p.headcount} people</Pill>}
                  <div className="small">{p.detail}</div>
                  {p.leftAt && <div className="small mute">Left at {formatDateTime(p.leftAt)}</div>}
                  {p.status && (
                    <div className="small mute">
                      {p.status === 'safe' ? 'Safe' : 'Missing'}, ticked by {p.markedBy} at {formatDateTime(p.markedAt)}
                    </div>
                  )}
                </div>
                {mayAct && (
                  <div className="row">
                    <button className="btn" style={{ minHeight: 48, minWidth: 96 }} disabled={busy || p.status === 'safe'} onClick={() => act(`/sites/${siteId}/roll-calls/${current.id}/mark`, { personKey: p.key, status: 'safe' })}>
                      Safe
                    </button>
                    <button
                      className="btn ghost"
                      style={{ minHeight: 48, minWidth: 96, color: '#b3261e' }}
                      disabled={busy || p.status === 'missing'}
                      onClick={() => act(`/sites/${siteId}/roll-calls/${current.id}/mark`, { personKey: p.key, status: 'missing' })}
                    >
                      Missing
                    </button>
                    {p.status && (
                      <button className="btn ghost sm" disabled={busy} onClick={() => act(`/sites/${siteId}/roll-calls/${current.id}/mark`, { personKey: p.key, status: 'clear' })}>
                        Undo
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {!current.people.length && <p className="mute">Nobody is recorded as on site.</p>}
          {mayAct && (
            <div className="card">
              <h2>Close the roll-call</h2>
              <Field label={current.counts.waiting || current.counts.missing ? 'What happened to those not ticked safe (needed)' : 'Note (optional)'}>
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <button className="btn" disabled={busy} onClick={() => act(`/sites/${siteId}/roll-calls/${current.id}/close`, { note })}>
                Close the roll-call
              </button>
            </div>
          )}
        </>
      )}
      {data && !!data.past.length && (
        <div className="card">
          <h2>Earlier roll-calls</h2>
          {data.past.map((c) => (
            <div key={c.id} className="small" style={{ marginTop: 6 }}>
              <b>{formatDateTime(c.startedAt)}</b> {c.reason && `· ${c.reason}`} · {c.counts.safe} of {c.counts.people} safe
              {c.counts.missing ? `, ${c.counts.missing} missing` : ''} · closed {formatDateTime(c.closedAt)} by {c.closedBy}
              {c.closeNote && <span className="mute"> · {c.closeNote}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
