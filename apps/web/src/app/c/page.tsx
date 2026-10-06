'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Device, pushState, PushState } from '@/lib/push';
import { useCustomer } from '@/lib/customer';

/**
 * Customer app, Home (phase 3, D-39). The foundation only: who you are, where, how the gate
 * reaches you, and whether alerts are on for this phone. Approving visitors and telling the gate
 * who is coming are added here later (D-40).
 */
export default function CustomerHome() {
  const { me } = useCustomer();
  const [alerts, setAlerts] = useState<PushState | null>(null);
  useEffect(() => {
    api<{ devices: Device[] }>('/notifications/push')
      .then((p) => pushState(p.devices))
      .then(setAlerts)
      .catch(() => undefined);
  }, []);

  return (
    <>
      <h1 className="m-h1">Hello, {me.fullName.split(' ')[0]}</h1>

      {alerts !== null && alerts !== 'on' && (
        <Link href="/c/account" className="m-strip">
          <b>Alerts are off on this phone. Tap to switch them on.</b>
          <span aria-hidden="true">›</span>
        </Link>
      )}
      {alerts === 'on' && (
        <div className="m-allclear">
          <b>Alerts are on for this phone.</b>
          <span className="mute small">The gate can reach you here even when On Par is closed.</span>
        </div>
      )}

      <section className="card" style={{ marginTop: 12 }}>
        <h2>{me.siteName}</h2>
        <div className="line">
          <span>{me.kind === 'tenant' ? 'Your unit' : 'You are'}</span>
          <b>{me.kind === 'tenant' ? me.unitName : `the ${me.kindLabel.toLowerCase()}${me.unitName ? `, unit ${me.unitName}` : ''}`}</b>
        </div>
        <div className="line">
          <span>Address</span>
          <b>{me.siteAddress}</b>
        </div>
        <div className="line">
          <span>Security by</span>
          <b>{me.companyName}</b>
        </div>
      </section>

      <section className="card">
        <h2>How the gate reaches you</h2>
        <div className="line">
          <span>Your number</span>
          <b>{me.phone || 'Not set'}</b>
        </div>
        <div className="line">
          <span>Second contact</span>
          <b>{me.secondContactPhone ? `${me.secondContactName}, ${me.secondContactPhone}` : 'Not set'}</b>
        </div>
        {!me.phone && <div className="banner warn" style={{ marginTop: 10 }}>Add your number, so the gate can phone you if you miss an alert.</div>}
        <Link className="btn ghost m-wide" style={{ marginTop: 12, textDecoration: 'none' }} href="/c/account">
          Change these numbers
        </Link>
      </section>

      <section className="card">
        <h2>Visitors</h2>
        <p className="mute">Coming soon: approve or refuse a visitor at the gate from here, and tell the gate in advance who is coming and at which gate.</p>
      </section>
    </>
  );
}
