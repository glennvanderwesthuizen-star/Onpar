'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, formatDate, useLoad } from '@/components/ui';
import { useSession } from '@/lib/session';

interface Delivery {
  id: string;
  number: number;
  status: 'ready' | 'with_supervisor';
  employeeName: string;
  siteName: string;
  items: string | null;
  nextOnDuty: { date: string; shiftName: string | null; startTime: string | null; today: boolean } | null;
}

interface Occurrence {
  id: string;
  date: string;
  title: string;
  state: string;
  review: string | null;
  cannotReason: string | null;
  siteName: string;
  doneByName: string | null;
  assigneeName: string | null;
}

const REASONS: Record<string, string> = {
  equipment_unavailable: 'Equipment unavailable',
  access_unavailable: 'Access unavailable',
  emergency: 'Emergency',
  supervisor_instruction: 'Supervisor instruction',
  other: 'Other',
};

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

/**
 * Supervisor app, My tasks: what is waiting on the supervisor himself. Uniform to collect and
 * deliver, guards' "could not complete" reasons to review, selfies to check and reports to pick up.
 */
export default function MobileTasks() {
  const { can } = useSession();
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const deliveries = useLoad(() => (can('uniform.deliver') ? api<Delivery[]>('/uniform/deliveries') : Promise.resolve([])), [round]);
  const reviews = useLoad(
    async () => {
      if (!can('tasks.view')) return [] as Occurrence[];
      // "Could not complete" from today and yesterday that nobody has reviewed.
      const boards = await Promise.all([day(0), day(-1)].map((d) => api<{ rows: Occurrence[] }>(`/tasks/board?date=${d}`)));
      return boards.flatMap((b) => b.rows).filter((o) => o.state === 'could_not_complete' && !o.review);
    },
    [round],
  );
  const selfies = useLoad(() => (can('attendance.view') ? api<{ counts: { todo: number } }>('/selfie-checks?view=todo').then((r) => r.counts.todo) : Promise.resolve(0)), [round]);
  const reports = useLoad(
    () => (can('reports.view') ? api<{ rows: { needsAttention: boolean; stage: string }[] }>('/reports?status=open').then((r) => r.rows.filter((x) => x.needsAttention || x.stage === 'reported').length) : Promise.resolve(0)),
    [round],
  );

  async function act(id: string, path: string, json: unknown) {
    setBusy(id);
    setError(null);
    try {
      await api(path, { method: 'POST', json });
      setReviewing(null);
      setNote('');
      setRound((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const loading = !deliveries.data || !reviews.data || selfies.data === null || reports.data === null;
  const nothing = !loading && !deliveries.data!.length && !reviews.data!.length && !selfies.data && !reports.data;

  return (
    <>
      <h1 className="m-h1">My tasks</h1>
      <ErrorBanner error={error ?? deliveries.error ?? reviews.error ?? selfies.error ?? reports.error} />
      {loading && !deliveries.error && !reviews.error && <p className="mute">Loading…</p>}
      {nothing && (
        <div className="m-allclear">
          <b>Nothing is waiting on you.</b>
        </div>
      )}

      {(!!selfies.data || !!reports.data) && (
        <nav className="card m-menu" aria-label="Waiting on you">
          {!!reports.data && (
            <Link href="/m/reports">
              <span>
                <b>Reports waiting on you</b>
                <span className="mute small">Not yet assigned, or an officer has followed up</span>
              </span>
              <span className="go">
                <span className="pill amber">{reports.data}</span>
                <span aria-hidden="true">›</span>
              </span>
            </Link>
          )}
          {!!selfies.data && (
            <Link href="/m/selfies">
              <span>
                <b>Selfies to check</b>
                <span className="mute small">From the last seven days</span>
              </span>
              <span className="go">
                <span className="pill blue">{selfies.data}</span>
                <span aria-hidden="true">›</span>
              </span>
            </Link>
          )}
        </nav>
      )}

      {!!reviews.data?.length && (
        <>
          <h2 className="m-h2">Tasks a guard could not complete</h2>
          {reviews.data.map((o) => (
            <article key={o.id} className="card">
              <h3 style={{ margin: 0, fontSize: 17 }}>{o.title}</h3>
              <p className="mute small">
                {o.siteName} · {formatDate(o.date)} · {o.doneByName ?? o.assigneeName ?? 'the post'}
              </p>
              <p>
                Reason given: <b>{REASONS[o.cannotReason ?? ''] ?? o.cannotReason ?? 'none'}</b>
              </p>
              {can('tasks.manage') && reviewing !== o.id && (
                <div className="m-actions">
                  <button className="btn" onClick={() => (setReviewing(o.id), setNote(''))}>
                    Review the reason
                  </button>
                  <Link className="btn ghost" href={`/tasks/occurrence/${o.id}`}>
                    See the details
                  </Link>
                </div>
              )}
              {reviewing === o.id && (
                <div className="m-form">
                  <label className="f">
                    <span>Your note (required)</span>
                    <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: confirmed the generator room was locked" />
                  </label>
                  <p className="mute small">Accept: no points are lost. Do not accept: it counts as a missed task and the guard loses the points for it. He can query that from his phone.</p>
                  <div className="m-actions">
                    <button className="btn" disabled={busy === o.id || note.trim().length < 3} onClick={() => act(o.id, `/tasks/occurrences/${o.id}/review`, { decision: 'accepted', note })}>
                      Accept the reason
                    </button>
                    <button className="btn danger" disabled={busy === o.id || note.trim().length < 3} onClick={() => act(o.id, `/tasks/occurrences/${o.id}/review`, { decision: 'not_accepted', note })}>
                      Do not accept
                    </button>
                    <button className="btn ghost" onClick={() => setReviewing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </>
      )}

      {!!deliveries.data?.length && (
        <>
          <h2 className="m-h2">Uniform</h2>
          {deliveries.data.map((d) => (
            <article key={d.id} className="card">
              <div className="m-alert-head">
                <h3 style={{ margin: 0, fontSize: 17 }}>{d.status === 'ready' ? 'Collect at stores' : `Deliver to ${d.employeeName.split(' ')[0]}`}</h3>
                <span className={`pill ${d.status === 'ready' ? 'amber' : d.nextOnDuty?.today ? 'red' : 'blue'}`}>{d.status === 'ready' ? 'Ready' : d.nextOnDuty?.today ? 'Deliver today' : 'With you'}</span>
              </div>
              <p>
                For <b>{d.employeeName}</b> at {d.siteName}
              </p>
              {d.items && <p className="mute small">{d.items}</p>}
              <p className="small">
                {d.nextOnDuty
                  ? d.nextOnDuty.today
                    ? `He is on duty today${d.nextOnDuty.startTime ? ` from ${d.nextOnDuty.startTime.slice(0, 5)}` : ''}.`
                    : `He is next on duty on ${formatDate(d.nextOnDuty.date)}${d.nextOnDuty.startTime ? ` from ${d.nextOnDuty.startTime.slice(0, 5)}` : ''}.`
                  : 'He is not on the roster in the next two weeks.'}
              </p>
              {d.status === 'ready' ? (
                <div className="m-actions">
                  <button className="btn" disabled={busy === d.id} onClick={() => act(d.id, `/uniform/orders/${d.id}/collected`, { note: '' })}>
                    {busy === d.id ? 'Saving…' : 'I have collected these'}
                  </button>
                </div>
              ) : (
                <p className="mute small">When you hand them over, he signs for them with his PIN on the post phone. That closes this task.</p>
              )}
            </article>
          ))}
        </>
      )}
    </>
  );
}
