'use client';

import Link from 'next/link';
import { useState } from 'react';
import { COULD_NOT_COMPLETE_REASONS, CouldNotCompleteReason, sastDate } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, useLoad } from '@/components/ui';
import { time } from '@/components/attendance';
import { whenText } from '@/components/TaskForm';
import { TaskStatus } from '@/components/TaskStatus';

interface BoardRow {
  id: string;
  title: string;
  dueTime: string | null;
  status: string;
  review: string | null;
  cannotReason: CouldNotCompleteReason | null;
  doneAt: string | null;
  doneByName: string | null;
  assigneeName: string;
  siteName: string;
  photoRequired: boolean;
  hasPhoto: boolean;
  photoPending: boolean;
}

interface Board {
  date: string;
  rows: BoardRow[];
  counts: { completed: number; outstanding: number; overdue: number; missed: number; couldNotComplete: number; awaitingReview: number };
}

interface TaskDef {
  id: string;
  title: string;
  siteName: string;
  assigneeName: string;
  recurrence: string;
  startDate: string;
  endDate: string | null;
  timeRequired: boolean;
  dueTime: string | null;
  photoRequired: boolean;
  active: boolean;
}

export default function TasksPage() {
  const { can } = useSession();
  const [date, setDate] = useState(() => sastDate(new Date()));
  const [siteId, setSiteId] = useState('');
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const board = useLoad(() => api<Board>(`/tasks/board?date=${date}${siteId ? `&siteId=${siteId}` : ''}`), [date, siteId]);
  const tasks = useLoad(() => api<TaskDef[]>(`/tasks${siteId ? `?siteId=${siteId}` : ''}`), [siteId]);
  const c = board.data?.counts;
  const move = (days: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    setDate(d.toISOString().slice(0, 10));
  };

  async function stop(t: TaskDef) {
    if (!window.confirm(`Stop "${t.title}"? Today's stays; later ones are cancelled.`)) return;
    await api(`/tasks/${t.id}/stop`, { method: 'POST' });
    tasks.reload();
    board.reload();
  }

  return (
    <>
      <div className="head">
        <div>
          <h1>Tasks</h1>
          <p className="mute">What was due on the day, and what happened to it.</p>
        </div>
        {can('tasks.manage') && (
          <Link className="btn" href="/tasks/new">
            + New task
          </Link>
        )}
      </div>

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

      <div className="tiles">
        <div className="tile">
          <b>{c?.completed ?? '–'}</b>
          <span>Done</span>
        </div>
        <div className="tile">
          <b>{c?.outstanding ?? '–'}</b>
          <span>Still to do</span>
        </div>
        <div className="tile">
          <b style={{ color: c?.overdue ? 'var(--amber)' : undefined }}>{c?.overdue ?? '–'}</b>
          <span>Overdue</span>
        </div>
        <div className="tile">
          <b style={{ color: c?.missed ? 'var(--red)' : undefined }}>{c?.missed ?? '–'}</b>
          <span>Missed</span>
        </div>
        <div className="tile">
          <b style={{ color: c?.awaitingReview ? 'var(--amber)' : undefined }}>{c?.awaitingReview ?? '–'}</b>
          <span>Could not complete, to review</span>
        </div>
      </div>

      <ErrorBanner error={board.error} />
      <div className="card scroll">
        {board.data && !board.data.rows.length && <p className="mute">No tasks fall on this day.</p>}
        {!!board.data?.rows.length && (
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>For</th>
                <th>When</th>
                <th>Status</th>
                <th>Done by</th>
              </tr>
            </thead>
            <tbody>
              {board.data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/tasks/occurrence/${r.id}`}>
                      <b>{r.title}</b>
                    </Link>
                    <div className="mute small">
                      {r.siteName}
                      {r.photoRequired && ' · photo required'}
                    </div>
                  </td>
                  <td>{r.assigneeName}</td>
                  <td>{r.dueTime ?? <span className="mute">Any time</span>}</td>
                  <td>
                    <TaskStatus status={r.status} review={r.review} />
                    {r.cannotReason && <div className="mute small">{COULD_NOT_COMPLETE_REASONS[r.cannotReason]}</div>}
                    {r.photoPending && <div className="mute small">Photo still uploading</div>}
                  </td>
                  <td>
                    {r.doneByName ?? '—'}
                    {r.doneAt && <div className="mute small">{time(r.doneAt)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card scroll">
        <h2>All tasks</h2>
        {tasks.data && !tasks.data.length && <p className="mute">No tasks set up yet.</p>}
        {!!tasks.data?.length && (
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>For</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tasks.data.map((t) => (
                <tr key={t.id} style={{ opacity: t.active ? 1 : 0.55 }}>
                  <td>
                    <b>{t.title}</b>
                    <div className="mute small">
                      {t.siteName}
                      {t.photoRequired && ' · photo required'}
                    </div>
                  </td>
                  <td>{t.assigneeName}</td>
                  <td>
                    {whenText(t)}
                    {t.endDate && <div className="mute small">Until {t.endDate}</div>}
                  </td>
                  <td>
                    {!t.active ? (
                      <Pill tone="grey">Stopped</Pill>
                    ) : (
                      can('tasks.manage') && (
                        <div className="row">
                          <Link className="btn ghost sm" href={`/tasks/${t.id}/edit`}>
                            Edit
                          </Link>
                          <button className="btn ghost sm" onClick={() => stop(t)}>
                            Stop
                          </button>
                        </div>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
