'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Device, disablePush, enablePush, isIos, markOn, PushState, pushState, currentSubscription } from '@/lib/push';
import { ErrorBanner, formatDateTime } from './ui';

interface Pref {
  kind: string;
  label: string;
  about: string;
  optional: boolean;
  on: boolean;
}

interface TestResult {
  alerts: number;
  sent: number;
  failed: number;
  noDevice: number;
}

/**
 * My account: alerts on this device, a test alert, the person's other devices, and which
 * alerts they receive (plan of 6 Oct 2026, phase 1).
 */
export function AlertSettings({ accountId }: { accountId: string }) {
  const [publicKey, setPublicKey] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [state, setState] = useState<PushState | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Pref[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  async function load() {
    const [push, p] = await Promise.all([api<{ publicKey: string; devices: Device[] }>('/notifications/push'), api<Pref[]>('/notifications/preferences')]);
    setPublicKey(push.publicKey);
    setDevices(push.devices);
    setPrefs(p);
    setState(await pushState(push.devices));
    setHere((await currentSubscription())?.endpoint ?? null);
  }
  useEffect(() => {
    load().catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(e);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const switchOn = () =>
    run(async () => {
      await enablePush(publicKey);
      markOn(accountId);
    });
  const switchOff = () =>
    run(async () => {
      await disablePush();
      markOn(null);
    });
  const sendTest = () =>
    run(async () => {
      const r = await api<TestResult>('/notifications/test', { method: 'POST' });
      setTest(r);
    });
  const removeDevice = (d: Device) => run(() => api(`/notifications/push/devices/${d.id}`, { method: 'DELETE' }).then(() => undefined));
  const toggle = (kind: string, on: boolean) =>
    run(async () => {
      const off = prefs.filter((p) => p.optional && (p.kind === kind ? !on : !p.on)).map((p) => p.kind);
      await api('/notifications/preferences', { method: 'PUT', json: { off } });
    });

  return (
    <>
      <div className="card" style={{ maxWidth: 560 }}>
        <h2>Alerts on this device</h2>
        <ErrorBanner error={error} />
        {state === null && <p className="mute">Checking…</p>}

        {state === 'on' && (
          <>
            <div className="banner ok">Alerts are on for this device. They arrive even when On Par is closed.</div>
            <div className="row">
              <button className="btn" onClick={sendTest} disabled={busy}>
                Send me a test alert
              </button>
              <button className="btn ghost" onClick={switchOff} disabled={busy}>
                Turn off on this device
              </button>
            </div>
          </>
        )}

        {state === 'off' && (
          <>
            <p>Get On Par alerts on this device, even when On Par is closed and the screen is locked.</p>
            <p className="mute small">Your browser will ask you to allow notifications. Choose Allow.</p>
            <button className="btn" onClick={switchOn} disabled={busy || !publicKey}>
              {busy ? 'Switching on…' : 'Allow alerts on this device'}
            </button>
          </>
        )}

        {state === 'ios_needs_home_screen' && (
          <>
            <div className="banner warn">On an iPhone or iPad, alerts only work once On Par is on your home screen.</div>
            <ol className="steps">
              <li>
                Open this page in <b>Safari</b>.
              </li>
              <li>
                Tap the <b>Share</b> button (the square with an arrow pointing up).
              </li>
              <li>
                Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.
              </li>
              <li>
                Open <b>On Par</b> from its new icon on your home screen, sign in, and come back to <b>My account</b>.
              </li>
            </ol>
            <p className="mute small">This needs iOS 16.4 or newer (Settings, General, About shows the version).</p>
          </>
        )}

        {state === 'blocked' && (
          <>
            <div className="banner warn">Notifications from On Par are blocked on this device, so alerts cannot be shown.</div>
            <p className="small">
              {isIos()
                ? 'To allow them: open the phone’s Settings, then Notifications, then On Par, and switch on Allow Notifications. Then come back to this page.'
                : 'To allow them: tap the padlock (or the settings icon) next to the web address at the top, find Notifications, and choose Allow. Then reload this page.'}
            </p>
          </>
        )}

        {state === 'unsupported' && (
          <div className="banner warn">This browser cannot show alerts. Use Chrome on Android, or Safari on an iPhone with On Par added to the home screen. Your alerts list still works here.</div>
        )}

        {test && (
          <div className={`banner ${test.sent ? 'ok' : 'warn'}`} role="status" style={{ marginTop: 12 }}>
            {test.sent > 0 && `Test alert sent to ${test.sent} device${test.sent === 1 ? '' : 's'}. It should appear within a few seconds. `}
            {test.failed > 0 && `${test.failed} device${test.failed === 1 ? '' : 's'} could not be reached. `}
            {test.noDevice > 0 && 'No device is set up for alerts yet, so it was only added to your alerts list.'}
          </div>
        )}
      </div>

      {devices.length > 0 && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h2>Your devices with alerts on</h2>
          {devices.map((d) => (
            <div className="line" key={d.id}>
              <span>
                <b>{d.label}</b>
                {d.endpoint === here && <span className="pill green" style={{ marginLeft: 8 }}>This device</span>}
                <div className="mute small">
                  Added {formatDateTime(d.addedAt)}
                  {d.lastAlertAt ? ` · last alert ${formatDateTime(d.lastAlertAt)}` : ' · no alert sent yet'}
                </div>
              </span>
              {d.endpoint !== here && (
                <button className="btn ghost sm" onClick={() => removeDevice(d)} disabled={busy}>
                  Remove
                </button>
              )}
            </div>
          ))}
          <p className="mute small" style={{ marginTop: 10 }}>
            Remove a device you no longer use, for example a lost phone.
          </p>
        </div>
      )}

      {prefs.length > 0 && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h2>Which alerts you receive</h2>
          {prefs.map((p) => (
            <label className="line check-line" key={p.kind}>
              <span>
                <b>{p.label}</b>
                <div className="mute small">{p.optional ? p.about : `${p.about} This alert cannot be switched off.`}</div>
              </span>
              <input type="checkbox" checked={p.on} disabled={busy || !p.optional} onChange={(e) => toggle(p.kind, e.target.checked)} aria-label={`Receive ${p.label} alerts`} />
            </label>
          ))}
          <p className="mute small" style={{ marginTop: 10 }}>
            These choices are saved now. The alerts themselves start arriving when the supervisor app is switched on; until then only the test alert is sent.
          </p>
        </div>
      )}
    </>
  );
}
