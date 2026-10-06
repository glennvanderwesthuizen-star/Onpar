'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use, useEffect, useRef, useState } from 'react';
import { FOLLOW_UP_OUTCOMES, FollowUpOutcome, MANAGEMENT_ACTIONS, Priority, PRIORITY_LABELS, ReportCategory, REPORT_CATEGORIES, Stage, STAGE_LABELS } from '@onpar/rules';
import { api, imageUrl } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDate, formatDateTime, useLoad } from '@/components/ui';
import { ReportBadge, StageProgress, TrafficLight } from '@/components/reports';

interface Report {
  id: string;
  number: number;
  colour: string;
  siteName: string;
  category: ReportCategory;
  priority: Priority;
  description: string;
  stage: Stage;
  needsAttention: boolean;
  reportedAt: string;
  receivedAt: string;
  lateSynced: boolean;
  reportedBy: string;
  source: string;
  hasPhoto: boolean;
  photoPending: boolean;
  assigneePersonId: string | null;
  assigneeName: string | null;
  assigneeRole: string | null;
  assigneePhone: string | null;
  assigneeKind: string | null;
  recipients: { name: string; role: string }[];
  declaration: null | { pending?: boolean; at?: string; statements?: { text: string; accepted: boolean }[]; comment?: string; shiftName?: string; shiftDate?: string };
  inspection: { id: string; state: string; date: string }[];
  history: {
    id: string;
    at: string;
    receivedAt: string;
    actorType: string;
    actorLabel: string;
    actorRole: string;
    action: string;
    stageAfter: Stage;
    outcome: FollowUpOutcome | null;
    note: string;
    lateSynced: boolean;
    hasPhoto: boolean;
    assigneeName: string | null;
    assigneeRole: string | null;
  }[];
}

const ACTION_TEXT: Record<string, string> = {
  reported: 'Reported',
  assigned: 'Assigned',
  actioned: 'Work recorded as done',
  attendance_checked: 'Attendance checked',
  job_inspected: 'Job inspected',
  closed: 'Closed and signed off',
  follow_up: 'Officer followed up',
  note: 'Note',
};

export default function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: r, error, reload } = useLoad(() => api<Report>(`/reports/${id}`), [id]);
  // The same page serves the full website and the supervisor app's phone frame (/m/reports/…).
  const back = usePathname().startsWith('/m/') ? '/m/reports' : '/reports';

  if (error) return <ErrorBanner error={error} />;
  if (!r) return <p className="mute">Loading…</p>;

  return (
    <>
      <div className="head">
        <div>
          <Link href={back} className="mute small">
            ← Reports
          </Link>
          <h1 className="row">
            <ReportBadge number={r.number} colour={r.colour} /> {REPORT_CATEGORIES[r.category]} <TrafficLight priority={r.priority} />
            <span className="mute small">{PRIORITY_LABELS[r.priority]}</span>
          </h1>
          <p className="mute">
            {r.siteName} · reported by {r.reportedBy} on {formatDateTime(r.reportedAt)}
            {r.lateSynced && ` (sent from the device at ${formatDateTime(r.receivedAt)})`}
          </p>
        </div>
      </div>
      <StageProgress stage={r.stage} />
      {r.needsAttention && r.stage !== 'closed' && <div className="banner warn">An officer has followed up. See the latest entry in the history.</div>}

      <div className="grid g2">
        <div className="card">
          <h2>What was reported</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{r.description}</p>
          {r.source === 'declaration' && <p className="mute small">Raised from a comment on a Duty On or Duty From declaration.</p>}
          <Photo path={r.hasPhoto ? `/reports/${r.id}/photo` : null} pending={r.photoPending} alt="Photo with the report" />
          <p className="mute small" style={{ marginTop: 10 }}>
            Sent to: {r.recipients.length ? r.recipients.map((x) => x.name).join(', ') : 'nobody at the site yet (company managers see every report)'}
          </p>
        </div>
        <div className="card">
          <h2>Assigned to</h2>
          {r.assigneeName ? (
            <p>
              <b>{r.assigneeName}</b>, {r.assigneeRole} ({r.assigneeKind === 'contractor' ? 'contractor' : 'staff'})
              <br />
              <a href={`tel:${r.assigneePhone}`}>{r.assigneePhone}</a>
            </p>
          ) : (
            <p className="mute">Nobody yet.</p>
          )}
          {r.inspection.length > 0 && (
            <p className="small">
              Inspection task for the officer on site:{' '}
              <Pill tone={r.inspection.at(-1)!.state === 'completed' ? 'green' : r.inspection.at(-1)!.state === 'cancelled' ? 'grey' : 'blue'}>
                {r.inspection.at(-1)!.state === 'completed' ? 'done' : r.inspection.at(-1)!.state === 'cancelled' ? 'cancelled (not fixed)' : 'waiting'}
              </Pill>
            </p>
          )}
          <Actions report={r} onDone={reload} />
        </div>
      </div>

      {r.declaration && (
        <div className="card">
          <h2>What the officer declared at Duty On</h2>
          {r.declaration.pending ? (
            <p className="mute">The officer had not completed the Duty On declaration for that shift.</p>
          ) : (
            <>
              <p className="mute small">
                {r.declaration.shiftName} shift of {formatDate(r.declaration.shiftDate)}, declared at {formatDateTime(r.declaration.at)}
              </p>
              <ul style={{ paddingLeft: 20 }}>
                {r.declaration.statements?.map((s) => (
                  <li key={s.text}>
                    {s.accepted ? '✓' : '✗'} “{s.text}”
                  </li>
                ))}
              </ul>
              {r.declaration.comment && <p>Comment: {r.declaration.comment}</p>}
              <p className="mute small">A declaration is evidence, not proof. Injury-on-duty questions are for an employment lawyer.</p>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2>History</h2>
        <div className="timeline">
          {r.history.map((h) => (
            <div key={h.id}>
              <b>{ACTION_TEXT[h.action] ?? h.action}</b>
              {h.outcome && <> · {FOLLOW_UP_OUTCOMES[h.outcome]}</>}
              <div className="mute small">
                {formatDateTime(h.at)} · {h.actorLabel}
                {h.actorRole && `, ${h.actorRole}`}
                {h.lateSynced && ` · sent at ${formatDateTime(h.receivedAt)} (was offline)`}
              </div>
              {h.assigneeName && (
                <div className="small">
                  To {h.assigneeName} ({h.assigneeRole})
                </div>
              )}
              {h.note && h.action !== 'follow_up' && <div>{h.note}</div>}
              {h.action === 'follow_up' && <div>{h.note.split(' · ').slice(1).join(' · ')}</div>}
              {h.stageAfter !== 'reported' && h.action === 'follow_up' && (
                <div className="mute small">Stage after: {STAGE_LABELS[h.stageAfter]}</div>
              )}
              {h.hasPhoto && <Photo path={`/reports/${r.id}/history/${h.id}/photo`} alt="Photo with this step" small />}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Photo({ path, pending, alt, small }: { path: string | null; pending?: boolean; alt: string; small?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let u: string | null = null;
    imageUrl(path).then((x) => setUrl((u = x))).catch(() => undefined);
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [path]);
  if (!path) return pending ? <p className="mute small">The photo is still uploading from the device.</p> : null;
  return url ? <img src={url} alt={alt} style={{ maxWidth: small ? 220 : '100%', borderRadius: 8, marginTop: 6 }} /> : <p className="mute small">Loading photo…</p>;
}

function Actions({ report: r, onDone }: { report: Report; onDone: () => void }) {
  const { can } = useSession();
  const people = useLoad(() => api<{ id: string; name: string; role: string; kind: string; active: boolean }[]>('/people'));
  const [note, setNote] = useState('');
  const [person, setPerson] = useState(r.assigneePersonId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  if (!can('reports.manage') || r.stage === 'closed') return null;

  const available = (Object.keys(MANAGEMENT_ACTIONS) as (keyof typeof MANAGEMENT_ACTIONS)[]).filter(
    (a) => (MANAGEMENT_ACTIONS[a].from as readonly string[]).includes(r.stage) && (a !== 'close' || can('reports.close')),
  );
  const send = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      // A photo of the work goes with a step (not with a note on its own).
      if (photo && path !== 'note') {
        const form = new FormData();
        form.append('data', JSON.stringify(body));
        form.append('photo', photo);
        await api(`/reports/${r.id}/${path}`, { method: 'POST', body: form });
      } else {
        await api(`/reports/${r.id}/${path}`, { method: 'POST', json: body });
      }
      setNote('');
      setPhoto(null);
      if (photoInput.current) photoInput.current.value = '';
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const hints: Record<string, string> = {
    assign: 'Choose who will fix it. The officer who reported it can follow up at any time.',
    actioned: 'Record that the assignee did the work (for contractors, you record it for them).',
    attendance_checked: 'Confirm the assignee actually came. The officer on site is then sent a task to inspect the work.',
    close: 'Sign off. The officer who reported it gets a point.',
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}>
      <h3>Next step</h3>
      {r.stage === 'job_inspected' && !can('reports.close') && <p className="mute small">Waiting for a company manager to close it.</p>}
      {r.stage === 'attendance_checked' && <p className="mute small">Waiting for the officer on site to inspect the work.</p>}
      <ErrorBanner error={error} />
      {available.includes('assign') && (
        <Field label={r.stage === 'assigned' ? 'Reassign to' : 'Assign to'} hint={people.data && !people.data.length ? 'Add people in the People directory first.' : undefined}>
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Choose…</option>
            {people.data
              ?.filter((p) => p.active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}, {p.role} ({p.kind === 'contractor' ? 'contractor' : 'staff'})
                </option>
              ))}
          </select>
        </Field>
      )}
      <Field label="Note">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {available.length > 0 && (
        <Field label="Photo (optional)" hint="For example the finished repair. On a phone this opens the camera. It is saved with the next step you record.">
          <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </Field>
      )}
      <div className="row">
        {available.map((a) => (
          <button
            key={a}
            className={a === 'assign' && r.stage === 'assigned' ? 'btn ghost' : 'btn'}
            title={hints[a]}
            disabled={busy || (a === 'assign' && (!person || person === r.assigneePersonId))}
            onClick={() => send(a, { note, ...(a === 'assign' ? { assigneePersonId: person } : {}) })}
          >
            {a === 'assign' && r.stage === 'assigned' ? 'Reassign' : MANAGEMENT_ACTIONS[a].label}
          </button>
        ))}
        <button className="btn ghost" disabled={busy || note.trim().length < 2} onClick={() => send('note', { note })}>
          Add note only
        </button>
      </div>
      {available.map((a) => (
        <p key={a} className="mute small" style={{ margin: '6px 0 0' }}>
          <b>{MANAGEMENT_ACTIONS[a].label}:</b> {hints[a]}
        </p>
      ))}
    </div>
  );
}
