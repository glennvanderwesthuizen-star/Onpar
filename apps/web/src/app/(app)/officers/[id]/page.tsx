'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { PHOTO_LABELS, REQUIRED_PHOTO_KINDS, PhotoKind } from '@onpar/rules';
import { api, imageUrl } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, StatusPill, formatDate, useLoad } from '@/components/ui';

interface Officer {
  id: string;
  employeeNumber: string;
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
  qualifications: { id: string; name: string; completionDate: string | null; expiryDate: string | null; status: string; hasCertificate: boolean }[];
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
              {o.qualifications.map((q) => (
                <tr key={q.id}>
                  <td>{q.name}</td>
                  <td>{formatDate(q.completionDate)}</td>
                  <td>{formatDate(q.expiryDate)}</td>
                  <td>
                    <StatusPill status={q.status} />
                  </td>
                  <td>{q.hasCertificate ? 'Uploaded' : <span className="mute">None</span>}</td>
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
