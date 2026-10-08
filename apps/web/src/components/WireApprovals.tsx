'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { AuthPhoto } from './AuthPhoto';
import { ErrorBanner, Field, Pill, formatDate, useLoad } from './ui';

interface Note {
  id: string;
  status: 'sent' | 'under_review' | 'adopted' | 'declined';
  statusLabel: string;
  noticed: string;
  suggestion: string;
  improves: string;
  hasPhoto: boolean;
  reason: string;
  sentAt: string;
  guard: string;
  site: string | null;
  decidedBy: string | null;
}
interface Award {
  id: string;
  kind: 'customer_praise' | 'discretionary';
  kindLabel: string;
  barbs: number;
  why: string;
  status: 'pending' | 'approved' | 'declined';
  reason: string;
  raisedAt: string;
  suggested: boolean;
  guard: string;
  site: string | null;
  raisedBy: string | null;
  decidedBy: string | null;
}
interface Approvals {
  notes: Note[];
  awards: Award[];
  budget: { siteId: string; site: string; used: number; budget: number }[];
  canDecide: boolean;
  range: { min: number; max: number; praise: number };
}

/**
 * Thuthuka notes and awards that wait for a person (rule book, 8 Oct 2026): managers look and
 * propose; the owner decides, always with a reason the guard reads.
 */
export function WireApprovals({ guards, changed }: { guards: { employeeId: string; name: string; site: string }[]; changed: () => void }) {
  const { data, error, reload } = useLoad(() => api<Approvals>('/wire/approvals'));
  const [err, setErr] = useState<unknown>(null);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;
  const done = () => {
    reload();
    changed();
  };
  const openNotes = data.notes.filter((n) => n.status === 'sent' || n.status === 'under_review');
  const openAwards = data.awards.filter((a) => a.status === 'pending');
  const decided = [...data.notes.filter((n) => !openNotes.includes(n)), ...data.awards.filter((a) => !openAwards.includes(a))];
  return (
    <div className="card">
      <h2>Waiting for a decision {openNotes.length + openAwards.length > 0 && <Pill tone="amber">{openNotes.length + openAwards.length}</Pill>}</h2>
      <p className="mute small">
        Thuthuka notes, customer praise and recognition awards. {data.canDecide ? 'You decide; the guard reads your reason.' : 'The owner decides; you can mark a note as being looked at and put an award forward.'}
      </p>
      <ErrorBanner error={err} />
      {!openNotes.length && !openAwards.length && <p className="mute">Nothing is waiting.</p>}
      {openNotes.map((n) => (
        <NoteItem key={n.id} n={n} canDecide={data.canDecide} done={done} fail={setErr} />
      ))}
      {openAwards.map((a) => (
        <AwardItem key={a.id} a={a} canDecide={data.canDecide} done={done} fail={setErr} />
      ))}
      <div className="row small mute" style={{ marginTop: 10 }}>
        Recognition barbs used this month:
        {data.budget.map((b) => (
          <span key={b.siteId}>
            {b.site} {b.used} of {b.budget}
          </span>
        ))}
      </div>
      <Propose guards={guards} range={data.range} done={done} />
      {!!decided.length && (
        <details style={{ marginTop: 12 }}>
          <summary>Decided in the last 30 days ({decided.length})</summary>
          {decided.map((x) => (
            <div key={x.id} className="small" style={{ marginTop: 6 }}>
              <b>{x.guard}</b> · {'kindLabel' in x ? `${x.kindLabel}, ${x.barbs} barbs` : `Thuthuka note: ${x.suggestion}`} ·{' '}
              {'kindLabel' in x ? (x.status === 'approved' ? 'Approved' : 'Declined') : x.statusLabel}
              {x.reason && <span className="mute"> · {x.reason}</span>}
              {x.decidedBy && <span className="mute"> · {x.decidedBy}</span>}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function NoteItem({ n, canDecide, done, fail }: { n: Note; canDecide: boolean; done: () => void; fail: (e: unknown) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (status: 'under_review' | 'adopted' | 'declined') => {
    setBusy(true);
    fail(null);
    try {
      await api(`/wire/notes/${n.id}/decide`, { method: 'POST', json: { status, reason } });
      done();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>
          Thuthuka note from {n.guard}
          {n.site && <span className="mute"> · {n.site}</span>}
        </b>
        <span className="mute small">
          {formatDate(n.sentAt)} · {n.statusLabel}
        </span>
      </div>
      <div className="small">
        <b>Noticed:</b> {n.noticed}
      </div>
      <div className="small">
        <b>Suggests:</b> {n.suggestion}
      </div>
      <div className="small">
        <b>Improves:</b> {n.improves}
      </div>
      {n.hasPhoto && <AuthPhoto path={`/wire/notes/${n.id}/photo`} alt="Photo with the note" width={180} />}
      {canDecide && (
        <Field label="Your reason (the guard reads it)">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Timer fitted on all gate lights" />
        </Field>
      )}
      <div className="row">
        {n.status === 'sent' && (
          <button className="btn ghost sm" disabled={busy} onClick={() => decide('under_review')}>
            Looking at it
          </button>
        )}
        {canDecide && (
          <>
            <button className="btn sm" disabled={busy || reason.trim().length < 5} onClick={() => decide('adopted')}>
              Adopt
            </button>
            <button className="btn ghost sm" disabled={busy || reason.trim().length < 5} onClick={() => decide('declined')}>
              Not taken up
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AwardItem({ a, canDecide, done, fail }: { a: Award; canDecide: boolean; done: () => void; fail: (e: unknown) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    fail(null);
    try {
      await api(`/wire/awards/${a.id}/decide`, { method: 'POST', json: { approve, reason } });
      done();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>
          {a.kindLabel} for {a.guard}, {a.barbs} barbs
          {a.site && <span className="mute"> · {a.site}</span>}
        </b>
        <span className="mute small">
          {formatDate(a.raisedAt)} · {a.suggested ? 'Suggested by On Par' : `Put forward by ${a.raisedBy ?? 'someone'}`}
        </span>
      </div>
      <div className="small">{a.why}</div>
      {canDecide && (
        <>
          <Field label="Your reason (needed to decline; the guard reads it if approved)">
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="row">
            <button className="btn sm" disabled={busy} onClick={() => decide(true)}>
              Approve
            </button>
            <button className="btn ghost sm" disabled={busy || reason.trim().length < 5} onClick={() => decide(false)}>
              Decline
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Propose({ guards, range, done }: { guards: { employeeId: string; name: string; site: string }[]; range: Approvals['range']; done: () => void }) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [kind, setKind] = useState<'customer_praise' | 'discretionary'>('customer_praise');
  const [barbs, setBarbs] = useState(String(Math.round((range.min + range.max) / 2)));
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (!open)
    return (
      <button className="btn ghost" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
        Put a guard forward for an award
      </button>
    );
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('/wire/awards', { method: 'POST', json: { employeeId, kind, barbs: kind === 'discretionary' ? Number(barbs) : undefined, why } });
      setOpen(false);
      setWhy('');
      done();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 12 }}>
      <h3>Put a guard forward</h3>
      <ErrorBanner error={err} />
      <div className="grid g3">
        <Field label="Guard">
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose…</option>
            {guards.map((g) => (
              <option key={g.employeeId} value={g.employeeId}>
                {g.name} ({g.site})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="customer_praise">Customer praise ({range.praise} barbs)</option>
            <option value="discretionary">
              Recognition award ({range.min} to {range.max} barbs)
            </option>
          </select>
        </Field>
        {kind === 'discretionary' && (
          <Field label="Barbs">
            <input inputMode="numeric" value={barbs} onChange={(e) => setBarbs(e.target.value.replace(/\D/g, ''))} />
          </Field>
        )}
      </div>
      <Field label="Why (a sentence the guard will read)">
        <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="For example: The tenant of unit 4 thanked him for his help" />
      </Field>
      <div className="row">
        <button className="btn" disabled={busy || !employeeId || why.trim().length < 5} onClick={send}>
          {busy ? 'Sending…' : 'Send to the owner'}
        </button>
        <button className="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
