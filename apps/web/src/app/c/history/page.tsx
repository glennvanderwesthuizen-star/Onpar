'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { ErrorBanner, formatDateTime, useLoad } from '@/components/ui';

interface PastVisit {
  id: string;
  visitor: string;
  vehicle: string | null;
  category: string;
  statusLabel: string;
  outcome: string | null;
  at: string;
  enteredAt: string | null;
  exitAt: string | null;
  exceptions: string[];
}

/** Customer app, History (visitor management, step 6): this customer's past visitors, and anything that did not match at the gate. */
export default function CustomerHistory() {
  const { data, error } = useLoad(() => api<PastVisit[]>('/customer/visits/history'), []);
  return (
    <>
      <h1 className="m-h1">History</h1>
      <p className="mute small" style={{ marginTop: -8 }}>
        Your last 100 visitors, newest first.
      </p>
      <ErrorBanner error={error} />
      <div className="card">
        {!data && !error && <p className="mute">Loading…</p>}
        {data && data.length === 0 && <p className="mute">No visitors yet.</p>}
        {data?.map((v) => (
          <Link key={v.id} href={`/c/visits/${v.id}`} className="line" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span>
              <b>{v.visitor}</b>
              <span className="mute small" style={{ display: 'block' }}>
                {v.vehicle ?? 'On foot'} · {v.category}
              </span>
              <span className="mute small" style={{ display: 'block' }}>
                {v.enteredAt ? `In ${formatDateTime(v.enteredAt)}` : formatDateTime(v.at)}
                {v.exitAt ? ` · out ${formatDateTime(v.exitAt)}` : ''}
              </span>
              {v.exceptions.map((x) => (
                <b key={x} className="small" style={{ display: 'block', color: 'var(--red, #b3261e)' }}>
                  {x}
                </b>
              ))}
            </span>
            <span className="small" style={{ textAlign: 'right' }}>
              {v.outcome ?? v.statusLabel}
            </span>
          </Link>
        ))}
      </div>
      <p className="m-foot">
        <Link className="btn ghost" style={{ minHeight: 44, textDecoration: 'none' }} href="/c">
          Back to Home
        </Link>
      </p>
    </>
  );
}
