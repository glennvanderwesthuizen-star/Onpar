'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, StatusPill, formatDate, useLoad } from '@/components/ui';

interface Overview {
  summary: { total: number; compliant: number; expiring: number; expired: number; compliantPercent: number };
  rows: { employeeId: string; employeeName: string; employeeNumber: string; siteName: string; type: string; name: string; expiryDate: string | null; status: string }[];
}

export default function TrainingPage() {
  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState('attention');
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const { data, error } = useLoad(() => api<Overview>(`/training${siteId ? `?siteId=${siteId}` : ''}`), [siteId]);
  const s = data?.summary;
  const rows = (data?.rows ?? []).filter((r) => (status === 'attention' ? r.status !== 'COMPLIANT' : status === 'all' ? true : r.status === status));

  return (
    <>
      <div className="head">
        <div>
          <h1>Training and qualifications</h1>
          <p className="mute">PSIRA registration and every current qualification. Expiring means within 30 days.</p>
        </div>
        <div style={{ width: 240 }}>
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Site">
            <option value="">All my sites</option>
            {sites.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="tiles">
        <div className="tile">
          <b style={{ color: s && s.compliantPercent < 100 ? 'var(--amber)' : 'var(--green)' }}>{s ? `${s.compliantPercent}%` : '–'}</b>
          <span>Compliant</span>
        </div>
        <div className="tile">
          <b style={{ color: s?.expiring ? 'var(--amber)' : undefined }}>{s?.expiring ?? '–'}</b>
          <span>Expiring in 30 days</span>
        </div>
        <div className="tile">
          <b style={{ color: s?.expired ? 'var(--red)' : undefined }}>{s?.expired ?? '–'}</b>
          <span>Expired</span>
        </div>
        <div className="tile">
          <b>{s?.total ?? '–'}</b>
          <span>Items tracked</span>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {[
          ['attention', 'Needs attention'],
          ['EXPIRED', 'Expired'],
          ['EXPIRING', 'Expiring'],
          ['all', 'All'],
        ].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={status === k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>
            {label}
          </button>
        ))}
      </div>

      <ErrorBanner error={error} />
      <div className="card scroll">
        {data && !rows.length && <p className="mute">{status === 'attention' ? 'Nothing is expired or expiring. Well done.' : 'Nothing here.'}</p>}
        {!!rows.length && (
          <table>
            <thead>
              <tr>
                <th>Officer</th>
                <th>Qualification</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.employeeId}-${r.type}-${r.name}`}>
                  <td>
                    <Link href={`/officers/${r.employeeId}`}>
                      <b>{r.employeeName}</b>
                    </Link>
                    <div className="mute small">
                      #{r.employeeNumber} · {r.siteName}
                    </div>
                  </td>
                  <td>{r.name}</td>
                  <td>{formatDate(r.expiryDate)}</td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="mute small">To record a renewal, open the officer and use “Record a qualification or renewal”. PSIRA registration is checked by hand against PSIRA&apos;s records.</p>
    </>
  );
}
