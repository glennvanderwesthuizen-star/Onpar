import { api } from './api';

/**
 * Alerts on this device (plan of 6 Oct 2026, decision D-38): the alert system built into
 * phone and computer browsers. Nothing here runs until the person asks for alerts.
 */

export interface Device {
  id: string;
  label: string;
  endpoint: string;
  addedAt: string;
  lastAlertAt: string | null;
}

/** Where this browser stands. */
export type PushState =
  /** The browser cannot show alerts at all (very old, or a private window). */
  | 'unsupported'
  /** An iPhone or iPad in Safari: On Par must first be added to the home screen. */
  | 'ios_needs_home_screen'
  /** The person refused alerts for this site in the browser; only they can undo that, in the browser's settings. */
  | 'blocked'
  | 'off'
  | 'on';

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Opened from the home-screen icon rather than a browser tab. */
export function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** This browser's alert address, if alerts are switched on in it. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(devices: Device[]): Promise<PushState> {
  if (!supported()) return isIos() && !isInstalled() ? 'ios_needs_home_screen' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const sub = await currentSubscription();
  return sub && devices.some((d) => d.endpoint === sub.endpoint) ? 'on' : 'off';
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const have = sub.options.applicationServerKey;
  if (!have) return false;
  const a = new Uint8Array(have);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function save(sub: PushSubscription) {
  const json = sub.toJSON();
  await api('/notifications/push/subscribe', { method: 'POST', json: { endpoint: json.endpoint, keys: json.keys } });
}

/**
 * Switches alerts on for this device. The browser asks the person for permission the first
 * time. Throws with a plain message if they say no.
 */
export async function enablePush(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Alerts were not allowed. To change this, allow notifications for On Par in your browser or phone settings.');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server's key (for example after a reinstall) cannot be reused.
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  try {
    // A browser that cannot reach its delivery service may wait for ever, so stop after 20 seconds.
    sub ??= await Promise.race([
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000)),
    ]);
  } catch {
    // Browsers refuse in a private or incognito window, and when they cannot reach their delivery service.
    throw new Error('This browser window could not switch alerts on. If it is a private or incognito window, open On Par in a normal window. Otherwise check the internet connection and try again.');
  }
  await save(sub);
}

/** Switches alerts off for this device only. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/notifications/push/unsubscribe', { method: 'POST', json: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

/**
 * Keeps the server in step with the browser: browsers sometimes renew their alert address by
 * themselves. If alerts are on here and the server has a different address for this person, the
 * current one is saved. Never asks for permission and never fails loudly.
 */
export async function keepInStep(userId: string): Promise<void> {
  try {
    if (!supported() || Notification.permission !== 'granted') return;
    const sub = await currentSubscription();
    if (!sub) return;
    const { publicKey, devices } = await api<{ publicKey: string; devices: Device[] }>('/notifications/push');
    if (!sameKey(sub, publicKey) || devices.some((d) => d.endpoint === sub.endpoint)) return;
    // Only renew an address this same person switched on here (the phone may be shared): the mark
    // is set when they switch alerts on and cleared when they switch them off.
    if (localStorage.getItem(MARK) !== userId) return;
    await save(sub);
  } catch {
    // Alerts are a convenience on top of the alerts list; a problem here must never break a page.
  }
}

const MARK = 'onpar.alerts.on';
/** Remembers, on this device only, which person switched alerts on here. */
export function markOn(userId: string | null) {
  try {
    if (userId) localStorage.setItem(MARK, userId);
    else localStorage.removeItem(MARK);
  } catch {
    // Private windows may refuse storage; alerts still work.
  }
}
