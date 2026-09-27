'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDate, formatDateTime, useLoad } from '@/components/ui';
import { FairnessNote, Points, PositionPill } from '@/components/scores';

interface Event {
  id: string;
  date: string;
  type: string;
  label: string;
  impact: number;
  evidence: string;
  sourceType: string;
  sourceId: string | null;
  reversesEventId: string | null;
  reversedBy: string | null;
  createdBy: string;
  reason: string | null;
  createdAt: string;
  siteName: string | null;
  queryStatus: string | null;
  queryText: string | null;
  queryAnswer: string | null;
  queryAnswerDue: string | null;
}

interface OfficerScore {
  employee: { id: string; name: string; employeeNumber: string; siteName: string };
  score: number;
  position: string;
  positionLabel: string;
  counted: number;
  cappedOff: number;
  from: string;
  to: string;
  events: Event[];
}

function sourceLink(e: Event) {
  if (e.sourceType === 'attendance' && e.sourceId) return `/attendance/${e.sourceId}`;
  if (e.sourceType === 'task' && e.sourceId) return `/tasks/occurrence/${e.sourceId}`;
  return null;
}

export default function OfficerScorePage({ params }: { params: Promise<{ employeeId: string }> }) {
  const { employeeId } = use(params);
  const { can } = useSession();
  const { data: s, error, reload } = useLoad(() => api<OfficerScore>(`/scores/${employeeId}`), [employeeId]);
  const [reversing, setReversing] = useState<string | null>(null);

  if (error) return <ErrorBanner error={error} />;
  if (!s) return <p className="mute">Loading…</p>;

  return (
    <>
      <div className="head">
        <div>
          <Link href="/scores" className="mute small">
            ← Scores
          </Link>
          <h1>{s.employee.name}</h1>
          <p className="mute">
            #{s.employee.employeeNumber} · {s.employee.siteName}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1 }}>{s.score}</div>
          <PositionPill position={s.position} label={s.positionLabel} />
        </div>
      </div>
      <FairnessNote />
      <p className="mute small">
        80 plus {s.counted >= 0 ? '+' : ''}
        {s.counted} points from {formatDate(s.from)} to {formatDate(s.to)}.
        {s.cappedOff !== 0 && ` ${Math.abs(s.cappedOff)} points did not count because of the daily limit of ±5.`}
      </p>

      {can('scores.award') && <Award employeeId={employeeId} onDone={reload} />}

      <div className="card scroll">
        <h2>Why the score is what it is</h2>
        {!s.events.length && <p className="mute">Nothing in the last 30 days.</p>}
        {!!s.events.length && (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>What happened</th>
                <th>Points</th>
                <th>Evidence</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.events.map((e) => {
                const link = sourceLink(e);
                return (
                  <tr key={e.id} style={{ opacity: e.reversedBy ? 0.55 : 1 }}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(e.date)}</td>
                    <td>
                      <b>{e.label}</b>
                      {e.reversedBy && (
                        <div>
                          <Pill tone="grey">Reversed</Pill>
                        </div>
                      )}
                      {e.createdBy && e.createdBy !== 'System' && <div className="mute small">By {e.createdBy}</div>}
                    </td>
                    <td>
                      <Points n={e.impact} />
                    </td>
                    <td className="small">
                      {e.evidence}
                      {e.reason && e.type === 'reversal' && <div>Reason: {e.reason}</div>}
                      {link && (
                        <div>
                          <Link href={link}>See the record</Link>
                        </div>
                      )}
                      {e.queryStatus && (
                        <div className="banner warn" style={{ margin: '6px 0 0', padding: '6px 10px' }}>
                          <b>Queried:</b> “{e.queryText}”
                          <div>
                            {e.queryStatus === 'open'
                              ? `Waiting for an answer, due ${formatDate(e.queryAnswerDue)}.`
                              : `${e.queryStatus === 'upheld' ? 'Upheld' : 'Reversed'}: ${e.queryAnswer}`}
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      {can('scores.reverse') && e.type !== 'reversal' && !e.reversedBy && (
                        <button className="btn ghost sm" onClick={() => setReversing(e.id)}>
                          Reverse
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {reversing && (
        <Reverse
          event={s.events.find((e) => e.id === reversing)!}
          onClose={() => setReversing(null)}
          onDone={() => {
            setReversing(null);
            reload();
          }}
        />
      )}
      <p className="mute small">Last updated {formatDateTime(new Date().toISOString())}.</p>
    </>
  );
}

function Award({ employeeId, onDone }: { employeeId: string; onDone: () => void }) {
  const { can } = useSession();
  const rules = useLoad(() => api<{ config: { supervisorAwardLimit: number; managerAwardLimit: number } }>('/scores/rules'));
  const isManager = can('scores.reverse');
  const limit = rules.data ? (isManager ? rules.data.config.managerAwardLimit : rules.data.config.supervisorAwardLimit) : isManager ? 5 : 2;
  const [points, setPoints] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  return (
    <div className="card">
      <h2>Recognise good work</h2>
      <p className="mute small">
        {isManager ? `Managers can award up to +${limit} at a time.` : `Supervisors can award up to +${limit}. For more, ask a manager.`} Points can
        only be awarded, never taken away by hand.
      </p>
      {ok && <div className="banner ok">Points awarded.</div>}
      <ErrorBanner error={error} />
      <div className="grid g3">
        <Field label="Points">
          <select value={points} onChange={(e) => setPoints(Number(e.target.value))}>
            {Array.from({ length: Math.round(limit * 2) }, (_, i) => (i + 1) / 2).map((n) => (
              <option key={n} value={n}>
                +{n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What did they do?">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Stopped a break-in at unit 4" />
        </Field>
      </div>
      <button
        className="btn"
        disabled={busy || reason.trim().length < 5}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setOk(false);
          try {
            await api(`/scores/${employeeId}/award`, { method: 'POST', json: { points, reason } });
            setReason('');
            setOk(true);
            onDone();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Award
      </button>
    </div>
  );
}

function Reverse({ event, onClose, onDone }: { event: Event; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="card" style={{ borderColor: 'var(--green)' }}>
      <h2>
        Reverse “{event.label}” (<Points n={event.impact} />) of {formatDate(event.date)}
      </h2>
      <p className="mute small">This adds an offsetting entry. The original stays on record with the reason for reversing it.</p>
      <ErrorBanner error={error} />
      <Field label="Reason">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="row">
        <button
          className="btn"
          disabled={busy || reason.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/scores/events/${event.id}/reverse`, { method: 'POST', json: { reason } });
              onDone();
            } catch (e) {
              setError(e);
              setBusy(false);
            }
          }}
        >
          Reverse
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
