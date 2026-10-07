'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { AuthPhoto } from './AuthPhoto';
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
}

/**
 * One visitor waiting at the gate, with Accept and Refuse (visitor management, step 3). The
 * first answer for the unit counts; if someone else answered first, this says so.
 */
export function VisitRequest({ visit, onChange }: { visit: CustomerVisit; onChange: (v: CustomerVisit | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const waiting = visit.status === 'awaiting_approval';

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
    </article>
  );
}

/** The Visitors part of the customer's Home: who is waiting at the gate, and the last few answered. */
export function CustomerVisits() {
  const [data, setData] = useState<{ waiting: CustomerVisit[]; recent: CustomerVisit[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    api<{ waiting: CustomerVisit[]; recent: CustomerVisit[] }>('/customer/visits')
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
        <p className="mute small" style={{ marginTop: 10 }}>
          Coming next: tell the gate in advance who is coming, and at which gate.
        </p>
      </div>
    </section>
  );
}
