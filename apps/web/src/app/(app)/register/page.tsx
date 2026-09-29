'use client';

import { useEffect, useState } from 'react';
import { sastDate } from '@onpar/rules';
import { api } from '@/lib/api';
import { ErrorBanner, Field, Pill, formatDate, useLoad } from '@/components/ui';

interface Day {
  date: string;
  here: boolean;
  siteName: string | null;
  scheduled: { name: string; startTime: string; endTime: string; hours: number } | null;
  dutyOnAt: string | null;
  dutyFromAt: string | null;
  arrival: { status: string; lateMinutes: number } | null;
  departure: { status: string; earlyMinutes: number } | null;
  hoursWorked: number | null;
  status: string;
  statusLabel: string;
}

interface Guard {
  id: string;
  name: string;
  employeeNumber: string;
  summary: { scheduled: number; completed: number; absent: number; late: number; unscheduled: number; hoursScheduled: number; hoursWorked: number };
  days: Day[];
}

interface Register {
  site: { id: string; name: string; client: string; payrollStartDay: number };
  period: { start: string; end: string; days: number };
  previous: string;
  next: string;
  today: string;
  totals: { scheduled: number; completed: number; absent: number; onDuty: number; hoursScheduled: number; hoursWorked: number };
  guards: Guard[];
  note: string;
}

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' }) : '—';
const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const TONE: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'grey'> = {
  complete: 'green',
  on_duty: 'blue',
  absent: 'red',
  unscheduled: 'amber',
  rest_day: 'grey',
  no_record: 'grey',
  upcoming: 'grey',
};

function csv(r: Register) {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    ['Employee number', 'Name', 'Date', 'Site', 'Rostered shift', 'Rostered start', 'Rostered end', 'Rostered hours', 'Duty On', 'Duty From', 'Hours worked', 'Late minutes', 'Status'].map(q).join(','),
  ];
  for (const g of r.guards) {
    for (const d of g.days) {
      if (!d.here) continue;
      lines.push(
        [
          g.employeeNumber,
          g.name,
          d.date,
          d.siteName ?? '',
          d.scheduled?.name ?? '',
          d.scheduled?.startTime ?? '',
          d.scheduled?.endTime ?? '',
          d.scheduled?.hours ?? '',
          d.dutyOnAt ? time(d.dutyOnAt) : '',
          d.dutyFromAt ? time(d.dutyFromAt) : '',
          d.hoursWorked ?? '',
          d.arrival?.status === 'LATE' ? d.arrival.lateMinutes : '',
          d.statusLabel,
        ]
          .map(q)
          .join(','),
      );
    }
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `attendance-register-${r.site.name.replace(/\W+/g, '-')}-${r.period.start}-to-${r.period.end}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function RegisterPage() {
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const [siteId, setSiteId] = useState('');
  const [date, setDate] = useState(sastDate(new Date()));
  const reg = useLoad(() => (siteId ? api<Register>(`/register?siteId=${siteId}&date=${date}`) : Promise.resolve(null)), [siteId, date]);

  useEffect(() => {
    if (!siteId && sites.data?.length === 1) setSiteId(sites.data[0].id);
  }, [sites.data, siteId]);

  const r = reg.data;
  return (
    <>
      <div className="head">
        <div>
          <h1>Attendance register</h1>
          <p className="mute">For each guard, the rostered shifts next to the Duty On and Duty From times really logged, for one payroll month.</p>
        </div>
        {r && (
          <button className="btn ghost" onClick={() => csv(r)}>
            Download for payroll (CSV)
          </button>
        )}
      </div>
      <ErrorBanner error={sites.error ?? reg.error} />
      <div className="card">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Site">
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">Choose a site…</option>
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          {r && (
            <div className="row">
              <button className="btn ghost sm" onClick={() => setDate(r.previous)}>
                ← Previous period
              </button>
              <b>
                {formatDate(r.period.start)} to {formatDate(r.period.end)}
              </b>
              <span className="mute small">({r.period.days} days)</span>
              <button className="btn ghost sm" onClick={() => setDate(r.next)}>
                Next period →
              </button>
            </div>
          )}
        </div>
      </div>
      {siteId && !r && !reg.error && <p className="mute">Loading…</p>}
      {r && (
        <>
          <div className="tiles">
            <div className="tile">
              <b>
                {r.totals.completed}/{r.totals.scheduled}
              </b>
              <span>Rostered shifts completed so far</span>
            </div>
            <div className="tile">
              <b>{r.totals.absent}</b>
              <span>Absent: no Duty On logged</span>
            </div>
            <div className="tile">
              <b>{r.totals.onDuty}</b>
              <span>On duty, no Duty From yet</span>
            </div>
            <div className="tile">
              <b>{r.totals.hoursWorked}</b>
              <span>Hours worked of {r.totals.hoursScheduled} rostered</span>
            </div>
          </div>
          <div className="banner warn small">{r.note} Times shown are only those really logged; a missing time is shown as missing, never filled in.</div>
          {!r.guards.length && <p className="mute">Nobody was rostered at or worked at this site in this period.</p>}
          {r.guards.map((g) => (
            <details key={g.id} className="card">
              <summary className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }}>
                <span>
                  <b>{g.name}</b> <span className="mute small">#{g.employeeNumber}</span>
                </span>
                <span className="row small">
                  <Pill tone="green">
                    {g.summary.completed}/{g.summary.scheduled} complete
                  </Pill>
                  {g.summary.absent > 0 && <Pill tone="red">{g.summary.absent} absent</Pill>}
                  {g.summary.late > 0 && <Pill tone="amber">{g.summary.late} late</Pill>}
                  {g.summary.unscheduled > 0 && <Pill tone="amber">{g.summary.unscheduled} not on roster</Pill>}
                  <span className="mute">
                    {g.summary.hoursWorked} h of {g.summary.hoursScheduled} h
                  </span>
                </span>
              </summary>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Rostered</th>
                      <th>Duty On</th>
                      <th>Duty From</th>
                      <th>Hours</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.days.map((d) => (
                      <tr key={d.date} style={d.here ? undefined : { opacity: 0.55 }}>
                        <td>{dayName(d.date)}</td>
                        <td>
                          {d.scheduled ? `${d.scheduled.name} ${d.scheduled.startTime}–${d.scheduled.endTime}` : '—'}
                          {!d.here && d.siteName && <div className="mute small">At {d.siteName}; counted on that site&rsquo;s register</div>}
                        </td>
                        <td>
                          {time(d.dutyOnAt)}
                          {d.arrival?.status === 'LATE' && <div className="small err">{d.arrival.lateMinutes} min late</div>}
                        </td>
                        <td>
                          {time(d.dutyFromAt)}
                          {d.departure?.status === 'EARLY_DEPARTURE' && <div className="small err">{d.departure.earlyMinutes} min early</div>}
                        </td>
                        <td>{d.hoursWorked ?? '—'}</td>
                        <td>
                          <Pill tone={TONE[d.status] ?? 'grey'}>{d.statusLabel}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </>
      )}
    </>
  );
}
