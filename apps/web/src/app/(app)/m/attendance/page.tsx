'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { ErrorBanner, formatDate, useLoad } from '@/components/ui';
import { clock } from '@/lib/supervisor';

interface Row {
  id: string;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  dutyOnAt: string;
  dutyFromAt: string | null;
  arrivalStatus: 'ON_TIME' | 'LATE' | 'UNSCHEDULED';
  lateMinutes: number;
  departureStatus: 'ON_TIME' | 'EARLY_DEPARTURE' | 'UNSCHEDULED' | null;
  earlyMinutes: number;
  exceptionReason: string | null;
  employeeName: string;
  employeeNumber: string;
  siteName: string;
  onDeclared: boolean;
  selfiePending: boolean;
  onBehalf: boolean;
}

/** Supervisor app, Attendance: today's register for the supervisor's sites, to read at a glance. */
export default function MobileAttendance() {
  const { data, error } = useLoad(() => api<{ date: string; rows: Row[] }>('/attendance'));
  const sites = [...new Set(data?.rows.map((r) => r.siteName) ?? [])];
  return (
    <>
      <h1 className="m-h1">Attendance today</h1>
      <ErrorBanner error={error} />
      {!data && !error && <p className="mute">Loading…</p>}
      {data && <p className="mute small">{formatDate(data.date)} · shifts that started today</p>}
      {data && data.rows.length === 0 && <div className="card mute">Nobody has logged Duty On today.</div>}
      {sites.map((site) => (
        <section key={site}>
          <h2 className="m-h2">{site}</h2>
          <div className="card" style={{ padding: 0 }}>
            {data!.rows
              .filter((r) => r.siteName === site)
              .map((r) => (
                <div key={r.id} className="m-row">
                  <span className="what">
                    <b>{r.employeeName}</b>
                    <span className="mute small">
                      {r.employeeNumber}
                      {r.shiftName ? ` · ${r.shiftName}` : ''}
                      {r.scheduledStart ? ` · ${clock(r.scheduledStart)} to ${clock(r.scheduledEnd)}` : ' · not on the roster'}
                    </span>
                    <span>
                      On {clock(r.dutyOnAt)} · {r.dutyFromAt ? `off ${clock(r.dutyFromAt)}` : 'still on duty'}
                    </span>
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {r.arrivalStatus === 'LATE' ? <span className="pill amber">Late {r.lateMinutes} min</span> : r.arrivalStatus === 'ON_TIME' ? <span className="pill green">On time</span> : <span className="pill grey">Unscheduled</span>}
                      {r.departureStatus === 'EARLY_DEPARTURE' && <span className="pill amber">Left {r.earlyMinutes} min early</span>}
                      {!r.onDeclared && <span className="pill amber">No declaration yet</span>}
                      {r.selfiePending && <span className="pill grey">Selfie uploading</span>}
                      {r.onBehalf && <span className="pill blue">Logged by a supervisor</span>}
                      {r.exceptionReason && <span className="pill blue">Exception approved</span>}
                    </span>
                  </span>
                </div>
              ))}
          </div>
        </section>
      ))}
      <p className="m-foot">
        <Link href="/attendance">Corrections and other days are on the full website</Link>
      </p>
    </>
  );
}
