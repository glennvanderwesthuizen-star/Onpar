'use client';

import Link from 'next/link';
import { useState } from 'react';
import { can as roleCan, sastDate } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDate, useLoad } from '@/components/ui';
import { FairnessNote, Points, PositionPill } from '@/components/scores';

interface Row {
  id: string;
  name: string;
  employeeNumber: string;
  siteName: string;
  score: number;
  position: string;
  positionLabel: string;
  openQueries: number;
}

interface Query {
  id: string;
  text: string;
  askedAt: string;
  answerDue: string;
  status: string;
  employeeId: string;
  employeeName: string;
  label: string;
  impact: number;
  evidence: string;
  eventDate: string;
}

export default function ScoresPage() {
  const { can } = useSession();
  const [siteId, setSiteId] = useState('');
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const rows = useLoad(() => api<Row[]>(`/scores${siteId ? `?siteId=${siteId}` : ''}`), [siteId]);
  const queries = useLoad(() => api<Query[]>('/scores/queries'));
  const data = rows.data ?? [];

  return (
    <>
      <div className="head">
        <div>
          <h1>Scores</h1>
          <p className="mute">Each officer starts at 80. The score counts the last 30 days.</p>
        </div>
        <Link className="btn ghost" href="/scores/rules">
          Scoring rules
        </Link>
      </div>
      <FairnessNote />

      <div className="tiles">
        <div className="tile">
          <b>{data.filter((r) => r.position === 'ABOVE_PAR').length}</b>
          <span>Above Par (90 or more)</span>
        </div>
        <div className="tile">
          <b>{data.filter((r) => r.position === 'ON_PAR').length}</b>
          <span>On Par (70 to 89)</span>
        </div>
        <div className="tile">
          <b style={{ color: data.some((r) => r.position === 'NEEDS_ATTENTION') ? 'var(--amber)' : undefined }}>
            {data.filter((r) => r.position === 'NEEDS_ATTENTION').length}
          </b>
          <span>Needs Attention (below 70)</span>
        </div>
        <div className="tile">
          <b style={{ color: queries.data?.length ? 'var(--amber)' : undefined }}>{queries.data?.length ?? '–'}</b>
          <span>Queries to answer</span>
        </div>
      </div>

      {!!queries.data?.length && <Queries queries={queries.data} canAnswer={can('scores.answer')} onDone={() => (queries.reload(), rows.reload())} />}

      <ErrorBanner error={rows.error} />
      <div className="card scroll">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Officers</h2>
          <div style={{ width: 240 }}>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Site">
              <option value="">All my sites</option>
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {rows.data && !data.length && <p className="mute">No officers.</p>}
        {!!data.length && (
          <table>
            <thead>
              <tr>
                <th>Officer</th>
                <th>Site</th>
                <th>Score</th>
                <th>Position</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/scores/${r.id}`}>
                      <b>{r.name}</b>
                    </Link>
                    <div className="mute small">#{r.employeeNumber}</div>
                  </td>
                  <td>{r.siteName}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <b>{r.score}</b>
                  </td>
                  <td>
                    <PositionPill position={r.position} label={r.positionLabel} />
                    {r.openQueries > 0 && <div className="mute small">{r.openQueries} open query</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Queries({ queries, canAnswer, onDone }: { queries: Query[]; canAnswer: boolean; onDone: () => void }) {
  const { me } = useSession();
  const today = sastDate(new Date());
  return (
    <div className="card">
      <h2>Queries waiting for an answer</h2>
      <p className="mute small">Answer within 3 working days. Upholding keeps the points; reversing them needs a manager.</p>
      {queries.map((q) => (
        <div key={q.id} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <Link href={`/scores/${q.employeeId}`}>
                <b>{q.employeeName}</b>
              </Link>{' '}
              queried <b>{q.label}</b> (<Points n={q.impact} />) of {formatDate(q.eventDate)}
            </div>
            <Pill tone={q.answerDue < today ? 'red' : 'amber'}>Answer by {formatDate(q.answerDue)}</Pill>
          </div>
          <div className="mute small">Evidence: {q.evidence}</div>
          <p style={{ margin: '6px 0' }}>“{q.text}”</p>
          {canAnswer && <Answer queryId={q.id} canReverse={roleCan(me.role as never, 'scores.reverse')} onDone={onDone} />}
        </div>
      ))}
    </div>
  );
}

function Answer({ queryId, canReverse, onDone }: { queryId: string; canReverse: boolean; onDone: () => void }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async (decision: 'upheld' | 'reversed') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/scores/queries/${queryId}/answer`, { method: 'POST', json: { decision, answer } });
      onDone();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <>
      <ErrorBanner error={error} />
      <Field label="Your answer (the officer will see it)">
        <input value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </Field>
      <div className="row">
        <button className="btn ghost" disabled={busy || answer.trim().length < 5} onClick={() => send('upheld')}>
          Uphold (points stay)
        </button>
        {canReverse && (
          <button className="btn" disabled={busy || answer.trim().length < 5} onClick={() => send('reversed')}>
            Reverse the points
          </button>
        )}
      </div>
    </>
  );
}
