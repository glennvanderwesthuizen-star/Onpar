'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Check, DEFAULT_POINT_RADIUS_M } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, useLoad } from '@/components/ui';
import { QrCard, useSave } from '@/components/patrols';

interface Setup {
  shifts: { id: string; name: string; kind: string; startTime: string; endTime: string; patrolPoints: number }[];
  types: { id: string; code: string; name: string; singleScan: boolean; active: boolean }[];
  rules: { typeId: string; shiftId: string; perShift: number; minGapMinutes: number; maxDurationMinutes: number; warning: string | null }[];
  points: Point[];
}

interface Point {
  id?: string;
  patrolTypeId: string;
  name: string;
  qrCode?: string;
  lat: number | '';
  lng: number | '';
  radiusM: number;
  instruction: string;
  photoMode: 'off' | 'optional' | 'required';
  noteMode: 'off' | 'optional' | 'required';
  checks: Check[];
  active: boolean;
}

export default function PatrolSetupPage() {
  const { can } = useSession();
  const editable = can('patrols.setup');
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const [siteId, setSiteId] = useState('');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('siteId');
    if (q) setSiteId(q);
  }, []);
  useEffect(() => {
    if (!siteId && sites.data?.length) setSiteId(sites.data[0].id);
  }, [sites.data, siteId]);
  const { data, error, reload } = useLoad(async () => (siteId ? api<Setup>(`/patrols/setup?siteId=${siteId}`) : null), [siteId]);
  const [editing, setEditing] = useState<Point | null>(null);
  const [printing, setPrinting] = useState(false);

  if (printing && data) {
    return (
      <>
        <div className="row no-print" style={{ marginBottom: 12 }}>
          <button className="btn" onClick={() => window.print()}>
            Print
          </button>
          <button className="btn ghost" onClick={() => setPrinting(false)}>
            Back
          </button>
        </div>
        <div className="qr-sheet">
          {data.points
            .filter((p) => p.active)
            .map((p) => {
              const t = data.types.find((x) => x.id === p.patrolTypeId);
              return <QrCard key={p.id} code={p.qrCode!} name={p.name} sub={t ? `${t.name} (${t.code})` : undefined} />;
            })}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="head">
        <div>
          <Link href="/patrols" className="mute small">
            ← Patrols
          </Link>
          <h1>Patrol setup</h1>
          <p className="mute">Patrol types, their rules for each shift, the patrol points and their QR codes.</p>
        </div>
        <div className="row">
          <div style={{ width: 240 }}>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Site">
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          {!!data?.points.length && (
            <button className="btn ghost" onClick={() => setPrinting(true)}>
              Print QR codes
            </button>
          )}
        </div>
      </div>
      <ErrorBanner error={error} />
      {data && (
        <>
          <Allocation data={data} editable={editable} onDone={reload} />
          {data.types.map((t) => (
            <TypeCard key={t.id} type={t} data={data} editable={editable} onDone={reload} onEditPoint={setEditing} />
          ))}
          {editable && <NewType siteId={siteId} onDone={reload} />}
          {editing && (
            <PointForm
              key={editing.id ?? 'new'}
              initial={editing}
              types={data.types}
              onClose={() => setEditing(null)}
              onDone={() => {
                setEditing(null);
                reload();
              }}
            />
          )}
        </>
      )}
    </>
  );
}

function Allocation({ data, editable, onDone }: { data: Setup; editable: boolean; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(data.shifts.map((s) => [s.id, s.patrolPoints])));
  const save = useSave();
  return (
    <div className="card">
      <h2>Patrol points per shift</h2>
      <p className="mute small">
        Each shift&apos;s allocation is shared equally across all its required patrols. Completing every patrol earns the whole allocation; a
        missed patrol earns nothing.
      </p>
      <ErrorBanner error={save.error} />
      <div className="grid g3">
        {data.shifts.map((s) => {
          const required = data.rules.filter((r) => r.shiftId === s.id).reduce((n, r) => n + r.perShift, 0);
          return (
            <Field
              key={s.id}
              label={`${s.name} (${s.startTime}–${s.endTime})`}
              hint={required ? `${required} patrols required: ${(values[s.id] / required || 0).toFixed(2)} each` : 'No patrols set for this shift yet.'}
            >
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="number" min={0} step={0.5} disabled={!editable} value={values[s.id]} onChange={(e) => setValues({ ...values, [s.id]: Number(e.target.value) })} />
                {editable && values[s.id] !== s.patrolPoints && (
                  <button className="btn sm" disabled={save.busy} onClick={() => save.run(() => api('/patrols/allocation', { method: 'PUT', json: { shiftId: s.id, points: values[s.id] } }).then(onDone))}>
                    Save
                  </button>
                )}
              </div>
            </Field>
          );
        })}
      </div>
    </div>
  );
}

function TypeCard({
  type: t,
  data,
  editable,
  onDone,
  onEditPoint,
}: {
  type: Setup['types'][number];
  data: Setup;
  editable: boolean;
  onDone: () => void;
  onEditPoint: (p: Point) => void;
}) {
  const points = data.points.filter((p) => p.patrolTypeId === t.id);
  return (
    <div className="card" style={{ opacity: t.active ? 1 : 0.6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          {t.code} · {t.name} {t.singleScan && <Pill tone="blue">Single scan</Pill>} {!t.active && <Pill tone="grey">Not in use</Pill>}
        </h2>
        {editable && (
          <button
            className="btn ghost sm"
            onClick={() => api(`/patrols/types/${t.id}`, { method: 'PUT', json: { code: t.code, name: t.name, singleScan: t.singleScan, active: !t.active } }).then(onDone)}
          >
            {t.active ? 'Stop using' : 'Use again'}
          </button>
        )}
      </div>
      <h3 style={{ marginTop: 12 }}>Rules per shift</h3>
      <div className="grid g2">
        {data.shifts.map((s) => (
          <RuleEditor key={s.id} typeId={t.id} shift={s} rule={data.rules.find((r) => r.typeId === t.id && r.shiftId === s.id)} editable={editable} onDone={onDone} />
        ))}
      </div>
      <h3 style={{ marginTop: 12 }}>Points ({points.length})</h3>
      {!points.length && <p className="mute small">No points yet. {t.singleScan ? 'A single-scan patrol needs one point.' : 'Add the places the guard must scan.'}</p>}
      <div className="scroll">
        <table>
          <tbody>
            {points.map((p) => (
              <tr key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}>
                <td>
                  <b>{p.name}</b>
                  {p.instruction && <div className="mute small">{p.instruction}</div>}
                </td>
                <td className="small">
                  {p.photoMode !== 'off' && <div>Photo {p.photoMode}</div>}
                  {p.noteMode !== 'off' && <div>Note {p.noteMode}</div>}
                  {p.checks.map((c) => (
                    <div key={c.id}>
                      {c.label}
                      {c.kind === 'number' && c.below != null && ` (flag below ${c.below} ${c.unit})`}
                      {c.kind === 'number' && c.above != null && ` (flag above ${c.above} ${c.unit})`}
                      {c.kind === 'ok_problem' && ' (OK / Problem)'}
                    </div>
                  ))}
                </td>
                <td className="small mute">
                  {Number(p.lat).toFixed(5)}, {Number(p.lng).toFixed(5)} · {p.radiusM} m
                </td>
                <td>
                  {editable && (
                    <button className="btn ghost sm" onClick={() => onEditPoint(p)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <button
          className="btn ghost"
          style={{ marginTop: 8 }}
          onClick={() =>
            onEditPoint({ patrolTypeId: t.id, name: '', lat: '', lng: '', radiusM: DEFAULT_POINT_RADIUS_M, instruction: '', photoMode: 'off', noteMode: 'off', checks: [], active: true })
          }
        >
          + Add point
        </button>
      )}
    </div>
  );
}

function RuleEditor({
  typeId,
  shift,
  rule,
  editable,
  onDone,
}: {
  typeId: string;
  shift: Setup['shifts'][number];
  rule?: Setup['rules'][number];
  editable: boolean;
  onDone: () => void;
}) {
  const [r, setR] = useState({ perShift: rule?.perShift ?? 4, minGapMinutes: rule?.minGapMinutes ?? 60, maxDurationMinutes: rule?.maxDurationMinutes ?? 45 });
  const save = useSave();
  const changed = !rule || r.perShift !== rule.perShift || r.minGapMinutes !== rule.minGapMinutes || r.maxDurationMinutes !== rule.maxDurationMinutes;
  return (
    <div className={`shift ${shift.kind}`} style={{ padding: 10 }}>
      <b>
        {shift.name} ({shift.startTime}–{shift.endTime})
      </b>{' '}
      {!rule && <Pill tone="grey">Not patrolled</Pill>}
      <ErrorBanner error={save.error} />
      <div className="grid g3" style={{ marginTop: 6 }}>
        <Field label="Patrols per shift" error={save.errors.perShift}>
          <input type="number" min={1} disabled={!editable} value={r.perShift} onChange={(e) => setR({ ...r, perShift: Number(e.target.value) })} />
        </Field>
        <Field label="Minimum gap (min)" error={save.errors.minGapMinutes}>
          <input type="number" min={0} disabled={!editable} value={r.minGapMinutes} onChange={(e) => setR({ ...r, minGapMinutes: Number(e.target.value) })} />
        </Field>
        <Field label="Maximum duration (min)" error={save.errors.maxDurationMinutes}>
          <input type="number" min={1} disabled={!editable} value={r.maxDurationMinutes} onChange={(e) => setR({ ...r, maxDurationMinutes: Number(e.target.value) })} />
        </Field>
      </div>
      {rule?.warning && !changed && <div className="banner warn small">{rule.warning}</div>}
      {editable && (
        <div className="row">
          {changed && (
            <button className="btn sm" disabled={save.busy} onClick={() => save.run(() => api(`/patrols/types/${typeId}/rules`, { method: 'PUT', json: { shiftId: shift.id, ...r } }).then(onDone))}>
              {rule ? 'Save rules' : 'Patrol this shift'}
            </button>
          )}
          {rule && (
            <button className="btn ghost sm" onClick={() => save.run(() => api(`/patrols/types/${typeId}/rules/${shift.id}`, { method: 'DELETE' }).then(onDone))}>
              Stop patrolling this shift
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewType({ siteId, onDone }: { siteId: string; onDone: () => void }) {
  const [t, setT] = useState({ code: '', name: '', singleScan: false });
  const save = useSave();
  return (
    <div className="card">
      <h2>Add a patrol type</h2>
      <p className="mute small">For example A Internal patrol, B External perimeter, C Guard room check-in (a single scan).</p>
      <ErrorBanner error={save.error} />
      <div className="grid g3">
        <Field label="Code" error={save.errors.code}>
          <input value={t.code} maxLength={4} onChange={(e) => setT({ ...t, code: e.target.value })} />
        </Field>
        <Field label="Name" error={save.errors.name}>
          <input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
        </Field>
        <Field label="Kind">
          <label className="row" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={t.singleScan} onChange={(e) => setT({ ...t, singleScan: e.target.checked })} /> Single scan (a check-in)
          </label>
        </Field>
      </div>
      <button
        className="btn"
        disabled={save.busy}
        onClick={() =>
          save.run(async () => {
            await api('/patrols/types', { method: 'POST', json: { siteId, ...t } });
            setT({ code: '', name: '', singleScan: false });
            onDone();
          })
        }
      >
        Add patrol type
      </button>
    </div>
  );
}

function PointForm({ initial, types, onClose, onDone }: { initial: Point; types: Setup['types']; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState<Point>(initial);
  const [locating, setLocating] = useState<string | null>(null);
  const save = useSave();
  const set = (patch: Partial<Point>) => setP({ ...p, ...patch });
  const setCheck = (i: number, patch: Partial<Check>) => set({ checks: p.checks.map((c, j) => (j === i ? ({ ...c, ...patch } as Check) : c)) });

  const here = () => {
    if (!navigator.geolocation) return setLocating('This browser cannot give a location. Enter the coordinates instead.');
    setLocating('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        set({ lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) });
        setLocating(`Location set, accurate to about ${Math.round(pos.coords.accuracy)} m.${pos.coords.accuracy > 25 ? ' That is not very accurate; stand in the open and try again.' : ''}`);
      },
      () => setLocating('Could not get your location. Enter the coordinates instead.'),
      { enableHighAccuracy: true, timeout: 20000 },
    );
  };

  return (
    <div className="card" style={{ borderColor: 'var(--green)', borderWidth: 2 }}>
      <h2>{p.id ? `Edit ${initial.name}` : 'New patrol point'}</h2>
      <ErrorBanner error={save.error} />
      <div className="grid g2">
        <Field label="Name" error={save.errors.name}>
          <input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Generator room" />
        </Field>
        <Field label="Patrol">
          <select value={p.patrolTypeId} onChange={(e) => set({ patrolTypeId: e.target.value })}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} · {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid g3">
        <Field label="Latitude" error={save.errors.lat}>
          <input type="number" step="any" value={p.lat} onChange={(e) => set({ lat: e.target.value === '' ? '' : Number(e.target.value) })} />
        </Field>
        <Field label="Longitude" error={save.errors.lng}>
          <input type="number" step="any" value={p.lng} onChange={(e) => set({ lng: e.target.value === '' ? '' : Number(e.target.value) })} />
        </Field>
        <Field label="Radius (metres)" hint="A scan counts within this distance.">
          <input type="number" min={5} max={500} value={p.radiusM} onChange={(e) => set({ radiusM: Number(e.target.value) })} />
        </Field>
      </div>
      <button type="button" className="btn ghost sm" onClick={here}>
        Use my current location (stand at the point)
      </button>
      {locating && <p className="mute small">{locating}</p>}
      <Field label="Special instruction shown when the guard arrives (optional)">
        <input value={p.instruction} onChange={(e) => set({ instruction: e.target.value })} />
      </Field>
      <div className="grid g3">
        <Field label="Photo">
          <select value={p.photoMode} onChange={(e) => set({ photoMode: e.target.value as Point['photoMode'] })}>
            <option value="off">Off</option>
            <option value="optional">Optional</option>
            <option value="required">Required</option>
          </select>
        </Field>
        <Field label="Note">
          <select value={p.noteMode} onChange={(e) => set({ noteMode: e.target.value as Point['noteMode'] })}>
            <option value="off">Off</option>
            <option value="optional">Optional</option>
            <option value="required">Required</option>
          </select>
        </Field>
        <Field label="In use">
          <label className="row" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={p.active} onChange={(e) => set({ active: e.target.checked })} /> Guards must scan this point
          </label>
        </Field>
      </div>

      <h3>Checks at this point</h3>
      <p className="mute small">A reading outside its limit, or Problem, raises an Amber report automatically.</p>
      {p.checks.map((c, i) => (
        <div key={c.id} className="row" style={{ alignItems: 'flex-end', marginBottom: 6 }}>
          <div style={{ width: 150 }}>
            <Field label="Kind">
              <select
                value={c.kind}
                onChange={(e) => {
                  const kind = e.target.value as Check['kind'];
                  set({ checks: p.checks.map((x, j) => (j === i ? (kind === 'number' ? { id: x.id, kind, label: x.label, unit: '', below: null, above: null } : { id: x.id, kind, label: x.label }) : x)) });
                }}
              >
                <option value="number">Number reading</option>
                <option value="ok_problem">OK or Problem</option>
                <option value="photo">Photo</option>
              </select>
            </Field>
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <Field label="What to check">
              <input value={c.label} onChange={(e) => setCheck(i, { label: e.target.value })} placeholder="e.g. Generator fuel" />
            </Field>
          </div>
          {c.kind === 'number' && (
            <>
              <div style={{ width: 90 }}>
                <Field label="Unit">
                  <input value={c.unit} onChange={(e) => setCheck(i, { unit: e.target.value })} placeholder="litres" />
                </Field>
              </div>
              <div style={{ width: 110 }}>
                <Field label="Flag below">
                  <input type="number" value={c.below ?? ''} onChange={(e) => setCheck(i, { below: e.target.value === '' ? null : Number(e.target.value) })} />
                </Field>
              </div>
              <div style={{ width: 110 }}>
                <Field label="Flag above">
                  <input type="number" value={c.above ?? ''} onChange={(e) => setCheck(i, { above: e.target.value === '' ? null : Number(e.target.value) })} />
                </Field>
              </div>
            </>
          )}
          <button type="button" className="btn ghost sm" style={{ marginBottom: 10 }} onClick={() => set({ checks: p.checks.filter((_, j) => j !== i) })}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => set({ checks: [...p.checks, { id: Math.random().toString(36).slice(2, 10), kind: 'number', label: '', unit: '', below: null, above: null }] })}
      >
        + Add a check
      </button>

      <div className="row" style={{ marginTop: 14 }}>
        <button
          className="btn"
          disabled={save.busy || p.lat === '' || p.lng === ''}
          onClick={() =>
            save.run(async () => {
              const body = { ...p, qrCode: undefined, id: undefined };
              await api(p.id ? `/patrols/points/${p.id}` : '/patrols/points', { method: p.id ? 'PUT' : 'POST', json: body });
              onDone();
            })
          }
        >
          {p.id ? 'Save point' : 'Add point'}
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
      {p.qrCode && (
        <div style={{ marginTop: 12 }}>
          <QrCard code={p.qrCode} name={p.name} />
        </div>
      )}
    </div>
  );
}
