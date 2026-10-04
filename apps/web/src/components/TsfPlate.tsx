'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { idCardQr } from '@onpar/rules';

/**
 * A guard's TSF number shown as a number plate: "BCD [TSF shield] 123 GP", dark blue on white,
 * tall narrow letters for reading at a glance (owner's design, 4 Oct 2026).
 */
export function TsfPlate({ number, size = 'md' }: { number: string | null | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const m = number ? /^([A-Z]{3})(\d{3})([A-Z]{2,3})$/.exec(number) : null;
  if (!m) return <span className="mute small">No TSF number yet</span>;
  return (
    <span className={`plate plate-${size}`} role="img" aria-label={`TSF number ${m[1]} ${m[2]} ${m[3]}`}>
      <span>{m[1]}</span>
      <img src="/tsf-logo.png" alt="" />
      <span>{m[2]}</span>
      <span>{m[3]}</span>
    </span>
  );
}

/**
 * The guard's ID card (credit-card size): the company logo, the QR code holding the TSF number,
 * and the guard's name. Nothing else, for POPIA (owner, 4 Oct 2026). Scanning it at the post phone
 * fills in who is signing in; the PIN is still typed every time.
 */
export function IdCard({ tsfNumber, name }: { tsfNumber: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(idCardQr(tsfNumber), { margin: 1, width: 500, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [tsfNumber]);
  return (
    <div className="id-card">
      <img className="id-logo" src="/tsf-logo.png" alt="The Security Franchise" />
      <div className="id-qr">{src && <img src={src} alt={`ID card QR code for ${name}`} />}</div>
      <div className="id-name">{name}</div>
    </div>
  );
}
