'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, formatDateTime, useLoad } from '@/components/ui';
import type { FaceVerdict } from '@onpar/rules';
import { AutoPill, BlinkPill, CheckPill, SelfieCheck, SelfieCompare } from '@/components/SelfieCompare';

interface Row {
  declarationId: string;
  attendanceId: string;
  kind: 'duty_on' | 'duty_from';
  officialAt: string;
  employeeId: string;
  employeeName: string;
  siteName: string;
  hasFacePhoto: boolean;
  result: SelfieCheck['result'] | null;
  note: string | null;
  checkedAt: string | null;
  checkedBy: string | null;
  autoVerdict: FaceVerdict | null;
  autoDistance: number | null;
  liveness: 'passed' | 'not_passed' | null;
}

const TABS = [
  ['todo', 'To check'],
  ['spot', 'Weekly spot check'],
  ['flagged', 'Flagged'],
  ['done', 'Checked'],
] as const;

const KIND = { duty_on: 'Duty On', duty_from: 'Duty From' } as const;

/**
 * Selfie checks (D-36, face recognition stage 1): is the person in the Duty On or Duty From selfie
 * the guard in the enrolment photo? People check, so it is an ordinary review of photos already
 * taken. "Not him" is a flag to look into; nothing happens to the guard automatically.
 */
export default function SelfieChecksPage() {
  const [view, setView] = useState<(typeof TABS)[number][0]>('todo');
  const [round, setRound] = useState(0);
  const { data, error, reload } = useLoad(() => api<{ rows: Row[]; counts: { todo: number; flagged: number } }>(`/selfie-checks?view=${view}`), [view, round]);

  return (
    <>
      <div className="head">
        <div>
          <Link href="/attendance" className="mute small">
            ← Attendance
          </Link>
          <h1>Selfie checks</h1>
          <p className="mute">
            Look at each selfie next to the enrolment photo and say whether it is him. Guards knowing that someone looks
            discourages sharing PINs. &quot;Not him&quot; is a flag for a manager to look into, never an automatic
            warning. Viewing photos is recorded in the audit log.
          </p>
        </div>
        {view === 'spot' && (
          <button className="btn ghost" onClick={() => setRound((r) => r + 1)}>
            Pick another 10
          </button>
        )}
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>
            {label}
            {k === 'todo' && data?.counts.todo ? ` (${data.counts.todo})` : ''}
            {k === 'flagged' && data?.counts.flagged ? ` (${data.counts.flagged})` : ''}
          </button>
        ))}
      </div>
      {view === 'spot' && (
        <p className="mute small">
          10 selfies from the last 7 days, picked at random. Do this once a week for every site.
        </p>
      )}
      <ErrorBanner error={error} />
      {data && !data.rows.length && (
        <div className="card mute">
          {view === 'flagged' ? 'Nothing flagged.' : view === 'done' ? 'Nothing checked in the last 30 days.' : 'Nothing to check. Well done.'}
        </div>
      )}
      <div className="grid g2">
        {data?.rows.map((r) => (
          <div key={r.declarationId} className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <Link href={`/officers/${r.employeeId}`}>
                  <b>{r.employeeName}</b>
                </Link>
                <div className="small mute">
                  {KIND[r.kind]} · {r.siteName} · {formatDateTime(r.officialAt)} ·{' '}
                  <Link href={`/attendance/${r.attendanceId}`}>shift</Link>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <CheckPill check={r.result ? { result: r.result, note: r.note ?? '', checkedAt: r.checkedAt!, checkedBy: r.checkedBy ?? '' } : null} />
                <div style={{ marginTop: 4 }}>
                  <AutoPill verdict={r.autoVerdict} distance={r.autoDistance} /> <BlinkPill liveness={r.liveness} />
                </div>
              </div>
            </div>
            {!r.hasFacePhoto && <p className="small">No enrolment photo to compare with.</p>}
            <SelfieCompare
              attendanceId={r.attendanceId}
              kind={r.kind}
              hasSelfie
              declarationId={r.declarationId}
              check={r.result ? { result: r.result, note: r.note ?? '', checkedAt: r.checkedAt!, checkedBy: r.checkedBy ?? '' } : null}
              onChecked={reload}
              autoShow={view !== 'done'}
              source={view === 'spot' ? 'spot_check' : 'review'}
            />
          </div>
        ))}
      </div>
    </>
  );
}
