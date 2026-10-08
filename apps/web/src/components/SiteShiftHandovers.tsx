'use client';

import { api } from '@/lib/api';
import { ErrorBanner, Pill, formatDateTime, useLoad } from './ui';

interface Line {
  name: string;
  expected: number;
  present: number;
  damaged: boolean;
}
interface Handover {
  id: string;
  shiftName: string | null;
  signedAt: string;
  items: Line[];
  note: string;
  receivedAt: string | null;
  receivedItems: Line[] | null;
  receivedNote: string | null;
  from: string;
  to: string | null;
  post: string | null;
  reportNumber: number | null;
  receivedReportNumber: number | null;
}

const short = (items: Line[]) => items.map((i) => `${i.name} ${i.present}/${i.expected}${i.damaged ? ' (damaged)' : ''}`).join(', ');

/** The site's shift handovers (D-45): equipment counted out and received, with the notes. */
export function SiteShiftHandovers({ siteId }: { siteId: string }) {
  const { data, error } = useLoad(() => api<Handover[]>(`/sites/${siteId}/shift-handovers`), [siteId]);
  if (error) return <ErrorBanner error={error} />;
  return (
    <div className="card">
      <h2>Shift handovers</h2>
      <p className="mute small">
        The last 30. The outgoing guard counts the shift&apos;s equipment (set up under each shift above) and leaves a note; the next guard on duty checks it and receives it. Anything missing, damaged or different becomes an equipment
        report.
      </p>
      {data && !data.length && <p className="mute">No handovers yet.</p>}
      {data?.map((h) => (
        <div key={h.id} className="small" style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>
              {h.from} to {h.to ?? '…'} {h.post && <span className="mute">· {h.post}</span>} {h.shiftName && <span className="mute">· {h.shiftName}</span>}
            </b>
            <span className="mute">{formatDateTime(h.signedAt)}</span>
          </div>
          <div>Handed over: {short(h.items) || 'no equipment set up'}</div>
          {h.note && <div className="mute">“{h.note}”</div>}
          {h.reportNumber && <Pill tone="amber">Equipment report #{h.reportNumber}</Pill>}
          {h.receivedAt ? (
            <div>
              Received {formatDateTime(h.receivedAt)}
              {h.receivedNote && <span className="mute"> · “{h.receivedNote}”</span>} {h.receivedReportNumber && <Pill tone="amber">Difference: report #{h.receivedReportNumber}</Pill>}
            </div>
          ) : (
            <Pill tone="grey">Not yet received</Pill>
          )}
        </div>
      ))}
    </div>
  );
}
