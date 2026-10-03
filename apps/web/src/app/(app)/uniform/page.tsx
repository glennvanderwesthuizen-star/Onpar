'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatRand, sastDate, UNIFORM_CONDITIONS } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDate, formatDateTime, useLoad } from '@/components/ui';
import { STATUS_TONE } from '@/components/uniform';
import { AuthPhoto } from '@/components/AuthPhoto';

interface Item {
  id?: string;
  name: string;
  variant: string;
  sizes: string[];
  priceCents: number;
  renewalMonths: number;
  active: boolean;
}

interface OrderRow {
  id: string;
  number: number;
  status: string;
  statusLabel: string;
  requestedAt: string;
  siteName: string;
  employeeName: string;
  employeeNumber: string;
  lines: number;
  notDue: number;
}

interface Delivery {
  id: string;
  number: number;
  status: string;
  statusLabel: string;
  employeeName: string;
  employeeNumber: string;
  siteName: string;
  items: string | null;
  handedOverAt: string | null;
  nextOnDuty: { date: string; shiftName: string; startTime: string; today: boolean } | null;
}


const itemLabel = (i: { name: string; variant: string }) => (i.variant ? `${i.name} (${i.variant})` : i.name);

export default function UniformPage() {
  const { can } = useSession();
  const tabs = [
    can('uniform.view') && ['orders', 'Orders'],
    can('uniform.deliver') && ['deliveries', 'My deliveries'],
    can('uniform.view') && ['catalogue', 'Catalogue'],
    can('uniform.view') && ['sites', 'Site lists'],
    can('uniform.issue') && ['guards', 'Guards'],
    (can('hr.uniform_notes.write') || can('hr.uniform_notes.view')) && ['notes', 'Condition notes'],
  ].filter(Boolean) as [string, string][];
  const [tab, setTab] = useState('');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    setTab(q && tabs.some(([k]) => k === q) ? q : (tabs[0]?.[0] ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="head">
        <div>
          <h1>Uniform</h1>
          <p className="mute">
            Guards order on the post phone. A manager decides each item, stores packs it, the supervisor collects it and hands it over when the guard is next on
            duty, and the guard signs for it with his PIN.
          </p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'orders' && <Orders />}
      {tab === 'deliveries' && <Deliveries />}
      {tab === 'catalogue' && <Catalogue editable={can('uniform.catalogue')} />}
      {tab === 'sites' && <SiteLists editable={can('uniform.catalogue')} />}
      {tab === 'guards' && <Guards />}
      {tab === 'notes' && <ConditionNotes />}
    </>
  );
}

function Orders() {
  const { can } = useSession();
  // Each role starts on what needs them.
  const [status, setStatus] = useState(can('uniform.review') ? 'requested' : can('uniform.stores') ? 'approved' : 'open');
  const { data, error } = useLoad(() => api<OrderRow[]>(`/uniform/orders?status=${status}`), [status]);
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        {[
          ['requested', 'Waiting for approval'],
          ['approved', 'With stores'],
          ['ready,with_supervisor', 'Ready or with supervisor'],
          ['open', 'All open'],
          ['received,declined', 'Done'],
        ].map(([k, label]) => (
          <button key={k} className={`btn sm ${status === k ? '' : 'ghost'}`} onClick={() => setStatus(k)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorBanner error={error} />
      <div className="card scroll">
        {data && !data.length && <p className="mute">No orders here.</p>}
        {!!data?.length && (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Guard</th>
                <th>Items</th>
                <th>Status</th>
                <th>Ordered</th>
              </tr>
            </thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/uniform/orders/${o.id}`}>#{o.number}</Link>
                  </td>
                  <td>
                    {o.employeeName} <span className="mute small">#{o.employeeNumber}</span>
                    <div className="mute small">{o.siteName}</div>
                  </td>
                  <td>
                    {o.lines} item{o.lines === 1 ? '' : 's'}
                    {o.notDue > 0 && <div className="small" style={{ color: 'var(--amber)' }}>{o.notDue} not yet due</div>}
                  </td>
                  <td>
                    <Pill tone={STATUS_TONE[o.status] ?? 'grey'}>{o.statusLabel}</Pill>
                  </td>
                  <td className="small">{formatDateTime(o.requestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** The supervisor's tasks: collect from stores, then hand over when each guard is next on duty. */
function Deliveries() {
  const { data, error, reload } = useLoad(() => api<Delivery[]>('/uniform/deliveries'));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const collect = async (id: string) => {
    setBusy(id);
    setErr(null);
    try {
      await api(`/uniform/orders/${id}/collected`, { method: 'POST', json: {} });
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const today = sastDate(new Date());
  return (
    <>
      <ErrorBanner error={error ?? err} />
      {data && !data.length && <div className="card mute">No uniform to collect or deliver.</div>}
      {data?.map((d) => (
        <div key={d.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <b>
                {d.status === 'ready' ? 'Collect at stores' : 'Deliver'}: uniform for {d.employeeName}
              </b>{' '}
              <span className="mute small">
                #{d.employeeNumber} · {d.siteName} · <Link href={`/uniform/orders/${d.id}`}>order #{d.number}</Link>
              </span>
              <div className="small">{d.items ?? 'No items to issue'}</div>
              <div className="small" style={{ marginTop: 4 }}>
                {d.nextOnDuty ? (
                  d.nextOnDuty.date === today ? (
                    <b style={{ color: 'var(--green)' }}>On duty today ({d.nextOnDuty.shiftName}, {d.nextOnDuty.startTime}): deliver now.</b>
                  ) : (
                    <>
                      Next on duty <b>{formatDate(d.nextOnDuty.date)}</b> ({d.nextOnDuty.shiftName}, {d.nextOnDuty.startTime}). Deliver then.
                    </>
                  )
                ) : (
                  <span className="mute">Not on the roster in the next two weeks.</span>
                )}
              </div>
            </div>
            <div>
              {d.status === 'ready' ? (
                <button className="btn" disabled={busy === d.id} onClick={() => collect(d.id)}>
                  I have collected it
                </button>
              ) : (
                <span className="mute small">
                  He signs for it on the post phone with his PIN.
                  {!d.handedOverAt && <div>Waiting for stores to confirm the hand-over.</div>}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

function Catalogue({ editable }: { editable: boolean }) {
  const { data, error, reload } = useLoad(() => api<Item[]>('/uniform/items'));
  const [items, setItems] = useState<Item[] | null>(null);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setItems(data);
  }, [data]);
  const set = (i: number, patch: Partial<Item>) => setItems((list) => list!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = async () => {
    setSaveErr(null);
    setSaved(false);
    try {
      await api('/uniform/items', { method: 'PUT', json: { items: items!.filter((i) => i.name.trim()) } });
      setSaved(true);
      reload();
    } catch (e) {
      setSaveErr(e);
    }
  };
  if (!items) return <ErrorBanner error={error} />;
  return (
    <div className="card scroll">
      <p className="mute small">
        Each type is its own line (Shirt: short sleeve, Shirt: golf). Sizes separated by commas. Retire an item instead of deleting it; past orders refer to it.
      </p>
      <ErrorBanner error={saveErr} />
      {saved && <div className="banner ok">Saved.</div>}
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Type</th>
            <th>Sizes</th>
            <th>Price (R)</th>
            <th>Renew every (months)</th>
            <th>In use</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={it.id ?? `new-${i}`} style={{ opacity: it.active ? 1 : 0.55 }}>
              <td>
                <input disabled={!editable} value={it.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="e.g. Shirt" />
              </td>
              <td>
                <input disabled={!editable} value={it.variant} onChange={(e) => set(i, { variant: e.target.value })} placeholder="e.g. Short sleeve" />
              </td>
              <td>
                <input
                  disabled={!editable}
                  value={it.sizes.join(', ')}
                  onChange={(e) => set(i, { sizes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                  placeholder="S, M, L, XL"
                />
              </td>
              <td style={{ width: 110 }}>
                <input
                  disabled={!editable}
                  type="number"
                  min={0}
                  step="0.01"
                  value={it.priceCents / 100}
                  onChange={(e) => set(i, { priceCents: Math.round(Number(e.target.value) * 100) })}
                />
              </td>
              <td style={{ width: 120 }}>
                <input disabled={!editable} type="number" min={1} max={60} value={it.renewalMonths} onChange={(e) => set(i, { renewalMonths: Number(e.target.value) })} />
              </td>
              <td>
                <input disabled={!editable} type="checkbox" checked={it.active} onChange={(e) => set(i, { active: e.target.checked })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editable && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn ghost" onClick={() => setItems([...items, { name: '', variant: '', sizes: [], priceCents: 0, renewalMonths: 12, active: true }])}>
            + Add item
          </button>
          <button className="btn" onClick={save}>
            Save catalogue
          </button>
        </div>
      )}
    </div>
  );
}

function SiteLists({ editable }: { editable: boolean }) {
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const items = useLoad(() => api<Item[]>('/uniform/items'));
  const [siteId, setSiteId] = useState('');
  const list = useLoad(() => (siteId ? api<{ itemId: string; quantity: number }[]>(`/uniform/sites/${siteId}/list`) : Promise.resolve(null)), [siteId]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!siteId && sites.data?.length) setSiteId(sites.data[0].id);
  }, [sites.data, siteId]);
  useEffect(() => {
    if (list.data) setQty(Object.fromEntries(list.data.map((l) => [l.itemId, l.quantity])));
  }, [list.data]);
  const save = async () => {
    setSaveErr(null);
    setSaved(false);
    try {
      await api(`/uniform/sites/${siteId}/list`, {
        method: 'PUT',
        json: { lines: Object.entries(qty).filter(([, q]) => q > 0).map(([itemId, quantity]) => ({ itemId, quantity })) },
      });
      setSaved(true);
    } catch (e) {
      setSaveErr(e);
    }
  };
  return (
    <div className="card">
      <div style={{ maxWidth: 320 }}>
        <Field label="Site">
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            {sites.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="mute small">How many of each item a guard at this site is entitled to each renewal period. Leave at 0 for items this site does not use.</p>
      <ErrorBanner error={items.error ?? list.error ?? saveErr} />
      {saved && <div className="banner ok">Saved.</div>}
      {items.data && !items.data.length && <p className="mute">Add items in the Catalogue tab first.</p>}
      <table>
        <tbody>
          {items.data
            ?.filter((i) => i.active)
            .map((i) => (
              <tr key={i.id}>
                <td>{itemLabel(i)}</td>
                <td style={{ width: 120 }}>
                  <input
                    disabled={!editable}
                    type="number"
                    min={0}
                    max={20}
                    value={qty[i.id!] ?? 0}
                    onChange={(e) => setQty({ ...qty, [i.id!]: Number(e.target.value) })}
                  />
                </td>
                <td className="mute small">{formatRand(i.priceCents)} each</td>
              </tr>
            ))}
        </tbody>
      </table>
      {editable && (
        <button className="btn" style={{ marginTop: 10 }} onClick={save} disabled={!siteId}>
          Save site list
        </button>
      )}
    </div>
  );
}

interface GuardKit {
  kit: { itemId: string; label: string; entitled: number; lastIssued: string | null; lastSize: string | null; nextDue: string | null; due: boolean; sizes: string[] }[];
  issues: { id: string; issuedOn: string; label: string; size: string; quantity: number; account: string; note: string }[];
}

/** A guard's uniform table, and recording an issue outside an order (for example a new guard's starter kit). */
function Guards() {
  const officers = useLoad(() => api<{ id: string; full_name: string; employee_number: string; site_name: string }[]>('/officers'));
  const [employeeId, setEmployeeId] = useState('');
  const g = useLoad(() => (employeeId ? api<GuardKit>(`/uniform/officers/${employeeId}`) : Promise.resolve(null)), [employeeId]);
  const [form, setForm] = useState({ itemId: '', size: '', quantity: 1, issuedOn: sastDate(new Date()), note: 'Starter kit' });
  const [err, setErr] = useState<unknown>(null);
  const item = g.data?.kit.find((k) => k.itemId === form.itemId);
  const record = async () => {
    setErr(null);
    try {
      await api('/uniform/issues', { method: 'POST', json: { employeeId, ...form } });
      setForm({ ...form, itemId: '', size: '' });
      g.reload();
    } catch (e) {
      setErr(e);
    }
  };
  const errors = err instanceof ApiError ? err.errors : {};
  return (
    <>
      <div className="card" style={{ maxWidth: 420 }}>
        <Field label="Guard">
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose a guard…</option>
            {officers.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.full_name} #{o.employee_number} · {o.site_name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorBanner error={g.error} />
      {g.data && (
        <>
          <div className="card scroll">
            <h2>His uniform</h2>
            {!g.data.kit.length && <p className="mute">His home site has no uniform list yet (Site lists tab).</p>}
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Entitled</th>
                  <th>Size</th>
                  <th>Last issued</th>
                  <th>Next due</th>
                </tr>
              </thead>
              <tbody>
                {g.data.kit.map((k) => (
                  <tr key={k.itemId}>
                    <td>{k.label}</td>
                    <td>{k.entitled}</td>
                    <td>{k.lastSize ?? '—'}</td>
                    <td>{k.lastIssued ? formatDate(k.lastIssued) : 'Never'}</td>
                    <td>{k.due ? <Pill tone="amber">Due now</Pill> : formatDate(k.nextDue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>Record an issue</h2>
            <p className="mute small">For uniform given outside an order, for example a new guard&apos;s starter kit. It starts that item&apos;s renewal period.</p>
            <ErrorBanner error={err} />
            <div className="grid g3">
              <Field label="Item" error={errors.itemId}>
                <select value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value, size: '' })}>
                  <option value="">Choose…</option>
                  {g.data.kit.map((k) => (
                    <option key={k.itemId} value={k.itemId}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Size" error={errors.size}>
                <select value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} disabled={!item?.sizes.length}>
                  <option value="">{item?.sizes.length ? 'Choose…' : 'No sizes'}</option>
                  {item?.sizes.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Quantity">
                <input type="number" min={1} max={20} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} />
              </Field>
              <Field label="Date issued" error={errors.issuedOn}>
                <input type="date" value={form.issuedOn} onChange={(e) => setForm({ ...form, issuedOn: e.target.value })} />
              </Field>
              <Field label="Note">
                <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </Field>
            </div>
            <button className="btn" onClick={record} disabled={!form.itemId}>
              Record issue
            </button>
          </div>
          <div className="card scroll">
            <h2>Issue history</h2>
            {!g.data.issues.length && <p className="mute">Nothing issued yet.</p>}
            <table>
              <tbody>
                {g.data.issues.map((i) => (
                  <tr key={i.id}>
                    <td>{formatDate(i.issuedOn)}</td>
                    <td>
                      {i.quantity} × {i.label} {i.size}
                    </td>
                    <td>{i.account === 'guard' ? <Pill tone="amber">Guard&apos;s account</Pill> : <Pill tone="grey">Company</Pill>}</td>
                    <td className="mute small">{i.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

interface Note {
  id: string;
  condition: string;
  conditionLabel: string;
  note: string;
  hasPhoto: boolean;
  createdAt: string;
  notedBy: string;
}

/**
 * Uniform condition notes (D-33): an HR record. Supervisors write them; managers and HR read
 * them (every view is logged). They never trigger anything by themselves and never show on
 * the post phone.
 */
function ConditionNotes() {
  const { can } = useSession();
  const officers = useLoad(() => api<{ id: string; full_name: string; employee_number: string; site_name: string }[]>('/officers'));
  const [employeeId, setEmployeeId] = useState('');
  const canView = can('hr.uniform_notes.view');
  const notes = useLoad(() => (employeeId && canView ? api<Note[]>(`/uniform/condition-notes?employeeId=${employeeId}`) : Promise.resolve(null)), [employeeId]);
  const [condition, setCondition] = useState('torn');
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setErr(null);
    setSaved(false);
    const form = new FormData();
    form.append('data', JSON.stringify({ employeeId, condition, note: text }));
    if (photo) form.append('photo', photo);
    try {
      await api('/uniform/condition-notes', { method: 'POST', body: form });
      setText('');
      setPhoto(null);
      setSaved(true);
      notes.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <>
      <div className="banner warn small">
        An HR record. It never leads to a warning or a deduction by itself, and it is never shown on the post phone. Managers may refer to it when deciding
        whether a replacement is on the guard&apos;s account.
      </div>
      <div className="card" style={{ maxWidth: 520 }}>
        <Field label="Guard">
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose a guard…</option>
            {officers.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.full_name} #{o.employee_number} · {o.site_name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {employeeId && can('hr.uniform_notes.write') && (
        <div className="card">
          <h2>Add a note</h2>
          <ErrorBanner error={err} />
          {saved && <div className="banner ok">Saved.</div>}
          <div className="grid g2">
            <Field label="Condition">
              <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                {Object.entries(UNIFORM_CONDITIONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Photo (optional)">
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            </Field>
          </div>
          <Field label="What you saw">
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: shirt torn at the shoulder, not reported" />
          </Field>
          <button className="btn" onClick={save} disabled={text.trim().length < 3}>
            Save note
          </button>
        </div>
      )}
      {employeeId && canView && (
        <div className="card">
          <h2>Notes</h2>
          <ErrorBanner error={notes.error} />
          {notes.data && !notes.data.length && <p className="mute">No notes for this guard.</p>}
          {notes.data?.map((n) => (
            <div key={n.id} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
              <b>{n.conditionLabel}</b> <span className="mute small">· {formatDateTime(n.createdAt)} · {n.notedBy}</span>
              <div>{n.note}</div>
              {n.hasPhoto && <AuthPhoto path={`/uniform/condition-notes/${n.id}/photo`} alt={n.note} />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
