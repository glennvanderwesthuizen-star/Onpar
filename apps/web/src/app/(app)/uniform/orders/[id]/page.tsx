'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatRand, orderTotals, LINE_DECISION_LABELS, LineDecision } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, formatDate, formatDateTime, useLoad } from '@/components/ui';
import { STATUS_TONE } from '@/components/uniform';

interface Line {
  id: string;
  itemId: string;
  label: string;
  size: string;
  quantity: number;
  wasDue: boolean;
  reason: string;
  decision: LineDecision | null;
  decisionNote: string;
  unitPriceCents: number;
}

interface Order {
  id: string;
  number: number;
  status: string;
  statusLabel: string;
  requestedAt: string;
  lateSynced: boolean;
  receivedAt: string | null;
  handedOverAt: string | null;
  handedOverBy: string | null;
  guardAgreedCents: number | null;
  guardAgreedStatement: string | null;
  siteName: string;
  employeeName: string;
  employeeNumber: string;
  lines: Line[];
  totals: { companyCents: number; guardCents: number };
  history: { at: string; actorLabel: string; actorRole: string; statusAfter: string; note: string }[];
  nextOnDuty: { date: string; shiftName: string; startTime: string } | null;
}

export default function UniformOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: o, error, reload } = useLoad(() => api<Order>(`/uniform/orders/${id}`), [id]);
  const [decisions, setDecisions] = useState<Record<string, { decision: LineDecision | ''; note: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    // Suggest: items that are due go on the company account; items not yet due wait for a decision.
    if (o?.status === 'requested') setDecisions(Object.fromEntries(o.lines.map((l) => [l.id, { decision: l.wasDue ? 'company' : '', note: '' }])));
  }, [o]);

  const act = async (path: string, json: unknown = {}) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/uniform/orders/${id}/${path}`, { method: 'POST', json });
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  if (!o) return <ErrorBanner error={error} />;
  const deciding = o.status === 'requested' && can('uniform.review');
  const live = deciding
    ? orderTotals(o.lines.map((l) => ({ quantity: l.quantity, decision: (decisions[l.id]?.decision || null) as LineDecision | null, unitPriceCents: l.unitPriceCents })))
    : o.totals;
  const lineErrors = err instanceof ApiError ? err.errors : {};

  return (
    <>
      <div className="head">
        <div>
          <Link href="/uniform" className="mute small">
            ← Uniform
          </Link>
          <h1>
            Uniform order #{o.number} <Pill tone={STATUS_TONE[o.status] ?? 'grey'}>{o.statusLabel}</Pill>
          </h1>
          <p className="mute">
            {o.employeeName} #{o.employeeNumber} · {o.siteName} · ordered {formatDateTime(o.requestedAt)}
            {o.lateSynced && ' (sent late from a phone without signal)'}
          </p>
        </div>
      </div>
      <ErrorBanner error={err} />

      <div className="card scroll">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Size</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Due?</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.label}</td>
                <td>{l.size || '—'}</td>
                <td>{l.quantity}</td>
                <td className="small">
                  {formatRand(l.unitPriceCents)} each
                  <div className="mute">{formatRand(l.unitPriceCents * l.quantity)}</div>
                </td>
                <td>
                  {l.wasDue ? (
                    <Pill tone="green">Due</Pill>
                  ) : (
                    <>
                      <Pill tone="amber">Not yet due</Pill>
                      <div className="small">&ldquo;{l.reason}&rdquo;</div>
                    </>
                  )}
                </td>
                <td style={{ minWidth: 240 }}>
                  {deciding ? (
                    <>
                      <select
                        value={decisions[l.id]?.decision ?? ''}
                        onChange={(e) => setDecisions({ ...decisions, [l.id]: { ...decisions[l.id], decision: e.target.value as LineDecision } })}
                      >
                        <option value="">Choose…</option>
                        {(Object.keys(LINE_DECISION_LABELS) as LineDecision[]).map((k) => (
                          <option key={k} value={k}>
                            {LINE_DECISION_LABELS[k]}
                          </option>
                        ))}
                      </select>
                      <input
                        style={{ marginTop: 4 }}
                        placeholder={decisions[l.id]?.decision === 'declined' ? 'Why not issued (needed)' : 'Note (optional)'}
                        value={decisions[l.id]?.note ?? ''}
                        onChange={(e) => setDecisions({ ...decisions, [l.id]: { ...decisions[l.id], note: e.target.value } })}
                      />
                      {lineErrors[l.id] && <div className="err">{lineErrors[l.id]}</div>}
                    </>
                  ) : l.decision ? (
                    <>
                      <Pill tone={l.decision === 'declined' ? 'grey' : l.decision === 'guard' ? 'amber' : 'green'}>{LINE_DECISION_LABELS[l.decision]}</Pill>
                      {l.decisionNote && <div className="small mute">{l.decisionNote}</div>}
                    </>
                  ) : (
                    <span className="mute">Waiting for approval</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10, gap: 18 }}>
          <span>
            Company account: <b>{formatRand(live.companyCents)}</b>
          </span>
          <span>
            Guard&apos;s account: <b style={{ color: live.guardCents ? 'var(--amber)' : undefined }}>{formatRand(live.guardCents)}</b>
          </span>
        </div>
        {deciding && (
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn"
              disabled={busy || o.lines.some((l) => !decisions[l.id]?.decision)}
              onClick={() => act('decide', { lines: o.lines.map((l) => ({ lineId: l.id, decision: decisions[l.id].decision, note: decisions[l.id].note })) })}
            >
              Save decisions and send to stores
            </button>
            <span className="mute small">Guard&apos;s-account items are issued; he signs that he agrees to pay when he receives them.</span>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Next step</h2>
        {o.status === 'requested' && !deciding && <p className="mute">Waiting for a manager or administrator to decide each item.</p>}
        {o.status === 'approved' && (
          <>
            <p>With stores, to pack.</p>
            {can('uniform.stores') && (
              <button className="btn" disabled={busy} onClick={() => act('ready')}>
                Items packed: ready for collection
              </button>
            )}
          </>
        )}
        {o.status === 'ready' && (
          <>
            <p>Ready for the supervisor to collect at stores.</p>
            <div className="row">
              {can('uniform.deliver') && (
                <button className="btn" disabled={busy} onClick={() => act('collected')}>
                  I have collected it
                </button>
              )}
              {can('uniform.stores') && !o.handedOverAt && (
                <button className="btn ghost" disabled={busy} onClick={() => act('handed-over')}>
                  Stores: handed to the supervisor
                </button>
              )}
            </div>
          </>
        )}
        {o.status === 'with_supervisor' && (
          <>
            <p>
              With the supervisor, to hand over when {o.employeeName.split(' ')[0]} is next on duty
              {o.nextOnDuty ? (
                <>
                  : <b>{formatDate(o.nextOnDuty.date)}</b> ({o.nextOnDuty.shiftName}, {o.nextOnDuty.startTime})
                </>
              ) : (
                ' (not on the roster in the next two weeks)'
              )}
              . He signs for it on the post phone with his PIN.
            </p>
            {can('uniform.stores') && !o.handedOverAt && (
              <button className="btn ghost" disabled={busy} onClick={() => act('handed-over')}>
                Stores: handed to the supervisor
              </button>
            )}
          </>
        )}
        {o.status === 'received' && (
          <p>
            Signed for by {o.employeeName} on {formatDateTime(o.receivedAt)}.
            {o.guardAgreedStatement && (
              <>
                <br />
                <b>He agreed: </b>&ldquo;{o.guardAgreedStatement}&rdquo;
                <span className="mute small"> (a record for payroll; On Par never deducts anything)</span>
              </>
            )}
          </p>
        )}
        {o.status === 'declined' && <p className="mute">No items were issued.</p>}
        {o.handedOverAt && (
          <p className="small mute">
            Stores confirmed the hand-over to the supervisor: {o.handedOverBy}, {formatDateTime(o.handedOverAt)}.
          </p>
        )}
      </div>

      <div className="card">
        <h2>History</h2>
        <table>
          <tbody>
            {o.history.map((h, i) => (
              <tr key={i}>
                <td className="small">{formatDateTime(h.at)}</td>
                <td>
                  {h.actorLabel} <span className="mute small">{h.actorRole}</span>
                </td>
                <td className="small">{h.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
