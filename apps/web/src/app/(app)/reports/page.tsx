'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Priority, ReportCategory, REPORT_CATEGORIES, Stage } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, formatDateTime, useLoad } from '@/components/ui';
import { ReportBadge, StagePill, TrafficLight } from '@/components/reports';

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
  routedToMe: boolean;
  reportedAt: string;
  reportedBy: string;
  assigneeName: string | null;
  source: string;
  hasPhoto: boolean;
}

interface List {
  rows: Row[];
  counts: { reported: number; resolved: number; outstanding: number; needsAttention: number; redOpen: number };
}

export default function ReportsPage() {
  const { can } = useSession();
  const router = useRouter();
  const [status, setStatus] = useState('open');
  const [siteId, setSiteId] = useState('');
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const { data, error } = useLoad(() => api<List>(`/reports?status=${status}${siteId ? `&siteId=${siteId}` : ''}`), [status, siteId]);
  const c = data?.counts;

  return (
    <>
      <div className="head">
        <div>
          <h1>Reports</h1>
          <p className="mute">
            {c ? `${c.reported} reported, ${c.resolved} resolved, ${c.outstanding} outstanding.` : 'Everything reported, from first report to sign-off.'}
          </p>
        </div>
        <div className="row">
          <Link className="btn ghost" href="/reports/people">
            People directory
          </Link>
          {can('reports.manage') && (
            <Link className="btn" href="/reports/new">
              + New report
            </Link>
          )}
        </div>
      </div>

      <div className="tiles">
        <div className="tile">
          <b>{c?.outstanding ?? '–'}</b>
          <span>Outstanding</span>
        </div>
        <div className="tile">
          <b style={{ color: c?.needsAttention ? 'var(--amber)' : undefined }}>{c?.needsAttention ?? '–'}</b>
          <span>Officer followed up, needs you</span>
        </div>
        <div className="tile">
          <b style={{ color: c?.redOpen ? 'var(--red)' : undefined }}>{c?.redOpen ?? '–'}</b>
          <span>Red, still open</span>
        </div>
        <div className="tile">
          <b>{c?.resolved ?? '–'}</b>
          <span>Resolved</span>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="tabs" role="tablist" style={{ marginBottom: 0, borderBottom: 0 }}>
            {[
              ['open', 'Open'],
              ['closed', 'Closed'],
              ['all', 'All'],
            ].map(([k, label]) => (
              <button key={k} role="tab" aria-selected={status === k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ width: 240, marginLeft: 'auto' }}>
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

      <ErrorBanner error={error} />
      <div className="card scroll">
        {data && !data.rows.length && <p className="mute">No reports here.</p>}
        {!!data?.rows.length && (
          <table>
            <thead>
              <tr>
                <th>Report</th>
                <th>Alert</th>
                <th>What</th>
                <th>Stage</th>
                <th>With</th>
                <th>Reported</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="link" onClick={() => router.push(`/reports/${r.id}`)}>
                  <td>
                    <Link href={`/reports/${r.id}`} onClick={(e) => e.stopPropagation()}>
                      <ReportBadge number={r.number} colour={r.colour} />
                    </Link>
                  </td>
                  <td>
                    <TrafficLight priority={r.priority} />
                  </td>
                  <td>
                    <b>{REPORT_CATEGORIES[r.category]}</b> · {r.siteName}
                    <div className="small" style={{ maxWidth: 360 }}>
                      {r.description.length > 110 ? r.description.slice(0, 110) + '…' : r.description}
                    </div>
                    {r.needsAttention && r.stage !== 'closed' && (
                      <div>
                        <Pill tone="amber">Officer followed up</Pill>
                      </div>
                    )}
                  </td>
                  <td>
                    <StagePill stage={r.stage} />
                    {r.routedToMe && r.stage !== 'closed' && <div className="mute small">Sent to you</div>}
                  </td>
                  <td>{r.assigneeName ?? <span className="mute">Not assigned</span>}</td>
                  <td className="small">
                    {r.reportedBy}
                    {r.source === 'declaration' && <div className="mute">From a declaration</div>}
                    <div className="mute">{formatDateTime(r.reportedAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
