'use client';

import { Pill } from './ui';

export function PositionPill({ position, label }: { position: string; label: string }) {
  const tone = position === 'ABOVE_PAR' ? 'green' : position === 'ON_PAR' ? 'blue' : 'amber';
  return <Pill tone={tone}>{label}</Pill>;
}

export function Points({ n }: { n: number }) {
  const text = Number.isInteger(n) ? String(Math.abs(n)) : Math.abs(n).toFixed(2);
  return <b style={{ color: n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--mute)' }}>{n > 0 ? `+${text}` : n < 0 ? `−${text}` : '0'}</b>;
}

/** The brief's safeguard, shown wherever scores are. */
export function FairnessNote() {
  return (
    <div className="banner warn small">
      Points inform a conversation. They never trigger discipline, deductions or dismissal on their own. Every lost point shows its
      evidence, and the officer can query it within 7 days.
    </div>
  );
}
