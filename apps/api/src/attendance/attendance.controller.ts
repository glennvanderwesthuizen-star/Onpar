import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { can, sastDate } from '@onpar/rules';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { DutyService } from './duty.service';
import { ScoringService } from '../scoring/scoring.service';

const OnBehalfBody = z.object({
  employeeId: z.string().uuid(),
  kind: z.enum(['duty_on', 'duty_from']),
  reason: z.string().trim().min(3, 'Give a reason.'),
  at: z.string().datetime({ offset: true }).optional(),
});

const ExceptionBody = z.object({ reason: z.string().trim().min(3, 'Give a reason.') });

/** Attendance for supervisors and managers (sections 6.3 and 6.11). */
@Controller('attendance')
@UseGuards(UserAuthGuard)
export class AttendanceController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly duty: DutyService,
    private readonly scoring: ScoringService,
  ) {}

  /** One day's attendance, by the date each shift started. */
  @Get()
  @RequirePermission('attendance.view')
  list(@CurrentUser() user: UserPrincipal, @Query('date') date?: string, @Query('siteId') siteId?: string) {
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : sastDate(new Date());
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT a.id, a.shift_date AS "shiftDate", a.shift_name AS "shiftName", a.scheduled_start AS "scheduledStart",
                  a.scheduled_end AS "scheduledEnd", a.duty_on_at AS "dutyOnAt", a.duty_from_at AS "dutyFromAt",
                  a.arrival_status AS "arrivalStatus", a.late_minutes AS "lateMinutes",
                  a.departure_status AS "departureStatus", a.early_minutes AS "earlyMinutes",
                  a.exception_reason AS "exceptionReason",
                  e.id AS "employeeId", e.full_name AS "employeeName", e.employee_number AS "employeeNumber",
                  s.id AS "siteId", s.name AS "siteName",
                  EXISTS (SELECT 1 FROM declarations d WHERE d.attendance_id = a.id AND d.kind = 'duty_on') AS "onDeclared",
                  EXISTS (SELECT 1 FROM declarations d WHERE d.attendance_id = a.id AND d.kind = 'duty_from') AS "fromDeclared",
                  EXISTS (SELECT 1 FROM declarations d WHERE d.attendance_id = a.id AND d.selfie_key IS NULL) AS "selfiePending",
                  (EXISTS (SELECT 1 FROM duty_events x WHERE x.attendance_id = a.id AND x.late_synced)
                    OR EXISTS (SELECT 1 FROM declarations d WHERE d.attendance_id = a.id AND d.late_synced)) AS "lateSynced",
                  (EXISTS (SELECT 1 FROM duty_events x WHERE x.attendance_id = a.id AND x.drift_flagged)
                    OR EXISTS (SELECT 1 FROM declarations d WHERE d.attendance_id = a.id AND d.drift_flagged)) AS "clockDrift",
                  EXISTS (SELECT 1 FROM duty_events x WHERE x.attendance_id = a.id AND x.on_behalf_by IS NOT NULL) AS "onBehalf",
                  EXISTS (SELECT 1 FROM declarations d WHERE d.attendance_id = a.id AND d.comment <> '') AS "hasComment"
             FROM attendance a
             JOIN employees e ON e.id = a.employee_id
             JOIN sites s ON s.id = a.site_id
            WHERE a.shift_date = $1
              AND ($2::uuid IS NULL OR a.site_id = $2::uuid)
              AND ($3::uuid[] IS NULL OR a.site_id = ANY($3::uuid[]))
            ORDER BY s.name, a.scheduled_start NULLS LAST, a.duty_on_at`,
          [day, siteId || null, user.siteIds],
        )
      ).rows;
      return { date: day, rows };
    });
  }

  /** One shift in full: both duty events and both declarations with their wording. */
  @Get(':id')
  @RequirePermission('attendance.view')
  get(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const a = (
        await tx.query(
          `SELECT a.*, e.full_name AS employee_name, e.employee_number, s.name AS site_name,
                  u.full_name AS exception_by_name
             FROM attendance a JOIN employees e ON e.id = a.employee_id JOIN sites s ON s.id = a.site_id
             LEFT JOIN users u ON u.id = a.exception_approved_by
            WHERE a.id = $1`,
          [id],
        )
      ).rows[0];
      if (!a || (user.siteIds && !user.siteIds.includes(a.site_id))) throw new NotFoundException('Attendance record not found.');
      const events = (
        await tx.query(
          `SELECT x.id, x.kind, x.official_at, x.device_clock, x.received_at, x.late_synced, x.drift_seconds, x.drift_flagged,
                  x.on_behalf_reason, u.full_name AS on_behalf_by_name, d.label AS device_label
             FROM duty_events x LEFT JOIN users u ON u.id = x.on_behalf_by LEFT JOIN devices d ON d.id = x.device_id
            WHERE x.attendance_id = $1 ORDER BY x.official_at`,
          [id],
        )
      ).rows;
      const declarations = (
        await tx.query(
          `SELECT id, kind, wording_version, statements, comment, raise_equipment_report, official_at, received_at,
                  late_synced, drift_seconds, drift_flagged, selfie_key IS NOT NULL AS has_selfie
             FROM declarations WHERE attendance_id = $1 ORDER BY official_at`,
          [id],
        )
      ).rows;
      return { ...a, events, declarations };
    });
  }

  /** The selfie from a declaration. Viewing it is logged, like registration photos. */
  @Get(':id/selfie/:kind')
  @RequirePermission('attendance.view')
  async selfie(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Res() res: Response,
  ) {
    const d = await this.db.withTenant(user.companyId, async (tx) => {
      const row = (
        await tx.query(
          `SELECT d.selfie_key, d.selfie_content_type, a.site_id FROM declarations d JOIN attendance a ON a.id = d.attendance_id
            WHERE d.attendance_id = $1 AND d.kind = $2`,
          [id, kind],
        )
      ).rows[0];
      if (!row?.selfie_key || (user.siteIds && !user.siteIds.includes(row.site_id))) throw new NotFoundException('Selfie not found.');
      await this.audit.byUser(tx, user, { action: 'attendance.selfie_view', entityType: 'attendance', entityId: id, after: { kind } });
      return row;
    });
    res.setHeader('Content-Type', d.selfie_content_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(d.selfie_key));
  }

  /**
   * The officer's registration face photo, for comparing with the selfie
   * (section 6.2). Access follows the site the shift was worked at, which may
   * differ from the officer's home site. Logged like any photo view.
   */
  @Get(':id/registration-photo')
  @RequirePermission('attendance.view')
  async registrationPhoto(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const p = await this.db.withTenant(user.companyId, async (tx) => {
      const row = (
        await tx.query(
          `SELECT a.site_id, a.employee_id, p.storage_key, p.content_type
             FROM attendance a JOIN employee_photos p ON p.employee_id = a.employee_id AND p.kind = 'face'
            WHERE a.id = $1`,
          [id],
        )
      ).rows[0];
      if (!row || (user.siteIds && !user.siteIds.includes(row.site_id))) throw new NotFoundException('Photo not found.');
      await this.audit.byUser(tx, user, {
        action: 'officer.photo_view',
        entityType: 'employee',
        entityId: row.employee_id,
        after: { kind: 'face', attendanceId: id },
      });
      return row;
    });
    res.setHeader('Content-Type', p.content_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(p.storage_key));
  }

  /** A supervisor logs Duty On or Duty From for someone, only with a reason (section 6.1). */
  @Post('on-behalf')
  @RequirePermission('attendance.manage')
  onBehalf(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(OnBehalfBody, body);
    return this.duty.recordOnBehalf(user, b.employeeId, b.kind, b.reason, b.at ? new Date(b.at) : null, randomUUID());
  }

  /** Marks a late arrival or early departure as an approved exception, with a reason. */
  @Post(':id/exception')
  @RequirePermission('attendance.manage')
  approveException(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseBody(ExceptionBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const a = (await tx.query('SELECT site_id, exception_reason FROM attendance WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!a || (user.siteIds && !user.siteIds.includes(a.site_id))) throw new NotFoundException('Attendance record not found.');
      await tx.query(
        'UPDATE attendance SET exception_approved_by = $2, exception_reason = $3, exception_at = now() WHERE id = $1',
        [id, user.userId, reason],
      );
      await this.audit.byUser(tx, user, {
        action: 'attendance.exception',
        entityType: 'attendance',
        entityId: id,
        before: { exceptionReason: a.exception_reason },
        after: { exceptionReason: reason },
        reason,
      });
      // Reversing points needs a manager (section 6.8). A supervisor's approval leaves the
      // late event in place for a manager to reverse from the officer's score page.
      let pointsReversed = false;
      if (can(user.role, 'scores.reverse')) {
        pointsReversed = !!(await this.scoring.reverseFor(tx, 'attendance', id, 'late', `Approved exception: ${reason}`, {
          type: 'user',
          id: user.userId,
          label: user.name,
        }));
      }
      return { ok: true, pointsReversed };
    });
  }
}
