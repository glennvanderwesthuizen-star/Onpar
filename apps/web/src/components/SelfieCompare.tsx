'use client';

import { useEffect, useState } from 'react';
import { api, imageUrl } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, formatDateTime } from './ui';

export interface SelfieCheck {
  result: 'match' | 'not_match' | 'unclear';
  note: string;
  checkedAt: string;
  checkedBy: string;
}

export const CHECK_LABEL = { match: 'Looks right', not_match: 'Not him', unclear: 'Unclear' } as const;
export const CHECK_TONE = { match: 'green', not_match: 'red', unclear: 'amber' } as const;

export function CheckPill({ check }: { check: SelfieCheck | null }) {
  if (!check) return <Pill tone="blue">Not checked</Pill>;
  return <Pill tone={CHECK_TONE[check.result]}>{CHECK_LABEL[check.result]}</Pill>;
}

/**
 * The declaration selfie next to the registration face photo (section 6.2), with the selfie
 * check buttons (D-36). Loading either photo is logged. "Not him" is a flag for a manager to look
 * into; it never does anything to the guard by itself.
 */
export function SelfieCompare({
  attendanceId,
  kind,
  hasSelfie,
  declarationId,
  check,
  onChecked,
  autoShow = false,
  source = 'review',
}: {
  attendanceId: string;
  kind: string;
  hasSelfie: boolean;
  declarationId?: string;
  check?: SelfieCheck | null;
  onChecked?: () => void;
  autoShow?: boolean;
  source?: 'review' | 'spot_check';
}) {
  const { can } = useSession();
  const [show, setShow] = useState(autoShow);
  const [urls, setUrls] = useState<{ selfie?: string; face?: string }>({});
  const [failed, setFailed] = useState<{ selfie?: boolean; face?: boolean }>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!show) return;
    const made: string[] = [];
    const load = (key: 'selfie' | 'face', path: string) =>
      imageUrl(path)
        .then((u) => {
          made.push(u);
          setUrls((x) => ({ ...x, [key]: u }));
        })
        .catch(() => setFailed((x) => ({ ...x, [key]: true })));
    if (hasSelfie) load('selfie', `/attendance/${attendanceId}/selfie/${kind}`);
    load('face', `/attendance/${attendanceId}/registration-photo`);
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, [show, attendanceId, kind, hasSelfie]);

  async function record(result: SelfieCheck['result']) {
    setBusy(true);
    setError(null);
    try {
      await api('/selfie-checks', { method: 'POST', json: { declarationId, result, note, source } });
      setNote('');
      onChecked?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!show) {
    return (
      <div>
        <button className="btn ghost" onClick={() => setShow(true)}>
          Compare selfie with registration photo
        </button>
        {declarationId && check !== undefined && (
          <div style={{ marginTop: 6 }}>
            <CheckPill check={check} />
          </div>
        )}
        <p className="mute small">Viewing photos is recorded in the audit log.</p>
      </div>
    );
  }
  return (
    <div>
      <div className="grid g2">
        <div className="photo">
          {urls.selfie ? (
            <img src={urls.selfie} alt="Selfie" />
          ) : (
            <div className="empty">{!hasSelfie ? 'Selfie still uploading' : failed.selfie ? 'Not available' : 'Loading…'}</div>
          )}
          <div className="small">Selfie</div>
        </div>
        <div className="photo">
          {urls.face ? (
            <img src={urls.face} alt="Registration face photo" />
          ) : (
            <div className="empty">{failed.face ? 'Not available' : 'Loading…'}</div>
          )}
          <div className="small">Registration photo</div>
        </div>
      </div>
      {declarationId && hasSelfie && (
        <div style={{ marginTop: 8 }}>
          {check && (
            <p className="small" style={{ margin: '0 0 6px' }}>
              <CheckPill check={check} /> {check.checkedBy}, {formatDateTime(check.checkedAt)}
              {check.note ? `: ${check.note}` : ''}
            </p>
          )}
          {can('attendance.selfie_check') && (
            <>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. new haircut, too dark" style={{ marginBottom: 6 }} />
              <div className="row">
                <button className="btn" disabled={busy} onClick={() => record('match')}>
                  Looks right
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => record('unclear')}>
                  Unclear
                </button>
                <button className="btn" style={{ background: 'var(--red)', borderColor: 'var(--red)' }} disabled={busy} onClick={() => record('not_match')}>
                  Not him
                </button>
              </div>
              <ErrorBanner error={error} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
