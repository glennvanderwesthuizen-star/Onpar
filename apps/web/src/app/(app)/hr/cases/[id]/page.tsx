'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { HearingRecord, hearingRecordErrors, noticeErrors, outcomeNotice } from '@onpar/rules';
import { api } from '@/lib/api';
import { AuthPhoto } from '@/components/AuthPhoto';
import { ErrorBanner, Field, Pill, formatDateTime, useLoad } from '@/components/ui';

interface Notice {
  id: string;
  typeLabel: string;
  subject: string;
  issuedAt: string;
  status: string;
  statusLabel: string;
}
interface Case {
  id: string;
  status: 'notice_sent' | 'published' | 'withdrawn';
  employee: string;
  employeeNumber: string;
  companyName: string;
  charge: string;
  hearingDate: string;
  hearingTime: string;
  venue: string;
  chairperson: string;
  initiator: string;
  witnesses: string[];
  hearing: HearingRecord;
  warnings: { id: string; label: string; date: string; charge: string }[];
  notice: Notice | null;
  outcome: Notice | null;
  events: { id: string; kind: string; at: string; actor_label: string; note: string }[];
  files: { id: string; title: string; contentType: string; uploadedAt: string; uploadedBy: string }[];
  findings: Record<string, string>;
  sanctions: Record<string, string>;
}

const EVENT: Record<string, string> = { opened: 'Opened', notice_sent: 'Notice to appear sent', form_saved: 'Inquiry form saved', file_added: 'Document uploaded', published: 'Decision published', withdrawn: 'Withdrawn' };

/** One disciplinary inquiry: the notice, the inquiry form, the documents, and the decision. */
export default function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, reload } = useLoad(() => api<Case>(`/hr/cases/${id}`), [id]);
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <p className="mute">Loading…</p>;
  const open = data.status === 'notice_sent';
  return (
    <>
      <p>
        <Link href="/hr">← HR</Link>
      </p>
      <h1>
        Disciplinary inquiry: {data.employee}{' '}
        {open ? <Pill tone="amber">Waiting for the inquiry</Pill> : data.status === 'published' ? <Pill tone="green">Decision published</Pill> : <Pill tone="grey">Withdrawn</Pill>}
      </h1>
      <div className="card">
        <p>
          <b>Charge:</b> {data.charge}
        </p>
        <p>
          <b>Inquiry:</b> {data.hearingDate} at {data.hearingTime}, {data.venue}
          {data.chairperson && `, chaired by ${data.chairperson}`}
          {data.initiator && `; brought by ${data.initiator}`}
        </p>
        {!!data.witnesses.length && (
          <p>
            <b>Company witnesses:</b> {data.witnesses.join(', ')}
          </p>
        )}
        <b>Warnings on file</b>
        <ol className="small">
          {data.warnings.map((w) => (
            <li key={w.id}>
              {w.label}, {w.date}: {w.charge}
            </li>
          ))}
        </ol>
        {data.notice && (
          <p className="small">
            Notice to appear: <Pill tone={data.notice.status === 'acknowledged' ? 'green' : 'blue'}>{data.notice.statusLabel}</Pill>{' '}
            <Link href={`/hr?notice=${data.notice.id}`}>Open it</Link>
          </p>
        )}
        {data.outcome && (
          <p className="small">
            Outcome: <Pill tone={data.outcome.status === 'acknowledged' ? 'green' : 'blue'}>{data.outcome.statusLabel}</Pill> <Link href={`/hr?notice=${data.outcome.id}`}>Open it</Link>
          </p>
        )}
      </div>
      <HearingForm c={data} open={open} saved={reload} />
      <Files c={data} changed={reload} />
      {open && <Decision c={data} done={reload} />}
      <div className="card">
        <h2>What has happened</h2>
        {data.events.map((e) => (
          <div key={e.id} className="small">
            <b>{formatDateTime(e.at)}</b> · {EVENT[e.kind] ?? e.kind} · {e.actor_label}
            {e.note && <span className="mute"> · {e.note}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

function HearingForm({ c, open, saved }: { c: Case; open: boolean; saved: () => void }) {
  const [h, setH] = useState<HearingRecord>({ heldOn: c.hearingDate, chairperson: c.chairperson, initiator: c.initiator, ...c.hearing });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => setH({ heldOn: c.hearingDate, chairperson: c.chairperson, initiator: c.initiator, ...c.hearing }), [c]);
  const set = (k: keyof HearingRecord, v: string | boolean) => setH((x) => ({ ...x, [k]: v }));
  const missing = hearingRecordErrors(h);
  const t = (k: keyof HearingRecord, label: string, rows = 3) => (
    <Field label={label}>
      <textarea rows={rows} disabled={!open} value={(h[k] as string) ?? ''} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  return (
    <div className="card">
      <h2>The disciplinary inquiry form</h2>
      <p className="mute small">Fill it in during or after the inquiry. Save as you go. It is fixed once the decision is published. Upload the signed copy below.</p>
      <ErrorBanner error={err} />
      {msg && <div className="banner ok">{msg}</div>}
      <div className="grid g4">
        <Field label="Held on" error={missing?.heldOn}>
          <input type="date" disabled={!open} value={h.heldOn ?? ''} onChange={(e) => set('heldOn', e.target.value)} />
        </Field>
        <Field label="Chairperson" error={missing?.chairperson}>
          <input disabled={!open} value={h.chairperson ?? ''} onChange={(e) => set('chairperson', e.target.value)} />
        </Field>
        <Field label="Initiator">
          <input disabled={!open} value={h.initiator ?? ''} onChange={(e) => set('initiator', e.target.value)} />
        </Field>
        <Field label="Employee present">
          <select disabled={!open} value={h.employeePresent === undefined ? '' : h.employeePresent ? 'yes' : 'no'} onChange={(e) => set('employeePresent', e.target.value === 'yes')}>
            <option value="">—</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
        <Field label="Representative">
          <input disabled={!open} value={h.representative ?? ''} onChange={(e) => set('representative', e.target.value)} />
        </Field>
        <Field label="Interpreter">
          <input disabled={!open} value={h.interpreter ?? ''} onChange={(e) => set('interpreter', e.target.value)} />
        </Field>
        <Field label="Plea">
          <select disabled={!open} value={h.plea ?? ''} onChange={(e) => set('plea', e.target.value)}>
            <option value="">—</option>
            <option value="guilty">Guilty</option>
            <option value="not_guilty">Not guilty</option>
          </select>
        </Field>
      </div>
      {t('witnesses', 'Witnesses heard, and what they said', 3)}
      {t('companyCase', "The company's case", 4)}
      {t('employeeCase', "The employee's case", 4)}
      <div className="grid g2">
        {t('mitigating', 'Mitigating factors', 2)}
        {t('aggravating', 'Aggravating factors', 2)}
      </div>
      <div className="grid g2">
        <Field label="Finding" error={missing?.finding}>
          <select disabled={!open} value={h.finding ?? ''} onChange={(e) => set('finding', e.target.value)}>
            <option value="">Choose…</option>
            {Object.entries(c.findings).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sanction" error={h.finding === 'guilty' ? missing?.sanction : undefined}>
          <select disabled={!open || h.finding !== 'guilty'} value={h.sanction ?? ''} onChange={(e) => set('sanction', e.target.value)}>
            <option value="">Choose…</option>
            {Object.entries(c.sanctions).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Reasons for the finding" error={missing?.reasons}>
        <textarea rows={4} disabled={!open} value={h.reasons ?? ''} onChange={(e) => set('reasons', e.target.value)} />
      </Field>
      <Field label="About the sanction (needed for Other)" error={missing?.sanctionNote}>
        <input disabled={!open} value={h.sanctionNote ?? ''} onChange={(e) => set('sanctionNote', e.target.value)} />
      </Field>
      {open && (
        <button
          className="btn ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            setMsg(null);
            try {
              await api(`/hr/cases/${c.id}/hearing`, { method: 'PUT', json: h });
              setMsg('Saved.');
              saved();
            } catch (e) {
              setErr(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save the form
        </button>
      )}
    </div>
  );
}

function Files({ c, changed }: { c: Case; changed: () => void }) {
  const [title, setTitle] = useState('Signed inquiry form');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="card">
      <h2>Documents</h2>
      {!c.files.length && <p className="mute">None uploaded yet.</p>}
      {c.files.map((f) => (
        <div key={f.id} className="small" style={{ marginBottom: 6 }}>
          <b>{f.title}</b> · {f.uploadedBy}, {formatDateTime(f.uploadedAt)}{' '}
          {f.contentType === 'application/pdf' ? (
            <a href={`/api/hr/cases/${c.id}/files/${f.id}`} target="_blank" rel="noreferrer">
              Open the PDF
            </a>
          ) : (
            <AuthPhoto path={`/hr/cases/${c.id}/files/${f.id}`} alt={f.title} width={240} />
          )}
        </div>
      ))}
      <ErrorBanner error={err} />
      <div className="row">
        <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ maxWidth: 260 }} />
        <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ maxWidth: 260 }} />
        <button
          className="btn ghost"
          disabled={busy || !file || title.trim().length < 2}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const form = new FormData();
              form.append('title', title);
              form.append('file', file!);
              await api(`/hr/cases/${c.id}/files`, { method: 'POST', body: form });
              setFile(null);
              changed();
            } catch (e) {
              setErr(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Upload
        </button>
      </div>
    </div>
  );
}

/** The decision: the outcome notice, filled from the form, edited by HR, then published to the employee. */
function Decision({ c, done }: { c: Case; done: () => void }) {
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  const filled = outcomeNotice({ companyName: c.companyName, employeeName: c.employee, employeeNumber: c.employeeNumber, date: today, charge: c.charge, issuedBy: 'HR' }, c.hearing);
  const [subject, setSubject] = useState(filled.subject);
  const [body, setBody] = useState(filled.body);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    setSubject(filled.subject);
    setBody(filled.body);
  }, [c.hearing]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = hearingRecordErrors(c.hearing);
  const problems = noticeErrors('hearing_outcome', subject, body, { outcome: c.hearing.reasons });
  const run = async (path: string, json: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      await api(path, { method: 'POST', json });
      done();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>The decision</h2>
      <ErrorBanner error={err} />
      {missing ? (
        <p className="mute">Save the inquiry form with the date, chairperson, finding and reasons{c.hearing.finding === 'guilty' ? ' and the sanction' : ''} first.</p>
      ) : (
        <>
          <Field label="Subject" error={problems?.subject}>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="The outcome notice (fill in or remove every part in [square brackets])" error={problems?.body}>
            <textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <p className="mute small">Publishing sends the outcome to the employee and closes the case for good.</p>
          <button className="btn" disabled={busy || !!problems} onClick={() => run(`/hr/cases/${c.id}/publish`, { subject, body })}>
            Publish the decision
          </button>
        </>
      )}
      <details style={{ marginTop: 14 }}>
        <summary>Withdraw the inquiry</summary>
        <Field label="Why">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <button className="btn ghost" disabled={busy || reason.trim().length < 5} onClick={() => run(`/hr/cases/${c.id}/withdraw`, { reason })}>
          Withdraw
        </button>
      </details>
    </div>
  );
}
