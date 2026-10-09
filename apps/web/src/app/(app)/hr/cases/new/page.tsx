'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { hearingDateError, inquiryDocuments, noticeErrors, noticeTemplate } from '@onpar/rules';
import { api } from '@/lib/api';
import { ErrorBanner, Field, useLoad } from '@/components/ui';

interface Draft {
  companyName: string;
  employeeName: string;
  employeeNumber: string;
  issuedBy: string;
  today: string;
  hearingMinDays: number;
  warnings: { id: string; label: string; date: string; charge: string }[];
}

export default function NewCasePage() {
  return (
    <Suspense fallback={<p className="mute">Loading…</p>}>
      <NewCase />
    </Suspense>
  );
}

/**
 * "Proceed to disciplinary action" (owner, 9 Oct 2026; D-53): the inquiry is set at least three
 * days ahead (by default), the three rights documents fill themselves in, and the notice to
 * appear lists everything. HR checks it all before it is sent.
 */
function NewCase() {
  const router = useRouter();
  const employeeId = useSearchParams().get('employee') ?? '';
  const { data, error } = useLoad(() => api<Draft>(`/hr/case-draft/${employeeId}`), [employeeId]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [charge, setCharge] = useState('');
  const [hearingDate, setHearingDate] = useState('');
  const [hearingTime, setHearingTime] = useState('10:00');
  const [venue, setVenue] = useState('');
  const [chairperson, setChairperson] = useState('');
  const [initiator, setInitiator] = useState('');
  const [witness, setWitness] = useState('');
  const [witnesses, setWitnesses] = useState<string[]>([]);
  const [representative, setRepresentative] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    if (data && picked === null) {
      setPicked(data.warnings.map((w) => w.id));
      setCharge(`Repeated misconduct after ${data.warnings.length} warnings: ${data.warnings.map((w) => w.charge).join('; ')}`);
    }
  }, [data, picked]);

  const warnings = (data?.warnings ?? []).filter((w) => picked?.includes(w.id));
  const docs = useMemo(
    () => (data ? inquiryDocuments({ companyName: data.companyName, employeeName: data.employeeName, employeeNumber: data.employeeNumber, date: data.today, charge, hearingDate: hearingDate || '[date]', hearingTime, venue: venue || '[venue]', chairperson }) : []),
    [data, charge, hearingDate, hearingTime, venue, chairperson],
  );
  const details = { charge, hearingDate, hearingTime, venue, chairperson, witnesses, representative, warnings: warnings.map(({ label, date, charge: c }) => ({ label, date, charge: c })), attachments: docs.map((d) => d.title) };
  const filled = data ? noticeTemplate('notice_to_appear', { companyName: data.companyName, employeeName: data.employeeName, employeeNumber: data.employeeNumber, siteName: null, date: data.today, issuedBy: data.issuedBy, prior: 0, details }) : null;
  useEffect(() => {
    if (filled && !edited) {
      setSubject(filled.subject);
      setBody(filled.body);
    }
  }, [filled?.subject, filled?.body, edited]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorBanner error={error} />;
  if (!data) return <p className="mute">Loading…</p>;
  const dateProblem = hearingDateError(hearingDate || undefined, data.today, data.hearingMinDays);
  const problems = noticeErrors('notice_to_appear', subject, body, details);
  const earliest = new Date(Date.parse(`${data.today}T12:00:00Z`) + data.hearingMinDays * 86_400_000).toISOString().slice(0, 10);

  async function send() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string }>('/hr/cases', {
        method: 'POST',
        json: { employeeId, charge, warningIds: picked, hearingDate, hearingTime, venue, chairperson, initiator, witnesses, representative, subject, body },
      });
      router.push(`/hr/cases/${r.id}`);
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        <Link href="/hr">← HR</Link>
      </p>
      <h1>Disciplinary inquiry: {data.employeeName}</h1>
      <div className="banner warn">Every document here is a draft for your labour lawyer. Check the bargaining council&apos;s rules before real use. On Par records the process; people decide.</div>
      <ErrorBanner error={err} />
      <div className="card">
        <h2>1. The warnings on file</h2>
        {data.warnings.map((w) => (
          <label key={w.id} className="row small" style={{ gap: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!picked?.includes(w.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...(x ?? []), w.id] : (x ?? []).filter((y) => y !== w.id)))} />
            {w.label}, {w.date}: {w.charge}
          </label>
        ))}
        <Field label="The charge" error={problems?.charge}>
          <textarea rows={2} value={charge} onChange={(e) => setCharge(e.target.value)} />
        </Field>
      </div>
      <div className="card">
        <h2>2. The inquiry</h2>
        <div className="grid g4">
          <Field label={`Date (from ${earliest})`} error={hearingDate ? (dateProblem ?? undefined) : undefined}>
            <input type="date" min={earliest} value={hearingDate} onChange={(e) => setHearingDate(e.target.value)} />
          </Field>
          <Field label="Time">
            <input type="time" value={hearingTime} onChange={(e) => setHearingTime(e.target.value)} />
          </Field>
          <Field label="Venue" error={problems?.venue}>
            <input value={venue} onChange={(e) => setVenue(e.target.value)} />
          </Field>
          <Field label="Chairperson">
            <input value={chairperson} onChange={(e) => setChairperson(e.target.value)} />
          </Field>
        </div>
        <div className="grid g2">
          <Field label="Who brings the charge (initiator)">
            <input value={initiator} onChange={(e) => setInitiator(e.target.value)} />
          </Field>
          <Field label="The employee's representative (if known)">
            <input value={representative} onChange={(e) => setRepresentative(e.target.value)} />
          </Field>
        </div>
        <Field label="Witnesses the company will call">
          <div className="row">
            <input value={witness} onChange={(e) => setWitness(e.target.value)} placeholder="Name" />
            <button
              type="button"
              className="btn ghost sm"
              disabled={!witness.trim()}
              onClick={() => {
                setWitnesses((x) => [...x, witness.trim()]);
                setWitness('');
              }}
            >
              Add
            </button>
          </div>
          {witnesses.map((x, i) => (
            <div key={i} className="small">
              {x}{' '}
              <button type="button" className="btn ghost sm" onClick={() => setWitnesses((y) => y.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
        </Field>
      </div>
      <div className="card">
        <h2>3. The documents that go with it</h2>
        {docs.map((d) => (
          <details key={d.title} style={{ marginBottom: 6 }}>
            <summary>{d.title}</summary>
            <div style={{ whiteSpace: 'pre-wrap', padding: 8 }}>{d.body}</div>
          </details>
        ))}
      </div>
      <div className="card">
        <h2>4. The notice to appear</h2>
        <Field label="Subject" error={problems?.subject}>
          <input
            value={subject}
            onChange={(e) => {
              setEdited(true);
              setSubject(e.target.value);
            }}
          />
        </Field>
        <Field label="The notice (edit freely)" error={problems?.body}>
          <textarea
            rows={18}
            value={body}
            onChange={(e) => {
              setEdited(true);
              setBody(e.target.value);
            }}
          />
        </Field>
        {edited && (
          <button type="button" className="btn ghost sm" onClick={() => setEdited(false)}>
            Start again from the template
          </button>
        )}
        <p className="mute small">The notice and the three documents go to the employee (MY MESSAGES on the post phone). If he does not acknowledge in time, you are asked to deliver them by hand.</p>
        <button className="btn" disabled={busy || !!dateProblem || !!problems || !picked} onClick={send}>
          {busy ? 'Sending…' : 'Send the notice to appear'}
        </button>
      </div>
    </>
  );
}
