'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { NOTICE_TYPE_LABELS, NOTICE_TYPES, NoticeDetails, NoticeType, noticeErrors, noticeTemplate } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AuthPhoto } from '@/components/AuthPhoto';
import { ErrorBanner, Field, Pill, formatDateTime, useLoad } from '@/components/ui';

interface Employee {
  id: string;
  name: string;
  employeeNumber: string;
  site: string | null;
  login: string | null;
  portalActive: boolean;
}
interface NoticeRow {
  id: string;
  employeeId: string;
  employee: string;
  employeeNumber: string;
  site: string | null;
  typeLabel: string;
  subject: string;
  issuedAt: string;
  issuedBy: string;
  ackDueAt: string;
  status: 'sent' | 'delivered' | 'opened' | 'acknowledged' | 'hand_delivery_requested' | 'hand_delivered';
  statusLabel: string;
  times: Record<string, string | null>;
}
interface NoticeFull extends NoticeRow {
  body: string;
  events: { id: string; kind: string; at: string; actor_label: string; note: string; hasPhoto: boolean }[];
}
interface Suggestion {
  employeeId: string;
  name: string;
  site: string | null;
  pattern: string;
  suggest: NoticeType;
  charge: string;
}
interface Context {
  companyName: string;
  employeeName: string;
  employeeNumber: string;
  siteName: string | null;
  issuedBy: string;
  prior: Record<NoticeType, number>;
  evidence: { id: string; label: string; points: number; date: string }[];
  ackHours: number;
}

const TONE: Record<NoticeRow['status'], 'green' | 'amber' | 'red' | 'blue' | 'grey'> = {
  sent: 'grey',
  delivered: 'blue',
  opened: 'blue',
  acknowledged: 'green',
  hand_delivery_requested: 'red',
  hand_delivered: 'green',
};
const today = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);

export default function HrPage() {
  return (
    <Suspense fallback={<p className="mute">Loading…</p>}>
      <Hr />
    </Suspense>
  );
}

/**
 * HR notices (brief sections 6.16 and 28). On Par supports the process and keeps the proof; it
 * never decides, and never sends a warning by itself.
 */
function Hr() {
  const { can } = useSession();
  const params = useSearchParams();
  const mayIssue = can('notices.issue');
  const employees = useLoad(() => api<Employee[]>('/hr/employees'));
  const notices = useLoad(() => api<NoticeRow[]>('/hr/notices'));
  const suggestions = useLoad(() => (mayIssue ? api<Suggestion[]>('/hr/suggestions') : Promise.resolve([])), [mayIssue]);
  const [open, setOpen] = useState<string | null>(params.get('notice'));
  const [draft, setDraft] = useState<{ employeeId: string; type: NoticeType; charge: string } | null>(null);
  const reload = () => {
    notices.reload();
    employees.reload();
    suggestions.reload();
  };

  return (
    <>
      <h1>HR notices</h1>
      <div className="banner warn">
        Every template is a draft. A labour lawyer must approve the wording, the warning ladder, validity periods and the process before real use, and an app notice alone may not be valid notice.
        On Par never sends a warning by itself.
      </div>
      <ErrorBanner error={notices.error ?? employees.error} />
      {mayIssue && !!suggestions.data?.length && (
        <div className="card">
          <h2>Patterns you may want to look at</h2>
          <p className="mute small">A suggestion only fills in the form. Nothing is sent unless you send it.</p>
          {suggestions.data.map((s) => (
            <div key={`${s.employeeId}${s.pattern}`} className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line)', padding: '8px 0' }}>
              <span>
                <b>{s.name}</b>
                {s.site && <span className="mute"> · {s.site}</span>}: {s.pattern}
              </span>
              <button className="btn ghost sm" onClick={() => setDraft({ employeeId: s.employeeId, type: s.suggest, charge: s.charge })}>
                Prepare a {NOTICE_TYPE_LABELS[s.suggest].toLowerCase()}
              </button>
            </div>
          ))}
        </div>
      )}
      {mayIssue && employees.data && (
        <NewNotice
          key={draft ? `${draft.employeeId}${draft.type}` : 'blank'}
          employees={employees.data}
          start={draft}
          done={(id) => {
            setDraft(null);
            setOpen(id);
            reload();
          }}
        />
      )}
      {open && <NoticeView id={open} mayIssue={mayIssue} close={() => setOpen(null)} changed={reload} />}
      <div className="card scroll">
        <h2>Notices sent</h2>
        {notices.data && !notices.data.length && <p className="mute">None yet.</p>}
        {!!notices.data?.length && (
          <table>
            <thead>
              <tr>
                <th>Sent</th>
                <th>Employee</th>
                <th>Notice</th>
                <th>Where it stands</th>
              </tr>
            </thead>
            <tbody>
              {notices.data.map((n) => (
                <tr key={n.id} onClick={() => setOpen(n.id)} style={{ cursor: 'pointer' }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(n.issuedAt)}</td>
                  <td>
                    {n.employee}
                    <div className="mute small">
                      {n.employeeNumber}
                      {n.site ? ` · ${n.site}` : ''}
                    </div>
                  </td>
                  <td>
                    {n.subject}
                    <div className="mute small">{n.typeLabel}</div>
                  </td>
                  <td>
                    <Pill tone={TONE[n.status]}>{n.statusLabel}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {employees.data && mayIssue && <PortalAccess employees={employees.data} changed={employees.reload} />}
      {mayIssue && <Settings />}
    </>
  );
}

function NewNotice({ employees, start, done }: { employees: Employee[]; start: { employeeId: string; type: NoticeType; charge: string } | null; done: (id: string) => void }) {
  const [open, setOpen] = useState(!!start);
  const [employeeId, setEmployeeId] = useState(start?.employeeId ?? '');
  const [type, setType] = useState<NoticeType>(start?.type ?? 'written_warning');
  const [d, setD] = useState<NoticeDetails>({ charge: start?.charge ?? '' });
  const [witness, setWitness] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [edited, setEdited] = useState(false);
  const [evidence, setEvidence] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const ctx = useLoad(() => (employeeId ? api<Context>(`/hr/notice-context/${employeeId}`) : Promise.resolve(null)), [employeeId]);
  const filled = useMemo(
    () => (ctx.data ? noticeTemplate(type, { ...ctx.data, date: today(), prior: ctx.data.prior[type] ?? 0, details: d }) : null),
    [ctx.data, type, d],
  );
  // Until HR edits the text by hand, it follows the template.
  useEffect(() => {
    if (filled && !edited) {
      setSubject(filled.subject);
      setBody(filled.body);
    }
  }, [filled, edited]);
  const problems = noticeErrors(type, subject, body, d);
  const set = (k: keyof NoticeDetails, v: string) => setD((x) => ({ ...x, [k]: v }));

  if (!open)
    return (
      <button className="btn" style={{ marginBottom: 12 }} onClick={() => setOpen(true)}>
        New notice
      </button>
    );

  async function send() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string }>('/hr/notices', { method: 'POST', json: { employeeId, type, subject, body, details: d, evidence } });
      setOpen(false);
      done(r.id);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const hearing = type === 'notice_to_appear';
  return (
    <div className="card">
      <h2>New notice</h2>
      <ErrorBanner error={err ?? ctx.error} />
      <div className="grid g2">
        <Field label="Employee">
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.employeeNumber}){e.site ? `, ${e.site}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind of notice">
          <select value={type} onChange={(e) => setType(e.target.value as NoticeType)}>
            {NOTICE_TYPES.map((t) => (
              <option key={t} value={t}>
                {NOTICE_TYPE_LABELS[t]}
                {ctx.data?.prior[t] ? ` (${ctx.data.prior[t]} on file)` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {employeeId && ctx.data && (
        <>
          <div className="grid g2">
            <Field label={type === 'general_message' ? 'Subject' : 'What it is about (the charge)'} error={problems?.charge}>
              <input value={d.charge ?? ''} onChange={(e) => set('charge', e.target.value)} />
            </Field>
            {type !== 'general_message' && (
              <Field label="When it happened">
                <input type="date" value={d.incidentDate ?? ''} max={today()} onChange={(e) => set('incidentDate', e.target.value)} />
              </Field>
            )}
          </div>
          {hearing && (
            <>
              <div className="grid g4">
                <Field label="Inquiry date" error={problems?.hearingDate}>
                  <input type="date" value={d.hearingDate ?? ''} min={today()} onChange={(e) => set('hearingDate', e.target.value)} />
                </Field>
                <Field label="Time" error={problems?.hearingTime}>
                  <input type="time" value={d.hearingTime ?? ''} onChange={(e) => set('hearingTime', e.target.value)} />
                </Field>
                <Field label="Venue" error={problems?.venue}>
                  <input value={d.venue ?? ''} onChange={(e) => set('venue', e.target.value)} />
                </Field>
                <Field label="Chairperson">
                  <input value={d.chairperson ?? ''} onChange={(e) => set('chairperson', e.target.value)} />
                </Field>
              </div>
              <Field label="Witnesses">
                <div className="row">
                  <input value={witness} onChange={(e) => setWitness(e.target.value)} placeholder="Name of a witness" />
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!witness.trim()}
                    onClick={() => {
                      setD((x) => ({ ...x, witnesses: [...(x.witnesses ?? []), witness.trim()] }));
                      setWitness('');
                    }}
                  >
                    Add
                  </button>
                </div>
                {(d.witnesses ?? []).map((w, i) => (
                  <div key={i} className="small">
                    {w}{' '}
                    <button type="button" className="btn ghost sm" onClick={() => setD((x) => ({ ...x, witnesses: (x.witnesses ?? []).filter((_, j) => j !== i) }))}>
                      Remove
                    </button>
                  </div>
                ))}
              </Field>
              <Field label="The employee's representative (if known)">
                <input value={d.representative ?? ''} onChange={(e) => set('representative', e.target.value)} />
              </Field>
            </>
          )}
          {type === 'hearing_outcome' && (
            <div className="grid g2">
              <Field label="Finding, with reasons" error={problems?.outcome}>
                <textarea rows={3} value={d.outcome ?? ''} onChange={(e) => set('outcome', e.target.value)} />
              </Field>
              <Field label="Sanction">
                <input value={d.sanction ?? ''} onChange={(e) => set('sanction', e.target.value)} />
              </Field>
            </div>
          )}
          {!!ctx.data.evidence.length && type !== 'general_message' && (
            <Field label="Cite performance events as evidence (optional)">
              {ctx.data.evidence.map((ev) => (
                <label key={ev.id} className="row small" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={evidence.includes(ev.id)}
                    onChange={(e) => setEvidence((x) => (e.target.checked ? [...x, ev.id] : x.filter((y) => y !== ev.id)))}
                  />
                  {ev.date} · {ev.label} ({ev.points})
                </label>
              ))}
            </Field>
          )}
          <Field label="Subject" error={problems?.subject}>
            <input
              value={subject}
              onChange={(e) => {
                setEdited(true);
                setSubject(e.target.value);
              }}
            />
          </Field>
          <Field label="The notice (edit freely; fill in or remove every part in [square brackets])" error={problems?.body}>
            <textarea
              rows={14}
              value={body}
              onChange={(e) => {
                setEdited(true);
                setBody(e.target.value);
              }}
              style={{ fontFamily: 'inherit' }}
            />
          </Field>
          {edited && (
            <button type="button" className="btn ghost sm" onClick={() => setEdited(false)}>
              Start again from the template
            </button>
          )}
          <p className="mute small">
            The guard reads it under MY MESSAGES on the post phone when he is signed in with his own PIN (or on his own page, if he has one). If it is not acknowledged within {ctx.data.ackHours} hours, you are asked to
            deliver it by hand. It cannot be changed once sent.
          </p>
          <div className="row">
            <button className="btn" disabled={busy || !!problems} onClick={send}>
              {busy ? 'Sending…' : 'Send the notice'}
            </button>
            <button className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function NoticeView({ id, mayIssue, close, changed }: { id: string; mayIssue: boolean; close: () => void; changed: () => void }) {
  const { data, error, reload } = useLoad(() => api<NoticeFull>(`/hr/notices/${id}`), [id]);
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function hand(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append('note', note);
      if (photo) form.append('photo', photo);
      await api(`/hr/notices/${id}/hand-delivered`, { method: 'POST', body: form });
      setNote('');
      setPhoto(null);
      reload();
      changed();
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <div className="row no-print" style={{ justifyContent: 'space-between' }}>
        <h2>{data?.subject ?? 'Notice'}</h2>
        <div className="row">
          <button className="btn ghost sm" onClick={() => window.print()}>
            Print for hand delivery
          </button>
          <button className="btn ghost sm" onClick={close}>
            Close
          </button>
        </div>
      </div>
      <ErrorBanner error={error ?? err} />
      {data && (
        <>
          <p>
            <Pill tone={TONE[data.status]}>{data.statusLabel}</Pill> <span className="mute small">To {data.employee} · sent {formatDateTime(data.issuedAt)} by {data.issuedBy}</span>
          </p>
          <div style={{ whiteSpace: 'pre-wrap', border: '1px solid var(--line)', borderRadius: 8, padding: 12, lineHeight: 1.5 }}>{data.body}</div>
          <div className="only-print" style={{ marginTop: 40 }}>
            Received by: ______________________ Signature: ______________________ Date: ____________
            <p className="small">Signing shows that I received this notice. It does not mean I agree with it or admit anything.</p>
          </div>
          <h3 className="no-print">What has happened</h3>
          <div className="no-print">
            {data.events.map((e) => (
              <div key={e.id} className="small" style={{ marginTop: 4 }}>
                <b>{formatDateTime(e.at)}</b> · {e.kind.replace(/_/g, ' ')} {e.actor_label && `· ${e.actor_label}`} {e.note && <span className="mute">· {e.note}</span>}
                {e.hasPhoto && <AuthPhoto path={`/hr/notices/${id}/events/${e.id}/photo`} alt="Signed copy" width={200} />}
              </div>
            ))}
          </div>
          {mayIssue && data.status !== 'acknowledged' && (
            <form className="no-print" onSubmit={hand} style={{ marginTop: 12 }}>
              <h3>Delivered by hand</h3>
              <Field label="Who delivered it, where, and whether the employee signed">
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <Field label="Photo of the signed copy">
                <input type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
              </Field>
              <button className="btn" disabled={busy || note.trim().length < 3}>
                Record hand delivery
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

/** A one-time code for an employee to open "My messages" on his own phone. */
function PortalAccess({ employees, changed }: { employees: Employee[]; changed: () => void }) {
  const [employeeId, setEmployeeId] = useState('');
  const [made, setMade] = useState<{ login: string; code: string; expiresAt: string; employee: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const chosen = employees.find((e) => e.id === employeeId);
  return (
    <div className="card">
      <h2>My messages: the employee&apos;s own page</h2>
      <p className="mute small">
        Notices go to the employee&apos;s own page, opened on his own phone at <b>{typeof window !== 'undefined' ? window.location.origin : ''}/p</b>. Give him a one-time code to open it (there is no SMS yet). A new code
        replaces his password.
      </p>
      <ErrorBanner error={err} />
      <div className="row">
        <select value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); setMade(null); }} style={{ maxWidth: 360 }}>
          <option value="">Choose an employee…</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.employeeNumber}) {e.portalActive ? '· page open' : e.login ? '· code given' : ''}
            </option>
          ))}
        </select>
        <button
          className="btn ghost"
          disabled={!employeeId}
          onClick={async () => {
            setErr(null);
            try {
              setMade(await api(`/hr/employees/${employeeId}/portal-code`, { method: 'POST' }));
              changed();
            } catch (e) {
              setErr(e);
            }
          }}
        >
          {chosen?.login ? 'Give a new code' : 'Give a code'}
        </button>
      </div>
      {made && (
        <div className="banner ok" style={{ marginTop: 10 }}>
          For {made.employee}: sign-in name <b>{made.login}</b>, one-time code <b style={{ fontSize: 20, letterSpacing: 2 }}>{made.code}</b>. Valid until {formatDateTime(made.expiresAt)}. It is
          shown only now: write it down or print it and hand it to him.
        </div>
      )}
    </div>
  );
}

function Settings() {
  const { data, reload } = useLoad(() => api<{ noticeAckHours: number; noticesOnPostPhone: boolean }>('/hr/settings'));
  const [hours, setHours] = useState('');
  const [onPhone, setOnPhone] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  if (!data) return null;
  const phone = onPhone ?? data.noticesOnPostPhone;
  const changed = !!hours || phone !== data.noticesOnPostPhone;
  return (
    <div className="card">
      <h2>Settings</h2>
      <ErrorBanner error={err} />
      <label className="row" style={{ gap: 6, marginBottom: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={phone} onChange={(e) => setOnPhone(e.target.checked)} />
        <span>
          <b>Guards read their notices on the post phone</b>
          <span className="mute small">
            {' '}
            (MY MESSAGES, for the guard signed in with his own PIN and holding the phone; with two guards on one phone, only the one holding it sees his). Off: the post phone shows only
            &quot;You have a personal message&quot;.
          </span>
        </span>
      </label>
      <div className="row">
        <Field label={`Hours to acknowledge before hand delivery (now ${data.noticeAckHours})`}>
          <input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value.replace(/\D/g, ''))} placeholder={String(data.noticeAckHours)} />
        </Field>
        <Field label="Why the change">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <button
          className="btn ghost"
          disabled={!changed || reason.trim().length < 3}
          onClick={async () => {
            setErr(null);
            try {
              await api('/hr/settings', { method: 'PUT', json: { noticeAckHours: Number(hours || data.noticeAckHours), noticesOnPostPhone: phone, reason } });
              setHours('');
              setOnPhone(null);
              setReason('');
              reload();
            } catch (e) {
              setErr(e);
            }
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
