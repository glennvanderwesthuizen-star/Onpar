'use client';

import { useState } from 'react';
import type { FaceVerdict } from '@onpar/rules';
import { api } from '@/lib/api';
import { ErrorBanner, formatDateTime, useLoad } from '@/components/ui';
import { AutoPill, BlinkPill, SelfieCheck, SelfieCompare } from '@/components/SelfieCompare';

interface Row {
  declarationId: string;
  attendanceId: string;
  kind: 'duty_on' | 'duty_from';
  officialAt: string;
  employeeName: string;
  siteName: string;
  hasFacePhoto: boolean;
  result: SelfieCheck['result'] | null;
  autoVerdict: FaceVerdict | null;
  autoDistance: number | null;
  liveness: 'passed' | 'not_passed' | null;
}

const KIND = { duty_on: 'Duty On', duty_from: 'Duty From' } as const;

/**
 * Supervisor app, Selfie checks (D-36): the selfies of the last seven days that nobody has
 * checked. One at a time: open the photos, then say whether it is him. "Not him" is a flag for
 * a manager to look into; nothing happens to the guard automatically.
 */
export default function MobileSelfies() {
  const [round, setRound] = useState(0);
  const { data, error } = useLoad(() => api<{ rows: Row[]; counts: { todo: number; flagged: number } }>('/selfie-checks?view=todo'), [round]);
  return (
    <>
      <h1 className="m-h1">Selfie checks</h1>
      <p className="mute small">Is the person in the selfie the guard in the enrolment photo? “Not him” is a flag for a manager to look into, never an automatic warning. Viewing photos is recorded.</p>
      <ErrorBanner error={error} />
      {!data && !error && <p className="mute">Loading…</p>}
      {data && data.rows.length === 0 && (
        <div className="m-allclear">
          <b>Every selfie of the last seven days has been checked.</b>
        </div>
      )}
      {data && data.rows.length > 0 && <p className="mute small">{data.counts.todo} to check.</p>}
      {data?.rows.map((r) => (
        <article key={r.declarationId} className="card">
          <div className="m-alert-head">
            <h3 style={{ margin: 0, fontSize: 17 }}>{r.employeeName}</h3>
            <span className="pill blue">{KIND[r.kind]}</span>
          </div>
          <p className="mute small">
            {r.siteName} · {formatDateTime(r.officialAt)}
          </p>
          <p style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <AutoPill verdict={r.autoVerdict} distance={r.autoDistance} />
            <BlinkPill liveness={r.liveness} />
          </p>
          {!r.hasFacePhoto && <div className="banner warn">This guard has no enrolment face photo to compare with.</div>}
          <SelfieCompare attendanceId={r.attendanceId} kind={r.kind} hasSelfie declarationId={r.declarationId} onChecked={() => setRound((n) => n + 1)} />
        </article>
      ))}
    </>
  );
}
