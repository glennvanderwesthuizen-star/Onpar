'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDateTime, useLoad } from '@/components/ui';
import { SimpleQr } from '@/components/patrols';

interface Device {
  id: string;
  label: string;
  serialOrImei: string;
  siteId: string | null;
  siteName: string | null;
  postName: string;
  status: string;
  kioskStatus: string;
  appVersion: string | null;
  lastSeenAt: string | null;
  batteryPct: number | null;
}

type Site = { id: string; name: string };

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'grey' | 'blue'> = {
  registered: 'blue',
  active: 'green',
  locked: 'amber',
  disabled: 'red',
  retired: 'grey',
};

export default function DevicesPage() {
  const { can } = useSession();
  const devices = useLoad(() => api<Device[]>('/devices'));
  const sites = useLoad(() => api<Site[]>('/sites'));
  const [editing, setEditing] = useState<Device | null>(null);
  const [newCode, setNewCode] = useState<{ label: string; token: string } | null>(null);
  const manage = can('devices.manage');

  return (
    <>
      <div className="head">
        <div>
          <h1>Post devices</h1>
          <p className="mute">A device belongs to a post (for example Gate 2), not a person.</p>
        </div>
      </div>
      <ErrorBanner error={devices.error} />
      {newCode && <SetupCode label={newCode.label} token={newCode.token} onClose={() => setNewCode(null)} fresh={false} />}
      <div className="card scroll">
        {devices.data && !devices.data.length && <p className="mute">No devices registered yet.</p>}
        {!!devices.data?.length && (
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Site and post</th>
                <th>Status</th>
                <th>Last seen</th>
                <th>Battery</th>
                <th>App</th>
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {devices.data.map((d) => (
                <tr key={d.id}>
                  <td>
                    <b>{d.label}</b>
                    <div className="mute small">{d.serialOrImei}</div>
                  </td>
                  <td>
                    {d.siteName ?? <span className="mute">Unassigned</span>}
                    {d.postName && <div className="mute small">{d.postName}</div>}
                  </td>
                  <td>
                    <Pill tone={STATUS_TONE[d.status] ?? 'grey'}>{d.status}</Pill>
                    <div className="mute small">Kiosk: {KIOSK[d.kioskStatus] ?? d.kioskStatus}</div>
                  </td>
                  <td>{d.lastSeenAt ? formatDateTime(d.lastSeenAt) : <span className="mute">Never</span>}</td>
                  <td>{d.batteryPct != null ? `${d.batteryPct}%` : '—'}</td>
                  <td>{d.appVersion ?? '—'}</td>
                  {manage && (
                    <td>
                      {d.status !== 'retired' && (
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn ghost sm" onClick={() => setEditing(d)}>
                            Change
                          </button>
                          <button
                            className="btn ghost sm"
                            onClick={async () => {
                              if (!window.confirm(`Make a new setup code for ${d.label}? The old code stops working, so the phone must scan the new one.`)) return;
                              try {
                                const r = await api<{ device: Device; deviceToken: string }>(`/devices/${d.id}/new-key`, { method: 'POST' });
                                setNewCode({ label: r.device.label, token: r.deviceToken });
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                              } catch (e) {
                                window.alert(e instanceof Error ? e.message : 'Could not make a new code.');
                              }
                            }}
                          >
                            New setup code
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {manage && editing && (
        <EditDevice
          key={editing.id}
          device={editing}
          sites={sites.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            devices.reload();
          }}
        />
      )}
      {manage && <RegisterDevice sites={sites.data ?? []} onRegistered={devices.reload} />}
    </>
  );
}

/** The lock-in state the phone reports with every check-in. */
const KIOSK: Record<string, string> = {
  locked: 'locked to On Par',
  permitted: 'allowed, not locked yet',
  not_managed: 'not managed (test phone)',
  unknown: 'not reported yet',
};

/** What the phone scans to set itself up: this website's address and the device key. */
function setupCode(token: string) {
  return `onpar://setup?server=${encodeURIComponent(window.location.origin)}&token=${encodeURIComponent(token)}`;
}

/** The phone setup code, shown once: right after registering, or after making a new one. */
function SetupCode({ label, token, onClose, fresh }: { label: string; token: string; onClose: () => void; fresh: boolean }) {
  return (
    <div className="banner ok">
      <p>
        <b>{label}</b> {fresh ? 'is registered' : 'has a new setup code (the old one no longer works)'}. Open On Par on the phone and scan this
        code:
      </p>
      <SimpleQr code={setupCode(token)} name={label} sub="On Par phone setup" />
      <p className="small">
        Or type the details on the phone: server <b>{typeof window === 'undefined' ? '' : window.location.origin}</b>, device key (not the
        IMEI):
      </p>
      <p>
        <span className="secret long">{token}</span>
      </p>
      <p className="small">
        The code and key are shown only now. Anyone with them can set up a phone as this device, so do not photograph or share them. If they
        are lost, press <b>New setup code</b> next to the device in the list.
      </p>
      <button className="btn ghost sm" onClick={onClose}>
        The phone is set up
      </button>
    </div>
  );
}

function RegisterDevice({ sites, onRegistered }: { sites: Site[]; onRegistered: () => void }) {
  const [f, setF] = useState({ label: '', serialOrImei: '', siteId: '', postName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [token, setToken] = useState<{ label: string; token: string } | null>(null);
  const errors = error instanceof ApiError ? error.errors : {};

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ device: Device; deviceToken: string }>('/devices', {
        method: 'POST',
        json: { ...f, siteId: f.siteId || null },
      });
      setToken({ label: r.device.label, token: r.deviceToken });
      setF({ label: '', serialOrImei: '', siteId: '', postName: '' });
      onRegistered();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Register a device</h2>
      {token && <SetupCode label={token.label} token={token.token} onClose={() => setToken(null)} fresh />}
      <ErrorBanner error={error} />
      <form onSubmit={submit}>
        <div className="grid g2">
          <Field label="Label" error={errors.label} hint="For example Device 001">
            <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          </Field>
          <Field label="Serial number or IMEI" error={errors.serialOrImei}>
            <input value={f.serialOrImei} onChange={(e) => setF({ ...f, serialOrImei: e.target.value })} />
          </Field>
          <Field label="Site">
            <select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}>
              <option value="">Not assigned yet</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Post" hint="For example Gate 2">
            <input value={f.postName} onChange={(e) => setF({ ...f, postName: e.target.value })} />
          </Field>
        </div>
        <button className="btn" disabled={busy}>
          {busy ? 'Registering…' : 'Register device'}
        </button>
      </form>
    </div>
  );
}

function EditDevice({ device, sites, onClose, onSaved }: { device: Device; sites: Site[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ siteId: device.siteId ?? '', postName: device.postName, status: device.status, reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = error instanceof ApiError ? error.errors : {};

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/devices/${device.id}`, { method: 'PUT', json: { ...f, siteId: f.siteId || null } });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ borderColor: 'var(--green)' }}>
      <h2>Change {device.label}</h2>
      <ErrorBanner error={error} />
      <form onSubmit={submit}>
        <div className="grid g3">
          <Field label="Site">
            <select value={f.siteId} onChange={(e) => setF({ ...f, siteId: e.target.value })}>
              <option value="">Not assigned</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Post">
            <input value={f.postName} onChange={(e) => setF({ ...f, postName: e.target.value })} />
          </Field>
          <Field label="Status" hint={f.status === 'retired' ? 'Retiring is permanent.' : undefined}>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="registered">Registered</option>
              <option value="active">Active</option>
              <option value="locked">Locked</option>
              <option value="disabled">Disabled</option>
              <option value="retired">Retired</option>
            </select>
          </Field>
        </div>
        <Field label="Reason (recorded in the audit log)" error={errors.reason}>
          <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
        <div className="row">
          <button className="btn" disabled={busy}>
            {busy ? 'Saving…' : 'Save change'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
