'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { addDays, sastDate } from '@onpar/rules';
import { formatDate } from './ui';

export interface Figures {
  attendance: { scheduled: number; onTime: number; late: number; absent: number; onDuty: number } | null;
  tasks: { total: number; completed: number; outstanding: number; overdue: number; missed: number; couldNotComplete: number } | null;
  reports: { open: number; actionRequired: number; overdue: number; redOpen: number } | null;
  reorders: { open: number } | null;
  patrols: { alertsOpen: number; completed: number; due: number; compliancePercent: number | null } | null;
  training: { total: number; compliant: number; expiring: number; expired: number; compliantPercent: number } | null;
  performance: { officers: number; needsAttention: number } | null;
  devices: { active: number; offline: number } | null;
}

export interface PatrolCompliance {
  siteId: string;
  siteName: string;
  typeCode: string;
  typeName: string;
  completed: number;
  due: number;
  compliancePercent: number | null;
}

type Tone = 'green' | 'amber' | 'red' | undefined;

function Stat({ n, label, tone, sub }: { n: number | string; label: string; tone?: Tone; sub?: string }) {
  return (
    <div className="stat">
      <b style={{ color: tone ? `var(--${tone})` : undefined }}>{n}</b>
      <span>{label}</span>
      {sub && <span className="small">{sub}</span>}
    </div>
  );
}

function Group({ title, href, children }: { title: string; href?: string; children: React.ReactNode }) {
  return (
    <div className="card fig">
      <h3>{href ? <Link href={href}>{title} →</Link> : title}</h3>
      <div className="stats">{children}</div>
    </div>
  );
}

const warn = (n: number, tone: Tone = 'amber'): Tone => (n > 0 ? tone : undefined);
const pct = (n: number | null) => (n === null ? '–' : `${n}%`);
const pctTone = (n: number | null): Tone => (n === null ? undefined : n >= 95 ? 'green' : n >= 80 ? 'amber' : 'red');

/** Every figure in section 6.11, grouped, each group linking to its page. */
export function FigureGroups({ f, date, compliance }: { f: Figures; date: string; compliance?: PatrolCompliance[] }) {
  return (
    <div className="figs">
      {f.attendance && (
        <Group title="Attendance" href={`/attendance?date=${date}`}>
          <Stat n={f.attendance.scheduled} label="Scheduled" />
          <Stat n={f.attendance.onTime} label="On time" tone={f.attendance.onTime ? 'green' : undefined} />
          <Stat n={f.attendance.late} label="Late" tone={warn(f.attendance.late)} />
          <Stat n={f.attendance.absent} label="Absent" tone={warn(f.attendance.absent, 'red')} sub="posts not filled" />
        </Group>
      )}
      {f.tasks && (
        <Group title="Tasks" href="/tasks">
          <Stat n={f.tasks.completed} label="Completed" tone={f.tasks.completed ? 'green' : undefined} />
          <Stat n={f.tasks.outstanding} label="Outstanding" />
          <Stat n={f.tasks.overdue} label="Overdue" tone={warn(f.tasks.overdue)} />
          <Stat n={f.tasks.missed} label="Missed" tone={warn(f.tasks.missed, 'red')} />
          {f.tasks.couldNotComplete > 0 && <Stat n={f.tasks.couldNotComplete} label="Could not complete" tone="amber" />}
        </Group>
      )}
      {f.reports && (
        <Group title="Reports" href="/reports">
          <Stat n={f.reports.open} label="Open" sub={f.reports.redOpen ? `${f.reports.redOpen} Red` : undefined} />
          <Stat n={f.reports.actionRequired} label="Action required" tone={warn(f.reports.actionRequired)} />
          <Stat n={f.reports.overdue} label="Overdue" tone={warn(f.reports.overdue, 'red')} />
        </Group>
      )}
      {f.patrols && (
        <Group title="Patrols" href={`/patrols`}>
          <Stat n={f.patrols.alertsOpen} label="Alerts open" tone={warn(f.patrols.alertsOpen, 'red')} />
          <Stat
            n={pct(f.patrols.compliancePercent)}
            label="Compliance"
            tone={pctTone(f.patrols.compliancePercent)}
            sub={f.patrols.due ? `${f.patrols.completed} of ${f.patrols.due} done` : 'none due yet'}
          />
          {compliance && compliance.length > 0 && (
            <div className="bytype">
              {compliance.map((c) => (
                <div key={`${c.siteId}${c.typeCode}`}>
                  <span>
                    {c.typeCode}. {c.typeName}
                    <span className="mute"> · {c.siteName}</span>
                  </span>
                  <b style={{ color: pctTone(c.compliancePercent) ? `var(--${pctTone(c.compliancePercent)})` : undefined }}>
                    {c.completed}/{c.due}
                  </b>
                </div>
              ))}
            </div>
          )}
        </Group>
      )}
      {f.reorders && (
        <Group title="Re-orders" href="/reorders">
          <Stat n={f.reorders.open} label="Open" />
        </Group>
      )}
      {f.training && (
        <Group title="Training" href="/training">
          <Stat n={f.training.total ? `${f.training.compliantPercent}%` : '–'} label="Compliant" tone={f.training.total ? pctTone(f.training.compliantPercent) : undefined} />
          <Stat n={f.training.expiring} label="Expiring" tone={warn(f.training.expiring)} />
          <Stat n={f.training.expired} label="Expired" tone={warn(f.training.expired, 'red')} />
        </Group>
      )}
      {f.performance && (
        <Group title="Performance" href="/scores">
          <Stat n={f.performance.needsAttention} label="Needs attention" tone={warn(f.performance.needsAttention)} sub={`of ${f.performance.officers} officers`} />
        </Group>
      )}
      {f.devices && (
        <Group title="Devices" href="/devices">
          <Stat n={f.devices.active} label="Active" />
          <Stat n={f.devices.offline} label="Not seen for an hour" tone={warn(f.devices.offline)} />
        </Group>
      )}
    </div>
  );
}

/** Previous day, a date picker, next day and Today. The date lives in the address, so drill-down links keep it. */
export function DateNav({ date, today }: { date: string; today?: string }) {
  const router = useRouter();
  const go = (d: string) => router.replace(`?date=${d}`, { scroll: false });
  const now = today ?? sastDate(new Date());
  return (
    <div className="row datenav">
      <button className="btn ghost" onClick={() => go(addDays(date, -1))} aria-label="Previous day">
        ←
      </button>
      <input type="date" aria-label="Date" value={date} max={now} onChange={(e) => e.target.value && go(e.target.value)} />
      <button className="btn ghost" onClick={() => go(addDays(date, 1))} aria-label="Next day" disabled={date >= now}>
        →
      </button>
      {date !== now && (
        <button className="btn ghost" onClick={() => go(now)}>
          Today
        </button>
      )}
    </div>
  );
}

export function dayLabel(date: string, today: string) {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return formatDate(date);
}

/** Refreshes the figures every minute while showing today. */
export function useAutoRefresh(reload: () => void, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
}

export function validDate(d: string | undefined) {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : sastDate(new Date());
}
