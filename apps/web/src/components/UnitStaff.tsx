'use client';

import { useState } from 'react';
import { WEEKDAYS } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDateTime, useLoad } from './ui';

interface Staff {
  id: string;
  fullName: string;
  visiting: string;
  cell: string;
  code: string;
  when: string;
  enrolled: boolean;
  ended: boolean;
  onSite: boolean;
  lastIn: string | null;
  lastOut: string | null;
}

const EMPTY = { fullName: '', cell: '', idNumber: '', days: [] as number[], hoursFrom: '', hoursTo: '', endDate: '', unitId: '' };

/** The form for registering someone who works for a unit: who, their cell number, and when they work. */
function StaffForm({ path, units, onDone, onCancel }: { path: string; units?: { id: string; name: string }[]; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = error instanceof ApiError ? error.errors : {};
  const set = (patch: Partial<typeof EMPTY>) => setF({ ...f, ...patch });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(path, {
        method: 'POST',
        json: { fullName: f.fullName, cell: f.cell, idNumber: f.idNumber, days: f.days, hoursFrom: f.hoursFrom || null, hoursTo: f.hoursTo || null, endDate: f.endDate || null, ...(units ? { unitId: f.unitId || null } : {}) },
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>Add a staff member</h2>
      <p className="mute small">Someone who works for the unit, such as a cleaner or gardener. They are let in on their working days without anyone being asked.</p>
      <ErrorBanner error={error} />
      {units && (
        <Field label="Works for" error={errors.unitId}>
          <select value={f.unitId} onChange={(e) => set({ unitId: e.target.value })}>
            <option value="">The office (the client)</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                Unit {u.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Name" error={errors.fullName}>
        <input value={f.fullName} onChange={(e) => set({ fullName: e.target.value })} required />
      </Field>
      <Field label="Cell number" error={errors.cell} hint="At the gate they give the last six digits of this number.">
        <input type="tel" value={f.cell} onChange={(e) => set({ cell: e.target.value })} required />
      </Field>
      <Field label="ID or passport number (optional)" error={errors.idNumber} hint="The gate scans their ID on the first day. If you give the number, it must be the same one.">
        <input value={f.idNumber} onChange={(e) => set({ idNumber: e.target.value })} />
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
        <Field label="Starts work (optional)" error={errors.hoursFrom}>
          <input type="time" value={f.hoursFrom} onChange={(e) => set({ hoursFrom: e.target.value })} />
        </Field>
        <Field label="Finishes work (optional)" error={errors.hoursTo} hint="If they are still on site then, you are asked whether they are still busy.">
          <input type="time" value={f.hoursTo} onChange={(e) => set({ hoursTo: e.target.value })} />
        </Field>
      </div>
      <Field label="Last day (optional)" error={errors.endDate}>
        <input type="date" value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} />
      </Field>
      <div className="m-actions">
        <button className="btn" disabled={busy}>
          {busy ? 'Saving…' : 'Add staff member'}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function StaffLine({ s, showUnit, onRemove }: { s: Staff; showUnit: boolean; onRemove?: () => void }) {
  return (
    <div className="line" style={{ alignItems: 'flex-start' }}>
      <span>
        <b>{s.fullName}</b> {s.onSite && <Pill tone="green">On site</Pill>} {s.ended && <Pill tone="grey">Ended</Pill>} {!s.enrolled && <Pill tone="amber">Not been yet</Pill>}
        <span className="mute small" style={{ display: 'block' }}>
          {showUnit ? `${s.visiting} · ` : ''}
          {s.when}
        </span>
        <span className="mute small" style={{ display: 'block' }}>
          Cell {s.cell} · gives <b>{s.code}</b> at the gate
        </span>
        {s.lastIn && (
          <span className="mute small" style={{ display: 'block' }}>
            Last in {formatDateTime(s.lastIn)}
            {s.lastOut && !s.onSite ? ` · out ${formatDateTime(s.lastOut)}` : ''}
          </span>
        )}
      </span>
      {onRemove && (
        <button className="btn ghost sm" onClick={onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}

/** "My staff" in the customer app (D-47): the people who work for this unit, when they last came and went, adding and removing. */
export function CustomerStaff() {
  const { data, error, reload } = useLoad(() => api<Staff[]>('/customer/staff'), []);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  async function remove(s: Staff) {
    if (!window.confirm(`Take ${s.fullName} off your staff? They will no longer be let in without you being asked.`)) return;
    setActionError(null);
    try {
      await api(`/customer/staff/${s.id}/remove`, { method: 'POST' });
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <section className="card" style={{ marginTop: 12 }}>
        <h2>My staff</h2>
        <p className="mute small">People who work for you, such as a cleaner or gardener. On their working days the gate lets them in on their cell number and photo, without asking you.</p>
        <ErrorBanner error={error ?? actionError} />
        {data && data.length === 0 && <p className="mute">Nobody yet.</p>}
        {data?.map((s) => <StaffLine key={s.id} s={s} showUnit={false} onRemove={() => remove(s)} />)}
        {!adding && (
          <button className="btn ghost m-wide" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
            Add a staff member
          </button>
        )}
      </section>
      {adding && (
        <StaffForm
          path="/customer/staff"
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </>
  );
}

/** Staff of the units of a site, on the website (D-47). The administrator adds them for a tenant who sends the details. */
export function SiteUnitStaff({ siteId }: { siteId: string }) {
  const { can } = useSession();
  const allowed = can('visitors.view');
  const manage = can('visitors.staff.manage');
  const { data, error, reload } = useLoad(() => (allowed ? api<Staff[]>(`/sites/${siteId}/unit-staff`) : Promise.resolve([] as Staff[])), [siteId, allowed]);
  const units = useLoad(() => (manage ? api<{ units: { id: string; name: string; active: boolean }[] }>(`/sites/${siteId}/customers`) : Promise.resolve({ units: [] })), [siteId, manage]);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  if (!allowed) return null;

  async function remove(s: Staff) {
    if (!window.confirm(`Take ${s.fullName} off the staff list of ${s.visiting}? They will no longer be let in without the customer being asked.`)) return;
    setActionError(null);
    try {
      await api(`/sites/${siteId}/unit-staff/${s.id}/remove`, { method: 'POST' });
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Staff of units{data ? ` (${data.length})` : ''}</h2>
        <button className="btn ghost sm" onClick={reload}>
          Refresh
        </button>
      </div>
      <p className="mute small">Cleaners, gardeners and others who work for a tenant. Tenants add their own in their app; the administrator can add them here. At the gate they give the last six digits of their cell number.</p>
      <ErrorBanner error={error ?? actionError} />
      {data && data.length === 0 && <p className="mute">No staff have been registered.</p>}
      {data?.map((s) => <StaffLine key={s.id} s={s} showUnit onRemove={manage ? () => remove(s) : undefined} />)}
      {manage && !adding && (
        <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>
          Add a staff member
        </button>
      )}
      {manage && adding && (
        <div style={{ marginTop: 12, maxWidth: 520 }}>
          <StaffForm
            path={`/sites/${siteId}/unit-staff`}
            units={(units.data?.units ?? []).filter((u) => u.active)}
            onCancel={() => setAdding(false)}
            onDone={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}
    </div>
  );
}
