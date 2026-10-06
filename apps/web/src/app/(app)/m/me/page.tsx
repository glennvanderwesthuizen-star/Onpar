'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, formatDate } from '@/components/ui';
import { useSession } from '@/lib/session';
import { clock } from '@/lib/supervisor';

/**
 * Supervisor app, Me (decision D-42): a supervisor is also an employee. His own shift, Duty On
 * and Duty From from his own phone (his PIN, then the declaration and a selfie; no location is
 * taken and he does not wait for a relief), his roster, score, training and uniform. Everything
 * here uses the same server rules as a guard's post phone.
 */

interface Wording {
  version: number;
  statements: string[];
}
interface RosterDay {
  date: string;
  status: string;
  siteName: string | null;
  shiftName: string | null;
  startTime: string | null;
  endTime: string | null;
}
interface State {
  employee: { id: string; name: string; employeeNumber: string; tsfNumber: string | null };
  attendance: null | { siteName: string; shiftName: string | null; scheduledStart: string | null; scheduledEnd: string | null; dutyOnAt: string; arrivalStatus: string; lateMinutes: number };
  pendingDeclaration: null | { kind: 'duty_on' | 'duty_from'; dutyEventId: string; wording: Wording };
  roster: { rostered: boolean; today: RosterDay; comingUp: RosterDay[] };
}
interface Score {
  score: number;
  positionLabel: string;
  position: string;
  events: { id: string; date: string; label: string; impact: number; evidence: string }[];
}
interface Qualification {
  name: string;
  expiryDate: string | null;
  status: 'COMPLIANT' | 'EXPIRING' | 'EXPIRED';
}
interface KitItem {
  itemId: string;
  label: string;
  sizes: string[];
  entitled: number;
  lastIssued: string | null;
  lastSize: string | null;
  nextDue: string | null;
  due: boolean;
}
interface Order {
  id: string;
  number: number;
  status: string;
  statusLabel: string;
  lines: { label: string; size: string; quantity: number; decision: string | null; decisionNote: string }[];
  guardCents: number;
  canReceive: boolean;
  agreeStatement: string | null;
}

const KIND = { duty_on: 'Duty On', duty_from: 'Duty From' } as const;
const stamp = () => {
  const now = new Date().toISOString();
  return { trustedAt: now, deviceClock: now };
};

function PinField({ value, onChange, label = 'Your PIN' }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label className="f">
      <span>{label}</span>
      <input type="password" inputMode="numeric" autoComplete="off" pattern="\d{4,6}" maxLength={6} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} required />
    </label>
  );
}

export default function MobileMe() {
  const { me } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!me.selfService) router.replace('/m');
  }, [me.selfService, router]);

  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () =>
    api<State>('/device/me')
      .then((s) => (setState(s), setError(null)))
      .catch(setError);
  useEffect(() => {
    if (me.selfService && me.employeeId) load();
  }, [me.selfService, me.employeeId]);

  if (!me.selfService) return null;
  if (!me.employeeId) {
    return (
      <>
        <h1 className="m-h1">Me</h1>
        <div className="card">
          <p>
            <b>Your sign-in is not joined to your officer record yet.</b>
          </p>
          <p>Ask an administrator to open the Users page, edit your sign-in, and choose your name under “Their own officer record”. Then sign out and in again.</p>
          <p className="mute small">Once joined, you can log your own Duty On and Duty From here, and see your shifts, score, training and uniform.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="m-h1">Me</h1>
      {!state && <ErrorBanner error={error} />}
      {!state && !error && <p className="mute">Loading…</p>}
      {state && (
        <>
          <p className="mute small" style={{ marginTop: -8 }}>
            {state.employee.name} · {state.employee.tsfNumber ?? state.employee.employeeNumber}
          </p>
          <Shift state={state} reload={load} />
          <Roster roster={state.roster} />
          <MyScore />
          <MyTraining />
          <MyUniform />
        </>
      )}
    </>
  );
}

/** Today's shift and the one thing to do next: Duty On, the declaration, or Duty From. */
function Shift({ state, reload }: { state: State; reload: () => Promise<unknown> }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [asking, setAsking] = useState(false);
  const today = state.roster.today;
  const a = state.attendance;
  const next: 'duty_on' | 'duty_from' = a ? 'duty_from' : 'duty_on';

  async function log(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/device/duty', { method: 'POST', wrongPinIs401: true, json: { eventId: crypto.randomUUID(), kind: next, pin, ...stamp() } });
      setPin('');
      setAsking(false);
      await reload();
    } catch (err) {
      setError(err);
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`card${a ? ' m-onduty' : ''}`}>
      <div className="m-alert-head">
        <h2 style={{ margin: 0 }}>My shift</h2>
        {a ? <span className="pill green">On duty</span> : <span className="pill grey">Not on duty</span>}
      </div>
      {a ? (
        <p>
          On duty at <b>{a.siteName}</b> since {clock(a.dutyOnAt)}
          {a.arrivalStatus === 'LATE' ? ` (${a.lateMinutes} min late)` : ''}.{a.scheduledEnd ? ` Your shift ends at ${clock(a.scheduledEnd)}.` : ''}
        </p>
      ) : today.status === 'working' ? (
        <p>
          Today: <b>{today.siteName}</b>, {today.shiftName} shift, {today.startTime?.slice(0, 5)} to {today.endTime?.slice(0, 5)}.
        </p>
      ) : (
        <p className="mute">{state.roster.rostered ? 'You are off today on the roster.' : 'You are not on the roster yet. Duty On is logged at your home site.'}</p>
      )}

      {state.pendingDeclaration ? (
        <Declaration owed={state.pendingDeclaration} onDone={reload} />
      ) : !asking ? (
        <button className={`btn m-wide${next === 'duty_from' ? ' ghost' : ''}`} onClick={() => (setAsking(true), setError(null))}>
          {KIND[next]}
        </button>
      ) : (
        <form className="m-form" onSubmit={log}>
          <ErrorBanner error={error} />
          <PinField value={pin} onChange={setPin} label={`Your PIN, to log ${KIND[next]}`} />
          <p className="mute small">
            {next === 'duty_on' ? 'Next you tick the declaration and take a selfie. No location is recorded.' : 'You do not need to wait for a relief. Next you tick the Duty From declaration and take a selfie.'}
          </p>
          <div className="m-actions">
            <button className="btn" disabled={busy || pin.length < 4}>
              {busy ? 'Saving…' : `Log ${KIND[next]}`}
            </button>
            <button type="button" className="btn ghost" onClick={() => (setAsking(false), setPin(''))}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** The declaration owed after Duty On or Duty From: every statement ticked, and a selfie. */
function Declaration({ owed, onDone }: { owed: NonNullable<State['pendingDeclaration']>; onDone: () => Promise<unknown> }) {
  const [ticked, setTicked] = useState<boolean[]>(owed.wording.statements.map(() => false));
  const [comment, setComment] = useState('');
  const [raise, setRaise] = useState(false);
  const [priority, setPriority] = useState<'green' | 'amber' | 'red'>('green');
  const [selfie, setSelfie] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const ready = ticked.every(Boolean) && !!selfie && (!raise || comment.trim().length > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selfie) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('data', JSON.stringify({ eventId: crypto.randomUUID(), dutyEventId: owed.dutyEventId, accepted: ticked, comment: comment.trim(), raiseEquipmentReport: raise, equipmentReportPriority: priority, ...stamp() }));
      form.append('selfie', selfie);
      await api('/device/declarations', { method: 'POST', body: form });
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="m-form" onSubmit={submit}>
      <h3>{KIND[owed.kind]} declaration</h3>
      <p className="mute small">Tick each statement and take a selfie to finish {KIND[owed.kind]}.</p>
      <ErrorBanner error={error} />
      {owed.wording.statements.map((text, i) => (
        <label key={text} className="line check-line">
          <span>{text}</span>
          <input type="checkbox" checked={ticked[i]} onChange={(e) => setTicked(ticked.map((t, j) => (j === i ? e.target.checked : t)))} />
        </label>
      ))}
      <label className="f" style={{ marginTop: 10 }}>
        <span>Comment (optional)</span>
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      {owed.kind === 'duty_on' && comment.trim().length > 0 && (
        <>
          <label className="line check-line">
            <span>Raise this comment as an equipment report</span>
            <input type="checkbox" checked={raise} onChange={(e) => setRaise(e.target.checked)} />
          </label>
          {raise && (
            <label className="f">
              <span>Priority</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
                <option value="green">Green</option>
                <option value="amber">Amber</option>
                <option value="red">Red</option>
              </select>
            </label>
          )}
        </>
      )}
      <label className="f" style={{ marginTop: 10 }}>
        <span>Selfie</span>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={(e) => setSelfie(e.target.files?.[0] ?? null)} required />
        <div className="mute small">This opens the front camera. Take the photo now; do not choose an old one.</div>
      </label>
      <button className="btn m-wide" disabled={busy || !ready}>
        {busy ? 'Sending…' : 'Submit declaration'}
      </button>
    </form>
  );
}

function Roster({ roster }: { roster: State['roster'] }) {
  if (!roster.comingUp.length) return null;
  return (
    <section className="card">
      <h2>Coming up</h2>
      {roster.comingUp.slice(0, 7).map((d) => (
        <div className="line" key={d.date}>
          <span>
            <b>{formatDate(d.date)}</b>
            <div className="mute small">{d.siteName}</div>
          </span>
          <span>
            {d.shiftName}
            <div className="mute small">
              {d.startTime?.slice(0, 5)} to {d.endTime?.slice(0, 5)}
            </div>
          </span>
        </div>
      ))}
    </section>
  );
}

function MyScore() {
  const [s, setS] = useState<Score | null>(null);
  useEffect(() => {
    api<Score>('/device/score').then(setS).catch(() => undefined);
  }, []);
  if (!s) return null;
  const tone = s.position === 'ABOVE_PAR' ? 'green' : s.position === 'ON_PAR' ? 'blue' : 'amber';
  return (
    <section className="card">
      <div className="m-alert-head">
        <h2 style={{ margin: 0 }}>My score</h2>
        <span className={`pill ${tone}`}>{s.positionLabel}</span>
      </div>
      <p style={{ fontSize: 28, fontWeight: 800, margin: '4px 0' }}>{s.score}</p>
      {s.events.length === 0 && <p className="mute small">Nothing has changed your score recently.</p>}
      {s.events.slice(0, 6).map((e) => (
        <div className="line" key={e.id}>
          <span>
            <b>{e.label}</b>
            <div className="mute small">
              {formatDate(e.date)}
              {e.evidence ? ` · ${e.evidence}` : ''}
            </div>
          </span>
          <b style={{ color: e.impact < 0 ? 'var(--red)' : 'var(--green)' }}>
            {e.impact > 0 ? '+' : ''}
            {e.impact}
          </b>
        </div>
      ))}
      <p className="mute small" style={{ marginTop: 8 }}>
        Scores never trigger a warning or a deduction by themselves.
      </p>
    </section>
  );
}

function MyTraining() {
  const [q, setQ] = useState<Qualification[] | null>(null);
  useEffect(() => {
    api<Qualification[]>('/device/qualifications').then(setQ).catch(() => undefined);
  }, []);
  if (!q?.length) return null;
  const tone = { COMPLIANT: 'green', EXPIRING: 'amber', EXPIRED: 'red' } as const;
  const text = { COMPLIANT: 'Current', EXPIRING: 'Expiring soon', EXPIRED: 'Expired' } as const;
  return (
    <section className="card">
      <h2>My training</h2>
      {q.map((x) => (
        <div className="line" key={x.name}>
          <span>
            <b>{x.name}</b>
            {x.expiryDate && <div className="mute small">Valid until {formatDate(x.expiryDate)}</div>}
          </span>
          <span className={`pill ${tone[x.status]}`}>{text[x.status]}</span>
        </div>
      ))}
    </section>
  );
}

/** His own uniform: what he is entitled to, ordering, and signing for a delivery. A manager decides the order, never himself. */
function MyUniform() {
  const [data, setData] = useState<{ kit: KitItem[]; orders: Order[] } | null>(null);
  const [picked, setPicked] = useState<Record<string, { size: string; quantity: number; reason: string }>>({});
  const [ordering, setOrdering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [agree, setAgree] = useState(false);
  const [signing, setSigning] = useState<string | null>(null);
  const load = () =>
    api<{ kit: KitItem[]; orders: Order[] }>('/device/uniform')
      .then(setData)
      .catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  if (!data || (!data.kit.length && !data.orders.length)) return null;
  const errors = error instanceof ApiError ? error.errors : {};
  const lines = Object.entries(picked);
  const waiting = data.orders.find((o) => o.status === 'requested');

  async function order(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ number: number }>('/device/uniform/orders', { method: 'POST', json: { eventId: crypto.randomUUID(), lines: lines.map(([itemId, l]) => ({ itemId, ...l })), ...stamp() } });
      setDone(`Order #${r.number} sent. A manager will decide it.`);
      setPicked({});
      setOrdering(false);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function receive(o: Order) {
    setBusy(true);
    setError(null);
    try {
      await api(`/device/uniform/orders/${o.id}/receive`, { method: 'POST', wrongPinIs401: true, json: { pin, agreeToPay: agree, ...stamp() } });
      setDone(`You signed for order #${o.number}.`);
      setSigning(null);
      setPin('');
      setAgree(false);
      await load();
    } catch (err) {
      setError(err);
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>My uniform</h2>
      {done && (
        <div className="banner ok" role="status">
          {done}
        </div>
      )}
      {data.orders.map((o) => (
        <div key={o.id} className="m-form" style={{ marginTop: 0 }}>
          <div className="m-alert-head">
            <b>Order #{o.number}</b>
            <span className="pill blue">{o.statusLabel}</span>
          </div>
          <p className="mute small">{o.lines.map((l) => `${l.quantity} × ${l.label}${l.size ? ` ${l.size}` : ''}${l.decision === 'declined' ? ' (not issued)' : ''}`).join(', ')}</p>
          {o.canReceive &&
            (signing === o.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  receive(o);
                }}
              >
                <ErrorBanner error={error} />
                {o.agreeStatement && (
                  <label className="line check-line">
                    <span>{o.agreeStatement}</span>
                    <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                  </label>
                )}
                <PinField value={pin} onChange={setPin} label="Your PIN, to sign for these items" />
                <div className="m-actions">
                  <button className="btn" disabled={busy || pin.length < 4 || (!!o.agreeStatement && !agree)}>
                    Sign for them
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setSigning(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button className="btn m-wide" onClick={() => (setSigning(o.id), setError(null))}>
                I have received these
              </button>
            ))}
        </div>
      ))}

      {data.kit.length > 0 && !ordering && (
        <>
          {data.kit.map((k) => (
            <div className="line" key={k.itemId}>
              <span>
                <b>{k.label}</b>
                <div className="mute small">
                  Entitled to {k.entitled} · {k.lastIssued ? `last issued ${formatDate(k.lastIssued)}` : 'never issued'}
                </div>
              </span>
              <span className={`pill ${k.due ? 'green' : 'grey'}`}>{k.due ? 'Due now' : `Due ${k.nextDue ? formatDate(k.nextDue) : ''}`}</span>
            </div>
          ))}
          {waiting ? (
            <p className="mute small" style={{ marginTop: 10 }}>
              Order #{waiting.number} is waiting for a manager’s decision. You can order again once it is decided.
            </p>
          ) : (
            <button className="btn ghost m-wide" style={{ marginTop: 12 }} onClick={() => (setOrdering(true), setDone(null), setError(null))}>
              Order uniform
            </button>
          )}
        </>
      )}

      {ordering && (
        <form className="m-form" onSubmit={order}>
          <ErrorBanner error={error} />
          {data.kit.map((k) => {
            const p = picked[k.itemId];
            return (
              <div key={k.itemId} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
                <label className="check-line" style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span>
                    <b>{k.label}</b>
                    <div className="mute small">{k.due ? 'Due now' : `Not due until ${k.nextDue ? formatDate(k.nextDue) : 'later'}`}</div>
                  </span>
                  <input
                    type="checkbox"
                    checked={!!p}
                    onChange={(e) => {
                      const next = { ...picked };
                      if (e.target.checked) next[k.itemId] = { size: k.lastSize && k.sizes.includes(k.lastSize) ? k.lastSize : (k.sizes[0] ?? ''), quantity: 1, reason: '' };
                      else delete next[k.itemId];
                      setPicked(next);
                    }}
                  />
                </label>
                {p && (
                  <div className="grid" style={{ marginTop: 8 }}>
                    {k.sizes.length > 0 && (
                      <label className="f">
                        <span>Size</span>
                        <select value={p.size} onChange={(e) => setPicked({ ...picked, [k.itemId]: { ...p, size: e.target.value } })}>
                          {k.sizes.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="f">
                      <span>How many (up to {k.entitled})</span>
                      <input type="number" inputMode="numeric" min={1} max={k.entitled} value={p.quantity} onChange={(e) => setPicked({ ...picked, [k.itemId]: { ...p, quantity: Math.max(1, Number(e.target.value) || 1) } })} />
                    </label>
                    {!k.due && (
                      <label className="f">
                        <span>Why do you need it before it is due?</span>
                        <input value={p.reason} onChange={(e) => setPicked({ ...picked, [k.itemId]: { ...p, reason: e.target.value } })} />
                      </label>
                    )}
                    {errors[k.itemId] && <div className="err">{errors[k.itemId]}</div>}
                  </div>
                )}
              </div>
            );
          })}
          <p className="mute small">A manager decides each item. You cannot decide your own order.</p>
          <div className="m-actions">
            <button className="btn" disabled={busy || !lines.length}>
              {busy ? 'Sending…' : 'Send order'}
            </button>
            <button type="button" className="btn ghost" onClick={() => (setOrdering(false), setPicked({}))}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <p className="m-foot mute small" style={{ marginTop: 12 }}>
        <Link href="/m/more">Back to More</Link>
      </p>
    </section>
  );
}
