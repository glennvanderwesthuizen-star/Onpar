'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { scoringErrors, EventType, ScoringConfig } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, useLoad } from '@/components/ui';

interface Rules {
  config: ScoringConfig;
  defaults: ScoringConfig;
  eventTypes: Record<EventType, { label: string; sign: number }>;
}

const SETTINGS: { key: keyof ScoringConfig; label: string; step?: number }[] = [
  { key: 'base', label: 'Starting score' },
  { key: 'windowDays', label: 'Days counted' },
  { key: 'dailyCap', label: 'Most points up or down in one day' },
  { key: 'aboveParFrom', label: 'Above Par from' },
  { key: 'onParFrom', label: 'On Par from' },
  { key: 'supervisorAwardLimit', label: 'Most a supervisor may award', step: 0.5 },
  { key: 'managerAwardLimit', label: 'Most a manager may award', step: 0.5 },
  { key: 'queryWindowDays', label: 'Days an officer has to query' },
  { key: 'answerWorkingDays', label: 'Working days to answer a query' },
];

export default function RulesPage() {
  const { can } = useSession();
  const editable = can('scores.rules');
  const { data, error: loadError } = useLoad(() => api<Rules>('/scores/rules'));
  const [c, setC] = useState<ScoringConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setC(data.config);
  }, [data]);

  if (loadError) return <ErrorBanner error={loadError} />;
  if (!data || !c) return <p className="mute">Loading…</p>;
  const errors = { ...scoringErrors(c), ...(error instanceof ApiError ? error.errors : {}) };
  const num = (v: string) => (v === '' || v === '-' ? NaN : Number(v));

  return (
    <>
      <div className="head">
        <div>
          <Link href="/scores" className="mute small">
            ← Scores
          </Link>
          <h1>Scoring rules</h1>
          <p className="mute">
            Changes apply to events from now on. Points already recorded keep the value they had. Have an employment lawyer review these
            before real use.
          </p>
        </div>
      </div>
      {saved && <div className="banner ok">Rules saved. They apply from now on.</div>}
      <ErrorBanner error={error} />
      <div className="card scroll">
        <h2>Points per event</h2>
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Points</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(data.eventTypes) as EventType[]).map((t) => (
              <tr key={t}>
                <td>{data.eventTypes[t].label}</td>
                <td style={{ width: 160 }}>
                  <input
                    type="number"
                    step={0.5}
                    disabled={!editable}
                    value={Number.isNaN(c.points[t]) ? '' : c.points[t]}
                    aria-label={`Points for ${data.eventTypes[t].label}`}
                    className={errors[`points.${t}`] ? 'invalid' : ''}
                    onChange={(e) => setC({ ...c, points: { ...c.points, [t]: num(e.target.value) } })}
                  />
                  {errors[`points.${t}`] && <div className="err">{errors[`points.${t}`]}</div>}
                </td>
                <td className="mute">{data.defaults.points[t]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mute small">Missed patrols are 0 by default because patrol points are earned per completed patrol (section 6.5).</p>
      </div>
      <div className="card">
        <h2>Score settings</h2>
        <div className="grid g3">
          {SETTINGS.map(({ key, label, step }) => (
            <Field key={key} label={label} error={errors[key]} hint={`Default ${data.defaults[key] as number}`}>
              <input
                type="number"
                step={step ?? 1}
                disabled={!editable}
                value={Number.isNaN(c[key] as number) ? '' : (c[key] as number)}
                onChange={(e) => setC({ ...c, [key]: num(e.target.value) })}
              />
            </Field>
          ))}
        </div>
      </div>
      {editable ? (
        <button
          className="btn"
          disabled={busy || Object.keys(scoringErrors(c)).length > 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setSaved(false);
            try {
              setC(await api<ScoringConfig>('/scores/rules', { method: 'PUT', json: c }));
              setSaved(true);
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save rules'}
        </button>
      ) : (
        <p className="mute">Only a company manager can change the rules.</p>
      )}
    </>
  );
}
