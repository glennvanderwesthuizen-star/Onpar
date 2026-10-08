'use client';

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_EQUIPMENT_TYPES, DEFAULT_PAYROLL_START_DAY, PROVINCES, PSIRA_GRADES_IN_USE, REQUIREMENT_DAYS, siteErrors, guardsNeededPerDay } from '@onpar/rules';
import { ApiError } from '@/lib/api';
import { ErrorBanner, Field } from './ui';

export interface Shift {
  id?: string;
  name: string;
  kind: 'day' | 'night';
  startTime: string;
  endTime: string;
  guardsRequired: number;
  /** Mon … Sun, then public holiday; null means the same every day (D-20). */
  guardsByDay?: number[] | null;
  equipment: Record<string, number>;
}

export interface Contact {
  name: string;
  phone: string;
}

export interface SiteValue {
  name: string;
  address: string;
  client: string;
  province: string | null;
  minimumGrade: string;
  armed: boolean;
  payrollStartDay: number;
  shifts: Shift[];
  contacts: { supervisor?: Contact; site_manager?: Contact; control_room?: Contact; police_station?: Contact; fire?: Contact; ambulance?: Contact; armed_response?: Contact };
}

export const EMPTY_SITE: SiteValue = {
  name: '',
  address: '',
  client: '',
  province: null,
  minimumGrade: 'E',
  armed: false,
  payrollStartDay: DEFAULT_PAYROLL_START_DAY,
  shifts: [
    { name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1, equipment: {} },
    { name: 'Night', kind: 'night', startTime: '18:00', endTime: '06:00', guardsRequired: 1, equipment: {} },
  ],
  contacts: {},
};

const CONTACTS: { key: keyof SiteValue['contacts']; label: string }[] = [
  { key: 'supervisor', label: 'Supervisor' },
  { key: 'site_manager', label: 'Site manager' },
  { key: 'control_room', label: 'Control room' },
];

/** The emergency panel on the post phone (owner, 7 Oct 2026). */
const EMERGENCY: { key: keyof SiteValue['contacts']; label: string; nameLabel: string; empty: string }[] = [
  { key: 'police_station', label: 'Local police station', nameLabel: 'Station name', empty: 'The phone always offers 10111 as well.' },
  { key: 'fire', label: 'Fire brigade', nameLabel: 'Name', empty: 'Left empty, the phone offers 10177.' },
  { key: 'ambulance', label: 'Ambulance', nameLabel: 'Name of the service', empty: 'Left empty, the phone offers 10177.' },
  { key: 'armed_response', label: 'Armed response', nameLabel: 'Company name', empty: 'Left empty, the phone shows no armed response button.' },
];

function ShiftCard({
  shift,
  index,
  errors,
  onChange,
  onRemove,
}: {
  shift: Shift;
  index: number;
  errors: Record<string, string>;
  onChange: (s: Shift) => void;
  onRemove?: () => void;
}) {
  const e = (f: string) => errors[`shifts.${index}.${f}`];
  const set = (patch: Partial<Shift>) => onChange({ ...shift, ...patch });
  const equipmentTotal = Object.values(shift.equipment).reduce((a, b) => a + b, 0);
  return (
    <div className={`shift ${shift.kind}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="badge">{shift.kind === 'day' ? 'DAY SHIFT' : 'NIGHT SHIFT'}</span>
        {onRemove && (
          <button type="button" className="btn ghost sm" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <div className="grid g2">
        <Field label="Shift name" error={e('name')}>
          <input value={shift.name} onChange={(ev) => set({ name: ev.target.value })} />
        </Field>
        <Field label="Type" error={e('kind')}>
          <select value={shift.kind} onChange={(ev) => set({ kind: ev.target.value as Shift['kind'] })}>
            <option value="day">Day</option>
            <option value="night">Night</option>
          </select>
        </Field>
        <Field label="Starts" error={e('startTime')}>
          <input type="time" value={shift.startTime} onChange={(ev) => set({ startTime: ev.target.value })} />
        </Field>
        <Field label="Ends" error={e('endTime')}>
          <input type="time" value={shift.endTime} onChange={(ev) => set({ endTime: ev.target.value })} />
        </Field>
      </div>
      <div className="guards">
        {shift.guardsByDay ? (
          <>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
              Guards needed on this shift, day by day
            </div>
            <div className="byday">
              {REQUIREMENT_DAYS.map((label, d) => {
                const n = shift.guardsByDay![d];
                const setDay = (v: number) => {
                  const guardsByDay = shift.guardsByDay!.map((x, j) => (j === d ? Math.max(0, v) : x));
                  set({ guardsByDay, guardsRequired: Math.max(1, ...guardsByDay) });
                };
                return (
                  <div key={label} className={d === 7 ? 'hol' : ''}>
                    <span>{label === 'Public holiday' ? 'Holiday' : label}</span>
                    <button type="button" aria-label={`One fewer guard on ${label}`} disabled={n <= 0} onClick={() => setDay(n - 1)}>
                      −
                    </button>
                    <b aria-live="polite">{n}</b>
                    <button type="button" aria-label={`One more guard on ${label}`} onClick={() => setDay(n + 1)}>
                      +
                    </button>
                  </div>
                );
              })}
            </div>
            {e('guardsByDay') && <div className="err">{e('guardsByDay')}</div>}
          </>
        ) : (
          <>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
              Guards needed on this shift, every day
            </div>
            <div className="stepper">
              <button
                type="button"
                aria-label="One fewer guard"
                disabled={shift.guardsRequired <= 1}
                onClick={() => set({ guardsRequired: Math.max(1, shift.guardsRequired - 1) })}
              >
                −
              </button>
              <b aria-live="polite">{shift.guardsRequired}</b>
              <button type="button" aria-label="One more guard" onClick={() => set({ guardsRequired: shift.guardsRequired + 1 })}>
                +
              </button>
            </div>
          </>
        )}
        <label className="row small" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={!!shift.guardsByDay}
            onChange={(ev) =>
              set(
                ev.target.checked
                  ? { guardsByDay: REQUIREMENT_DAYS.map(() => shift.guardsRequired) }
                  : { guardsByDay: null, guardsRequired: Math.max(1, ...(shift.guardsByDay ?? [1])) },
              )
            }
          />
          A different number on some days (weekends, public holidays)
        </label>
      </div>
      <details className="eq">
        <summary>Equipment for this shift{equipmentTotal ? ` (${equipmentTotal} items)` : ''}</summary>
        <div className="grid g3">
          {DEFAULT_EQUIPMENT_TYPES.map((item) => (
            <Field key={item} label={item} error={e(`equipment.${item}`)}>
              <input
                type="number"
                min={0}
                inputMode="numeric"
                value={shift.equipment[item] ?? 0}
                onChange={(ev) => {
                  const n = Math.max(0, Math.floor(Number(ev.target.value) || 0));
                  const equipment = { ...shift.equipment, [item]: n };
                  if (!n) delete equipment[item];
                  set({ equipment });
                }}
              />
            </Field>
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * Creates or edits a site. In edit mode (`autosave`) changes are saved as they
 * are made, with no separate save step (brief section 30).
 */
export function SiteForm({
  initial,
  onSave,
  autosave = false,
}: {
  initial: SiteValue;
  /** May return the saved site, so new shifts pick up their permanent IDs. */
  onSave: (v: SiteValue) => Promise<SiteValue | void>;
  autosave?: boolean;
}) {
  const [site, setSite] = useState<SiteValue>(initial);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [state, setState] = useState<'idle' | 'dirty' | 'saving' | 'saved'>('idle');
  const [showErrors, setShowErrors] = useState(autosave);
  const first = useRef(true);
  const skipNext = useRef(false);

  const localErrors = siteErrors(site);
  const errors = showErrors ? { ...localErrors, ...serverErrors } : serverErrors;
  const set = (patch: Partial<SiteValue>) => {
    setSite((s) => ({ ...s, ...patch }));
    setServerErrors({});
  };

  async function save(v: SiteValue) {
    setState('saving');
    setError(null);
    try {
      const saved = await onSave(v);
      if (saved && v.shifts.some((sh) => !sh.id)) {
        // Match by object identity, so shifts added or edited while saving are left alone.
        skipNext.current = true;
        setSite((cur) => ({
          ...cur,
          shifts: cur.shifts.map((sh) => {
            const j = v.shifts.indexOf(sh);
            return !sh.id && j >= 0 && saved.shifts[j]?.id ? { ...sh, id: saved.shifts[j].id } : sh;
          }),
        }));
      }
      setState('saved');
    } catch (e) {
      setError(e);
      if (e instanceof ApiError) setServerErrors(e.errors);
      setState('dirty');
    }
  }

  useEffect(() => {
    if (!autosave) return;
    if (first.current || skipNext.current) {
      first.current = false;
      skipNext.current = false;
      return;
    }
    setState('dirty');
    if (Object.keys(siteErrors(site)).length) return;
    const t = setTimeout(() => save(site), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, autosave]);

  const hasErrors = Object.keys(localErrors).length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setShowErrors(true);
        if (!hasErrors) save(site);
      }}
    >
      {autosave && (
        <div className="mute small" style={{ marginBottom: 10 }} aria-live="polite">
          {state === 'saving'
            ? 'Saving…'
            : state === 'saved'
              ? 'All changes saved.'
              : state === 'dirty'
                ? hasErrors
                  ? 'Fix the highlighted fields to save.'
                  : 'Saving shortly…'
                : 'Changes save automatically.'}
        </div>
      )}
      <ErrorBanner error={error} />
      <div className="card">
        <h2>Site details</h2>
        <div className="grid g2">
          <Field label="Site name" error={errors.name}>
            <input value={site.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Client" error={errors.client}>
            <input value={site.client} onChange={(e) => set({ client: e.target.value })} />
          </Field>
          <Field label="Address or area" error={errors.address}>
            <input value={site.address} onChange={(e) => set({ address: e.target.value })} />
          </Field>
          <Field label="Province" error={errors.province} hint="Starts the TSF numbers of guards enrolled here, e.g. BCD 123 GP.">
            <select value={site.province ?? ''} onChange={(e) => set({ province: e.target.value || null })}>
              <option value="">Choose…</option>
              {PROVINCES.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name} ({p.code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Minimum PSIRA grade" error={errors.minimumGrade}>
            <select value={site.minimumGrade} onChange={(e) => set({ minimumGrade: e.target.value })}>
              {[...(PSIRA_GRADES_IN_USE as readonly string[]).includes(site.minimumGrade) ? [] : [site.minimumGrade], ...PSIRA_GRADES_IN_USE].map((g) => (
                <option key={g} value={g}>
                  Grade {g}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Payroll month starts on day"
            error={errors.payrollStartDay}
            hint={`The payroll month runs from day ${site.payrollStartDay} to the day before, next month.`}
          >
            <input
              type="number"
              min={1}
              max={28}
              value={site.payrollStartDay}
              onChange={(e) => set({ payrollStartDay: Number(e.target.value) })}
            />
          </Field>
          <Field label="Armed site" hint="Armed sites require firearm competency for every officer.">
            <label className="row" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={site.armed} onChange={(e) => set({ armed: e.target.checked })} /> This site is
              armed
            </label>
          </Field>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Shifts</h2>
          <span className="mute small">{site.shifts.some((x) => x.guardsByDay) ? 'Up to ' : ''}
            {guardsNeededPerDay(site.shifts)} guards needed per day in total
          </span>
        </div>
        {errors.shifts && <div className="err">{errors.shifts}</div>}
        <div className="grid g2">
          {site.shifts.map((s, i) => (
            <ShiftCard
              key={s.id ?? `new-${i}`}
              shift={s}
              index={i}
              errors={errors}
              onChange={(ns) => set({ shifts: site.shifts.map((x, j) => (j === i ? ns : x)) })}
              onRemove={site.shifts.length > 1 ? () => set({ shifts: site.shifts.filter((_, j) => j !== i) }) : undefined}
            />
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn ghost"
            onClick={() =>
              set({
                shifts: [...site.shifts, { name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1, equipment: {} }],
              })
            }
          >
            + Add day shift
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() =>
              set({
                shifts: [
                  ...site.shifts,
                  { name: 'Night', kind: 'night', startTime: '18:00', endTime: '06:00', guardsRequired: 1, equipment: {} },
                ],
              })
            }
          >
            + Add night shift
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Approved contacts</h2>
        <p className="mute small">These are the only numbers a guard can call from the post device at this site.</p>
        <div className="grid g3">
          {CONTACTS.map(({ key, label }) => {
            const c = site.contacts[key] ?? { name: '', phone: '' };
            const update = (patch: Partial<Contact>) => set({ contacts: { ...site.contacts, [key]: { ...c, ...patch } } });
            return (
              <div key={key}>
                <h3>{label}</h3>
                <Field label="Name">
                  <input value={c.name} onChange={(e) => update({ name: e.target.value })} />
                </Field>
                <Field label="Phone number">
                  <input type="tel" value={c.phone} onChange={(e) => update({ phone: e.target.value })} />
                </Field>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h2>Emergency numbers</h2>
        <p className="mute small">
          After PANIC, and on the Call screen, the guard sees Police, Fire brigade, Ambulance and Armed response. The phone never dials these by itself: the guard taps the one he needs,
          and each call is recorded.
        </p>
        <div className="grid g2">
          {EMERGENCY.map(({ key, label, nameLabel, empty }) => {
            const c = site.contacts[key] ?? { name: '', phone: '' };
            const update = (patch: Partial<Contact>) => set({ contacts: { ...site.contacts, [key]: { ...c, ...patch } } });
            return (
              <div key={key}>
                <h3>{label}</h3>
                <Field label={nameLabel}>
                  <input value={c.name} onChange={(e) => update({ name: e.target.value })} />
                </Field>
                <Field label="Phone number">
                  <input type="tel" value={c.phone} onChange={(e) => update({ phone: e.target.value })} />
                </Field>
                <p className="mute small">{empty}</p>
              </div>
            );
          })}
        </div>
      </div>

      {!autosave && (
        <div className="row">
          <button className="btn" disabled={state === 'saving'}>
            {state === 'saving' ? 'Creating…' : 'Create site'}
          </button>
          {showErrors && hasErrors && <span className="err">Please fix the highlighted fields.</span>}
        </div>
      )}
    </form>
  );
}
