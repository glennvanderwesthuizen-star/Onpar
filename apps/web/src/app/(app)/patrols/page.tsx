'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sastDate } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, useLoad } from '@/components/ui';
import { time } from '@/components/attendance';
import { PatrolAlerts, PatrolState } from '@/components/patrols';

interface Row {
  id: string;
  state: string;
  review: string | null;
  windowStart: string;
  windowEnd: string;
  startedAt: string | null;
  finishedAt: string | null;
  pointsEarned: number;
  partialReason: string | null;
  typeCode: string;
  typeName: string;
  employeeName: string;
  siteName: string;
  pointsDone: number;
  pointsTotal: number;
  rejectedScans: number;
  alertId: string | null;
}

interface Day {
  date: string;
  rows: Row[];
  compliance: { typeCode: string; typeName: string; completed: number; total: number }[];
  rejectedWithoutPatrol: { id: string; label: string; at: string; distanceM: number | null; accuracyM: number | null; employeeName: string; pointName: string | null }[];
}

export default function PatrolsPage() {
  const { can } = useSession();
  const router = useRouter();
  const [date, setDate] = useState(() => sastDate(new Date()));
  const [siteId, setSiteId] = useState('');
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const { data, error, reload } = useLoad(() => api<Day>(`/patrols?date=${date}${siteId ? `&siteId=${siteId}` : ''}`), [date, siteId]);
  const move = (days: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    setDate(d.toISOString().slice(0, 10));
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>Patrols</h1>
          <p className="mute">Each patrol is proven by QR scans with a GPS lock. Location is only captured at the moment of a scan.</p>
        </div>
        {can('patrols.view') && (
          <Link className="btn ghost" href={`/patrols/setup${siteId ? `?siteId=${siteId}` : ''}`}>
            Patrol setup and QR codes
          </Link>
        )}
      </div>

      <PatrolAlerts onChange={reload} />

      <div className="card">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <button className="btn ghost" onClick={() => move(-1)} aria-label="Previous day">
            ←
          </button>
          <div style={{ width: 180 }}>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </Field>
          </div>
          <button className="btn ghost" onClick={() => move(1)} aria-label="Next day">
            →
          </button>
          <div style={{ width: 240 }}>
            <Field label="Site">
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">All my sites</option>
                {sites.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
      </div>

      {!!data?.compliance.length && (
        <div className="tiles">
          {data.compliance.map((c) => (
            <div key={c.typeName} className="tile">
              <b style={{ color: c.total && c.completed < c.total ? 'var(--amber)' : undefined }}>
                {c.completed}/{c.total}
              </b>
              <span>
                {c.typeName} ({c.typeCode}) completed
              </span>
            </div>
          ))}
        </div>
      )}

      <ErrorBanner error={error} />
      <div className="card scroll">
        {data && !data.rows.length && <p className="mute">No patrols in windows on this day.</p>}
        {!!data?.rows.length && (
          <table>
            <thead>
              <tr>
                <th>Window</th>
                <th>Patrol</th>
                <th>Officer</th>
                <th>Status</th>
                <th>Points visited</th>
                <th>Patrol points</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="link" onClick={() => router.push(`/patrols/${r.id}`)}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {time(r.windowStart)}–{time(r.windowEnd)}
                  </td>
                  <td>
                    <Link href={`/patrols/${r.id}`} onClick={(e) => e.stopPropagation()}>
                      <b>
                        {r.typeName} ({r.typeCode})
                      </b>
                    </Link>
                    <div className="mute small">{r.siteName}</div>
                  </td>
                  <td>{r.employeeName}</td>
                  <td>
                    <PatrolState state={r.state} review={r.review} />
                    {r.startedAt && (
                      <div className="mute small">
                        {time(r.startedAt)}
                        {r.finishedAt && ` to ${time(r.finishedAt)}`}
                      </div>
                    )}
                    {r.alertId && <div className="small" style={{ color: 'var(--red)' }}>Went overdue</div>}
                  </td>
                  <td>
                    {r.state === 'missed' ? '—' : `${r.pointsDone} of ${r.pointsTotal}`}
                    {r.rejectedScans > 0 && <div className="small" style={{ color: 'var(--red)' }}>{r.rejectedScans} rejected scan(s)</div>}
                  </td>
                  <td>{r.pointsEarned ? `+${r.pointsEarned.toFixed(2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!!data?.rejectedWithoutPatrol.length && (
        <div className="card scroll">
          <h2>Rejected scans</h2>
          <p className="mute small">Scans that did not count, for example a code scanned from far away or with poor GPS.</p>
          <table>
            <tbody>
              {data.rejectedWithoutPatrol.map((s) => (
                <tr key={s.id}>
                  <td>{time(s.at)}</td>
                  <td>{s.employeeName}</td>
                  <td>{s.pointName ?? 'Unknown code'}</td>
                  <td>
                    {s.label}
                    {s.distanceM != null && ` · ${s.distanceM} m from the point`}
                    {s.accuracyM != null && ` · GPS ±${Math.round(s.accuracyM)} m`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
