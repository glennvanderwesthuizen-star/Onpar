'use client';

import Link from 'next/link';
import { use } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, StatusPill, formatDateTime, useLoad } from '@/components/ui';
import { ArrivalPill, DeparturePill, time } from '@/components/attendance';
import { PositionPill } from '@/components/scores';
import { DateNav, dayLabel, FigureGroups, Figures, PatrolCompliance, useAutoRefresh, validDate } from '@/components/dashboard';

interface Shift {
  id: string;
  shiftName: string | null;
  arrivalStatus: 'ON_TIME' | 'LATE' | 'UNSCHEDULED';
  lateMinutes: number;
  dutyOnAt: string;
  dutyFromAt: string | null;
  departureStatus: 'ON_TIME' | 'EARLY_DEPARTURE' | 'UNSCHEDULED' | null;
  earlyMinutes: number;
  exceptionReason: string | null;
}

interface SiteDay {
  date: string;
  today: string;
  site: { id: string; name: string; client: string; armed: boolean };
  figures: Figures;
  patrolCompliance: PatrolCompliance[];
  officers: {
    id: string;
    name: string;
    employeeNumber: string;
    homeSite: boolean;
    shifts: Shift[];
    tasks: { completed: number; open: number };
    patrols: { completed: number; missed: number; total: number };
    reportsMade: number;
    training: string | null;
    score: number | null;
    position: string | null;
    positionLabel: string | null;
  }[];
  declarations: { id: string; attendanceId: string; kind: string; comment: string; at: string; hasSelfie: boolean; lateSynced: boolean; employeeName: string; reportId: string | null }[];
  readings: {
    id: string;
    patrolId: string;
    label: string;
    kind: string;
    valueNum: number | null;
    valueOk: boolean | null;
    unit: string | null;
    outOfLimit: boolean;
    reportId: string | null;
    at: string;
    pointName: string;
    employeeName: string;
  }[];
  rejectedScans: { id: string; patrolId: string | null; label: string; at: string; distanceM: number | null; pointName: string | null; employeeName: string }[];
  devices: { id: string; label: string; postName: string; status: string; kioskStatus: string; appVersion: string | null; lastSeenAt: string | null; batteryPct: number | null }[] | null;
}

const HOUR = 60 * 60 * 1000;

export default function SiteDashboard({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string }> }) {
  const { id } = use(params);
  const date = validDate(use(searchParams).date);
  const { me } = useSession();
  const router = useRouter();
  const { data: d, error, reload } = useLoad(() => api<SiteDay>(`/dashboard/sites/${id}?date=${date}`), [id, date]);
  useAutoRefresh(reload, !!d && d.date === d.today);
  if (error) return <ErrorBanner error={error} />;
  if (!d) return <p className="mute">Loading…</p>;
  const officerHref = (oid: string) => `/dashboard/officers/${oid}?date=${d.date}`;

  return (
    <>
      <div className="crumbs">
        <Link href={`/?date=${d.date}`}>{me.company.name}</Link> › <b>{d.site.name}</b>
      </div>
      <div className="head">
        <div>
          <h1>{d.site.name}</h1>
          <p className="mute">
            {d.site.client} · {dayLabel(d.date, d.today)}
            {d.site.armed ? ' · armed site' : ''}
          </p>
        </div>
        <DateNav date={d.date} today={d.today} />
      </div>

      <FigureGroups f={d.figures} date={d.date} compliance={d.patrolCompliance} />

      <div className="card scroll">
        <h2>Officers</h2>
        {!d.officers.length && <p className="mute">No officers are based here and nobody worked here on this day.</p>}
        {d.officers.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Officer</th>
                <th>Shift</th>
                <th>Tasks</th>
                <th>Patrols</th>
                <th>Reports</th>
                {d.officers[0].training !== null && <th>Training</th>}
                {d.officers[0].position !== null && <th>Performance</th>}
              </tr>
            </thead>
            <tbody>
              {d.officers.map((o) => (
                <tr key={o.id} className="click" onClick={() => router.push(officerHref(o.id))}>
                  <td>
                    <Link href={officerHref(o.id)}>
                      <b>{o.name}</b>
                    </Link>
                    <div className="mute small">
                      #{o.employeeNumber}
                      {!o.homeSite && ' · based at another site'}
                    </div>
                  </td>
                  <td>
                    {o.shifts.length === 0 && <span className="mute">Not on duty</span>}
                    {o.shifts.map((s) => (
                      <div key={s.id} className="row" style={{ gap: 4 }}>
                        <span className="small">
                          {s.shiftName ?? 'Shift'} {time(s.dutyOnAt)}–{s.dutyFromAt ? time(s.dutyFromAt) : ''}
                        </span>
                        <ArrivalPill row={s} />
                        <DeparturePill row={s} />
                      </div>
                    ))}
                  </td>
                  <td>
                    {o.tasks.completed} done
                    {o.tasks.open > 0 && <span className="mute"> · {o.tasks.open} to do</span>}
                  </td>
                  <td>
                    {o.patrols.total ? `${o.patrols.completed} of ${o.patrols.total}` : <span className="mute">–</span>}
                    {o.patrols.missed > 0 && <span style={{ color: 'var(--red)' }}> · {o.patrols.missed} missed</span>}
                  </td>
                  <td>{o.reportsMade || <span className="mute">0</span>}</td>
                  {o.training !== null && (
                    <td>
                      <StatusPill status={o.training} />
                    </td>
                  )}
                  {o.position !== null && (
                    <td>
                      <b>{o.score}</b> <PositionPill position={o.position} label={o.positionLabel!} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="dgrid">
        <div className="card">
          <h2>Duty declarations</h2>
          {!d.declarations.length && <p className="mute">None on this day.</p>}
          {d.declarations.map((x) => (
            <Link key={x.id} href={`/attendance/${x.attendanceId}`} className="line">
              <span>
                <b>{x.employeeName}</b>, {x.kind === 'duty_on' ? 'Duty On' : 'Duty From'} at {time(x.at)}
                <div className="mute small">
                  {x.hasSelfie ? 'Selfie taken' : 'Selfie still to arrive'}
                  {x.lateSynced ? ' · late-synced' : ''}
                </div>
                {x.comment && <div className="small">“{x.comment}”</div>}
              </span>
              {x.comment ? <Pill tone="amber">{x.reportId ? 'Comment, report raised' : 'Comment'}</Pill> : <Pill tone="green">Declared</Pill>}
            </Link>
          ))}
        </div>

        <div className="card">
          <h2>Checkpoint readings</h2>
          {!d.readings.length && <p className="mute">None on this day.</p>}
          {d.readings.map((r) => (
            <Link key={r.id} href={`/patrols/${r.patrolId}`} className="line">
              <span>
                <b>{r.pointName}</b>: {r.label}{' '}
                {r.kind === 'number' ? `${r.valueNum ?? '—'} ${r.unit ?? ''}` : r.kind === 'ok_problem' ? (r.valueOk ? 'OK' : 'Problem') : 'photo taken'}
                <div className="mute small">
                  {r.employeeName} at {time(r.at)}
                </div>
              </span>
              <Pill tone={r.outOfLimit ? 'red' : 'green'}>{r.outOfLimit ? (r.reportId ? 'Report raised' : 'Out of limit') : 'OK'}</Pill>
            </Link>
          ))}
        </div>

        {d.rejectedScans.length > 0 && (
          <div className="card">
            <h2>Rejected scans</h2>
            {d.rejectedScans.map((s) => (
              <div key={s.id} className="line">
                <span>
                  <b>{s.employeeName}</b>, {s.pointName ?? 'unknown code'} at {time(s.at)}
                  <div className="mute small">
                    {s.label}
                    {s.distanceM !== null ? `, ${s.distanceM} m away` : ''}
                  </div>
                </span>
                <Pill tone="red">Rejected</Pill>
              </div>
            ))}
          </div>
        )}

        {d.devices && (
          <div className="card">
            <h2>Devices</h2>
            {!d.devices.length && <p className="mute">No devices at this site.</p>}
            {d.devices.filter((x) => x.status !== 'registered').map((x) => {
              const offline = x.status === 'active' && (!x.lastSeenAt || Date.now() - new Date(x.lastSeenAt).getTime() > HOUR);
              return (
                <Link key={x.id} href="/devices" className="line">
                  <span>
                    <b>{x.label}</b>
                    {x.postName && <span className="mute"> · {x.postName}</span>}
                    <div className="mute small">
                      Last seen {x.lastSeenAt ? formatDateTime(x.lastSeenAt) : 'never'}
                      {x.batteryPct !== null ? ` · battery ${x.batteryPct}%` : ''}
                      {x.appVersion ? ` · app ${x.appVersion}` : ''}
                    </div>
                  </span>
                  <Pill tone={x.status === 'locked' ? 'red' : offline ? 'amber' : x.status === 'active' ? 'green' : 'grey'}>
                    {x.status === 'locked' ? 'Locked' : offline ? 'Offline' : x.status === 'active' ? 'Online' : x.status === 'registered' ? 'Not set up yet' : 'Disabled'}
                  </Pill>
                </Link>
              );
            })}
            {d.devices.some((x) => x.status === 'registered') && (
              <p className="mute small">
                {d.devices.filter((x) => x.status === 'registered').length} registered but not set up on a phone yet:{' '}
                {d.devices.filter((x) => x.status === 'registered').map((x) => x.label).join(', ')}.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
