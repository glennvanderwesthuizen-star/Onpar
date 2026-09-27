'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { enrolmentErrors, PHOTO_LABELS, PSIRA_GRADES, REQUIRED_PHOTO_KINDS, PhotoKind } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, Field, useLoad } from '@/components/ui';

const QUALIFICATION_TYPES = [
  { type: 'firearm_competency', label: 'Firearm competency' },
  { type: 'first_aid', label: 'First aid' },
  { type: 'fire_fighting', label: 'Fire fighting' },
  { type: 'other', label: 'Other' },
];

/** Standard issued items (section 6.7). Uniform has sizes; equipment has asset numbers. */
const KIT: { item: string; sized: boolean }[] = [
  { item: 'Shirt', sized: true },
  { item: 'Trousers', sized: true },
  { item: 'Jacket', sized: true },
  { item: 'Boots or shoes', sized: true },
  { item: 'Cap', sized: true },
  { item: 'Belt', sized: true },
  { item: 'Reflective vest', sized: true },
  { item: 'Raincoat', sized: true },
  { item: 'Radio', sized: false },
  { item: 'Torch', sized: false },
  { item: 'Key set', sized: false },
];

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

interface Qualification {
  type: string;
  name: string;
  completionDate: string;
  expiryDate: string;
  file?: File;
}

interface KitRow {
  issued: boolean;
  value: string;
  issueDate: string;
}

type Tab = 'personal' | 'qualifications' | 'photos' | 'kit';

export default function EnrolPage() {
  const sites = useLoad(() => api<{ id: string; name: string; minimum_grade: string; armed: boolean }[]>('/sites'));
  const [tab, setTab] = useState<Tab>('personal');
  const [p, setP] = useState({
    fullName: '',
    idNumber: '',
    cellNumber: '',
    nextOfKinName: '',
    nextOfKinNumber: '',
    psiraNumber: '',
    psiraGrade: '',
    psiraExpiry: '',
    siteId: '',
  });
  const [quals, setQuals] = useState<Qualification[]>([]);
  const [photos, setPhotos] = useState<Partial<Record<PhotoKind, File>>>({});
  const [kit, setKit] = useState<Record<string, KitRow>>(() =>
    Object.fromEntries(KIT.map((k) => [k.item, { issued: false, value: '', issueDate: today() }])),
  );
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [done, setDone] = useState<{ id: string; name: string; employeeNumber: string; pin: string } | null>(null);

  const errors = useMemo(() => {
    const e = enrolmentErrors({ ...p, photoKinds: Object.keys(photos) });
    quals.forEach((q, i) => {
      if (!q.name.trim()) e[`qualifications.${i}.name`] = 'Name the qualification.';
    });
    return { ...e, ...serverErrors };
  }, [p, photos, quals, serverErrors]);
  const shown = tried ? errors : serverErrors;

  const tabHasError: Record<Tab, boolean> = {
    personal: Object.keys(errors).some((k) => k in p),
    qualifications: Object.keys(errors).some((k) => k.startsWith('qualifications')),
    photos: Object.keys(errors).some((k) => k.startsWith('photo')),
    kit: false,
  };

  const setField = (k: keyof typeof p, v: string) => {
    setP((x) => ({ ...x, [k]: v }));
    setServerErrors({});
    setWarnings([]);
  };

  async function submit(acknowledgeWarnings = false) {
    setTried(true);
    if (Object.keys(errors).length) {
      const firstTab = (['personal', 'qualifications', 'photos'] as Tab[]).find((t) => tabHasError[t]);
      if (firstTab) setTab(firstTab);
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set(
      'data',
      JSON.stringify({
        ...p,
        qualifications: quals.map(({ file: _f, ...q }) => q),
        issuedItems: KIT.filter((k) => kit[k.item].issued).map((k) => ({
          item: k.item,
          ...(k.sized ? { size: kit[k.item].value } : { assetNumber: kit[k.item].value }),
          issueDate: kit[k.item].issueDate,
        })),
        acknowledgeWarnings,
      }),
    );
    for (const k of REQUIRED_PHOTO_KINDS) form.set(`photo_${k}`, photos[k]!);
    quals.forEach((q, i) => q.file && form.set(`certificate_${i}`, q.file));
    try {
      const r = await api<{ officer: { id: string; fullName: string; employeeNumber: string }; initialPin: string }>('/officers', {
        method: 'POST',
        body: form,
      });
      setDone({ id: r.officer.id, name: r.officer.fullName, employeeNumber: r.officer.employeeNumber, pin: r.initialPin });
    } catch (e) {
      if (e instanceof ApiError && e.warnings.length) {
        setWarnings(e.warnings);
      } else {
        setError(e);
        if (e instanceof ApiError) {
          setServerErrors(e.errors);
          if (Object.keys(e.errors).some((k) => k in p)) setTab('personal');
        }
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card" style={{ maxWidth: 560 }}>
        <h1>{done.name} is enrolled</h1>
        <p>
          Employee number <b>{done.employeeNumber}</b>
        </p>
        <p>Their first PIN is:</p>
        <p>
          <span className="secret">{done.pin}</span>
        </p>
        <div className="banner warn">
          Write this down and give it to the officer privately. It will not be shown again. If it is lost, a supervisor can
          reset it from the officer&apos;s page.
        </div>
        <div className="row">
          <Link className="btn" href={`/officers/${done.id}`}>
            View officer
          </Link>
          {/* A full page load clears the form. */}
          <a className="btn ghost" href="/officers/new">
            Enrol another
          </a>
        </div>
      </div>
    );
  }

  const site = sites.data?.find((s) => s.id === p.siteId);

  return (
    <>
      <div className="head">
        <div>
          <Link href="/officers" className="mute small">
            ← Officers
          </Link>
          <h1>Enrol an officer</h1>
          <p className="mute">All four tabs are checked before the officer can be enrolled.</p>
        </div>
      </div>
      <ErrorBanner error={error} />
      {warnings.length > 0 && (
        <div className="banner warn" role="alert">
          <b>Please check before enrolling:</b>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="small" style={{ marginTop: 8 }}>
            You can still enrol this officer. The reason will be recorded in the audit log as enrolled despite these warnings.
          </p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => submit(true)}>
              Enrol anyway
            </button>
            <button className="btn ghost" onClick={() => setWarnings([])}>
              Go back and change
            </button>
          </div>
        </div>
      )}

      <div className="tabs" role="tablist">
        {(
          [
            ['personal', 'Personal'],
            ['qualifications', 'Qualifications'],
            ['photos', `Photos (${Object.keys(photos).length} of 4)`],
            ['kit', 'Uniform and kit'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {label}
            {tried && tabHasError[t] && <span className="dot" aria-label="has errors" />}
          </button>
        ))}
      </div>

      {tab === 'personal' && (
        <div className="card">
          <div className="grid g2">
            <Field label="Full name" error={shown.fullName}>
              <input value={p.fullName} onChange={(e) => setField('fullName', e.target.value)} />
            </Field>
            <Field label="SA ID number" error={shown.idNumber} hint="13 digits. Only the last four will be shown after saving.">
              <input inputMode="numeric" value={p.idNumber} onChange={(e) => setField('idNumber', e.target.value)} />
            </Field>
            <Field label="Cell number" error={shown.cellNumber}>
              <input type="tel" value={p.cellNumber} onChange={(e) => setField('cellNumber', e.target.value)} />
            </Field>
            <Field label="Assigned site" error={shown.siteId}>
              <select value={p.siteId} onChange={(e) => setField('siteId', e.target.value)}>
                <option value="">Choose a site…</option>
                {sites.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {site && (
                <div className="mute small">
                  Minimum grade {site.minimum_grade} · {site.armed ? 'Armed site' : 'Unarmed site'}
                </div>
              )}
            </Field>
            <Field label="Next of kin" error={shown.nextOfKinName}>
              <input value={p.nextOfKinName} onChange={(e) => setField('nextOfKinName', e.target.value)} />
            </Field>
            <Field label="Next of kin's number" error={shown.nextOfKinNumber}>
              <input type="tel" value={p.nextOfKinNumber} onChange={(e) => setField('nextOfKinNumber', e.target.value)} />
            </Field>
            <Field label="PSIRA number" error={shown.psiraNumber} hint="Check this against PSIRA's official records by hand.">
              <input value={p.psiraNumber} onChange={(e) => setField('psiraNumber', e.target.value)} />
            </Field>
            <Field label="PSIRA grade" error={shown.psiraGrade}>
              <select value={p.psiraGrade} onChange={(e) => setField('psiraGrade', e.target.value)}>
                <option value="">Choose…</option>
                {PSIRA_GRADES.map((g) => (
                  <option key={g} value={g}>
                    Grade {g}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="PSIRA expiry" error={shown.psiraExpiry}>
              <input type="date" value={p.psiraExpiry} onChange={(e) => setField('psiraExpiry', e.target.value)} />
            </Field>
          </div>
        </div>
      )}

      {tab === 'qualifications' && (
        <div className="card">
          {!quals.length && <p className="mute">No qualifications added. Armed sites need a firearm competency.</p>}
          {quals.map((q, i) => {
            const update = (patch: Partial<Qualification>) => setQuals(quals.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} className="card" style={{ background: 'var(--bg)' }}>
                <div className="grid g3">
                  <Field label="Type">
                    <select
                      value={q.type}
                      onChange={(e) =>
                        update({
                          type: e.target.value,
                          name: q.name || (QUALIFICATION_TYPES.find((t) => t.type === e.target.value)?.label ?? ''),
                        })
                      }
                    >
                      {QUALIFICATION_TYPES.map((t) => (
                        <option key={t.type} value={t.type}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Course or qualification" error={shown[`qualifications.${i}.name`]}>
                    <input value={q.name} onChange={(e) => update({ name: e.target.value })} />
                  </Field>
                  <Field label="Completed">
                    <input type="date" value={q.completionDate} onChange={(e) => update({ completionDate: e.target.value })} />
                  </Field>
                  <Field label="Expires">
                    <input type="date" value={q.expiryDate} onChange={(e) => update({ expiryDate: e.target.value })} />
                  </Field>
                  <Field label="Certificate (PDF or photo)" error={shown[`qualifications.${i}.certificate`]}>
                    <input
                      type="file"
                      accept="application/pdf,image/jpeg,image/png,image/webp"
                      onChange={(e) => update({ file: e.target.files?.[0] })}
                    />
                  </Field>
                </div>
                <button className="btn ghost sm" onClick={() => setQuals(quals.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            );
          })}
          <button
            className="btn ghost"
            onClick={() =>
              setQuals([...quals, { type: 'firearm_competency', name: 'Firearm competency', completionDate: '', expiryDate: '' }])
            }
          >
            + Add qualification
          </button>
        </div>
      )}

      {tab === 'photos' && (
        <div className="card">
          <p className="mute small">
            All four are required. Photos are sensitive personal information: only people who need them can view them, and each
            view is logged.
          </p>
          {shown.photos && <div className="err" style={{ marginBottom: 10 }}>{shown.photos}</div>}
          <div className="grid g2">
            {REQUIRED_PHOTO_KINDS.map((k) => (
              <PhotoPicker
                key={k}
                label={PHOTO_LABELS[k]}
                file={photos[k]}
                error={shown[`photo_${k}`]}
                onChange={(f) => setPhotos((x) => ({ ...x, [k]: f }))}
              />
            ))}
          </div>
        </div>
      )}

      {tab === 'kit' && (
        <div className="card scroll">
          <p className="mute small">Tick each item issued. Sizes let the guard re-order the right size later.</p>
          <table>
            <thead>
              <tr>
                <th>Issued</th>
                <th>Item</th>
                <th>Size or asset number</th>
                <th>Issue date</th>
              </tr>
            </thead>
            <tbody>
              {KIT.map((k) => {
                const row = kit[k.item];
                const update = (patch: Partial<KitRow>) => setKit({ ...kit, [k.item]: { ...row, ...patch } });
                return (
                  <tr key={k.item}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${k.item} issued`}
                        checked={row.issued}
                        onChange={(e) => update({ issued: e.target.checked })}
                      />
                    </td>
                    <td>{k.item}</td>
                    <td>
                      <input
                        disabled={!row.issued}
                        placeholder={k.sized ? 'Size, e.g. L or 9' : 'Asset number'}
                        value={row.value}
                        onChange={(e) => update({ value: e.target.value })}
                      />
                    </td>
                    <td>
                      <input type="date" disabled={!row.issued} value={row.issueDate} onChange={(e) => update({ issueDate: e.target.value })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="row">
        <button className="btn" disabled={busy} onClick={() => submit(false)}>
          {busy ? 'Enrolling…' : 'Enrol officer'}
        </button>
        {tried && Object.keys(errors).length > 0 && <span className="err">Some tabs need attention (marked with a red dot).</span>}
      </div>
    </>
  );
}

function PhotoPicker({ label, file, error, onChange }: { label: string; file?: File; error?: string; onChange: (f: File) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return setUrl(null);
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <div className="photo">
      {url ? <img src={url} alt={label} /> : <div className="empty">No photo yet</div>}
      <Field label={label} error={error}>
        <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => e.target.files?.[0] && onChange(e.target.files[0])} />
      </Field>
    </div>
  );
}
