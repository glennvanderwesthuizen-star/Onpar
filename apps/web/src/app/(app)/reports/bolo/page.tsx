'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, formatDateTime, useLoad } from '@/components/ui';
import { AuthPhoto } from '@/components/AuthPhoto';

interface Bolo {
  id: string;
  note: string;
  reportedAt: string;
  lateSynced: boolean;
  hasPhoto: boolean;
  siteName: string | null;
  deviceLabel: string;
  postName: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
}

/** "Be on the lookout": photos and notes sent from the post phones. */
export default function BoloPage() {
  const [siteId, setSiteId] = useState('');
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const { data, error } = useLoad(() => api<Bolo[]>(`/bolos${siteId ? `?siteId=${siteId}` : ''}`), [siteId]);

  return (
    <>
      <div className="head">
        <div>
          <h1>BOLO: be on the lookout</h1>
          <p className="mute">Photos and notes sent from the post phones, newest first.</p>
        </div>
        <div className="row">
          <Link className="btn ghost" href="/reports">
            Back to reports
          </Link>
          <div style={{ width: 240 }}>
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
      {data && !data.length && <div className="card mute">No BOLOs yet.</div>}
      <div className="bolo-grid">
        {data?.map((b) => (
          <div key={b.id} className="card">
            {b.hasPhoto ? <AuthPhoto path={`/bolos/${b.id}/photo`} alt={b.note} width={320} /> : <p className="mute small">No photo</p>}
            <p style={{ whiteSpace: 'pre-wrap' }}>{b.note}</p>
            <div className="small mute">
              {[b.siteName, b.postName, b.deviceLabel].filter(Boolean).join(' · ')}
              <br />
              {formatDateTime(b.reportedAt)}
              {b.lateSynced && ' · sent late (the phone was offline)'}
              <br />
              {b.employeeName ? `${b.employeeName} (${b.employeeNumber})` : 'Nobody was signed in'}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
