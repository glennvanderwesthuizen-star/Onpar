'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, Pill, formatDate, useLoad } from './ui';

interface Item {
  id: string;
  name: string;
  category: string;
  barbs: number;
  costRand: number | null;
  monthsService: number;
  wireAtLeast: number;
  needsGrade: string | null;
  monthsAtStandard: number;
  inStore: boolean;
  active: boolean;
}
interface Store {
  storeOpen: boolean;
  coursesPerYear: number;
  categories: Record<string, string>;
  items: Item[];
  aiming: { employeeId: string; name: string; site: string | null; goal: string; ready: boolean; monthsToGo: number | null; nextStep: string | null }[];
  plan: { itemId: string; name: string; aiming: number; readyNow: number; withinThreeMonths: number; costWithinThreeMonths: number | null }[];
  handins: { id: string; itemName: string; barbs: number; costRand: number | null; status: string; requestedAt: string; doneAt: string | null; cancelReason: string | null; guard: string; site: string | null; doneBy: string | null }[];
}

const rand = (n: number | null) => (n === null ? 'not priced' : `R${Math.round(n).toLocaleString('en-ZA')}`);
const blank: Omit<Item, 'id'> = { name: '', category: 'kit', barbs: 0, costRand: null, monthsService: 0, wireAtLeast: 0, needsGrade: null, monthsAtStandard: 0, inStore: true, active: true };

/**
 * Goals and the store (The Wire, step 3): the owner's table that guards choose their goal from,
 * who is aiming at what and when they will be ready, and hand-ins waiting to be supplied.
 */
export function WireStore({ canManage, settings, saved }: { canManage: boolean; settings: Record<string, unknown>; saved: () => void }) {
  const { data, error, reload } = useLoad(() => api<Store>('/wire/store'));
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await work();
      reload();
      saved();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const waiting = data.handins.filter((h) => h.status === 'requested');

  return (
    <>
      <div className="card scroll">
        <h2>
          Goals and the store{' '}
          {data.storeOpen ? <Pill tone="green">Store open</Pill> : <Pill tone="grey">Store closed</Pill>}
        </h2>
        <p className="mute small">
          Guards choose a goal from this table on their phone, or write their own, and see each step ticked off. {data.storeOpen ? 'They can hand in barbs for rows marked "in the store".' : 'Nobody can hand in barbs while the store is closed; goals still show when a guard is ready.'} The rand
          cost is yours only and never reaches a phone.
        </p>
        <ErrorBanner error={err} />
        {canManage && (
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() => run(() => api('/wire/settings', { method: 'PUT', json: { ...settings, storeOpen: !data.storeOpen } }))}
          >
            {data.storeOpen ? 'Close the store' : 'Open the store'}
          </button>
        )}
        {!data.storeOpen && canManage && <p className="mute small">Open it once your accountant has answered on tax for these benefits.</p>}

        <h3 style={{ marginTop: 16 }}>Who is aiming at what</h3>
        {!data.aiming.length && <p className="mute">No guard has chosen a goal yet.</p>}
        {!!data.plan.length && (
          <table>
            <thead>
              <tr>
                <th>Goal</th>
                <th>Aiming at it</th>
                <th>Ready now</th>
                <th>Ready within 3 months</th>
                <th>Cost of those</th>
              </tr>
            </thead>
            <tbody>
              {data.plan.map((p) => (
                <tr key={p.itemId}>
                  <td>{p.name}</td>
                  <td>{p.aiming}</td>
                  <td>{p.readyNow}</td>
                  <td>{p.withinThreeMonths}</td>
                  <td>{rand(p.costWithinThreeMonths)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!!data.aiming.length && (
          <details style={{ marginTop: 8 }}>
            <summary>Every guard and his goal ({data.aiming.length})</summary>
            {data.aiming.map((a) => (
              <div key={a.employeeId} className="small" style={{ marginTop: 4 }}>
                <b>{a.name}</b> {a.site && <span className="mute">({a.site})</span>} · {a.goal} ·{' '}
                {a.ready ? <Pill tone="green">Ready</Pill> : a.monthsToGo !== null ? `about ${a.monthsToGo} month${a.monthsToGo === 1 ? '' : 's'}` : (a.nextStep ?? 'in his own words')}
              </div>
            ))}
          </details>
        )}

        <h3 style={{ marginTop: 16 }}>Hand-ins to supply {waiting.length > 0 && <Pill tone="amber">{waiting.length}</Pill>}</h3>
        {!data.handins.length && <p className="mute">None yet.</p>}
        {data.handins.map((h) => (
          <HandIn key={h.id} h={h} canManage={canManage} busy={busy} run={run} />
        ))}
      </div>

      <div className="card scroll">
        <h2>The goals and store table</h2>
        <p className="mute small">
          One row per goal. A guard sees a step for every condition you fill in. "In the store" rows can be handed in for once the store is open; a row with no barb price (a milestone such as the silver barb) is a goal only. Check
          each course&apos;s grade against PSIRA&apos;s rules; the first values are placeholders. One funded course per guard in any {data.coursesPerYear === 1 ? 'twelve months' : `twelve months (${data.coursesPerYear} allowed)`}.
        </p>
        <table>
          <thead>
            <tr>
              <th>Goal</th>
              <th>Kind</th>
              <th>Barbs</th>
              <th>Cost (R)</th>
              <th>Months of service</th>
              <th>Barbs on Wire</th>
              <th>Needs grade</th>
              <th>Months at standard</th>
              <th>In the store</th>
              <th>In use</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <ItemRow key={i.id} item={i} categories={data.categories} canManage={canManage} busy={busy} run={run} />
            ))}
            {canManage && <ItemRow item={{ ...blank, id: '' }} categories={data.categories} canManage busy={busy} run={run} />}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HandIn({ h, canManage, busy, run }: { h: Store['handins'][number]; canManage: boolean; busy: boolean; run: (w: () => Promise<unknown>) => void }) {
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  return (
    <div className="small" style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
      <b>{h.guard}</b> {h.site && <span className="mute">({h.site})</span>} · {h.itemName} · {h.barbs} barbs · {rand(h.costRand)} · {formatDate(h.requestedAt)} ·{' '}
      {h.status === 'requested' ? <Pill tone="amber">To supply</Pill> : h.status === 'supplied' ? <Pill tone="green">Supplied</Pill> : <Pill tone="grey">Cancelled</Pill>}
      {h.cancelReason && <span className="mute"> · {h.cancelReason}</span>}
      {h.status === 'requested' && canManage && (
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn sm" disabled={busy} onClick={() => run(() => api(`/wire/handins/${h.id}/supply`, { method: 'POST' }))}>
            Supplied
          </button>
          {!cancelling ? (
            <button className="btn ghost sm" disabled={busy} onClick={() => setCancelling(true)}>
              Cancel and give the barbs back
            </button>
          ) : (
            <>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason the guard will read" style={{ minWidth: 0, flex: 1 }} />
              <button className="btn ghost sm" disabled={busy || reason.trim().length < 5} onClick={() => run(() => api(`/wire/handins/${h.id}/cancel`, { method: 'POST', json: { reason } }))}>
                Cancel it
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ItemRow({ item, categories, canManage, busy, run }: { item: Item; categories: Record<string, string>; canManage: boolean; busy: boolean; run: (w: () => Promise<unknown>) => void }) {
  const [v, setV] = useState<Item>(item);
  const isNew = !item.id;
  const changed = JSON.stringify(v) !== JSON.stringify(item);
  const n = (k: keyof Item) => (
    <input
      inputMode="numeric"
      style={{ width: 70 }}
      disabled={!canManage}
      value={v[k] === null ? '' : String(v[k])}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d.]/g, '');
        setV({ ...v, [k]: k === 'costRand' ? (t === '' ? null : Number(t)) : Number(t || 0) });
      }}
    />
  );
  const { id, ...body } = v;
  return (
    <tr style={{ opacity: v.active ? 1 : 0.55 }}>
      <td>
        <input value={v.name} disabled={!canManage} placeholder={isNew ? 'Add a goal…' : ''} onChange={(e) => setV({ ...v, name: e.target.value })} style={{ minWidth: 170 }} />
      </td>
      <td>
        <select value={v.category} disabled={!canManage} onChange={(e) => setV({ ...v, category: e.target.value })}>
          {Object.entries(categories).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </td>
      <td>{n('barbs')}</td>
      <td>{n('costRand')}</td>
      <td>{n('monthsService')}</td>
      <td>{n('wireAtLeast')}</td>
      <td>
        <select value={v.needsGrade ?? ''} disabled={!canManage} onChange={(e) => setV({ ...v, needsGrade: e.target.value || null })}>
          <option value="">None</option>
          {['E', 'D', 'C', 'B', 'A'].map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </td>
      <td>{n('monthsAtStandard')}</td>
      <td>
        <input type="checkbox" checked={v.inStore} disabled={!canManage} onChange={(e) => setV({ ...v, inStore: e.target.checked })} />
      </td>
      <td>
        <input type="checkbox" checked={v.active} disabled={!canManage || isNew} onChange={(e) => setV({ ...v, active: e.target.checked })} />
      </td>
      <td>
        {canManage && changed && (
          <button
            className="btn sm"
            disabled={busy || v.name.trim().length < 2}
            onClick={() =>
              run(async () => {
                await api(isNew ? '/wire/items' : `/wire/items/${id}`, { method: isNew ? 'POST' : 'PUT', json: body });
                if (isNew) setV(item);
              })
            }
          >
            {isNew ? 'Add' : 'Save'}
          </button>
        )}
      </td>
    </tr>
  );
}
