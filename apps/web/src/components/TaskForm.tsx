'use client';

import { useState } from 'react';
import { RECURRENCE_LABELS, RECURRENCES, sastDate, taskErrors } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, Field, useLoad } from './ui';

export interface TaskValue {
  title: string;
  instructions: string;
  siteId: string;
  assigneeType: 'employee' | 'post';
  assigneeEmployeeId: string | null;
  assigneeDeviceId: string | null;
  recurrence: string;
  startDate: string;
  endDate: string | null;
  timeRequired: boolean;
  dueTime: string | null;
  photoRequired: boolean;
}

export const emptyTask = (): TaskValue => ({
  title: '',
  instructions: '',
  siteId: '',
  assigneeType: 'post',
  assigneeEmployeeId: null,
  assigneeDeviceId: null,
  recurrence: 'once',
  startDate: sastDate(new Date()),
  endDate: null,
  timeRequired: false,
  dueTime: null,
  photoRequired: false,
});

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** A plain-language summary of when the task happens. */
export function whenText(t: Pick<TaskValue, 'recurrence' | 'startDate' | 'timeRequired' | 'dueTime'>) {
  const d = new Date(`${t.startDate}T12:00:00Z`);
  const at = t.timeRequired && t.dueTime ? ` at ${t.dueTime}` : ', any time during the shift';
  switch (t.recurrence) {
    case 'daily':
      return `Every day${at}`;
    case 'weekly':
      return `Every ${d.toLocaleDateString('en-ZA', { weekday: 'long', timeZone: 'UTC' })}${at}`;
    case 'monthly':
      return `On the ${ordinal(d.getUTCDate())} of every month${at}`;
    default:
      return `On ${d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}${at}`;
  }
}

/**
 * Creates or edits a task. When editing, the site, how often and the first
 * date are fixed: to change those, stop the task and create a new one.
 */
export function TaskForm({ initial, editing, onSave }: { initial: TaskValue; editing?: boolean; onSave: (t: TaskValue) => Promise<void> }) {
  const [t, setT] = useState<TaskValue>(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const officers = useLoad(() => api<{ id: string; full_name: string; employee_number: string; site_id: string; status: string }[]>('/officers'));
  const devices = useLoad(() => api<{ id: string; label: string; postName: string; siteId: string | null; status: string }[]>('/devices'));

  const serverErrors = error instanceof ApiError ? error.errors : {};
  const errors = { ...(tried ? taskErrors(t) : {}), ...serverErrors };
  const set = (patch: Partial<TaskValue>) => {
    setT((x) => ({ ...x, ...patch }));
    setError(null);
  };
  const posts = devices.data?.filter((d) => d.siteId === t.siteId && d.status !== 'disabled' && d.status !== 'retired') ?? [];
  const people = officers.data?.filter((o) => o.status === 'active') ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (Object.keys(taskErrors(t)).length) return;
    setBusy(true);
    try {
      await onSave(t);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <ErrorBanner error={error} />
      <div className="card">
        <h2>The task</h2>
        <div className="grid g2">
          <Field label="What needs doing" error={errors.title}>
            <input value={t.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Check all fire extinguishers" />
          </Field>
          <Field label="Site" error={errors.siteId}>
            <select value={t.siteId} disabled={editing} onChange={(e) => set({ siteId: e.target.value, assigneeDeviceId: null })}>
              <option value="">Choose a site…</option>
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Instructions for the officer (optional)">
          <textarea rows={2} value={t.instructions} onChange={(e) => set({ instructions: e.target.value })} />
        </Field>
        <label className="row" style={{ marginBottom: 6 }}>
          <input type="checkbox" checked={t.photoRequired} onChange={(e) => set({ photoRequired: e.target.checked })} /> A photo is required as
          proof
        </label>
      </div>

      <div className="card">
        <h2>Who does it</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <label className="row">
            <input type="radio" checked={t.assigneeType === 'post'} onChange={() => set({ assigneeType: 'post', assigneeEmployeeId: null })} /> A post
            (whoever is on duty there)
          </label>
          <label className="row">
            <input type="radio" checked={t.assigneeType === 'employee'} onChange={() => set({ assigneeType: 'employee', assigneeDeviceId: null })} /> A
            specific officer
          </label>
        </div>
        {t.assigneeType === 'post' ? (
          <Field label="Post" error={errors.assigneeDeviceId} hint={!t.siteId ? 'Choose the site first.' : !posts.length ? 'This site has no post devices yet.' : undefined}>
            <select value={t.assigneeDeviceId ?? ''} onChange={(e) => set({ assigneeDeviceId: e.target.value || null })}>
              <option value="">Choose a post…</option>
              {posts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.postName || d.label} ({d.label})
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Officer" error={errors.assigneeEmployeeId}>
            <select value={t.assigneeEmployeeId ?? ''} onChange={(e) => set({ assigneeEmployeeId: e.target.value || null })}>
              <option value="">Choose an officer…</option>
              {people.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.full_name} (#{o.employee_number})
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="card">
        <h2>When</h2>
        <div className="grid g3">
          <Field label="How often" error={errors.recurrence} hint={editing ? 'To change this, stop the task and create a new one.' : undefined}>
            <select value={t.recurrence} disabled={editing} onChange={(e) => set({ recurrence: e.target.value })}>
              {RECURRENCES.map((r) => (
                <option key={r} value={r}>
                  {RECURRENCE_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.recurrence === 'once' ? 'Date' : 'First date'} error={errors.startDate}>
            <input type="date" disabled={editing} value={t.startDate} min={editing ? undefined : sastDate(new Date())} onChange={(e) => set({ startDate: e.target.value })} />
          </Field>
          {t.recurrence !== 'once' && (
            <Field label="Last date (optional)" error={errors.endDate}>
              <input type="date" value={t.endDate ?? ''} onChange={(e) => set({ endDate: e.target.value || null })} />
            </Field>
          )}
        </div>
        <label className="row" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={t.timeRequired} onChange={(e) => set({ timeRequired: e.target.checked, dueTime: e.target.checked ? t.dueTime ?? '08:00' : null })} />{' '}
          A specific time is required
        </label>
        {t.timeRequired && (
          <div style={{ maxWidth: 200 }}>
            <Field label="Time" error={errors.dueTime}>
              <input type="time" value={t.dueTime ?? ''} onChange={(e) => set({ dueTime: e.target.value })} />
            </Field>
          </div>
        )}
        <p className="mute small">
          {whenText(t)}. The server creates each one on schedule, even if the last one was not done. Anything not done by the end of its
          day is recorded as missed.
        </p>
      </div>

      <button className="btn" disabled={busy}>
        {busy ? 'Saving…' : editing ? 'Save changes' : 'Create task'}
      </button>
    </form>
  );
}
