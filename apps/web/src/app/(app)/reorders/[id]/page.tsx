'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { REORDER_ACTIONS, REORDER_STAGE_LABELS, REORDER_STAGES, ReorderAction } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, formatDateTime, useLoad } from '@/components/ui';
import { itemText, Reorder, StagePillR } from '@/components/reorders';

type Detail = Reorder & {
  history: { id: string; at: string; receivedAt: string; actorLabel: string; actorRole: string; stage: string; note: string; lateSynced: boolean; assigneeName: string | null }[];
};

export default function ReorderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data: r, error, reload } = useLoad(() => api<Detail>(`/reorders/${id}`), [id]);
  const people = useLoad(() => api<{ id: string; name: string; role: string; active: boolean }[]>('/people'));
  const [note, setNote] = useState('');
  const [person, setPerson] = useState('');
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<unknown>(null);

  if (error) return <ErrorBanner error={error} />;
  if (!r) return <p className="mute">Loading…</p>;
  const at = REORDER_STAGES.indexOf(r.stage);
  const actions = (Object.keys(REORDER_ACTIONS) as ReorderAction[]).filter((a) => (REORDER_ACTIONS[a].from as readonly string[]).includes(r.stage));
  const send = async (a: ReorderAction) => {
    setBusy(true);
    setActError(null);
    try {
      await api(`/reorders/${r.id}/${a}`, { method: 'POST', json: { note, ...(a === 'assigned' ? { assigneePersonId: person } : {}) } });
      setNote('');
      reload();
    } catch (e) {
      setActError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="head">
        <div>
          <Link href="/reorders" className="mute small">
            ← Re-orders
          </Link>
          <h1>
            R{r.number} · {itemText(r)}
          </h1>
          <p className="mute">
            {r.kind === 'personal' ? `Personal re-order for ${r.employeeName} (#${r.employeeNumber})` : `Site re-order for ${r.siteName}, asked by ${r.employeeName}`} ·{' '}
            {formatDateTime(r.requestedAt)}
          </p>
        </div>
        <StagePillR stage={r.stage} />
      </div>
      <div className="stages">
        {REORDER_STAGES.map((s, i) => (
          <span key={s} className={i < at ? 'done' : i === at ? 'now' : ''}>
            {REORDER_STAGE_LABELS[s]}
          </span>
        ))}
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Request</h2>
          <p>
            <b>{itemText(r)}</b>
          </p>
          {r.comment && <p>Reason: {r.comment}</p>}
          {r.kind === 'personal' && <p className="mute small">The size or asset number comes from the officer&apos;s profile. When they confirm receipt, the item&apos;s issue date updates.</p>}
          {r.assigneeName && (
            <p>
              Delivering: <b>{r.assigneeName}</b> · <a href={`tel:${r.assigneePhone}`}>{r.assigneePhone}</a>
            </p>
          )}
          <p className="mute small">Whether the company recovers the cost of a replacement from an employee is a labour-law question. On Par does not make deductions.</p>
        </div>
        <div className="card">
          <h2>Next step</h2>
          {r.stage === 'received' ? (
            <p className="mute">Received on {formatDateTime(r.receivedAt)}. Nothing more to do.</p>
          ) : r.stage === 'delivered' ? (
            <p className="mute">Waiting for the officer to confirm receipt on the device.</p>
          ) : !can('reorders.manage') ? (
            <p className="mute">Waiting for a supervisor.</p>
          ) : (
            <>
              <ErrorBanner error={actError} />
              {actions.includes('assigned') && (
                <Field label={r.stage === 'assigned' ? 'Reassign delivery to' : 'Who will deliver it'}>
                  <select value={person} onChange={(e) => setPerson(e.target.value)}>
                    <option value="">Choose…</option>
                    {people.data
                      ?.filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}, {p.role}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
              <Field label="Note">
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Ordered from the uniform supplier, order 5521" />
              </Field>
              <div className="row">
                {actions.map((a) => (
                  <button key={a} className={a === 'assigned' && r.stage === 'assigned' ? 'btn ghost' : 'btn'} disabled={busy || (a === 'assigned' && !person)} onClick={() => send(a)}>
                    {a === 'assigned' && r.stage === 'assigned' ? 'Reassign' : REORDER_ACTIONS[a].label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2>History</h2>
        <div className="timeline">
          {r.history.map((h) => (
            <div key={h.id}>
              <b>{REORDER_STAGE_LABELS[h.stage as keyof typeof REORDER_STAGE_LABELS]}</b>
              <div className="mute small">
                {formatDateTime(h.at)} · {h.actorLabel}, {h.actorRole}
                {h.lateSynced && ` · sent ${formatDateTime(h.receivedAt)} (was offline)`}
              </div>
              {h.assigneeName && <div className="small">To {h.assigneeName}</div>}
              {h.note && <div>{h.note}</div>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
