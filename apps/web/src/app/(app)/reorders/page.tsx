'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, formatDateTime, useLoad } from '@/components/ui';
import { itemText, Reorder, StagePillR } from '@/components/reorders';

export default function ReordersPage() {
  const { can } = useSession();
  const router = useRouter();
  const [status, setStatus] = useState('open');
  const { data, error } = useLoad(() => api<{ rows: Reorder[]; counts: { open: number; waiting: number; received: number } }>(`/reorders?status=${status}`), [status]);
  return (
    <>
      <div className="head">
        <div>
          <h1>Re-orders</h1>
          <p className="mute">Replacement uniform and equipment, and supplies for sites, from request to receipt.</p>
        </div>
        {can('officers.view') && (
          <Link className="btn ghost" href="/reorders/kit">
            Kit list
          </Link>
        )}
      </div>
      <div className="tiles">
        <div className="tile">
          <b style={{ color: data?.counts.waiting ? 'var(--amber)' : undefined }}>{data?.counts.waiting ?? '–'}</b>
          <span>Waiting to be ordered</span>
        </div>
        <div className="tile">
          <b>{data?.counts.open ?? '–'}</b>
          <span>Open</span>
        </div>
        <div className="tile">
          <b>{data?.counts.received ?? '–'}</b>
          <span>Received</span>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[
          ['open', 'Open'],
          ['closed', 'Received'],
          ['all', 'All'],
        ].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={status === k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorBanner error={error} />
      <div className="card scroll">
        {data && !data.rows.length && <p className="mute">Nothing here.</p>}
        {!!data?.rows.length && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>What</th>
                <th>For</th>
                <th>Stage</th>
                <th>Delivering</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="link" onClick={() => router.push(`/reorders/${r.id}`)}>
                  <td>
                    <Link href={`/reorders/${r.id}`} onClick={(e) => e.stopPropagation()}>
                      <b>R{r.number}</b>
                    </Link>
                  </td>
                  <td>
                    <b>{itemText(r)}</b>
                    {r.comment && <div className="mute small">{r.comment}</div>}
                  </td>
                  <td>
                    {r.kind === 'personal' ? r.employeeName : <>Site: {r.siteName}</>}
                    <div className="mute small">{r.kind === 'personal' ? `Personal · ${r.siteName}` : `asked by ${r.employeeName}`}</div>
                  </td>
                  <td>
                    <StagePillR stage={r.stage} />
                  </td>
                  <td>{r.assigneeName ?? <span className="mute">—</span>}</td>
                  <td className="small">{formatDateTime(r.requestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
