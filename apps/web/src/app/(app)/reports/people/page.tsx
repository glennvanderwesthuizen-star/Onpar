'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, useLoad } from '@/components/ui';

interface Person {
  id: string;
  name: string;
  role: string;
  phone: string;
  kind: 'internal' | 'contractor';
  active: boolean;
}

const EMPTY = { name: '', role: '', phone: '', kind: 'contractor' as Person['kind'], active: true };

export default function PeoplePage() {
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => api<Person[]>('/people'));
  const [editing, setEditing] = useState<Person | null>(null);
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const errors = saveError instanceof ApiError ? saveError.errors : {};
  const manage = can('people.manage');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaveError(null);
    try {
      if (editing) await api(`/people/${editing.id}`, { method: 'PUT', json: f });
      else await api('/people', { method: 'POST', json: f });
      setEditing(null);
      setF(EMPTY);
      reload();
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <Link href="/reports" className="mute small">
            ← Reports
          </Link>
          <h1>People directory</h1>
          <p className="mute">Staff and contractors that reports can be assigned to.</p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="card scroll">
        {data && !data.length && <p className="mute">Nobody yet. Add the plumber, electrician or handyman you use.</p>}
        {!!data?.length && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Does</th>
                <th>Phone</th>
                <th>Type</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}>
                  <td>
                    <b>{p.name}</b>
                    {!p.active && (
                      <div>
                        <Pill tone="grey">Not in use</Pill>
                      </div>
                    )}
                  </td>
                  <td>{p.role}</td>
                  <td>
                    <a href={`tel:${p.phone}`}>{p.phone}</a>
                  </td>
                  <td>{p.kind === 'contractor' ? 'Contractor' : 'Staff'}</td>
                  <td>
                    {manage && (
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          setEditing(p);
                          setF({ name: p.name, role: p.role, phone: p.phone, kind: p.kind, active: p.active });
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {manage && (
        <form className="card" onSubmit={save}>
          <h2>{editing ? `Edit ${editing.name}` : 'Add someone'}</h2>
          <ErrorBanner error={saveError} />
          <div className="grid g2">
            <Field label="Name" error={errors.name}>
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label="What they do" error={errors.role}>
              <input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="e.g. Plumber" />
            </Field>
            <Field label="Phone" error={errors.phone}>
              <input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            </Field>
            <Field label="Type">
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Person['kind'] })}>
                <option value="contractor">Contractor</option>
                <option value="internal">Staff</option>
              </select>
            </Field>
          </div>
          {editing && (
            <label className="row" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Still in use (untick to
              stop assigning new reports to them)
            </label>
          )}
          <div className="row">
            <button className="btn" disabled={busy}>
              {editing ? 'Save' : 'Add'}
            </button>
            {editing && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setEditing(null);
                  setF(EMPTY);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </>
  );
}
