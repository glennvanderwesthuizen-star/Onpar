'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Priority, ReportCategory, REPORT_CATEGORIES, Stage } from '@onpar/rules';
import { api } from '@/lib/api';
import { ErrorBanner, useLoad } from '@/components/ui';
import { ReportBadge, StagePill, TrafficLight } from '@/components/reports';
import { ago } from '@/lib/supervisor';

interface Row {
  id: string;
  number: number;
  colour: string;
  siteName: string;
  category: ReportCategory;
  priority: Priority;
  description: string;
  stage: Stage;
  needsAttention: boolean;
  reportedAt: string;
  reportedBy: string;
  assigneeName: string | null;
}

/** Supervisor app, Reports: the open reports at the supervisor's sites; tap one to act on it. */
export default function MobileReports() {
  const [only, setOnly] = useState<'all' | 'attention'>('all');
  const { data, error } = useLoad(() => api<{ rows: Row[]; counts: { outstanding: number; needsAttention: number; redOpen: number } }>('/reports?status=open'));
  // Waiting on the supervisor: an officer followed up, or nobody has been assigned yet.
  const waiting = (r: Row) => r.needsAttention || r.stage === 'reported';
  const rows = data?.rows.filter((r) => only === 'all' || waiting(r)) ?? [];
  return (
    <>
      <h1 className="m-h1">Open reports</h1>
      <ErrorBanner error={error} />
      {!data && !error && <p className="mute">Loading…</p>}
      {data && (
        <>
          <div className="m-seg" role="group" aria-label="Which reports">
            <button aria-pressed={only === 'all'} onClick={() => setOnly('all')}>
              All open ({data.rows.length})
            </button>
            <button aria-pressed={only === 'attention'} onClick={() => setOnly('attention')}>
              Waiting on you ({data.rows.filter(waiting).length})
            </button>
          </div>
          {rows.length === 0 && <div className="m-allclear">{only === 'all' ? <b>No open reports.</b> : <b>Nothing is waiting on you.</b>}</div>}
          {rows.length > 0 && (
            <div className="card" style={{ padding: 0 }}>
              {rows.map((r) => (
                <Link key={r.id} href={`/m/reports/${r.id}`} className="m-row">
                  <ReportBadge number={r.number} colour={r.colour} />
                  <span className="what">
                    <b>
                      {REPORT_CATEGORIES[r.category]} <TrafficLight priority={r.priority} />
                    </b>
                    <span>{r.description.length > 90 ? `${r.description.slice(0, 90)}…` : r.description}</span>
                    <span className="mute small">
                      {r.siteName} · {ago(r.reportedAt)} · {r.assigneeName ? `with ${r.assigneeName}` : 'nobody assigned'}
                    </span>
                    <span>
                      <StagePill stage={r.stage} /> {r.needsAttention && <span className="pill amber">Officer followed up</span>}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
