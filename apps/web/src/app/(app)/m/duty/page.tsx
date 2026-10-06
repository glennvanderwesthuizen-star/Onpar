'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner } from '@/components/ui';
import { useSession } from '@/lib/session';
import { clock, CONTACT_LABEL, OnDuty, tel, useHome } from '@/lib/supervisor';

/** Supervisor app, On duty: every guard on duty at the supervisor's sites; call him, or release him with a reason. */
export default function MobileDuty() {
  const { can } = useSession();
  const { data, error, stale, reload } = useHome();
  const [releasing, setReleasing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function release(g: OnDuty) {
    setBusy(true);
    setActionError(null);
    try {
      await api('/attendance/on-behalf', { method: 'POST', json: { employeeId: g.employeeId, kind: 'duty_from', reason } });
      setDone(`${g.name} is off duty. It is recorded under your name with your reason.`);
      setReleasing(null);
      setReason('');
      await reload();
      window.dispatchEvent(new Event('onpar:alerts'));
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="m-h1">Guards on duty</h1>
      {stale && <div className="banner warn">No connection. Showing the last update{data ? ` from ${clock(data.now)}` : ''}.</div>}
      {!data && <ErrorBanner error={error} />}
      {done && (
        <div className="banner ok" role="status">
          {done}
        </div>
      )}
      {!data && !error && <p className="mute">Loading…</p>}
      {data?.sites.map((s) => (
        <section key={s.id} id={s.id} className="m-section">
          <h2 className="m-h2">{s.name}</h2>
          {s.onDuty.length === 0 && <div className="card mute">Nobody is on duty.</div>}
          {s.onDuty.map((g) => (
            <article key={g.attendanceId} className={`card m-guard${g.relief === 'uncovered' ? ' red' : ''}`}>
              <div className="m-alert-head">
                <h3>{g.name}</h3>
                {g.relief === 'uncovered' ? <span className="pill red">No relief</span> : g.relief === 'waiting' ? <span className="pill amber">Waiting for relief</span> : g.relief === 'relieved' ? <span className="pill green">Relief arrived</span> : g.late > 0 ? <span className="pill amber">Late {g.late} min</span> : <span className="pill green">On duty</span>}
              </div>
              <p className="mute small">
                {g.employeeNumber}
                {g.shiftName ? ` · ${g.shiftName} shift` : ''} · on since {clock(g.dutyOnAt)}
                {g.scheduledEnd ? ` · shift ends ${clock(g.scheduledEnd)}` : ''}
              </p>
              {g.relief === 'uncovered' && <p>His relief has not arrived and the waiting time is over. He may leave, and the post will then be empty.</p>}
              {g.relief === 'waiting' && <p>His shift has ended and he is waiting for his relief{g.reliefUnlocksAt ? `. He may leave at ${clock(g.reliefUnlocksAt)} if nobody arrives` : ''}.</p>}
              <div className="m-actions">
                <a className="btn" href={tel(g.cell)}>
                  Call {g.name.split(' ')[0]}
                </a>
                {can('attendance.manage') && (
                  <button className="btn ghost" onClick={() => (setReleasing(releasing === g.attendanceId ? null : g.attendanceId), setReason(''), setActionError(null), setDone(null))}>
                    {releasing === g.attendanceId ? 'Cancel' : 'Release from duty'}
                  </button>
                )}
              </div>
              {releasing === g.attendanceId && (
                <form
                  className="m-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    release(g);
                  }}
                >
                  <ErrorBanner error={actionError} />
                  <label className="f">
                    <span>Why is {g.name.split(' ')[0]} being released?</span>
                    <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: sick, sent home; or relief did not arrive" required minLength={3} />
                  </label>
                  <p className="mute small">This logs Duty From for him now. It is recorded under your name and cannot be undone from here.</p>
                  <button className="btn danger m-wide" disabled={busy || reason.trim().length < 3}>
                    {busy ? 'Saving…' : `Release ${g.name.split(' ')[0]} now`}
                  </button>
                </form>
              )}
            </article>
          ))}
          {s.contacts.length > 0 && (
            <div className="m-actions">
              {s.contacts.map((c) => (
                <a key={c.kind} className="btn ghost sm" href={tel(c.phone)}>
                  Call {CONTACT_LABEL[c.kind].toLowerCase()}
                </a>
              ))}
            </div>
          )}
        </section>
      ))}
    </>
  );
}
