'use client';

import { useState } from 'react';
import { WEEKDAYS } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, Field, Pill, useLoad } from './ui';

interface Pass {
  id: string;
  kind: 'once' | 'ongoing';
  visitorName: string;
  category: string;
  gateName: string | null;
  when: string;
  idNumber: string | null;
  cell: string | null;
  registration: string | null;
  by: string;
  contractor: boolean;
  maxWorkers: number | null;
  leaveBy: string | null;
  state: 'current' | 'used' | 'ended' | 'cancelled';
  stateLabel: string;
}
interface Options {
  categories: { id: string; name: string }[];
  gates: { id: string; name: string }[];
  today: string;
}
type Data = Options & { current: Pass[]; past: Pass[] };

const EMPTY = { contractor: false, maxWorkers: '0', leaveBy: '18:00', visitorName: '', categoryId: '', gateId: '', idNumber: '', cell: '', registration: '', visitDate: '', time: '', days: [] as number[], hoursFrom: '', hoursTo: '', startDate: '', endDate: '' };

/**
 * The form for telling the gate who is coming (visitor management, step 4): one visit on a
 * day, or a regular on set days and hours. `fromVisit`: made from a visitor already let in,
 * so the gate's own record of their ID and number plate is used and nothing is typed.
 */
export function PassForm({ options, fromVisit, startName = '', onDone, onCancel }: { options: Options; fromVisit?: string; startName?: string; onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<'once' | 'ongoing'>(fromVisit ? 'ongoing' : 'once');
  const [f, setF] = useState({ ...EMPTY, visitorName: startName, visitDate: options.today });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = error instanceof ApiError ? error.errors : {};
  const set = (patch: Partial<typeof EMPTY>) => setF({ ...f, ...patch });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        kind,
        visitorName: f.visitorName,
        // A visitor, or a contractor with the workers you approve and a time to be gone by.
        contractor: f.contractor,
        maxWorkers: f.contractor ? (f.maxWorkers.trim() === '' ? null : Number(f.maxWorkers)) : null,
        leaveBy: f.contractor ? f.leaveBy || null : null,
        gateId: f.gateId || null,
        idNumber: f.idNumber,
        cell: f.cell,
        registration: f.registration,
        // One day: that day. More than one: from that day on, to the last day if one was given.
        visitDate: kind === 'once' ? f.visitDate || null : null,
        time: null,
        days: f.days,
        hoursFrom: f.hoursFrom || null,
        hoursTo: f.hoursTo || null,
        startDate: kind === 'ongoing' ? f.visitDate || null : null,
        endDate: f.endDate || null,
      };
      await api(fromVisit ? `/customer/visits/${fromVisit}/pass` : '/customer/passes', { method: 'POST', json: body });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>{fromVisit ? 'Let them in next time' : 'Tell the gate who is coming'}</h2>
      <ErrorBanner error={error} />
      <div className="m-actions" style={{ marginTop: 0, marginBottom: 4 }}>
        <button type="button" className={`btn ${f.contractor ? 'ghost' : ''}`} onClick={() => set({ contractor: false })}>
          A visitor
        </button>
        <button type="button" className={`btn ${f.contractor ? '' : 'ghost'}`} onClick={() => set({ contractor: true })}>
          A contractor
        </button>
      </div>
      <p className="mute small" style={{ marginTop: 0 }}>
        {f.contractor ? 'Someone coming to do work, with workers the gate counts in and out.' : 'Someone coming to see you or to deliver.'}
      </p>

      <Field label={f.contractor ? 'Who is coming: contractor’s name or company' : 'Who is coming'} error={errors.visitorName}>
        <input value={f.visitorName} onChange={(e) => set({ visitorName: e.target.value })} required />
      </Field>
      {f.contractor && (
        <>
          <Field label="Contractor’s cell number" error={errors.cell}>
            <input type="tel" value={f.cell} onChange={(e) => set({ cell: e.target.value })} required />
          </Field>
          <div className="grid g2">
            <Field label="Workers with them" error={errors.maxWorkers} hint="Not counting the contractor. More than this and you are asked.">
              <input inputMode="numeric" value={f.maxWorkers} onChange={(e) => set({ maxWorkers: e.target.value.replace(/\D/g, '').slice(0, 2) })} required />
            </Field>
            <Field label="Must be gone by" error={errors.leaveBy} hint="If they are still on site then, you are asked whether they are still busy.">
              <input type="time" value={f.leaveBy} onChange={(e) => set({ leaveBy: e.target.value })} required />
            </Field>
          </div>
        </>
      )}

      <Field label={kind === 'once' ? 'When are they coming' : 'First day'} error={errors.visitDate ?? errors.startDate}>
        <input type="date" min={options.today} value={f.visitDate} onChange={(e) => set({ visitDate: e.target.value })} required />
      </Field>
      <div className="m-actions" style={{ marginBottom: 12 }}>
        <button type="button" className={`btn ${kind === 'once' ? '' : 'ghost'}`} onClick={() => setKind('once')}>
          That day only
        </button>
        <button type="button" className={`btn ${kind === 'ongoing' ? '' : 'ghost'}`} onClick={() => setKind('ongoing')}>
          More than one day
        </button>
      </div>
      {kind === 'ongoing' && (
        <>
          <Field label="Last day" error={errors.endDate} hint="Leave empty to let them in until you remove them from your list.">
            <input type="date" min={f.visitDate || options.today} value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} />
          </Field>
          <Field label="Which days" error={errors.days} hint="Leave all unticked for every day.">
            <div className="chips">
              {WEEKDAYS.map((d, i) => {
                const on = f.days.includes(i + 1);
                return (
                  <label key={d} className="chip" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={() => set({ days: on ? f.days.filter((x) => x !== i + 1) : [...f.days, i + 1] })} />
                    {d}
                  </label>
                );
              })}
            </div>
          </Field>
          <div className="grid g2">
            <Field label="From what time (optional)" error={errors.hoursFrom}>
              <input type="time" value={f.hoursFrom} onChange={(e) => set({ hoursFrom: e.target.value })} />
            </Field>
            <Field label="Until what time (optional)" error={errors.hoursTo}>
              <input type="time" value={f.hoursTo} onChange={(e) => set({ hoursTo: e.target.value })} />
            </Field>
          </div>
        </>
      )}

      {options.gates.length > 1 && (
        <Field label="Which gate" error={errors.gateId} hint="They are still let in at another gate; the guard sees which one you named.">
          <select value={f.gateId} onChange={(e) => set({ gateId: e.target.value })}>
            <option value="">Any gate</option>
            {options.gates.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {fromVisit ? (
        <p className="mute small">The gate will recognise them by the ID and number plate it scanned this time. You can add their cell number as well.</p>
      ) : (
        <>
          <h3 style={{ marginTop: 14 }}>How the gate will know them</h3>
          <p className="mute small">{f.contractor ? 'The gate can find them by the cell number above. A number plate or ID number as well makes it quicker.' : 'Give at least one. It must match exactly what is scanned at the gate.'}</p>
          {errors.identifier && <div className="err">{errors.identifier}</div>}
          <Field label="Number plate" error={errors.registration}>
            <input value={f.registration} onChange={(e) => set({ registration: e.target.value })} autoCapitalize="characters" />
          </Field>
          <Field label="ID or passport number" error={errors.idNumber}>
            <input value={f.idNumber} onChange={(e) => set({ idNumber: e.target.value })} />
          </Field>
        </>
      )}
      {!f.contractor && (
        <Field label={fromVisit ? 'Cell number (optional)' : 'Cell number'} error={errors.cell} hint="The guard asks the visitor for it and types it in.">
          <input type="tel" value={f.cell} onChange={(e) => set({ cell: e.target.value })} />
        </Field>
      )}

      <div className="m-actions">
        <button className="btn" disabled={busy}>
          {busy ? 'Saving…' : 'Tell the gate'}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The customer's list of expected and regular visitors, with adding and removing. */
export function CustomerPasses() {
  const { data, error, reload } = useLoad(() => api<Data>('/customer/passes'), []);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  async function remove(p: Pass) {
    if (!window.confirm(`Take ${p.visitorName} off your list? The gate will ask you next time they come.`)) return;
    setActionError(null);
    try {
      await api(`/customer/passes/${p.id}/cancel`, { method: 'POST' });
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <h1 className="m-h1">Visitors</h1>
      <ErrorBanner error={error ?? actionError} />
      {saved && !adding && (
        <div className="banner ok" role="status">
          <b>The gate has been told.</b> They will be let in without asking you, and you get an alert when they arrive.
        </div>
      )}
      {!data && !error && <p className="mute">Loading…</p>}
      {data && !adding && (
        <button className="btn m-wide" onClick={() => (setAdding(true), setSaved(false))}>
          Tell the gate who is coming
        </button>
      )}
      {data && adding && (
        <PassForm
          options={data}
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            setSaved(true);
            reload();
          }}
        />
      )}
      {data && (
        <section className="card" style={{ marginTop: 12 }}>
          <h2>Expected and regular visitors</h2>
          {data.current.length === 0 && <p className="mute">Nobody yet. Anyone not on this list waits at the gate while you are asked.</p>}
          {data.current.map((p) => (
            <div key={p.id} className="line" style={{ alignItems: 'flex-start' }}>
              <span>
                <b>{p.visitorName}</b> <Pill tone={p.kind === 'once' ? 'amber' : 'green'}>{p.stateLabel}</Pill>
                <span className="mute small" style={{ display: 'block' }}>
                  {p.contractor ? `Contractor · up to ${p.maxWorkers ?? 0} worker${p.maxWorkers === 1 ? '' : 's'} · gone by ${p.leaveBy ?? '18:00'}` : 'Visitor'} · {p.when}
                  {p.gateName ? ` · ${p.gateName}` : ''}
                </span>
                <span className="mute small" style={{ display: 'block' }}>
                  {[p.registration ? `Plate ${p.registration}` : null, p.idNumber ? `ID ${p.idNumber}` : null, p.cell ? `Cell ${p.cell}` : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              <button className="btn ghost sm" onClick={() => remove(p)}>
                Remove
              </button>
            </div>
          ))}
          {data.past.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Earlier</h3>
              {data.past.map((p) => (
                <div key={p.id} className="line">
                  <span>
                    {p.visitorName}
                    <span className="mute small" style={{ display: 'block' }}>
                      {p.contractor ? `Contractor · up to ${p.maxWorkers ?? 0} worker${p.maxWorkers === 1 ? '' : 's'} · gone by ${p.leaveBy ?? '18:00'}` : 'Visitor'} · {p.when}
                    </span>
                  </span>
                  <span className="mute small">{p.stateLabel}</span>
                </div>
              ))}
            </>
          )}
        </section>
      )}
    </>
  );
}
