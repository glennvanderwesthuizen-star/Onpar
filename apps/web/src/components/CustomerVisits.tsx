'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { AuthPhoto } from './AuthPhoto';
import { PassForm } from './CustomerPasses';

type PassOptions = React.ComponentProps<typeof PassForm>['options'];
import { ErrorBanner, formatDateTime } from './ui';

export interface CustomerVisit {
  id: string;
  type: 'vehicle' | 'pedestrian';
  status: string;
  statusLabel: string;
  at: string;
  visitor: string;
  vehicle: string | null;
  pax: number | null;
  category: string;
  gateName: string;
  visiting: string;
  hasFace: boolean;
  outcome: string | null;
  canPass: boolean;
  /** While on site: when they are due to leave, and what this unit told the gate. */
  stay?: { dueAt: string | null; overdue: boolean; overBy: string | null; says: string | null; contractor: boolean } | null;
}

/**
 * One visitor waiting at the gate, with Accept and Refuse (visitor management, step 3). The
 * first answer for the unit counts; if someone else answered first, this says so.
 */
export function VisitRequest({ visit, onChange }: { visit: CustomerVisit; onChange: (v: CustomerVisit | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const waiting = visit.status === 'awaiting_approval';
  const [passing, setPassing] = useState(false);
  const [passed, setPassed] = useState(false);
  const [options, setOptions] = useState<PassOptions | null>(null);
  const openPass = () =>
    api<PassOptions>('/customer/passes')
      .then((o) => {
        setOptions(o);
        setPassing(true);
      })
      .catch(setError);

  const [until, setUntil] = useState('');
  async function stay(answer: 'extended' | 'should_have_left') {
    setBusy(true);
    setError(null);
    try {
      onChange(await api<CustomerVisit>(`/customer/visits/${visit.id}/stay`, { method: 'POST', json: { answer, until: answer === 'extended' ? until : null } }));
      setUntil('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'accept' | 'refuse') {
    setBusy(true);
    setError(null);
    try {
      onChange(await api<CustomerVisit>(`/customer/visits/${visit.id}/decide`, { method: 'POST', json: { decision } }));
    } catch (e) {
      setError(e);
      // Someone else may have answered: show how it stands now.
      onChange(await api<CustomerVisit>(`/customer/visits/${visit.id}`).catch(() => null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card m-alert ${waiting ? 'amber' : visit.status === 'on_site' ? '' : 'red'}`}>
      <div className="mute small">
        {waiting ? 'At the gate now' : visit.statusLabel} · {visit.gateName} · {formatDateTime(visit.at)}
      </div>
      <h3>{visit.visitor}</h3>
      <div>
        {visit.vehicle ?? 'On foot'}
        {visit.pax !== null && visit.type === 'vehicle' ? ` · ${visit.pax} passenger${visit.pax === 1 ? '' : 's'}` : ''}
      </div>
      <div className="mute small">
        {visit.category} · to see {visit.visiting.toLowerCase() === 'the office' ? 'the office' : visit.visiting}
      </div>
      {visit.hasFace && (
        <div style={{ marginTop: 10 }}>
          <AuthPhoto path={`/customer/visits/${visit.id}/face`} alt="The visitor's face, photographed at the gate" width={300} />
        </div>
      )}
      <ErrorBanner error={error} />
      {waiting ? (
        <div className="m-actions tall" style={{ marginTop: 12, marginBottom: 0 }}>
          <button className="btn" disabled={busy} onClick={() => decide('accept')}>
            Accept
          </button>
          <button className="btn danger" disabled={busy} onClick={() => decide('refuse')}>
            Refuse
          </button>
        </div>
      ) : (
        <div className={`banner ${visit.status === 'on_site' ? 'ok' : 'err'}`} style={{ marginTop: 12, marginBottom: 0 }} role="status">
          <b>{visit.outcome ?? visit.statusLabel}</b>
        </div>
      )}
      {visit.status === 'on_site' && visit.stay && (
        <div style={{ marginTop: 12 }}>
          {visit.stay.overdue ? (
            <div className="banner warn" role="status">
              <b>Still on site, {visit.stay.overBy} past the time to be gone by.</b> Is your {visit.stay.contractor ? 'contractor' : 'visitor'} still busy?
            </div>
          ) : (
            visit.stay.dueAt && (
              <p className="mute small" style={{ margin: 0 }}>
                Due to leave by {formatDateTime(visit.stay.dueAt)}.
              </p>
            )
          )}
          {visit.stay.says && (
            <p className="small" style={{ margin: '6px 0 0' }}>
              You told the gate: <b>{visit.stay.says}</b>
            </p>
          )}
          {(visit.stay.overdue || visit.stay.dueAt) && (
            <>
              <label className="f" style={{ marginTop: 10 }}>
                <span>Still busy until</span>
                <input type="time" value={until} onChange={(e) => setUntil(e.target.value)} />
              </label>
              <div className="m-actions" style={{ marginBottom: 0 }}>
                <button className="btn" disabled={busy || !until} onClick={() => stay('extended')}>
                  Tell the gate
                </button>
                {visit.stay.overdue && (
                  <button className="btn danger" disabled={busy} onClick={() => stay('should_have_left')}>
                    Should have left
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {visit.canPass && !passing && !passed && (
        <button className="btn ghost m-wide" style={{ marginTop: 10 }} onClick={openPass}>
          Let them in next time without asking
        </button>
      )}
      {passed && (
        <div className="banner ok" style={{ marginTop: 10, marginBottom: 0 }} role="status">
          The gate has been told. They are on your Visitors list.
        </div>
      )}
      {passing && options && (
        <div style={{ marginTop: 12 }}>
          <PassForm options={options} fromVisit={visit.id} startName={visit.visitor} onCancel={() => setPassing(false)} onDone={() => (setPassing(false), setPassed(true))} />
        </div>
      )}
    </article>
  );
}

interface OnSiteVisitor {
  id: string;
  visitor: string;
  vehicle: string | null;
  pax: number | null;
  category: string;
  enteredAt: string;
  stay: string;
  overdue: boolean;
  overBy: string | null;
}

/** The Visitors part of the customer's Home: who is waiting at the gate, and the last few answered. */
export function CustomerVisits() {
  const [data, setData] = useState<{ waiting: CustomerVisit[]; recent: CustomerVisit[]; onSite: OnSiteVisitor[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    api<{ waiting: CustomerVisit[]; recent: CustomerVisit[]; onSite: OnSiteVisitor[] }>('/customer/visits')
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(setError);
  }, []);
  // A visitor is waiting at a gate, so this page keeps itself fresh while it is open.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    window.addEventListener('onpar:alerts', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('onpar:alerts', load);
    };
  }, [load]);

  return (
    <section style={{ marginTop: 12 }}>
      {data?.waiting.map((v) => <VisitRequest key={v.id} visit={v} onChange={load} />)}
      <div className="card">
        <h2>Visitors</h2>
        {!data && !error && <p className="mute">Loading…</p>}
        {!data && <ErrorBanner error={error} />}
        {data && data.waiting.length === 0 && <p className="mute">Nobody is waiting at the gate for you. When a visitor arrives, you get an alert and they show here.</p>}
        {data && data.onSite.length > 0 && (
          <>
            <h3 style={{ marginTop: 10 }}>On site now ({data.onSite.length})</h3>
            {data.onSite.map((v) => (
              <Link key={v.id} href={`/c/visits/${v.id}`} className="line" style={{ textDecoration: 'none', color: 'inherit' }}>
                <span>
                  <b>{v.visitor}</b>
                  <span className="mute small" style={{ display: 'block' }}>
                    {v.vehicle ?? 'On foot'} · {v.category}
                  </span>
                </span>
                <span className="small" style={{ textAlign: 'right' }}>
                  {v.stay}
                  {v.overdue && (
                    <b style={{ display: 'block', color: 'var(--red, #b3261e)' }}>
                      {v.overBy} past their time
                    </b>
                  )}
                </span>
              </Link>
            ))}
          </>
        )}
        {data && data.recent.length > 0 && (
          <>
            <h3 style={{ marginTop: 10 }}>The last few days</h3>
            {data.recent.slice(0, 8).map((v) => (
              <Link key={v.id} href={`/c/visits/${v.id}`} className="line" style={{ textDecoration: 'none', color: 'inherit' }}>
                <span>
                  <b>{v.visitor}</b>
                  <span className="mute small" style={{ display: 'block' }}>
                    {formatDateTime(v.at)} · {v.vehicle ?? 'On foot'}
                  </span>
                </span>
                <span className="small" style={{ textAlign: 'right' }}>
                  {v.outcome ?? v.statusLabel}
                </span>
              </Link>
            ))}
          </>
        )}
        <Link className="btn ghost m-wide" style={{ marginTop: 12, textDecoration: 'none' }} href="/c/visitors">
          Tell the gate who is coming
        </Link>
        <Link className="btn ghost m-wide" style={{ marginTop: 8, textDecoration: 'none' }} href="/c/history">
          History: all past visitors
        </Link>
      </div>
    </section>
  );
}
