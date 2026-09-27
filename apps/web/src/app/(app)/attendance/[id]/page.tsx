'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { api, imageUrl } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDate, formatDateTime, useLoad } from '@/components/ui';
import { ArrivalPill, DeparturePill, time } from '@/components/attendance';

interface Detail {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_number: string;
  site_name: string;
  shift_name: string | null;
  shift_date: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  duty_on_at: string;
  duty_from_at: string | null;
  arrival_status: 'ON_TIME' | 'LATE' | 'UNSCHEDULED';
  late_minutes: number;
  departure_status: 'ON_TIME' | 'EARLY_DEPARTURE' | 'UNSCHEDULED' | null;
  early_minutes: number;
  exception_reason: string | null;
  exception_by_name: string | null;
  exception_at: string | null;
  events: {
    id: string;
    kind: string;
    official_at: string;
    device_clock: string;
    received_at: string;
    late_synced: boolean;
    drift_seconds: number;
    drift_flagged: boolean;
    on_behalf_reason: string | null;
    on_behalf_by_name: string | null;
    device_label: string | null;
  }[];
  declarations: {
    id: string;
    kind: 'duty_on' | 'duty_from';
    wording_version: number;
    statements: { text: string; accepted: boolean }[];
    comment: string;
    raise_equipment_report: boolean;
    official_at: string;
    late_synced: boolean;
    drift_flagged: boolean;
    has_selfie: boolean;
  }[];
}

const KIND = { duty_on: 'Duty On', duty_from: 'Duty From' } as const;

export default function AttendanceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data: a, error, reload } = useLoad(() => api<Detail>(`/attendance/${id}`), [id]);

  if (error) return <ErrorBanner error={error} />;
  if (!a) return <p className="mute">Loading…</p>;
  const row = {
    arrivalStatus: a.arrival_status,
    lateMinutes: a.late_minutes,
    departureStatus: a.departure_status,
    earlyMinutes: a.early_minutes,
    dutyFromAt: a.duty_from_at,
    exceptionReason: a.exception_reason,
  };

  return (
    <>
      <div className="head">
        <div>
          <Link href="/attendance" className="mute small">
            ← Attendance
          </Link>
          <h1>{a.employee_name}</h1>
          <p className="mute">
            #{a.employee_number} · {a.site_name} · {a.shift_name ?? 'No matching shift'} shift of {formatDate(a.shift_date)}
          </p>
        </div>
        <div className="row">
          <ArrivalPill row={row} /> <DeparturePill row={row} />
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Times</h2>
          <p>
            Scheduled {time(a.scheduled_start)} to {time(a.scheduled_end)}
          </p>
          <p>
            Duty On {time(a.duty_on_at)} · Duty From {time(a.duty_from_at)}
          </p>
          {a.events.map((e) => (
            <div key={e.id} className="small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6, marginTop: 6 }}>
              <b>{KIND[e.kind as keyof typeof KIND]}</b> at {formatDateTime(e.official_at)}
              {e.device_label && <> on {e.device_label}</>}
              {e.on_behalf_by_name && (
                <div>
                  Logged by {e.on_behalf_by_name}: {e.on_behalf_reason}
                </div>
              )}
              {e.late_synced && <div className="mute">Sent from the device at {formatDateTime(e.received_at)} (was offline)</div>}
              {e.drift_flagged && (
                <div style={{ color: 'var(--red)' }}>
                  Phone clock was {Math.round(Math.abs(e.drift_seconds) / 60)} min {e.drift_seconds > 0 ? 'fast' : 'slow'}
                </div>
              )}
            </div>
          ))}
        </div>
        <Exception detail={a} canManage={can('attendance.manage')} onDone={reload} />
      </div>

      {(['duty_on', 'duty_from'] as const).map((kind) => {
        const d = a.declarations.find((x) => x.kind === kind);
        if (kind === 'duty_from' && !a.duty_from_at) return null;
        return (
          <div key={kind} className="card">
            <h2>{KIND[kind]} declaration</h2>
            {!d ? (
              <div className="banner warn">Declaration pending. The officer has not completed it on the device yet.</div>
            ) : (
              <div className="grid g2">
                <div>
                  <p className="mute small">
                    Made at {formatDateTime(d.official_at)} · wording version {d.wording_version}
                    {d.late_synced && ' · synced late'}
                  </p>
                  <ul style={{ paddingLeft: 20 }}>
                    {d.statements.map((s) => (
                      <li key={s.text}>
                        {s.accepted ? '✓' : '✗'} “{s.text}”
                      </li>
                    ))}
                  </ul>
                  {d.comment && (
                    <div className="banner warn">
                      <b>Comment:</b> {d.comment}
                      {d.raise_equipment_report && (
                        <div className="small">Raised as an equipment report (reports arrive in milestone 5).</div>
                      )}
                    </div>
                  )}
                  <p className="mute small">A declaration is a record of what the officer stated. It is evidence, not proof.</p>
                </div>
                <SelfieCompare attendanceId={a.id} kind={kind} hasSelfie={d.has_selfie} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function Exception({ detail, canManage, onDone }: { detail: Detail; canManage: boolean; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const needs = detail.arrival_status === 'LATE' || detail.departure_status === 'EARLY_DEPARTURE';
  return (
    <div className="card">
      <h2>Exception</h2>
      {detail.exception_reason ? (
        <p>
          <Pill tone="blue">Approved</Pill> by {detail.exception_by_name} on {formatDateTime(detail.exception_at)}: {detail.exception_reason}
        </p>
      ) : !needs ? (
        <p className="mute">Nothing to approve for this shift.</p>
      ) : canManage ? (
        <>
          <p className="mute small">Approve the late arrival or early departure if there was a good reason. It is recorded in the audit log.</p>
          <ErrorBanner error={error} />
          <Field label="Reason">
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <button
            className="btn"
            disabled={busy || reason.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/attendance/${detail.id}/exception`, { method: 'POST', json: { reason } });
                onDone();
              } catch (e) {
                setError(e);
                setBusy(false);
              }
            }}
          >
            Approve exception
          </button>
        </>
      ) : (
        <p className="mute">Not approved.</p>
      )}
    </div>
  );
}

/** The declaration selfie next to the registration face photo (section 6.2). Loading either is logged. */
function SelfieCompare({ attendanceId, kind, hasSelfie }: { attendanceId: string; kind: string; hasSelfie: boolean }) {
  const [show, setShow] = useState(false);
  const [urls, setUrls] = useState<{ selfie?: string; face?: string }>({});
  const [failed, setFailed] = useState<{ selfie?: boolean; face?: boolean }>({});
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

  if (!show) {
    return (
      <div>
        <button className="btn ghost" onClick={() => setShow(true)}>
          Compare selfie with registration photo
        </button>
        <p className="mute small">Viewing photos is recorded in the audit log.</p>
      </div>
    );
  }
  return (
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
  );
}
