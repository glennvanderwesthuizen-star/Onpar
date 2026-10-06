'use client';

import { useState } from 'react';
import { ROLE_LABELS, SITE_SCOPED_ROLES, Role } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDateTime, useLoad } from '@/components/ui';

interface User {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  roleLabel: string;
  active: boolean;
  mustChangePassword: boolean;
  siteIds: string[];
  lastSignIn: string | null;
  employeeId: string | null;
  employeeLabel: string | null;
}
interface Officer {
  id: string;
  full_name: string;
  tsf_number: string | null;
  employee_number: string;
  status: string;
}
/** Roles that are also employees with their own shifts, Duty On and Duty From (D-42). */
const SELF_ROLES: Role[] = ['site_supervisor', 'site_manager'];
interface Site {
  id: string;
  name: string;
}

/** Payroll clerk is a Phase 2 role with nothing to do yet, so it is not offered. */
const ROLE_CHOICES = (Object.keys(ROLE_LABELS) as Role[]).filter((r) => r !== 'payroll_clerk');

const ROLE_HELP: Partial<Record<Role, string>> = {
  system_admin: 'Setup: sites, devices, users.',
  company_manager: 'Whole company: closes reports, approves reversals, edits scoring rules, enrols officers.',
  site_manager: 'Their sites: as a supervisor, plus Red reports and patrol setup.',
  site_supervisor: 'Their sites: attendance, tasks, reports, patrols, awards up to +2.',
  client_manager: 'Read-only summary for their site.',
  hr_admin: 'Officers and training.',
};

function TempPassword({ who, password, onClose }: { who: string; password: string; onClose: () => void }) {
  return (
    <div className="banner ok" role="status">
      <b>Temporary password for {who}:</b> <code className="secret">{password}</code>
      <div className="small" style={{ marginTop: 4 }}>
        Give it to them privately (in person or by phone, not by email). It is shown only now. They must choose their own password when they sign in.
      </div>
      <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={onClose}>
        Done
      </button>
    </div>
  );
}

function UserForm({
  sites,
  officers,
  initial,
  editing,
  onSave,
  onCancel,
}: {
  sites: Site[];
  officers: Officer[];
  initial: { fullName: string; email: string; role: Role; siteIds: string[]; active: boolean; employeeId: string | null };
  editing?: boolean;
  onSave: (v: typeof initial) => Promise<void>;
  onCancel?: () => void;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = error instanceof ApiError ? error.errors : {};
  const scoped = SITE_SCOPED_ROLES.includes(v.role);
  const toggleSite = (id: string) => setV({ ...v, siteIds: v.siteIds.includes(id) ? v.siteIds.filter((x) => x !== id) : [...v.siteIds, id] });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ ...v, siteIds: scoped ? v.siteIds : [], employeeId: SELF_ROLES.includes(v.role) ? v.employeeId : null });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <ErrorBanner error={error} />
      <div className="grid g2">
        <Field label="Full name" error={errors.fullName}>
          <input value={v.fullName} onChange={(e) => setV({ ...v, fullName: e.target.value })} required />
        </Field>
        <Field label="Email (they sign in with this)" error={errors.email}>
          <input type="email" value={v.email} disabled={editing} onChange={(e) => setV({ ...v, email: e.target.value })} required />
        </Field>
      </div>
      <Field label="Role" hint={ROLE_HELP[v.role]} error={errors.role}>
        <select value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as Role })}>
          {ROLE_CHOICES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      {scoped && (
        <fieldset className="f">
          <span>Sites they look after</span>
          <div className="row">
            {sites.map((s) => (
              <label key={s.id} className="row" style={{ gap: 4 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={v.siteIds.includes(s.id)} onChange={() => toggleSite(s.id)} />
                {s.name}
              </label>
            ))}
          </div>
          {errors.siteIds && <div className="err">{errors.siteIds}</div>}
        </fieldset>
      )}
      {SELF_ROLES.includes(v.role) && (
        <Field
          label="Their own officer record"
          error={errors.employeeId}
          hint="Choose this if they are also an employee with their own shifts. They can then log their own Duty On and Duty From, and see their shifts, score and uniform, in the supervisor app on their own phone. Enrol them as an officer first if they are not in the list."
        >
          <select value={v.employeeId ?? ''} onChange={(e) => setV({ ...v, employeeId: e.target.value || null })}>
            <option value="">Not joined to an officer record</option>
            {officers
              .filter((o) => o.status === 'active' || o.id === v.employeeId)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.full_name} ({o.tsf_number ?? o.employee_number})
                </option>
              ))}
          </select>
        </Field>
      )}
      {editing && (
        <label className="row" style={{ gap: 6, margin: '8px 0' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} />
          Active (untick to stop them signing in straight away)
        </label>
      )}
      <div className="row">
        <button className="btn" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Add user'}
        </button>
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export default function UsersPage() {
  const { me } = useSession();
  const { data, error, reload } = useLoad(() => api<User[]>('/users'));
  const sites = useLoad(() => api<Site[]>('/sites'));
  const officers = useLoad(() => api<Officer[]>('/officers'));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ who: string; password: string } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const siteName = (id: string) => sites.data?.find((s) => s.id === id)?.name ?? '…';

  async function reset(u: User) {
    if (!confirm(`Give ${u.fullName} a new temporary password? Their current password stops working.`)) return;
    setActionError(null);
    try {
      const r = await api<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`, { method: 'POST' });
      setTemp({ who: u.fullName, password: r.temporaryPassword });
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <h1>Users</h1>
          <p className="mute">People who sign in to this website. Guards sign in on the post phones with their employee number and PIN instead.</p>
        </div>
        {!adding && (
          <button className="btn" onClick={() => setAdding(true)}>
            Add a user
          </button>
        )}
      </div>
      {temp && <TempPassword who={temp.who} password={temp.password} onClose={() => setTemp(null)} />}
      <ErrorBanner error={error ?? actionError} />
      {adding && sites.data && (
        <div className="card">
          <h2>Add a user</h2>
          <UserForm
            sites={sites.data}
            officers={officers.data ?? []}
            initial={{ fullName: '', email: '', role: 'site_supervisor', siteIds: [], active: true, employeeId: null }}
            onCancel={() => setAdding(false)}
            onSave={async (v) => {
              const r = await api<{ temporaryPassword: string }>('/users', { method: 'POST', json: v });
              setTemp({ who: v.fullName, password: r.temporaryPassword });
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}
      <div className="card scroll">
        {data && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Sites</th>
                <th>Last signed in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((u) =>
                editing === u.id && sites.data ? (
                  <tr key={u.id}>
                    <td colSpan={5}>
                      <UserForm
                        sites={sites.data}
                        editing
                        officers={officers.data ?? []}
                        initial={{ fullName: u.fullName, email: u.email, role: u.role, siteIds: u.siteIds, active: u.active, employeeId: u.employeeId }}
                        onCancel={() => setEditing(null)}
                        onSave={async (v) => {
                          await api(`/users/${u.id}`, { method: 'PUT', json: { fullName: v.fullName, role: v.role, siteIds: v.siteIds, active: v.active, employeeId: v.employeeId } });
                          setEditing(null);
                          reload();
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
                    <td>
                      <b>{u.fullName}</b>
                      {u.id === me.id && <span className="mute"> (you)</span>}
                      <div className="mute small">{u.email}</div>
                      {u.employeeLabel && <div className="mute small">Officer record: {u.employeeLabel}</div>}
                    </td>
                    <td>
                      {u.roleLabel}
                      <div className="row" style={{ gap: 4, marginTop: 2 }}>
                        {!u.active && <Pill tone="grey">Inactive</Pill>}
                        {u.active && u.mustChangePassword && <Pill tone="amber">Temporary password</Pill>}
                      </div>
                    </td>
                    <td>{u.siteIds.length ? u.siteIds.map(siteName).join(', ') : <span className="mute">All sites</span>}</td>
                    <td>{u.lastSignIn ? formatDateTime(u.lastSignIn) : <span className="mute">Never</span>}</td>
                    <td>
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn ghost sm" onClick={() => setEditing(u.id)}>
                          Edit
                        </button>
                        {u.id !== me.id && (
                          <button className="btn ghost sm" onClick={() => reset(u)}>
                            Reset password
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
