'use client';

import Link from 'next/link';
import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, useLoad } from '@/components/ui';
import { PatrolAlerts } from '@/components/patrols';
import { DateNav, dayLabel, FigureGroups, Figures, PatrolCompliance, useAutoRefresh, validDate } from '@/components/dashboard';

interface Dashboard {
  date: string;
  today: string;
  totals: Figures;
  sites: { siteId: string; siteName: string; figures: Figures }[];
  patrolCompliance: PatrolCompliance[];
}

const n = (x: number | undefined | null, bad = false) => (x ? <b style={{ color: bad ? 'var(--red)' : 'var(--amber)' }}>{x}</b> : <span className="mute">0</span>);

export default function Overview({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const date = validDate(use(searchParams).date);
  const { me, can } = useSession();
  const router = useRouter();
  const { data, error, reload } = useLoad(() => api<Dashboard>(`/dashboard?date=${date}`), [date]);
  const today = data?.today;
  useAutoRefresh(reload, !!today && date === today);
  const drill = can('attendance.view');
  // Roles without the dashboard (stores clerk, payroll clerk) start on their own page.
  useEffect(() => {
    if (!can('dashboard.view')) router.replace(can('uniform.stores') ? '/uniform' : can('register.view') ? '/register' : '/account');
  }, [can, router]);

  return (
    <>
      <div className="head">
        <div>
          <h1>Good day, {me.name.split(' ')[0]}</h1>
          <p className="mute">
            {me.company.name} · {data ? dayLabel(data.date, data.today) : '…'}
            {today && date === today ? ' · refreshes every minute' : ''}
          </p>
        </div>
        <DateNav date={date} today={today} />
      </div>
      {can('patrols.view') && date === today && <PatrolAlerts onChange={reload} />}
      <ErrorBanner error={error} />
      {!data && !error && <p className="mute">Loading…</p>}
      {data && (
        <>
          <FigureGroups f={data.totals} date={data.date} compliance={data.patrolCompliance} />

          {data.sites.length > 0 && data.totals.attendance && (
            <div className="card scroll">
              <h2>By site</h2>
              {drill && <p className="mute small">Open a site to see each officer&apos;s day.</p>}
              <table>
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>On time</th>
                    <th>Late</th>
                    <th>Absent</th>
                    <th>Tasks done</th>
                    <th>Overdue or missed</th>
                    <th>Reports open</th>
                    <th>Patrols</th>
                    {data.totals.training && <th>Training</th>}
                    {data.totals.performance && <th>Needs attention</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.sites.map(({ siteId, siteName, figures: f }) => (
                    <tr
                      key={siteId}
                      className={drill ? 'click' : undefined}
                      onClick={drill ? () => router.push(`/dashboard/sites/${siteId}?date=${data.date}`) : undefined}
                    >
                      <td>{drill ? <Link href={`/dashboard/sites/${siteId}?date=${data.date}`}>{siteName}</Link> : siteName}</td>
                      <td>
                        {f.attendance!.onTime} of {f.attendance!.scheduled}
                      </td>
                      <td>{n(f.attendance!.late)}</td>
                      <td>{n(f.attendance!.absent, true)}</td>
                      <td>
                        {f.tasks!.completed} of {f.tasks!.total}
                      </td>
                      <td>{n(f.tasks!.overdue + f.tasks!.missed, true)}</td>
                      <td>
                        {f.reports!.open}
                        {f.reports!.overdue > 0 && <span style={{ color: 'var(--red)' }}> · {f.reports!.overdue} overdue</span>}
                      </td>
                      <td>{f.patrols!.compliancePercent === null ? <span className="mute">–</span> : `${f.patrols!.compliancePercent}%`}</td>
                      {f.training && <td>{f.training.total ? `${f.training.compliantPercent}%` : <span className="mute">–</span>}</td>}
                      {f.performance && <td>{n(f.performance.needsAttention)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mute small">
            Absent counts posts nobody logged Duty On for once a shift has started, until rostering names who is expected. A report is overdue when open
            longer than 1 day (Red), 3 days (Amber) or 7 days (Green). Patrol compliance counts patrols whose window has closed.
          </p>
        </>
      )}
    </>
  );
}
