'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { PHOTO_LABELS, REQUIRED_PHOTO_KINDS, PhotoKind } from '@onpar/rules';
import { api, imageUrl, openFile } from '@/lib/api';
import { QUALIFICATION_TYPES, PSIRA_GRADES } from '@onpar/rules';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, StatusPill, formatDate, useLoad } from '@/components/ui';
import { TsfPlate } from '@/components/TsfPlate';
import { BadgeActions } from '@/components/BadgeActions';

interface Officer {
  id: string;
  employeeNumber: string;
  tsfNumber: string | null;
  siteProvince: string | null;
  badges: { issuedAt: string; cancelledAt: string | null; cancelReason: string | null }[];
  fullName: string;
  idNumberMasked: string;
  dateOfBirth: string;
  cellNumber: string;
  nextOfKinName: string;
  nextOfKinNumber: string;
  psiraNumber: string;
  psiraGrade: string;
  psiraExpiry: string;
  psiraStatus: string;
  status: string;
  locked: boolean;
  siteId: string;
  siteName: string;
  photos: PhotoKind[];
  siteWarnings: string[];
  qualifications: { id: string; type: string; name: string; completionDate: string | null; expiryDate: string | null; status: string; hasCertificate: boolean; current: boolean }[];
  issuedItems: { id: string; item: string; size: string | null; assetNumber: string | null; issueDate: string }[];
}

export default function OfficerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data: o, error, reload } = useLoad(() => api<Officer>(`/officers/${id}`), [id]);
  const [showPhotos, setShowPhotos] = useState(false);

  if (error) return <ErrorBanner error={error} />;
  if (!o) return <p className="mute">Loading…</p>;

  return (
    <>
      <div className="head">
        <div>
          <Link href="/officers" className="mute small">
            ← Officers
          </Link>
          <h1>{o.fullName}</h1>
          <p className="mute">
            Employee #{o.employeeNumber} · <Link href={`/sites/${o.siteId}`}>{o.siteName}</Link>
          </p>
        </div>
        <div className="row">{o.locked ? <Pill tone="red">Locked out (PIN)</Pill> : <Pill tone="green">Active</Pill>}</div>
      </div>

      <div className="card row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <div className="small mute" style={{ marginBottom: 6 }}>
            TSF number: typed at the post phone if the guard has no card
          </div>
          <TsfPlate number={o.tsfNumber} size="md" />
          {!o.tsfNumber && (
            <div className="small" style={{ marginTop: 6 }}>
              {o.siteProvince ? 'Issued shortly.' : 'Set the province on the site to issue a TSF number.'}
            </div>
          )}
        </div>
        {can('officers.enrol') && <BadgeActions officer={o} onDone={reload} />}
      </div>
      {o.siteWarnings.length > 0 && (
        <div className="banner warn">
          <b>Site check</b>
          <ul>
            {o.siteWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid g2">
        <div className="card">
          <h2>Personal</h2>
          <Detail label="SA ID number" value={o.idNumberMasked} />
          <Detail label="Date of birth" value={formatDate(o.dateOfBirth)} />
          <Detail label="Cell number" value={o.cellNumber} />
          <Detail label="Next of kin" value={`${o.nextOfKinName}, ${o.nextOfKinNumber}`} />
        </div>
        <div className="card">
          <h2>PSIRA</h2>
          <Detail label="Number" value={o.psiraNumber} />
          <Detail label="Grade" value={`Grade ${o.psiraGrade}`} />
          <Detail label="Expiry" value={<>{formatDate(o.psiraExpiry)} <StatusPill status={o.psiraStatus} /></>} />
          {can('training.record') && <UpdatePsira officer={o} onDone={reload} />}
        </div>
      </div>

      <div className="card scroll">
        <h2>Qualifications</h2>
        {!o.qualifications.length ? (
          <p className="mute">None on file.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Qualification</th>
                <th>Completed</th>
                <th>Expires</th>
                <th>Status</th>
                <th>Certificate</th>
              </tr>
            </thead>
            <tbody>
              {[...o.qualifications]
                .sort((a, b) => Number(b.current) - Number(a.current) || (b.expiryDate ?? '9999').localeCompare(a.expiryDate ?? '9999'))
                .map((q) => (
                  <tr key={q.id} style={{ opacity: q.current ? 1 : 0.55 }}>
                    <td>
                      {q.name}
                      {!q.current && <div className="mute small">Earlier record, replaced by a renewal</div>}
                    </td>
                    <td>{formatDate(q.completionDate)}</td>
                    <td>{formatDate(q.expiryDate)}</td>
                    <td>{q.current ? <StatusPill status={q.status} /> : <span className="mute small">History</span>}</td>
                    <td>
                      {q.hasCertificate ? (
                        <button className="btn ghost sm" onClick={() => openFile(`/qualifications/${q.id}/certificate`)}>
                          Open
                        </button>
                      ) : (
                        <span className="mute">None</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card scroll">
        <h2>Uniform and kit issued</h2>
        {!o.issuedItems.length ? (
          <p className="mute">Nothing recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Size or asset</th>
                <th>Issued</th>
              </tr>
            </thead>
            <tbody>
              {o.issuedItems.map((i) => (
                <tr key={i.id}>
                  <td>{i.item}</td>
                  <td>{i.size ?? i.assetNumber ?? '—'}</td>
                  <td>{formatDate(i.issueDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {can('training.record') && <RecordQualification officerId={o.id} onDone={reload} />}

      {can('kit.issue') && <IssueKit officerId={o.id} onDone={reload} />}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Registration photos</h2>
          {!showPhotos && (
            <button className="btn ghost sm" onClick={() => setShowPhotos(true)}>
              Show photos
            </button>
          )}
        </div>
        <p className="mute small">Viewing photos is recorded in the audit log.</p>
        {showPhotos && (
          <div className="grid g2">
            {REQUIRED_PHOTO_KINDS.map((k) => (
              <Photo key={k} officerId={o.id} kind={k} present={o.photos.includes(k)} />
            ))}
          </div>
        )}
      </div>

      {can('officers.unlock') && <ResetPin officerId={o.id} locked={o.locked} onDone={reload} />}
    </>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="mute small">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function Photo({ officerId, kind, present }: { officerId: string; kind: PhotoKind; present: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!present) return;
    let u: string | null = null;
    imageUrl(`/officers/${officerId}/photos/${kind}`)
      .then((x) => setUrl((u = x)))
      .catch(() => setFailed(true));
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [officerId, kind, present]);
  return (
    <div className="photo">
      {url ? <img src={url} alt={PHOTO_LABELS[kind]} /> : <div className="empty">{failed || !present ? 'Not available' : 'Loading…'}</div>}
      <div className="small" style={{ marginTop: 6 }}>
        {PHOTO_LABELS[kind]}
      </div>
    </div>
  );
}

function ResetPin({ officerId, locked, onDone }: { officerId: string; locked: boolean; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pin, setPin] = useState<string | null>(null);
  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ newPin: string }>(`/officers/${officerId}/reset-pin`, { method: 'POST', json: { reason } });
      setPin(r.newPin);
      setReason('');
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <h2>{locked ? 'Unlock and reset PIN' : 'Reset PIN'}</h2>
      {pin ? (
        <>
          <p>The new PIN is:</p>
          <p>
            <span className="secret">{pin}</span>
          </p>
          <div className="banner warn">Give it to the officer privately. It will not be shown again.</div>
        </>
      ) : (
        <>
          <p className="mute small">
            {locked
              ? 'This officer entered a wrong PIN five times. Confirm who they are in person before resetting.'
              : 'Use this if the officer has forgotten their PIN.'}
          </p>
          <ErrorBanner error={error} />
          <Field label="Reason (recorded in the audit log)">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Identity confirmed in person at Gate 2" />
          </Field>
          <button className="btn" disabled={busy || reason.trim().length < 3} onClick={reset}>
            {busy ? 'Resetting…' : 'Reset PIN'}
          </button>
        </>
      )}
    </div>
  );
}

function IssueKit({ officerId, onDone }: { officerId: string; onDone: () => void }) {
  const catalogue = useLoad(() => api<{ name: string; tracking: 'size' | 'asset'; active: boolean }[]>('/kit/catalogue'));
  const [f, setF] = useState({ item: '', value: '', issueDate: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const tracking = catalogue.data?.find((k) => k.name === f.item)?.tracking ?? 'size';
  return (
    <div className="card">
      <h2>Issue kit</h2>
      <p className="mute small">Issuing an item again (for example a replacement) updates its size or asset number and issue date.</p>
      <ErrorBanner error={error} />
      <div className="grid g3">
        <Field label="Item">
          <select value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })}>
            <option value="">Choose…</option>
            {catalogue.data
              ?.filter((k) => k.active)
              .map((k) => (
                <option key={k.name} value={k.name}>
                  {k.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label={tracking === 'size' ? 'Size' : 'Asset number'}>
          <input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        </Field>
        <Field label="Issue date">
          <input type="date" value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} />
        </Field>
      </div>
      <button
        className="btn"
        disabled={busy || !f.item}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(`/officers/${officerId}/issued-items`, {
              method: 'POST',
              json: { item: f.item, issueDate: f.issueDate, ...(tracking === 'size' ? { size: f.value } : { assetNumber: f.value }) },
            });
            setF({ ...f, item: '', value: '' });
            onDone();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Issue
      </button>
    </div>
  );
}

function RecordQualification({ officerId, onDone }: { officerId: string; onDone: () => void }) {
  const [f, setF] = useState({ type: 'first_aid', name: '', completionDate: '', expiryDate: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  return (
    <div className="card">
      <h2>Record a qualification or renewal</h2>
      <p className="mute small">A renewal is recorded as a new entry; the earlier one is kept as history. Completed training earns the officer a point.</p>
      {ok && <div className="banner ok">Recorded.</div>}
      <ErrorBanner error={error} />
      <div className="grid g3">
        <Field label="Type">
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, name: f.name || QUALIFICATION_TYPES[e.target.value as keyof typeof QUALIFICATION_TYPES] })}>
            {Object.entries(QUALIFICATION_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Course or qualification">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. First aid level 1" />
        </Field>
        <Field label="Completed">
          <input type="date" value={f.completionDate} onChange={(e) => setF({ ...f, completionDate: e.target.value })} />
        </Field>
        <Field label="Expires">
          <input type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
        </Field>
        <Field label="Certificate (PDF or photo)">
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
      </div>
      <button
        className="btn"
        disabled={busy || f.name.trim().length < 2}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setOk(false);
          const form = new FormData();
          form.set('data', JSON.stringify({ type: f.type, name: f.name, completionDate: f.completionDate || null, expiryDate: f.expiryDate || null }));
          if (file) form.set('certificate', file);
          try {
            await api(`/officers/${officerId}/qualifications`, { method: 'POST', body: form });
            setF({ type: 'first_aid', name: '', completionDate: '', expiryDate: '' });
            setFile(null);
            setOk(true);
            onDone();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Record
      </button>
    </div>
  );
}

function UpdatePsira({ officer, onDone }: { officer: Officer; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ psiraNumber: officer.psiraNumber, psiraGrade: officer.psiraGrade, psiraExpiry: officer.psiraExpiry, reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!open) {
    return (
      <button className="btn ghost sm" onClick={() => setOpen(true)}>
        Update PSIRA details
      </button>
    );
  }
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <ErrorBanner error={error} />
      <Field label="PSIRA number">
        <input value={f.psiraNumber} onChange={(e) => setF({ ...f, psiraNumber: e.target.value })} />
      </Field>
      <div className="grid g2">
        <Field label="Grade">
          <select value={f.psiraGrade} onChange={(e) => setF({ ...f, psiraGrade: e.target.value })}>
            {PSIRA_GRADES.map((g) => (
              <option key={g} value={g}>
                Grade {g}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Expiry">
          <input type="date" value={f.psiraExpiry} onChange={(e) => setF({ ...f, psiraExpiry: e.target.value })} />
        </Field>
      </div>
      <Field label="What changed" hint="Check it against PSIRA's official records first.">
        <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Renewed, checked on the PSIRA website" />
      </Field>
      <div className="row">
        <button
          className="btn sm"
          disabled={busy || f.reason.trim().length < 3}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api(`/officers/${officer.id}/psira`, { method: 'PUT', json: f });
              setOpen(false);
              onDone();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </button>
        <button className="btn ghost sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
