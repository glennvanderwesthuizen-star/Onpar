'use client';

import { ErrorBanner, Pill, formatDate, useLoad } from './ui';
import { api } from '@/lib/api';

interface Board {
  month: string | null;
  improved: { display: string; hidden: boolean; improvedBy: number }[];
  milestones: { display: string; hidden: boolean; label: string; date: string }[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The recognition board as managers see it: real names, marked where the guard has chosen not to be named on phones. */
export function WireBoard() {
  const { data, error } = useLoad(() => api<Board>('/wire/board'));
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;
  const hiddenPill = <Pill tone="grey">shown as &quot;A guard&quot;</Pill>;
  return (
    <div className="card">
      <h2>Recognition board</h2>
      <p className="mute small">
        What guards see under My Wire: the most improved guards of the last finished month, each against his own record, and Wire milestones from the last 60 days. Never a full ranking. A guard&apos;s name shows on phones only if he has chosen it;
        guards at other sites see his region, not his site.
      </p>
      <h3>Most improved{data.month ? `, ${MONTHS[Number(data.month.slice(5)) - 1]} ${data.month.slice(0, 4)}` : ''}</h3>
      {!data.improved.length && <p className="mute">Nobody yet. This fills in after a month end, once guards have earlier months to beat.</p>}
      {data.improved.map((g, i) => (
        <div key={i} className="small">
          <b>{g.display}</b> · {g.improvedBy} points above his own average {g.hidden && hiddenPill}
        </div>
      ))}
      <h3 style={{ marginTop: 12 }}>Milestones</h3>
      {!data.milestones.length && <p className="mute">None in the last 60 days.</p>}
      {data.milestones.map((m, i) => (
        <div key={i} className="small">
          {formatDate(m.date)} · <b>{m.display}</b> reached {m.label.startsWith("Silver") || m.label.startsWith("Gold") ? `the ${m.label}` : m.label} {m.hidden && hiddenPill}
        </div>
      ))}
    </div>
  );
}
