import { Body, Controller, Get, NotFoundException, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

const CheckBody = z.object({
  declarationId: z.string().uuid(),
  result: z.enum(['match', 'not_match', 'unclear']),
  note: z.string().trim().max(500).default(''),
  source: z.enum(['review', 'spot_check']).default('review'),
});

const VIEWS = ['todo', 'spot', 'flagged', 'done'] as const;

/**
 * Selfie checks (D-36, face recognition stage 1): supervisors and managers compare Duty On and
 * Duty From selfies with the enrolment photo. "Not him" is a flag to look into, never an
 * automatic consequence. The photos themselves load through the attendance endpoints (logged).
 */
@Controller('selfie-checks')
@UseGuards(UserAuthGuard)
export class SelfieChecksController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * todo: selfies of the last 7 days nobody has checked yet; spot: 10 of those picked at random
   * (the weekly spot check); flagged: "not him" or "unclear" in the last 90 days; done: checked
   * in the last 30 days. Selfies removed under the retention policy are left out.
   */
  @Get()
  @RequirePermission('attendance.view')
  list(@CurrentUser() user: UserPrincipal, @Query('view') view = 'todo', @Query('siteId') siteId?: string) {
    if (!VIEWS.includes(view as (typeof VIEWS)[number])) view = 'todo';
    const where = {
      todo: `d.received_at > now() - interval '7 days' AND lc.result IS NULL`,
      spot: `d.received_at > now() - interval '7 days' AND lc.result IS NULL`,
      flagged: `((lc.result IN ('not_match','unclear') AND lc.checked_at > now() - interval '90 days')
                 OR (lc.result IS NULL AND (fm.verdict IN ('no_match','uncertain') OR d.liveness = 'not_passed') AND d.received_at > now() - interval '90 days'))`,
      done: `lc.checked_at > now() - interval '30 days'`,
    }[view as (typeof VIEWS)[number]];
    const order = view === 'spot' ? 'random()' : view === 'todo' ? 'd.official_at DESC' : 'lc.checked_at DESC';
    const limit = view === 'spot' ? 10 : 100;
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT d.id AS "declarationId", d.attendance_id AS "attendanceId", d.kind, d.official_at AS "officialAt",
                  e.id AS "employeeId", e.full_name AS "employeeName", e.tsf_number AS "tsfNumber", s.name AS "siteName",
                  EXISTS (SELECT 1 FROM employee_photos p WHERE p.employee_id = e.id AND p.kind = 'face') AS "hasFacePhoto",
                  lc.result, lc.note, lc.checked_at AS "checkedAt", u.full_name AS "checkedBy",
                  fm.verdict AS "autoVerdict", fm.distance::float AS "autoDistance", d.liveness
             FROM declarations d
             JOIN attendance a ON a.id = d.attendance_id
             JOIN employees e ON e.id = d.employee_id
             JOIN sites s ON s.id = a.site_id
             LEFT JOIN LATERAL (SELECT c.* FROM selfie_checks c WHERE c.declaration_id = d.id ORDER BY c.checked_at DESC LIMIT 1) lc ON true
             LEFT JOIN users u ON u.id = lc.checked_by
             LEFT JOIN LATERAL (SELECT f.verdict, f.distance FROM face_matches f WHERE f.declaration_id = d.id ORDER BY f.created_at DESC LIMIT 1) fm ON true
            WHERE d.selfie_key IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM retention_log r WHERE r.storage_key = d.selfie_key)
              AND ($1::uuid[] IS NULL OR a.site_id = ANY($1::uuid[]))
              AND ($2::uuid IS NULL OR a.site_id = $2)
              AND ${where}
            ORDER BY ${order} LIMIT ${limit}`,
          [user.siteIds, siteId || null],
        )
      ).rows;
      const counts = (
        await tx.query(
          `SELECT count(*) FILTER (WHERE lc.result IS NULL AND d.received_at > now() - interval '7 days')::int AS todo,
                  count(*) FILTER (WHERE (lc.result IN ('not_match','unclear') AND lc.checked_at > now() - interval '90 days')
                                      OR (lc.result IS NULL AND (fm.verdict IN ('no_match','uncertain') OR d.liveness = 'not_passed') AND d.received_at > now() - interval '90 days'))::int AS flagged
             FROM declarations d JOIN attendance a ON a.id = d.attendance_id
             LEFT JOIN LATERAL (SELECT c.result, c.checked_at FROM selfie_checks c WHERE c.declaration_id = d.id ORDER BY c.checked_at DESC LIMIT 1) lc ON true
             LEFT JOIN LATERAL (SELECT f.verdict FROM face_matches f WHERE f.declaration_id = d.id ORDER BY f.created_at DESC LIMIT 1) fm ON true
            WHERE d.selfie_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_log r WHERE r.storage_key = d.selfie_key)
              AND ($1::uuid[] IS NULL OR a.site_id = ANY($1::uuid[]))`,
          [user.siteIds],
        )
      ).rows[0];
      return { rows, counts };
    });
  }

  /** Records what the checker saw. Several checks may be made; the latest counts. */
  @Post()
  @RequirePermission('attendance.selfie_check')
  check(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(CheckBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const d = (
        await tx.query(
          `SELECT d.id, d.attendance_id, d.employee_id, a.site_id FROM declarations d JOIN attendance a ON a.id = d.attendance_id
            WHERE d.id = $1 AND d.selfie_key IS NOT NULL`,
          [b.declarationId],
        )
      ).rows[0];
      if (!d || (user.siteIds && !user.siteIds.includes(d.site_id))) throw new NotFoundException('Selfie not found.');
      const { id } = (
        await tx.query(
          `INSERT INTO selfie_checks (company_id, declaration_id, attendance_id, employee_id, result, note, source, checked_by)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [d.id, d.attendance_id, d.employee_id, b.result, b.note, b.source, user.userId],
        )
      ).rows[0];
      await this.audit.byUser(tx, user, {
        action: 'attendance.selfie_check',
        entityType: 'employee',
        entityId: d.employee_id,
        after: { declarationId: d.id, result: b.result, source: b.source, note: b.note },
      });
      return { id };
    });
  }
}
