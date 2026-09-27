'use client';

import Link from 'next/link';
import { use } from 'react';
import {
  COULD_NOT_COMPLETE_REASONS,
  EVENT_TYPES,
  FOLLOW_UP_OUTCOMES,
  REPORT_CATEGORIES,
  STAGE_LABELS,
  CouldNotCompleteReason,
  FollowUpOutcome,
  Priority,
  ReportCategory,
  Stage,
} from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, StatusPill, formatDate, useLoad } from '@/components/ui';
import { ArrivalPill, DeparturePill, time } from '@/components/attendance';
import { TaskStatus } from '@/components/TaskStatus';
import { PatrolState } from '@/components/patrols';
import { StagePill, TrafficLight } from '@/components/reports';
import { Points, PositionPill } from '@/components/scores';
import { DateNav, dayLabel, validDate } from '@/components/dashboard';

interface OfficerDay {
  date: string;
  today: string;
  officer: { id: string; name: string; employeeNumber: string; homeSiteId: string; homeSiteName: string };
  shifts: {
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
    siteId: string;
    siteName: string;
    declarations: { id: string; kind: string; comment: string; at: string; hasSelfie: boolean }[];
  }[];
  tasks: {
    id: string;
    title: string;
    status: string;
    dueTime: string | null;
    doneAt: string | null;
    doneByMe: boolean;
    doneByName: string | null;
    comment: string;
    cannotReason: CouldNotCompleteReason | null;
    review: string | null;
    siteName: string;
  }[];
  patrols: {
    id: string;
    state: string;
    windowStart: string;
    windowEnd: string;
    startedAt: string | null;
    finishedAt: string | null;
    pointsEarned: number;
    partialReason: string | null;
    review: string | null;
    typeCode: string;
    typeName: string;
  }[];
  reports: { id: string; number: number; category: ReportCategory; priority: Priority; stage: Stage; description: string; reportedAt: string }[];
  actions: { id: string; reportId: string; reportNumber: number; action: string; outcome: FollowUpOutcome | null; note: string; at: string }[];
  training: { qualificationId: string | null; name: string; expiryDate: string | null; status: string }[] | null;
  performance: {
    score: number;
    position: string;
    positionLabel: string;
    events: { id: string; type: string; impact: number; evidence: string; by: string; createdAt: string }[];
  } | null;
}

const eventLabel = (t: string) => (t === 'reversal' ? 'Reversal' : (EVENT_TYPES[t as keyof typeof EVENT_TYPES]?.label ?? t));

function actionText(a: OfficerDay['actions'][number]) {
  if (a.action === 'follow_up') return `Follow-up: ${a.outcome ? FOLLOW_UP_OUTCOMES[a.outcome] : ''}`;
  if (a.action === 'note') return 'Note';
  return STAGE_LABELS[a.action as Stage] ?? a.action;
}

export default function OfficerDayPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string }> }) {
  const { id } = use(params);
  const date = validDate(use(searchParams).date);
  const { me, can } = useSession();
  const { data: d, error } = useLoad(() => api<OfficerDay>(`/dashboard/officers/${id}?date=${date}`), [id, date]);
  if (error) return <ErrorBanner error={error} />;
  if (!d) return <p className="mute">Loading…</p>;
  const o = d.officer;
  const siteId = d.shifts[0]?.siteId ?? o.homeSiteId;
  const siteName = d.shifts[0]?.siteName ?? o.homeSiteName;
  const empty = (x: unknown[]) => x.length === 0;

  return (
    <>
      <div className="crumbs">
        <Link href={`/?date=${d.date}`}>{me.company.name}</Link> › <Link href={`/dashboard/sites/${siteId}?date=${d.date}`}>{siteName}</Link> ›{' '}
        <b>{o.name}</b> › {formatDate(d.date)}
      </div>
      <div className="head">
        <div>
          <h1>{o.name}</h1>
          <p className="mute">
            #{o.employeeNumber} · based at {o.homeSiteName} · {dayLabel(d.date, d.today)}
          </p>
        </div>
        <DateNav date={d.date} today={d.today} />
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        {can('officers.view') && (
          <Link className="btn ghost" href={`/officers/${o.id}`}>
            Profile
          </Link>
        )}
        {d.performance && (
          <Link className="btn ghost" href={`/scores/${o.id}`}>
            Full score history
          </Link>
        )}
      </div>

      <div className="dgrid">
        <div className="card">
          <h2>Shift and declarations</h2>
          {empty(d.shifts) && <p className="mute">Not on duty on this day.</p>}
          {d.shifts.map((s) => (
            <div key={s.id}>
              <Link href={`/attendance/${s.id}`} className="line">
                <span>
                  <b>{s.shiftName ?? 'Shift'}</b> at {s.siteName}
                  <div className="mute small">
                    Duty On {time(s.dutyOnAt)} · Duty From {s.dutyFromAt ? time(s.dutyFromAt) : 'not yet'}
                    {s.scheduledStart && ` · scheduled ${time(s.scheduledStart)}–${time(s.scheduledEnd)}`}
                  </div>
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <ArrivalPill row={s} />
                  <DeparturePill row={s} />
                </span>
              </Link>
              {s.declarations.map((x) => (
                <Link key={x.id} href={`/attendance/${s.id}`} className="line sub">
                  <span>
                    {x.kind === 'duty_on' ? 'Duty On' : 'Duty From'} declaration at {time(x.at)}
                    <span className="mute small"> · {x.hasSelfie ? 'selfie taken' : 'selfie still to arrive'}</span>
                    {x.comment && <div className="small">“{x.comment}”</div>}
                  </span>
                  <Pill tone={x.comment ? 'amber' : 'green'}>{x.comment ? 'Comment' : 'Declared'}</Pill>
                </Link>
              ))}
            </div>
          ))}
        </div>

        {d.performance && (
          <div className="card">
            <h2>Performance</h2>
            <div className="row" style={{ marginBottom: 8 }}>
              <b style={{ fontSize: 28 }}>{d.performance.score}</b>
              <PositionPill position={d.performance.position} label={d.performance.positionLabel} />
              <span className="mute small">as at the end of this day</span>
            </div>
            {empty(d.performance.events) && <p className="mute">No score changes on this day.</p>}
            {d.performance.events.map((e) => (
              <Link key={e.id} href={`/scores/${o.id}`} className="line">
                <span>
                  <b>{eventLabel(e.type)}</b>
                  <div className="mute small">{e.evidence}</div>
                </span>
                <Points n={e.impact} />
              </Link>
            ))}
          </div>
        )}

        <div className="card">
          <h2>Tasks</h2>
          {empty(d.tasks) && <p className="mute">No tasks on this day.</p>}
          {d.tasks.map((t) => (
            <Link key={t.id} href={`/tasks/occurrence/${t.id}`} className="line">
              <span>
                <b>{t.title}</b>
                <div className="mute small">
                  {t.dueTime ? `Due ${t.dueTime}` : 'Any time in the shift'}
                  {t.doneAt && ` · done ${time(t.doneAt)}${t.doneByMe ? '' : ` by ${t.doneByName}`}`}
                  {t.cannotReason && ` · ${COULD_NOT_COMPLETE_REASONS[t.cannotReason]}`}
                </div>
                {t.comment && <div className="small">“{t.comment}”</div>}
              </span>
              <TaskStatus status={t.status} review={t.review} />
            </Link>
          ))}
        </div>

        <div className="card">
          <h2>Patrols</h2>
          {empty(d.patrols) && <p className="mute">No patrols on this day.</p>}
          {d.patrols.map((p) => (
            <Link key={p.id} href={`/patrols/${p.id}`} className="line">
              <span>
                <b>
                  {p.typeCode}. {p.typeName}
                </b>
                <div className="mute small">
                  Window {time(p.windowStart)}–{time(p.windowEnd)}
                  {p.startedAt && ` · ${time(p.startedAt)}–${p.finishedAt ? time(p.finishedAt) : ''}`}
                  {p.pointsEarned > 0 && ` · +${p.pointsEarned} points`}
                </div>
              </span>
              <PatrolState state={p.state} review={p.review} />
            </Link>
          ))}
        </div>

        <div className="card">
          <h2>Reports and follow-ups</h2>
          {empty(d.reports) && empty(d.actions) && <p className="mute">No reports or follow-ups on this day.</p>}
          {d.reports.map((r) => (
            <Link key={r.id} href={`/reports/${r.id}`} className="line">
              <span>
                <b>
                  #{r.number} {REPORT_CATEGORIES[r.category]}
                </b>{' '}
                <TrafficLight priority={r.priority} />
                <div className="mute small">Reported at {time(r.reportedAt)}</div>
                <div className="small">{r.description}</div>
              </span>
              <StagePill stage={r.stage} />
            </Link>
          ))}
          {d.actions.map((a) => (
            <Link key={a.id} href={`/reports/${a.reportId}`} className="line">
              <span>
                <b>
                  #{a.reportNumber} {actionText(a)}
                </b>
                <div className="mute small">at {time(a.at)}</div>
                {a.note && <div className="small">“{a.note}”</div>}
              </span>
              <Pill tone="blue">Follow-up</Pill>
            </Link>
          ))}
        </div>

        {d.training && (
          <div className="card">
            <h2>Training</h2>
            {d.training.map((q) => (
              <Link key={q.name} href={`/officers/${o.id}`} className="line">
                <span>
                  <b>{q.name}</b>
                  <div className="mute small">{q.expiryDate ? `Expires ${formatDate(q.expiryDate)}` : 'Does not expire'}</div>
                </span>
                <StatusPill status={q.status} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
