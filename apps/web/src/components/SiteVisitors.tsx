'use client';

import { useEffect, useState } from 'react';
import { BARRED_KIND_LABELS, BARRED_KINDS, BarredKind, CATEGORY_KIND_LABELS, CATEGORY_KINDS, CategoryKind, categoryLimitText, VisitorCheck, VisitorSettings } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDate, formatDateTime, useLoad } from './ui';

interface Gate {
  id: string;
  name: string;
  active: boolean;
}
interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  contractor: boolean;
  limitMinutes: number | null;
  limitUntil: string | null;
  active: boolean;
}
interface Barred {
  id: string;
  kind: BarredKind;
  kindLabel: string;
  value: string;
  unitName: string | null;
  reason: string;
  addedBy: string;
  addedAt: string;
  reviewDue: string;
  reviewNow: boolean;
}
interface Phone {
  id: string;
  label: string;
  postName: string;
  gateId: string | null;
}
interface Visit {
  id: string;
  type: 'vehicle' | 'pedestrian';
  status: string;
  statusLabel: string;
  deniedReason: string | null;
  at: string;
  surname: string;
  names: string;
  idNumber: string;
  registration: string | null;
  make: string | null;
  model: string | null;
  colour: string | null;
  unitName: string | null;
  category: string;
  pax: number | null;
  gateName: string;
  guard: string;
  captureMethod: 'scan' | 'manual';
  documentLabel: string;
  warnings: string[];
  answered: string | null;
}
interface Setup {
  gates: Gate[];
  phones: Phone[];
  settings: VisitorSettings & { saved: boolean };
  checks: { key: VisitorCheck; label: string; about: string; notYet: string | null }[];
  limits: Record<'noResponseSeconds' | 'overstayEscalationMinutes' | 'retentionMonths', { min: number; max: number }>;
  categories: Category[];
  barred: Barred[];
  units: { id: string; name: string }[];
}
type LimitType = 'none' | 'hours' | 'until';
type CategoryDraft = { id: string | null; name: string; kind: CategoryKind; contractor: boolean; limitType: LimitType; hours: string; until: string; active: boolean };

const NEW_CATEGORY: CategoryDraft = { id: null, name: '', kind: 'once_off', contractor: false, limitType: 'hours', hours: '4', until: '17:00', active: true };

/**
 * Visitor management, step 1: a site's gates, visitor checks, time limits, categories and
 * barred list, on the site's page. The administrator changes them; company managers can look.
 */
export function SiteVisitors({ siteId }: { siteId: string }) {
  const { can } = useSession();
  const manage = can('visitors.setup.manage');
  const { data, error, reload } = useLoad(() => api<Setup>(`/sites/${siteId}/visitor-setup`), [siteId]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [failedIn, setFailedIn] = useState('');
  const [gateName, setGateName] = useState('');
  const [settings, setSettings] = useState<VisitorSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [category, setCategory] = useState<CategoryDraft | null>(null);
  const [bar, setBar] = useState<{ kind: BarredKind; value: string; unitId: string; reason: string } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; reason: string } | null>(null);
  const errors = actionError instanceof ApiError ? actionError.errors : {};
  const errorsIn = (section: string) => (failedIn === section ? errors : {});

  useEffect(() => {
    if (data) {
      const { saved: _saved, ...s } = data.settings;
      setSettings(s);
    }
  }, [data]);

  async function run(section: string, action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    setFailedIn('');
    setSaved(false);
    try {
      await action();
      reload();
      return true;
    } catch (e) {
      setActionError(e);
      setFailedIn(section);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!can('visitors.setup.view')) return null;
  const base = `/sites/${siteId}`;
  const changed = !!data && !!settings && JSON.stringify(settings) !== JSON.stringify((({ saved: _s, ...rest }) => rest)(data.settings));

  const addGate = (e: React.FormEvent) => {
    e.preventDefault();
    run('gate', () => api(`${base}/gates`, { method: 'POST', json: { name: gateName } })).then((ok) => ok && setGateName(''));
  };
  const saveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    run('settings', () => api(`${base}/visitor-settings`, { method: 'PUT', json: settings })).then((ok) => ok && setSaved(true));
  };
  const saveCategory = (e: React.FormEvent) => {
    e.preventDefault();
    if (!category) return;
    const body = {
      name: category.name,
      kind: category.kind,
      contractor: category.contractor,
      limitMinutes: category.limitType === 'hours' ? Math.round(Number(category.hours.replace(',', '.')) * 60) : null,
      limitUntil: category.limitType === 'until' ? category.until : null,
      active: category.active,
    };
    run('category', () => (category.id ? api(`${base}/visitor-categories/${category.id}`, { method: 'PUT', json: body }) : api(`${base}/visitor-categories`, { method: 'POST', json: body }))).then(
      (ok) => ok && setCategory(null),
    );
  };
  const saveBar = (e: React.FormEvent) => {
    e.preventDefault();
    if (!bar) return;
    run('bar', () => api(`${base}/barred`, { method: 'POST', json: { ...bar, unitId: bar.unitId || null } })).then((ok) => ok && setBar(null));
  };
  const remove = (e: React.FormEvent) => {
    e.preventDefault();
    if (!removing) return;
    run('remove', () => api(`${base}/barred/${removing.id}/remove`, { method: 'POST', json: { reason: removing.reason } })).then((ok) => ok && setRemoving(null));
  };
  const number = (key: 'noResponseSeconds' | 'overstayEscalationMinutes' | 'retentionMonths', label: string, hint: string) =>
    settings && (
      <Field label={label} error={errorsIn('settings')[key]} hint={hint}>
        <input type="number" inputMode="numeric" min={data?.limits[key].min} max={data?.limits[key].max} value={settings[key]} disabled={!manage} onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })} />
      </Field>
    );

  return (
    <div className="card">
      <h2>Visitors</h2>
      <p className="mute small">
        How visitors are handled at this site: its gates, the checks at the gate, how long visitors may stay, and who is barred.
        {manage ? '' : ' Only the system administrator can change these.'}
      </p>
      <ErrorBanner error={error ?? actionError} />
      {!data && !error && <p className="mute">Loading…</p>}
      {data && settings && (
        <>
          <h3 style={{ marginTop: 14 }}>Gates</h3>
          {data.gates.length === 0 && <p className="mute">No gates yet. Add each gate where visitors come in. A tenant who announces a visitor chooses one.</p>}
          <div className="chips">
            {data.gates.map((g) => (
              <span key={g.id} className={`chip${g.active ? '' : ' off'}`}>
                <b>{g.name}</b>
                {!g.active && <span className="mute small">not in use</span>}
                {manage && (
                  <button disabled={busy} onClick={() => run('gate', () => api(`${base}/gates/${g.id}`, { method: 'PUT', json: { name: g.name, active: !g.active } }))}>
                    {g.active ? 'retire' : 'bring back'}
                  </button>
                )}
              </span>
            ))}
          </div>
          {manage && (
            <form className="row" onSubmit={addGate}>
              <input style={{ maxWidth: 220 }} value={gateName} onChange={(e) => setGateName(e.target.value)} placeholder="Gate name, e.g. Main gate" aria-label="New gate name" required />
              <button className="btn ghost" disabled={busy || !gateName.trim()}>
                Add gate
              </button>
              {errorsIn('gate').name && <span className="err">{errorsIn('gate').name}</span>}
            </form>
          )}

          <h3 style={{ marginTop: 22 }}>Gate phones</h3>
          <p className="mute small">A post phone at a gate gets a Visitors button for scanning visitors in. Choose the gate each phone stands at.</p>
          {data.phones.length === 0 && <p className="mute">This site has no phones yet. Register one on the Devices page and give it this site.</p>}
          {data.phones.map((p) => (
            <div key={p.id} className="row" style={{ marginBottom: 6 }}>
              <span style={{ minWidth: 180 }}>
                <b>{p.label}</b>
                {p.postName && <span className="mute small"> · {p.postName}</span>}
              </span>
              <select
                style={{ maxWidth: 240 }}
                aria-label={`Gate for ${p.label}`}
                value={p.gateId ?? ''}
                disabled={!manage || busy}
                onChange={(e) => run('phone', () => api(`${base}/gate-phones/${p.id}`, { method: 'PUT', json: { gateId: e.target.value || null } }))}
              >
                <option value="">Not a gate phone</option>
                {data.gates
                  .filter((g) => g.active)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
            </div>
          ))}

          <form onSubmit={saveSettings}>
            <h3 style={{ marginTop: 22 }}>Checks at the gate</h3>
            <div className="vis-checks">
              {data.checks.map((c) => (
                <label key={c.key} className={`vis-check${c.notYet ? ' off' : ''}`}>
                  <input type="checkbox" checked={settings.checks[c.key]} disabled={!manage || !!c.notYet} onChange={(e) => setSettings({ ...settings, checks: { ...settings.checks, [c.key]: e.target.checked } })} />
                  <span>
                    <b>{c.label}</b> {c.notYet && <Pill tone="grey">Not available yet</Pill>}
                    <span className="mute small" style={{ display: 'block' }}>
                      {c.about} {c.notYet}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            <h3 style={{ marginTop: 22 }}>Waiting times</h3>
            <div className="grid g2">
              {number('noResponseSeconds', 'Seconds the customer has to answer an alert', 'After this the guard is offered the phone. 120 is two minutes.')}
              {number('overstayEscalationMinutes', 'Minutes before an overstay goes to the supervisor', 'The guard is alerted first.')}
              {number('retentionMonths', 'Months visitor records are kept', 'A proposal: confirm with whoever handles POPIA for you.')}
              <label className="vis-check" style={{ alignSelf: 'center' }}>
                <input type="checkbox" checked={settings.secondContact} disabled={!manage} onChange={(e) => setSettings({ ...settings, secondContact: e.target.checked })} />
                <span>
                  <b>Second contact</b>
                  <span className="mute small" style={{ display: 'block' }}>
                    If the customer does not answer the phone, the guard may dial their second contact.
                  </span>
                </span>
              </label>
            </div>
            {manage && (
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn" disabled={busy || !changed}>
                  Save checks and times
                </button>
                {changed && <span className="mute small">You have changes that are not saved.</span>}
                {saved && !changed && (
                  <span className="small" role="status">
                    Saved. This applies from the next visit.
                  </span>
                )}
                {!data.settings.saved && !changed && !saved && <span className="mute small">This site is on the standard settings.</span>}
              </div>
            )}
          </form>

          <h3 style={{ marginTop: 22 }}>Visitor categories</h3>
          <div className="cust-wrap">
            <table className="cust-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Approval lasts</th>
                  <th>May stay</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {data.categories.map((c) => (
                  <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}>
                    <td>
                      <b>{c.name}</b> {c.contractor && <Pill tone="blue">Contractor</Pill>} {!c.active && <Pill tone="grey">Not in use</Pill>}
                    </td>
                    <td>{CATEGORY_KIND_LABELS[c.kind]}</td>
                    <td>{categoryLimitText(c)}</td>
                    {manage && (
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn ghost sm"
                          onClick={() => {
                            setActionError(null);
                            setCategory({
                              id: c.id,
                              name: c.name,
                              kind: c.kind,
                              contractor: c.contractor,
                              limitType: c.limitUntil ? 'until' : c.limitMinutes ? 'hours' : 'none',
                              hours: c.limitMinutes ? String(c.limitMinutes / 60) : '4',
                              until: c.limitUntil ?? '17:00',
                              active: c.active,
                            });
                          }}
                        >
                          Change
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {manage && !category && (
            <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => (setActionError(null), setCategory(NEW_CATEGORY))}>
              Add a category
            </button>
          )}
          {category && (
            <form onSubmit={saveCategory} className="vis-form">
              <h3>{category.id ? 'Change category' : 'New category'}</h3>
              <div className="grid g2">
                <Field label="Name" error={errorsIn('category').name}>
                  <input value={category.name} onChange={(e) => setCategory({ ...category, name: e.target.value })} required />
                </Field>
                <Field label="Approval lasts" error={errorsIn('category').kind}>
                  <select value={category.kind} onChange={(e) => setCategory({ ...category, kind: e.target.value as CategoryKind })}>
                    {CATEGORY_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {CATEGORY_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="May stay" error={errorsIn('category').limitMinutes ?? errorsIn('category').limitUntil}>
                  <select value={category.limitType} onChange={(e) => setCategory({ ...category, limitType: e.target.value as LimitType })}>
                    <option value="hours">A number of hours</option>
                    <option value="until">Until a time of day</option>
                    <option value="none">No limit</option>
                  </select>
                </Field>
                {category.limitType === 'hours' && (
                  <Field label="Hours on site">
                    <input inputMode="decimal" value={category.hours} onChange={(e) => setCategory({ ...category, hours: e.target.value })} required />
                  </Field>
                )}
                {category.limitType === 'until' && (
                  <Field label="Must have left by">
                    <input type="time" value={category.until} onChange={(e) => setCategory({ ...category, until: e.target.value })} required />
                  </Field>
                )}
              </div>
              <label className="vis-check">
                <input type="checkbox" checked={category.contractor} onChange={(e) => setCategory({ ...category, contractor: e.target.checked })} />
                <span>This is a contractor category</span>
              </label>
              {category.id && (
                <label className="vis-check">
                  <input type="checkbox" checked={category.active} onChange={(e) => setCategory({ ...category, active: e.target.checked })} />
                  <span>In use</span>
                </label>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn" disabled={busy}>
                  Save category
                </button>
                <button type="button" className="btn ghost" onClick={() => setCategory(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          <h3 style={{ marginTop: 22 }}>Barred list</h3>
          <p className="mute small">
            An ID number, cell number or number plate that may not come in. This is personal information about that person: add an entry only with a clear reason. Entries are reviewed every year.
          </p>
          {data.barred.length === 0 && <p className="mute">Nobody is barred.</p>}
          {data.barred.length > 0 && (
            <div className="cust-wrap">
              <table className="cust-table">
                <thead>
                  <tr>
                    <th>Barred</th>
                    <th>From</th>
                    <th>Reason</th>
                    <th>Added</th>
                    {manage && <th />}
                  </tr>
                </thead>
                <tbody>
                  {data.barred.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <b>{b.value}</b>
                        <div className="mute small">{b.kindLabel}</div>
                      </td>
                      <td>{b.unitName ? `Unit ${b.unitName}` : 'The whole site'}</td>
                      <td>{b.reason}</td>
                      <td>
                        {formatDate(b.addedAt)}
                        <div className="mute small">by {b.addedBy}</div>
                        {b.reviewNow ? <Pill tone="amber">Review due</Pill> : <div className="mute small">Review by {formatDate(b.reviewDue)}</div>}
                      </td>
                      {manage && (
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn ghost sm" onClick={() => (setActionError(null), setRemoving({ id: b.id, reason: '' }))}>
                            Take off
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {removing && (
            <form onSubmit={remove} className="vis-form">
              <h3>Take {data.barred.find((b) => b.id === removing.id)?.value} off the barred list</h3>
              <Field label="Why is it being taken off?" error={errorsIn('remove').reason} hint="The entry is kept in the records with this reason.">
                <input value={removing.reason} onChange={(e) => setRemoving({ ...removing, reason: e.target.value })} required />
              </Field>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn" disabled={busy}>
                  Take off the list
                </button>
                <button type="button" className="btn ghost" onClick={() => setRemoving(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {manage && !bar && !removing && (
            <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => (setActionError(null), setBar({ kind: 'registration', value: '', unitId: '', reason: '' }))}>
              Bar someone
            </button>
          )}
          {bar && (
            <form onSubmit={saveBar} className="vis-form">
              <h3>Add to the barred list</h3>
              <div className="grid g2">
                <Field label="What to bar" error={errorsIn('bar').kind}>
                  <select value={bar.kind} onChange={(e) => setBar({ ...bar, kind: e.target.value as BarredKind })}>
                    {BARRED_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {BARRED_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={BARRED_KIND_LABELS[bar.kind]} error={errorsIn('bar').value} hint="Spaces and dashes do not matter.">
                  <input value={bar.value} onChange={(e) => setBar({ ...bar, value: e.target.value })} required />
                </Field>
                <Field label="Barred from" error={errorsIn('bar').unitId}>
                  <select value={bar.unitId} onChange={(e) => setBar({ ...bar, unitId: e.target.value })}>
                    <option value="">The whole site</option>
                    {data.units.map((u) => (
                      <option key={u.id} value={u.id}>
                        Unit {u.name} only
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reason" error={errorsIn('bar').reason}>
                  <input value={bar.reason} onChange={(e) => setBar({ ...bar, reason: e.target.value })} required />
                </Field>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn" disabled={busy}>
                  Add to the barred list
                </button>
                <button type="button" className="btn ghost" onClick={() => setBar(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'grey'> = {
  awaiting_approval: 'amber',
  on_site: 'green',
  exited: 'grey',
  exited_exception: 'red',
  denied: 'red',
  denied_no_response: 'red',
  left_no_scan_out: 'red',
};

/** The visitors recorded at a site's gates, newest first (visitor management, step 2). ID numbers show their last four characters only. */
export function SiteVisits({ siteId }: { siteId: string }) {
  const { can } = useSession();
  const allowed = can('visitors.view');
  const { data, error, reload } = useLoad(() => (allowed ? api<Visit[]>(`/sites/${siteId}/visits`) : Promise.resolve([] as Visit[])), [siteId, allowed]);
  if (!allowed) return null;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Visitors at the gate</h2>
        <button className="btn ghost sm" onClick={reload}>
          Refresh
        </button>
      </div>
      <p className="mute small">The last 50 visitors scanned in at this site.</p>
      <ErrorBanner error={error} />
      {!data && !error && <p className="mute">Loading…</p>}
      {data && data.length === 0 && <p className="mute">No visitors have been scanned in yet.</p>}
      {data && data.length > 0 && (
        <div className="cust-wrap">
          <table className="cust-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Visitor</th>
                <th>Vehicle</th>
                <th>Visiting</th>
                <th>Gate</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((v) => (
                <tr key={v.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(v.at)}</td>
                  <td>
                    <b>
                      {v.surname}
                      {v.names ? `, ${v.names}` : ''}
                    </b>
                    <div className="mute small">
                      {v.documentLabel} {v.idNumber}
                    </div>
                    <div className="mute small">{v.category}</div>
                  </td>
                  <td>
                    {v.type === 'pedestrian' ? (
                      <span className="mute">On foot</span>
                    ) : (
                      <>
                        <b>{v.registration}</b>
                        <div className="mute small">{[v.colour, v.make, v.model].filter(Boolean).join(' ')}</div>
                        {v.pax !== null && (
                          <div className="mute small">
                            {v.pax} passenger{v.pax === 1 ? '' : 's'}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td>{v.unitName ? `Unit ${v.unitName}` : 'The office'}</td>
                  <td>
                    {v.gateName}
                    <div className="mute small">{v.guard}</div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <Pill tone={STATUS_TONE[v.status] ?? 'grey'}>{v.statusLabel}</Pill>
                      {v.deniedReason === 'barred' && <Pill tone="red">Barred</Pill>}
                      {v.captureMethod === 'manual' && <Pill tone="grey">Manual capture</Pill>}
                      {v.warnings.length > 0 && <Pill tone="amber">Expired document</Pill>}
                    </div>
                    {v.answered && <div className="mute small">{v.answered}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
