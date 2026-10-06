'use client';

import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDateTime, useLoad } from './ui';

interface Unit {
  id: string;
  name: string;
  active: boolean;
  people: number;
}
interface Customer {
  id: string;
  kind: 'client' | 'tenant';
  fullName: string;
  email: string;
  unitId: string | null;
  unitName: string | null;
  phone: string;
  secondContactName: string;
  secondContactPhone: string;
  active: boolean;
  mustChangePassword: boolean;
  lastSignIn: string | null;
  alertsOn: boolean;
}
type Draft = { kind: 'client' | 'tenant'; fullName: string; email: string; unitId: string; phone: string; secondContactName: string; secondContactPhone: string; active: boolean };
interface ImportRow {
  unit: string;
  fullName: string;
  email: string;
  phone: string;
  secondContactName: string;
  secondContactPhone: string;
}

const EMPTY: Draft = { kind: 'tenant', fullName: '', email: '', unitId: '', phone: '', secondContactName: '', secondContactPhone: '', active: true };

/** Rows from a spreadsheet: unit, full name, email, phone, second contact name, second contact phone. A heading row is skipped. */
export function parseTenantRows(text: string): { rows: ImportRow[]; skipped: string[] } {
  const rows: ImportRow[] = [];
  const skipped: string[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
    const cells = line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
    const [unit = '', fullName = '', email = '', phone = '', secondContactName = '', secondContactPhone = ''] = cells;
    if (!email.includes('@')) {
      // The first line may be headings; anything else without an email address is reported.
      if (!(i === 0 && /unit/i.test(unit))) skipped.push(`Line ${i + 1}: no email address ("${line.slice(0, 60)}")`);
      continue;
    }
    if (!unit || fullName.length < 2) {
      skipped.push(`Line ${i + 1}: needs a unit and a full name`);
      continue;
    }
    rows.push({ unit, fullName, email, phone, secondContactName, secondContactPhone });
  }
  return { rows, skipped };
}

/**
 * The units, client and tenants of a site (phase 3, D-39), on the site's page. The
 * administrator adds and changes them; managers can look. Each customer gets a temporary
 * password shown once, and signs in to the customer app with their email.
 */
export function SiteCustomers({ siteId }: { siteId: string }) {
  const { can } = useSession();
  const manage = can('customers.manage');
  const { data, error, reload } = useLoad(() => api<{ units: Unit[]; customers: Customer[] }>(`/sites/${siteId}/customers`), [siteId]);
  const [unitName, setUnitName] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [temps, setTemps] = useState<{ who: string; email: string; password: string }[]>([]);
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const errors = actionError instanceof ApiError ? actionError.errors : {};

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  const addUnit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api(`/sites/${siteId}/units`, { method: 'POST', json: { name: unitName } });
      setUnitName('');
    });
  };
  const toggleUnit = (u: Unit) => run(() => api(`/sites/${siteId}/units/${u.id}`, { method: 'PUT', json: { name: u.name, active: !u.active } }).then(() => undefined));
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    run(async () => {
      const body = { ...draft, unitId: draft.unitId || null };
      if (editing) {
        await api(`/sites/${siteId}/customers/${editing}`, { method: 'PUT', json: body });
      } else {
        const r = await api<{ temporaryPassword: string }>(`/sites/${siteId}/customers`, { method: 'POST', json: body });
        setTemps([{ who: draft.fullName, email: draft.email, password: r.temporaryPassword }]);
      }
      setDraft(null);
      setEditing(null);
    });
  };
  const reset = (c: Customer) =>
    run(async () => {
      const r = await api<{ temporaryPassword: string }>(`/sites/${siteId}/customers/${c.id}/reset-password`, { method: 'POST' });
      setTemps([{ who: c.fullName, email: c.email, password: r.temporaryPassword }]);
    });
  const parsed = parseTenantRows(pasted);
  const doImport = () =>
    run(async () => {
      const r = await api<{ created: { fullName: string; email: string; temporaryPassword: string }[] }>(`/sites/${siteId}/customers/import`, { method: 'POST', json: { rows: parsed.rows } });
      setTemps(r.created.map((c) => ({ who: c.fullName, email: c.email, password: c.temporaryPassword })));
      setPasted('');
      setImporting(false);
    });

  if (!can('customers.view')) return null;
  return (
    <div className="card">
      <h2>Units, client and tenants</h2>
      <p className="mute small">
        The people at this site who use the customer app: the client who hires you, and the tenants in each unit. They sign in with their email at the same address as you, and get alerts on their own phone.
        {manage ? '' : ' Only the system administrator can change these.'}
      </p>
      <ErrorBanner error={error ?? actionError} />
      {Object.keys(errors).some((k) => k.startsWith('row')) && (
        <div className="banner err">
          <ul>
            {Object.entries(errors)
              .filter(([k]) => k.startsWith('row'))
              .map(([k, v]) => (
                <li key={k}>{v}</li>
              ))}
          </ul>
        </div>
      )}

      {temps.length > 0 && (
        <div className="banner ok" role="status">
          <b>{temps.length === 1 ? `Temporary password for ${temps[0].who}` : `Temporary passwords for ${temps.length} people`}</b>
          <div className="cust-wrap">
            <table className="cust-table">
              <tbody>
                {temps.map((t) => (
                  <tr key={t.email}>
                    <td>{t.who}</td>
                    <td>{t.email}</td>
                    <td>
                      <code className="secret-sm">{t.password}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small" style={{ marginTop: 4 }}>
            Give each person their password privately. They are shown only now. Each person must choose their own password when they first sign in.
          </div>
          <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setTemps([])}>
            Done
          </button>
        </div>
      )}

      {!data && !error && <p className="mute">Loading…</p>}
      {data && (
        <>
          <h3 style={{ marginTop: 14 }}>Units</h3>
          {data.units.length === 0 && <p className="mute">No units yet. Add each house, flat, office or shop that will have a tenant.</p>}
          <div className="chips">
            {data.units.map((u) => (
              <span key={u.id} className={`chip${u.active ? '' : ' off'}`}>
                <b>{u.name}</b>
                <span className="mute small">
                  {u.people} {u.people === 1 ? 'person' : 'people'}
                  {u.active ? '' : ' · not in use'}
                </span>
                {manage && (
                  <button disabled={busy} onClick={() => toggleUnit(u)}>
                    {u.active ? 'retire' : 'bring back'}
                  </button>
                )}
              </span>
            ))}
          </div>
          {manage && (
            <form className="row" onSubmit={addUnit}>
              <input style={{ maxWidth: 220 }} value={unitName} onChange={(e) => setUnitName(e.target.value)} placeholder="Unit number or name" aria-label="New unit number or name" required />
              <button className="btn ghost" disabled={busy || !unitName.trim()}>
                Add unit
              </button>
              {errors.name && <span className="err">{errors.name}</span>}
            </form>
          )}

          <h3 style={{ marginTop: 18 }}>Client and tenants</h3>
          {data.customers.length === 0 && <p className="mute">Nobody yet.</p>}
          {data.customers.length > 0 && (
            <div className="cust-wrap">
              <table className="cust-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Unit</th>
                    <th>Phone</th>
                    <th>Status</th>
                    {manage && <th />}
                  </tr>
                </thead>
                <tbody>
                  {data.customers.map((c) => (
                    <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}>
                      <td>
                        <b>{c.fullName}</b>
                        <div className="mute small">{c.email}</div>
                      </td>
                      <td>{c.kind === 'client' ? <Pill tone="blue">Client</Pill> : c.unitName}</td>
                      <td>
                        {c.phone || <span className="mute">None</span>}
                        {c.secondContactPhone && (
                          <div className="mute small">
                            {c.secondContactName}: {c.secondContactPhone}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          {!c.active && <Pill tone="grey">Inactive</Pill>}
                          {c.active && c.mustChangePassword && <Pill tone="amber">Has not signed in yet</Pill>}
                          {c.active && !c.mustChangePassword && <Pill tone={c.alertsOn ? 'green' : 'amber'}>{c.alertsOn ? 'Alerts on' : 'Alerts off'}</Pill>}
                        </div>
                        {c.lastSignIn && <div className="mute small">Last signed in {formatDateTime(c.lastSignIn)}</div>}
                      </td>
                      {manage && (
                        <td>
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="btn ghost sm"
                              onClick={() => {
                                setEditing(c.id);
                                setDraft({ kind: c.kind, fullName: c.fullName, email: c.email, unitId: c.unitId ?? '', phone: c.phone, secondContactName: c.secondContactName, secondContactPhone: c.secondContactPhone, active: c.active });
                                setActionError(null);
                              }}
                            >
                              Edit
                            </button>
                            <button className="btn ghost sm" disabled={busy} onClick={() => reset(c)}>
                              New password
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {manage && !draft && !importing && (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => (setDraft(EMPTY), setEditing(null), setActionError(null))}>
                Add a person
              </button>
              <button className="btn ghost" onClick={() => (setImporting(true), setActionError(null))}>
                Add many from a spreadsheet
              </button>
            </div>
          )}

          {manage && draft && (
            <form onSubmit={save} style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 14 }}>
              <h3>{editing ? 'Edit' : 'Add a person'}</h3>
              <div className="grid g2">
                <Field label="They are" error={errors.kind}>
                  <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}>
                    <option value="tenant">A tenant (lives or works in a unit)</option>
                    <option value="client">The client (hires the security company)</option>
                  </select>
                </Field>
                <Field label={draft.kind === 'tenant' ? 'Unit' : 'Unit (optional)'} error={errors.unitId} hint={data.units.some((u) => u.active) ? undefined : 'Add a unit above first.'}>
                  <select value={draft.unitId} onChange={(e) => setDraft({ ...draft, unitId: e.target.value })} required={draft.kind === 'tenant'}>
                    <option value="">{draft.kind === 'tenant' ? 'Choose…' : 'None'}</option>
                    {data.units
                      .filter((u) => u.active || u.id === draft.unitId)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Full name" error={errors.fullName}>
                  <input value={draft.fullName} onChange={(e) => setDraft({ ...draft, fullName: e.target.value })} required />
                </Field>
                <Field label="Email (they sign in with this)" error={errors.email}>
                  <input type="email" value={draft.email} disabled={!!editing} onChange={(e) => setDraft({ ...draft, email: e.target.value })} required />
                </Field>
                <Field label="Phone (the gate phones this if an alert is missed)" error={errors.phone}>
                  <input type="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
                </Field>
                <Field label="Second contact: name" error={errors.secondContactName}>
                  <input value={draft.secondContactName} onChange={(e) => setDraft({ ...draft, secondContactName: e.target.value })} />
                </Field>
                <Field label="Second contact: phone" error={errors.secondContactPhone}>
                  <input type="tel" value={draft.secondContactPhone} onChange={(e) => setDraft({ ...draft, secondContactPhone: e.target.value })} />
                </Field>
              </div>
              {editing && (
                <label className="row" style={{ gap: 6, margin: '8px 0' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                  Active (untick to stop them signing in and getting alerts straight away)
                </label>
              )}
              <div className="row">
                <button className="btn" disabled={busy}>
                  {busy ? 'Saving…' : editing ? 'Save' : 'Add and show their temporary password'}
                </button>
                <button type="button" className="btn ghost" onClick={() => (setDraft(null), setEditing(null))}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {manage && importing && (
            <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 14 }}>
              <h3>Add many tenants from a spreadsheet</h3>
              <p className="mute small">
                One tenant per line, in this order: <b>unit, full name, email, phone, second contact name, second contact phone</b>. Only the first three are needed. Copy the rows from Excel and paste them here, or choose a CSV file. Units that do not exist yet are created.
              </p>
              <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'14, Thabo Nkosi, thabo@example.co.za, 082 555 0140\n15, Lerato Molefe, lerato@example.co.za'} aria-label="Tenants, one per line" />
              <div className="row" style={{ marginTop: 6 }}>
                <input ref={file} type="file" accept=".csv,text/csv,text/plain" style={{ maxWidth: 280 }} onChange={async (e) => setPasted((await e.target.files?.[0]?.text()) ?? '')} aria-label="Or choose a CSV file" />
              </div>
              {pasted.trim() && (
                <p className="small" style={{ marginTop: 8 }}>
                  <b>{parsed.rows.length}</b> tenant{parsed.rows.length === 1 ? '' : 's'} ready to add.
                  {parsed.skipped.length > 0 && <span className="err"> {parsed.skipped.length} line{parsed.skipped.length === 1 ? '' : 's'} left out: {parsed.skipped.slice(0, 3).join('; ')}{parsed.skipped.length > 3 ? '…' : ''}</span>}
                </p>
              )}
              <div className="row">
                <button className="btn" disabled={busy || parsed.rows.length === 0} onClick={doImport}>
                  {busy ? 'Adding…' : `Add ${parsed.rows.length || ''} tenant${parsed.rows.length === 1 ? '' : 's'}`}
                </button>
                <button className="btn ghost" onClick={() => (setImporting(false), setPasted(''))}>
                  Cancel
                </button>
              </div>
              <p className="mute small" style={{ marginTop: 6 }}>If any line has a problem, nothing is added and the problems are listed, so you can fix them and try again.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
