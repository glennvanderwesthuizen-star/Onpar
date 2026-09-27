'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { COULD_NOT_COMPLETE_REASONS, CouldNotCompleteReason } from '@onpar/rules';
import { api, imageUrl } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, formatDate, formatDateTime, useLoad } from '@/components/ui';
import { TaskStatus } from '@/components/TaskStatus';

interface Occurrence {
  id: string;
  title: string;
  instructions: string;
  occurrence_date: string;
  due_hhmm: string | null;
  photo_required: boolean;
  site_name: string;
  assignee_name: string;
  status: string;
  state: string;
  done_by_name: string | null;
  done_at: string | null;
  comment: string;
  cannot_reason: CouldNotCompleteReason | null;
  has_photo: boolean;
  photo_pending: boolean;
  review: string | null;
  review_note: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  history: { id: string; at: string; received_at: string; actor_type: string; actor_label: string; action: string; note: string; late_synced: boolean }[];
}

const ACTION: Record<string, string> = {
  completed: 'Completed',
  could_not_complete: 'Could not complete',
  missed: 'Missed',
  cancelled: 'Cancelled',
  review_accepted: 'Reason accepted',
  review_not_accepted: 'Reason not accepted',
};

export default function OccurrencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data: o, error, reload } = useLoad(() => api<Occurrence>(`/tasks/occurrences/${id}`), [id]);
  const [photo, setPhoto] = useState<string | null>(null);

  useEffect(() => {
    if (!o?.has_photo) return;
    let u: string | null = null;
    imageUrl(`/tasks/occurrences/${id}/photo`).then((x) => setPhoto((u = x))).catch(() => undefined);
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [o?.has_photo, id]);

  if (error) return <ErrorBanner error={error} />;
  if (!o) return <p className="mute">Loading…</p>;

  return (
    <>
      <div className="head">
        <div>
          <Link href="/tasks" className="mute small">
            ← Tasks
          </Link>
          <h1>{o.title}</h1>
          <p className="mute">
            {o.site_name} · {o.assignee_name} · {formatDate(o.occurrence_date)}, {o.due_hhmm ?? 'any time during the shift'}
          </p>
        </div>
        <TaskStatus status={o.status} review={o.review} />
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>What happened</h2>
          {o.instructions && (
            <p>
              <span className="mute small">Instructions:</span> {o.instructions}
            </p>
          )}
          {o.done_by_name ? (
            <p>
              {o.state === 'completed' ? 'Done' : 'Reported as could not complete'} by <b>{o.done_by_name}</b> at {formatDateTime(o.done_at)}
            </p>
          ) : (
            <p className="mute">Nobody has done this yet.</p>
          )}
          {o.cannot_reason && (
            <p>
              <b>Reason:</b> {COULD_NOT_COMPLETE_REASONS[o.cannot_reason]}
            </p>
          )}
          {o.comment && (
            <p>
              <b>Comment:</b> {o.comment}
            </p>
          )}
          <h3 style={{ marginTop: 14 }}>History</h3>
          {!o.history.length && <p className="mute small">Nothing yet.</p>}
          {o.history.map((h) => (
            <div key={h.id} className="small" style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}>
              <b>{ACTION[h.action] ?? h.action}</b> · {formatDateTime(h.at)} · {h.actor_type === 'system' ? 'System' : h.actor_label}
              {h.note && <div>{h.note}</div>}
              {h.late_synced && <div className="mute">Sent from the device at {formatDateTime(h.received_at)} (was offline)</div>}
            </div>
          ))}
        </div>

        <div className="card">
          <h2>Photo</h2>
          {photo ? (
            <img src={photo} alt={`Photo for ${o.title}`} style={{ width: '100%', borderRadius: 8 }} />
          ) : (
            <p className="mute">{o.photo_pending ? 'The photo is still uploading from the device.' : o.photo_required ? 'Required, not received yet.' : 'No photo.'}</p>
          )}
        </div>
      </div>

      {o.state === 'could_not_complete' && <Review occurrence={o} canManage={can('tasks.manage')} onDone={reload} />}
    </>
  );
}

function Review({ occurrence: o, canManage, onDone }: { occurrence: Occurrence; canManage: boolean; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async (decision: 'accepted' | 'not_accepted') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/tasks/occurrences/${o.id}/review`, { method: 'POST', json: { decision, note } });
      onDone();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>Supervisor review</h2>
      {o.review ? (
        <p>
          {o.review === 'accepted' ? 'Reason accepted' : 'Reason not accepted'} by {o.reviewed_by_name} on {formatDateTime(o.reviewed_at)}: {o.review_note}
        </p>
      ) : canManage ? (
        <>
          <p className="mute small">
            There is no penalty until you review this. Accepting the reason means none at all. Not accepting it means the task counts as not
            done.
          </p>
          <ErrorBanner error={error} />
          <Field label="Note">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="row">
            <button className="btn" disabled={busy || note.trim().length < 3} onClick={() => send('accepted')}>
              Accept the reason
            </button>
            <button className="btn ghost" disabled={busy || note.trim().length < 3} onClick={() => send('not_accepted')}>
              Do not accept
            </button>
          </div>
        </>
      ) : (
        <p className="mute">Waiting for a supervisor to review.</p>
      )}
    </div>
  );
}
