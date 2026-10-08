/**
 * The shift handover (owner, 7 Oct 2026; D-45): the outgoing guard counts the shift's equipment
 * and writes a note; the incoming guard checks it and receives it. Anything missing or damaged,
 * or any difference between the two counts, becomes an equipment report.
 */

export interface HandoverItem {
  name: string;
  /** How many the shift should have (from the site's setup). */
  expected: number;
  /** How many are actually there. */
  present: number;
  damaged: boolean;
}

/** What is wrong with a handed-over list, in plain words. Empty when everything is there and fine. */
export function handoverProblems(items: HandoverItem[]): string[] {
  const out: string[] = [];
  for (const i of items) {
    if (i.present < i.expected) out.push(`${i.name}: ${i.present} of ${i.expected}`);
    if (i.damaged) out.push(`${i.name}: damaged`);
  }
  return out;
}

/** Where the incoming guard's count differs from what was handed over to him. */
export function receiveDifferences(handed: HandoverItem[], received: HandoverItem[]): string[] {
  const out: string[] = [];
  for (const h of handed) {
    const r = received.find((x) => x.name === h.name);
    if (!r) continue;
    if (r.present !== h.present) out.push(`${h.name}: handed over ${h.present}, received ${r.present}`);
    if (r.damaged && !h.damaged) out.push(`${h.name}: found damaged`);
  }
  return out;
}

export function handoverItemErrors(items: HandoverItem[]): string | null {
  for (const i of items) {
    if (!i.name.trim()) return 'Every item needs a name.';
    if (!Number.isInteger(i.present) || i.present < 0 || i.present > 999) return `Count ${i.name} as a whole number.`;
  }
  return null;
}
