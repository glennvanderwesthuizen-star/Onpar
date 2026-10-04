import { randomInt } from 'node:crypto';
import { generateTsfNumber, isProvince } from '@onpar/rules';
import { Tx } from '../db/db.service';

/**
 * Gives every active-or-inactive guard who has no TSF number yet one, from their home site's
 * province. Guards at a site without a province wait until it is set. Returns who got what,
 * so the caller can audit it. Runs inside the caller's tenant transaction.
 */
export async function issueMissingTsfNumbers(
  tx: Tx,
  where: { siteId?: string; employeeId?: string },
): Promise<{ employeeId: string; tsfNumber: string }[]> {
  const waiting = (
    await tx.query(
      `SELECT e.id, s.province FROM employees e JOIN sites s ON s.id = e.home_site_id
        WHERE e.tsf_number IS NULL AND s.province IS NOT NULL
          AND ($1::uuid IS NULL OR e.home_site_id = $1) AND ($2::uuid IS NULL OR e.id = $2)
        ORDER BY e.created_at FOR UPDATE OF e`,
      [where.siteId ?? null, where.employeeId ?? null],
    )
  ).rows;
  const issued: { employeeId: string; tsfNumber: string }[] = [];
  for (const e of waiting) {
    if (!isProvince(e.province)) continue;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 50) throw new Error('Could not find a free TSF number.');
      const n = generateTsfNumber(e.province, randomInt);
      if ((await tx.query('SELECT 1 FROM employees WHERE tsf_number = $1', [n])).rowCount) continue;
      await tx.query('UPDATE employees SET tsf_number = $2, tsf_number_issued_at = now() WHERE id = $1', [e.id, n]);
      issued.push({ employeeId: e.id, tsfNumber: n });
      break;
    }
  }
  return issued;
}
