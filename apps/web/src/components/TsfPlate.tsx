'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { imageUrl } from '@/lib/api';

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
 * The guard's ID badge (owner's design, 4 Oct 2026), landscape for wearing on the chest: the TSF
 * logo on the left, his photo in the middle with only his full name beneath, and the QR code on
 * the right. The QR code holds only a random card code in a link: no name or number.
 */
export function IdBadge({ qr, name, photoPath }: { qr: string; name: string; photoPath: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(qr, { margin: 0, width: 600, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [qr]);
  useEffect(() => {
    if (!photoPath) return;
    let u: string | null = null;
    imageUrl(photoPath)
      .then((x) => setPhoto((u = x)))
      .catch(() => setPhoto(null));
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [photoPath]);
  return (
    <div className="badge-card">
      <div className="badge-logo">
        <img src="/tsf-logo.png" alt="The Security Franchise" />
      </div>
      <div className="badge-person">
        <div className="badge-photo">{photo ? <img src={photo} alt={name} /> : <span>No photo</span>}</div>
        <div className="badge-name">{name}</div>
      </div>
      <div className="badge-qr">
        {src && <img src={src} alt="ID card QR code" />}
        <span>Scan to verify</span>
      </div>
    </div>
  );
}
