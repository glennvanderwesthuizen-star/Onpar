'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { sastDate } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, useLoad } from '@/components/ui';
import { ArrivalPill, AttendanceRow, DeparturePill, time } from '@/components/attendance';

export default function AttendancePage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const initial = use(searchParams).date;
  const { can } = useSession();
  const [date, setDate] = useState(() => (initial && /^\d{4}-\d{2}-\d{2}$/.test(initial) ? initial : sastDate(new Date())));
  const [siteId, setSiteId] = useState('');
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const { data, error, reload } = useLoad(
    () => api<{ date: string; rows: AttendanceRow[] }>(`/attendance?date=${date}${siteId ? `&siteId=${siteId}` : ''}`),
    [date, siteId],
  );
  const rows = data?.rows ?? [];
  const pending = rows.filter((r) => !r.onDeclared || (r.dutyFromAt && !r.fromDeclared)).length;
  const shift = (days: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    setDate(d.toISOString().slice(0, 10));
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>Attendance</h1>
          <p className="mute">Shifts are listed on the day they started. All times are South African time.</p>
        </div>
        <Link className="btn ghost" href="/attendance/selfies">
          Selfie checks
        </Link>
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <button className="btn ghost" onClick={() => shift(-1)} aria-label="Previous day">
            ←
          </button>
          <div style={{ width: 180 }}>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </Field>
          </div>
          <button className="btn ghost" onClick={() => shift(1)} aria-label="Next day">
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
          <b>{rows.length}</b>
          <span>Shifts started</span>
        </div>
        <div className="tile">
          <b>{rows.filter((r) => r.arrivalStatus === 'ON_TIME').length}</b>
          <span>On time</span>
        </div>
        <div className="tile">
          <b style={{ color: rows.some((r) => r.arrivalStatus === 'LATE') ? 'var(--red)' : undefined }}>
            {rows.filter((r) => r.arrivalStatus === 'LATE').length}
          </b>
          <span>Late</span>
        </div>
        <div className="tile">
          <b style={{ color: pending ? 'var(--amber)' : undefined }}>{pending}</b>
          <span>Declaration pending</span>
        </div>
      </div>

      <div className="banner warn small">
        Absences cannot be shown yet: that needs the roster (who was meant to work), which comes in the rostering milestone.
      </div>

      <ErrorBanner error={error} />
      <div className="card scroll">
        {data && !rows.length && <p className="mute">Nobody logged Duty On for a shift starting on this day.</p>}
        {rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Officer</th>
                <th>Shift</th>
                <th>Duty On</th>
                <th>Duty From</th>
                <th>Declarations</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/attendance/${r.id}`}>
                      <b>{r.employeeName}</b>
                    </Link>
                    <div className="mute small">
                      #{r.employeeNumber} · {r.siteName}
                    </div>
                  </td>
                  <td>
                    {r.shiftName ?? '—'}
                    <div className="mute small">
                      {time(r.scheduledStart)} to {time(r.scheduledEnd)}
                    </div>
                  </td>
                  <td>
                    {time(r.dutyOnAt)}
                    <div>
                      <ArrivalPill row={r} />
                    </div>
                  </td>
                  <td>
                    {time(r.dutyFromAt)}
                    <div>
                      <DeparturePill row={r} />
                    </div>
                  </td>
                  <td>
                    {r.onDeclared ? <Pill tone="green">On ✓</Pill> : <Pill tone="amber">On pending</Pill>}{' '}
                    {r.dutyFromAt && (r.fromDeclared ? <Pill tone="green">From ✓</Pill> : <Pill tone="amber">From pending</Pill>)}
                    {r.selfiePending && <div className="mute small">Selfie still uploading</div>}
                  </td>
                  <td className="small">
                    {r.hasComment && <div>💬 Comment</div>}
                    {r.onBehalf && <div>Logged by supervisor</div>}
                    {r.lateSynced && <div>Synced late (was offline)</div>}
                    {r.clockDrift && <div style={{ color: 'var(--red)' }}>Phone clock out by over 2 min</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {can('attendance.manage') && <OnBehalf onDone={reload} />}
    </>
  );
}

function OnBehalf({ onDone }: { onDone: () => void }) {
  const officers = useLoad(() => api<{ id: string; full_name: string; employee_number: string; site_name: string }[]>('/officers'));
  const [f, setF] = useState({ employeeId: '', kind: 'duty_on', reason: '', at: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api('/attendance/on-behalf', {
        method: 'POST',
        json: { employeeId: f.employeeId, kind: f.kind, reason: f.reason, ...(f.at ? { at: new Date(`${f.at}:00+02:00`).toISOString() } : {}) },
      });
      setOk(f.kind === 'duty_on' ? 'Duty On recorded.' : 'Duty From recorded.');
      setF({ employeeId: '', kind: 'duty_on', reason: '', at: '' });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Log Duty On or Duty From for an officer</h2>
      <p className="mute small">
        Only when the officer cannot do it on the device. A reason is required and it is recorded in the audit log. The officer still
        has to complete the declaration and selfie on the device.
      </p>
      {ok && <div className="banner ok">{ok}</div>}
      <ErrorBanner error={error} />
      <form onSubmit={submit}>
        <div className="grid g2">
          <Field label="Officer">
            <select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })} required>
              <option value="">Choose…</option>
              {officers.data?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.full_name} (#{o.employee_number}, {o.site_name})
                </option>
              ))}
            </select>
          </Field>
          <Field label="What to log">
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="duty_on">Duty On (arrival)</option>
              <option value="duty_from">Duty From (departure)</option>
            </select>
          </Field>
          <Field label="Actual time (leave empty for now)">
            <input type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} />
          </Field>
          <Field label="Reason">
            <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Device battery flat" />
          </Field>
        </div>
        <button className="btn" disabled={busy || !f.employeeId || f.reason.trim().length < 3}>
          {busy ? 'Saving…' : 'Record'}
        </button>
      </form>
    </div>
  );
}
