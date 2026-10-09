import { Injectable } from '@nestjs/common';
import { DEFAULT_VISITOR_CATEGORIES, DEFAULT_VISITOR_SETTINGS, VISITOR_CHECKS, VisitorChecks, VisitorSettings } from '@onpar/rules';
import { Tx } from '../db/db.service';

export interface CategoryRow {
  id: string;
  name: string;
  kind: string;
  contractor: boolean;
  limitMinutes: number | null;
  limitUntil: string | null;
  active: boolean;
}

/**
 * A site's visitor settings and categories as the rest of On Par reads them. A site that has
 * never saved settings gets the defaults from the rules package; a site with no categories
 * yet is given the five standard ones the first time anyone looks.
 */
@Injectable()
export class VisitorSetupService {
  async settings(tx: Tx, siteId: string): Promise<VisitorSettings & { saved: boolean }> {
    const r = (await tx.query('SELECT checks, no_response_seconds, second_contact, overstay_escalation_minutes FROM site_visitor_settings WHERE site_id = $1', [siteId])).rows[0];
    if (!r) return { ...DEFAULT_VISITOR_SETTINGS, saved: false };
    // A check added to On Par after this site saved its settings starts on its default.
    const checks = Object.fromEntries(VISITOR_CHECKS.map((c) => [c, typeof r.checks[c] === 'boolean' ? r.checks[c] : DEFAULT_VISITOR_SETTINGS.checks[c]])) as VisitorChecks;
    return { checks, noResponseSeconds: r.no_response_seconds, secondContact: r.second_contact, overstayEscalationMinutes: r.overstay_escalation_minutes, saved: true };
  }

  async categories(tx: Tx, siteId: string): Promise<CategoryRow[]> {
    const read = async () =>
      (
        await tx.query(
          `SELECT id, name, kind, contractor, limit_minutes AS "limitMinutes", to_char(limit_until, 'HH24:MI') AS "limitUntil", active
             FROM visitor_categories WHERE site_id = $1 ORDER BY active DESC, sort, created_at, lower(name)`,
          [siteId],
        )
      ).rows as CategoryRow[];
    const rows = await read();
    if (rows.length) return rows;
    for (const [i, c] of DEFAULT_VISITOR_CATEGORIES.entries()) {
      await tx.query(
        `INSERT INTO visitor_categories (company_id, site_id, name, kind, contractor, limit_minutes, limit_until, sort)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6::time, $7) ON CONFLICT DO NOTHING`,
        [siteId, c.name, c.kind, c.contractor, c.limitMinutes, c.limitUntil, i],
      );
    }
    return read();
  }
}
