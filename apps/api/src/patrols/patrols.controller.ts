import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { ruleErrors, ruleFitWarning, sastDate, shiftLengthMinutes, SCAN_RESULT_LABELS } from '@onpar/rules';
import {
  CurrentGuard,
  CurrentUser,
  GuardAuthGuard,
  GuardPrincipal,
  RequirePermission,
  UserAuthGuard,
  UserPrincipal,
} from '../common/auth';
import { parseBody, throwIfErrors } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';
import { RetentionService } from '../privacy/retention.service';
import { ScoringService } from '../scoring/scoring.service';
import { PatrolsService, Upload } from './patrols.service';

const TypeBody = z.object({
  siteId: z.string().uuid(),
  code: z.string().trim().min(1, 'Give it a short code, like A.').max(4),
  name: z.string().trim().min(2, 'Name the patrol, for example Internal patrol.'),
  singleScan: z.boolean().default(false),
});
const TypeEdit = TypeBody.omit({ siteId: true }).extend({ active: z.boolean().default(true) });
const RuleBody = z.object({
  shiftId: z.string().uuid(),
  perShift: z.number().int(),
  minGapMinutes: z.number().int(),
  maxDurationMinutes: z.number().int(),
});
const CheckSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1), kind: z.literal('number'), label: z.string().trim().min(1), unit: z.string().trim().default(''), below: z.number().nullable().optional(), above: z.number().nullable().optional() }),
  z.object({ id: z.string().min(1), kind: z.literal('ok_problem'), label: z.string().trim().min(1) }),
  z.object({ id: z.string().min(1), kind: z.literal('photo'), label: z.string().trim().min(1) }),
]);
const PointBody = z.object({
  patrolTypeId: z.string().uuid(),
  name: z.string().trim().min(2, 'Name the point, for example Generator room.'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(5).max(500).default(30),
  instruction: z.string().trim().max(1000).default(''),
  photoMode: z.enum(['off', 'optional', 'required']).default('off'),
  noteMode: z.enum(['off', 'optional', 'required']).default('off'),
  checks: z.array(CheckSchema).max(20).default([]),
  active: z.boolean().default(true),
});
const AllocationBody = z.object({ shiftId: z.string().uuid(), points: z.number().min(0).max(1000) });
const ReviewBody = z.object({ decision: z.enum(['accepted', 'not_accepted']), note: z.string().trim().min(3, 'Add a short note.') });
const SafeBody = z.object({ note: z.string().trim().min(3, 'Say how you confirmed the guard is safe.') });

const isoTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const ScanBody = z.object({
  eventId: z.string().uuid(),
  patrolId: z.string().uuid(),
  qrCode: z.string().trim().min(1),
  lat: z.number(),
  lng: z.number(),
  accuracyM: z.number().min(0),
  trustedAt: isoTime,
  deviceClock: isoTime,
});
const ChecksBody = z.object({
  eventId: z.string().uuid(),
  note: z.string().max(2000).default(''),
  readings: z.array(z.object({ checkId: z.string(), value: z.number().optional(), ok: z.boolean().optional() })).default([]),
  trustedAt: isoTime,
  deviceClock: isoTime,
});
const CannotBody = z.object({ reason: z.string().trim().min(3, 'Say why the patrol could not be finished.'), trustedAt: isoTime, deviceClock: isoTime });

function jsonField(body: Record<string, unknown>): unknown {
  if (typeof body?.data !== 'string') return body;
  try {
    return JSON.parse(body.data);
  } catch {
    throw new BadRequestException('The form data could not be read.');
  }
}

/** A short code that is hard to guess, printed as a QR code at the point. */
function newQrCode() {
  return 'OP-' + randomBytes(9).toString('base64url').toUpperCase();
}

@Controller('patrols')
@UseGuards(UserAuthGuard)
export class PatrolsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly patrols: PatrolsService,
    private readonly scoring: ScoringService,
    private readonly retention: RetentionService,
  ) {}

  /** Everything set up for a site: shifts with allocations, types with rules and warnings, and points. */
  @Get('setup')
  @RequirePermission('patrols.view')
  setup(@CurrentUser() user: UserPrincipal, @Query('siteId', ParseUUIDPipe) siteId: string) {
    this.siteAccess(user, siteId);
    return this.db.withTenant(user.companyId, async (tx) => {
      const shifts = (
        await tx.query(
          `SELECT id, name, kind, to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime",
                  patrol_points::float AS "patrolPoints" FROM site_shifts WHERE site_id = $1 ORDER BY sort_order`,
          [siteId],
        )
      ).rows;
      const types = (await tx.query(`SELECT id, code, name, single_scan AS "singleScan", active FROM patrol_types WHERE site_id = $1 ORDER BY code`, [siteId])).rows;
      const rules = (
        await tx.query(
          `SELECT r.patrol_type_id AS "typeId", r.shift_id AS "shiftId", r.per_shift AS "perShift", r.min_gap_minutes AS "minGapMinutes",
                  r.max_duration_minutes AS "maxDurationMinutes"
             FROM patrol_rules r JOIN patrol_types t ON t.id = r.patrol_type_id WHERE t.site_id = $1`,
          [siteId],
        )
      ).rows.map((r) => {
        const s = shifts.find((x) => x.id === r.shiftId);
        return { ...r, warning: s ? ruleFitWarning(shiftLengthMinutes(s.startTime, s.endTime), r) : null };
      });
      const points = (
        await tx.query(
          `SELECT id, patrol_type_id AS "patrolTypeId", name, qr_code AS "qrCode", lat, lng, radius_m AS "radiusM", instruction,
                  photo_mode AS "photoMode", note_mode AS "noteMode", checks, active FROM patrol_points WHERE site_id = $1 ORDER BY sort_order, name`,
          [siteId],
        )
      ).rows;
      return { shifts, types, rules, points };
    });
  }

  @Post('types')
  @RequirePermission('patrols.setup')
  createType(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const t = parseBody(TypeBody, body);
    this.siteAccess(user, t.siteId);
    return this.db.withTenant(user.companyId, async (tx) => {
      try {
        const { id } = (
          await tx.query(`INSERT INTO patrol_types (company_id, site_id, code, name, single_scan) VALUES (app_company_id(), $1, upper($2), $3, $4) RETURNING id`, [
            t.siteId,
            t.code,
            t.name,
            t.singleScan,
          ])
        ).rows[0];
        await this.audit.byUser(tx, user, { action: 'patrol.type_create', entityType: 'patrol_type', entityId: id, after: t });
        return { id };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throwIfErrors({ code: 'This site already has a patrol with that code.' });
        if ((e as { code?: string }).code === '23503') throw new NotFoundException('Site not found.');
        throw e;
      }
    });
  }

  @Put('types/:id')
  @RequirePermission('patrols.setup')
  updateType(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const t = parseBody(TypeEdit, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = await this.type(tx, user, id);
      await tx.query('UPDATE patrol_types SET code = upper($2), name = $3, single_scan = $4, active = $5 WHERE id = $1', [id, t.code, t.name, t.singleScan, t.active]);
      await this.audit.byUser(tx, user, { action: 'patrol.type_update', entityType: 'patrol_type', entityId: id, before, after: t });
      return { id };
    });
  }

  /** Sets the three rules for a patrol type on one shift. Returns a warning if they cannot fit (section 6.5). */
  @Put('types/:id/rules')
  @RequirePermission('patrols.setup')
  setRule(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const r = parseBody(RuleBody, body);
    throwIfErrors(ruleErrors(r));
    return this.db.withTenant(user.companyId, async (tx) => {
      const t = await this.type(tx, user, id);
      const s = (await tx.query(`SELECT to_char(start_time, 'HH24:MI') AS st, to_char(end_time, 'HH24:MI') AS et FROM site_shifts WHERE id = $1 AND site_id = $2`, [r.shiftId, t.site_id])).rows[0];
      if (!s) throw new NotFoundException('That shift is not at this site.');
      await tx.query(
        `INSERT INTO patrol_rules (company_id, patrol_type_id, shift_id, per_shift, min_gap_minutes, max_duration_minutes)
         VALUES (app_company_id(), $1, $2, $3, $4, $5)
         ON CONFLICT (patrol_type_id, shift_id) DO UPDATE SET per_shift = $3, min_gap_minutes = $4, max_duration_minutes = $5`,
        [id, r.shiftId, r.perShift, r.minGapMinutes, r.maxDurationMinutes],
      );
      await this.audit.byUser(tx, user, { action: 'patrol.rules', entityType: 'patrol_type', entityId: id, after: r });
      return { warning: ruleFitWarning(shiftLengthMinutes(s.st, s.et), r) };
    });
  }

  @Delete('types/:id/rules/:shiftId')
  @RequirePermission('patrols.setup')
  removeRule(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('shiftId', ParseUUIDPipe) shiftId: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.type(tx, user, id);
      await tx.query('DELETE FROM patrol_rules WHERE patrol_type_id = $1 AND shift_id = $2', [id, shiftId]);
      await this.audit.byUser(tx, user, { action: 'patrol.rules_remove', entityType: 'patrol_type', entityId: id, after: { shiftId } });
      return { ok: true };
    });
  }

  /** The shift's patrol points allocation, shared across all its required patrols. */
  @Put('allocation')
  @RequirePermission('patrols.setup')
  allocation(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const a = parseBody(AllocationBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const s = (await tx.query('SELECT site_id FROM site_shifts WHERE id = $1', [a.shiftId])).rows[0];
      if (!s) throw new NotFoundException('Shift not found.');
      this.siteAccess(user, s.site_id);
      await tx.query('UPDATE site_shifts SET patrol_points = $2 WHERE id = $1', [a.shiftId, a.points]);
      await this.audit.byUser(tx, user, { action: 'patrol.allocation', entityType: 'site_shift', entityId: a.shiftId, after: a });
      return { ok: true };
    });
  }

  @Post('points')
  @RequirePermission('patrols.setup')
  createPoint(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const p = parseBody(PointBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const t = await this.type(tx, user, p.patrolTypeId);
      const { id } = (
        await tx.query(
          `INSERT INTO patrol_points (company_id, site_id, patrol_type_id, name, qr_code, lat, lng, radius_m, instruction, photo_mode, note_mode, checks, active,
                                      sort_order)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   (SELECT coalesce(max(sort_order), 0) + 1 FROM patrol_points WHERE patrol_type_id = $2)) RETURNING id`,
          [t.site_id, p.patrolTypeId, p.name, newQrCode(), p.lat, p.lng, p.radiusM, p.instruction, p.photoMode, p.noteMode, JSON.stringify(p.checks), p.active],
        )
      ).rows[0];
      await this.audit.byUser(tx, user, { action: 'patrol.point_create', entityType: 'patrol_point', entityId: id, after: p });
      return { id };
    });
  }

  @Put('points/:id')
  @RequirePermission('patrols.setup')
  updatePoint(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const p = parseBody(PointBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = (await tx.query('SELECT * FROM patrol_points WHERE id = $1', [id])).rows[0];
      if (!before) throw new NotFoundException('Point not found.');
      const t = await this.type(tx, user, p.patrolTypeId);
      if (t.site_id !== before.site_id) throw new BadRequestException('A point cannot move to another site.');
      await tx.query(
        `UPDATE patrol_points SET patrol_type_id = $2, name = $3, lat = $4, lng = $5, radius_m = $6, instruction = $7, photo_mode = $8,
                note_mode = $9, checks = $10, active = $11 WHERE id = $1`,
        [id, p.patrolTypeId, p.name, p.lat, p.lng, p.radiusM, p.instruction, p.photoMode, p.noteMode, JSON.stringify(p.checks), p.active],
      );
      await this.audit.byUser(tx, user, { action: 'patrol.point_update', entityType: 'patrol_point', entityId: id, before, after: p });
      return { id };
    });
  }

  /** One day's patrols, by the day each window started. */
  @Get()
  @RequirePermission('patrols.view')
  list(@CurrentUser() user: UserPrincipal, @Query('date') date?: string, @Query('siteId') siteId?: string) {
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : sastDate(new Date());
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT p.id, p.state, p.window_start AS "windowStart", p.window_end AS "windowEnd", p.started_at AS "startedAt",
                  p.finished_at AS "finishedAt", p.points_earned::float AS "pointsEarned", p.partial_reason AS "partialReason", p.review,
                  t.code AS "typeCode", t.name AS "typeName", e.full_name AS "employeeName", s.name AS "siteName",
                  (SELECT count(*)::int FROM patrol_visits v WHERE v.patrol_id = p.id AND v.done_at IS NOT NULL) AS "pointsDone",
                  (SELECT count(*)::int FROM patrol_points pt WHERE pt.patrol_type_id = p.patrol_type_id AND pt.active) AS "pointsTotal",
                  (SELECT count(*)::int FROM patrol_scans sc WHERE sc.patrol_id = p.id AND sc.result LIKE 'rejected%') AS "rejectedScans",
                  al.id AS "alertId", al.cleared_at AS "alertClearedAt"
             FROM patrol_instances p JOIN patrol_types t ON t.id = p.patrol_type_id JOIN employees e ON e.id = p.employee_id
             JOIN sites s ON s.id = p.site_id LEFT JOIN patrol_alerts al ON al.patrol_id = p.id
            WHERE p.window_start >= $1::date::timestamptz AND p.window_start < ($1::date + 1)::timestamptz
              AND ($2::uuid IS NULL OR p.site_id = $2::uuid) AND ($3::uuid[] IS NULL OR p.site_id = ANY($3::uuid[]))
            ORDER BY p.window_start, t.code, e.full_name`,
          [day, siteId || null, user.siteIds],
        )
      ).rows;
      // Compliance per type (section 6.11): completed out of windows so far.
      const byType = new Map<string, { typeCode: string; typeName: string; completed: number; total: number }>();
      for (const r of rows) {
        const k = `${r.siteName}·${r.typeCode}`;
        const v = byType.get(k) ?? { typeCode: r.typeCode, typeName: `${r.typeName} (${r.siteName})`, completed: 0, total: 0 };
        if (r.state !== 'active') v.total++;
        if (r.state === 'completed') v.completed++;
        byType.set(k, v);
      }
      // Rejected scans with no patrol (for example a code scanned from far away before starting).
      const loose = (
        await tx.query(
          `SELECT sc.id, sc.result, sc.official_at AS "at", sc.distance_m AS "distanceM", sc.accuracy_m AS "accuracyM", e.full_name AS "employeeName",
                  pt.name AS "pointName"
             FROM patrol_scans sc JOIN employees e ON e.id = sc.employee_id LEFT JOIN patrol_points pt ON pt.id = sc.point_id
            WHERE sc.patrol_id IS NULL AND sc.official_at >= $1::date::timestamptz AND sc.official_at < ($1::date + 1)::timestamptz
              AND ($2::uuid[] IS NULL OR pt.site_id = ANY($2::uuid[]))
            ORDER BY sc.official_at DESC`,
          [day, user.siteIds],
        )
      ).rows.map((r) => ({ ...r, label: SCAN_RESULT_LABELS[r.result as keyof typeof SCAN_RESULT_LABELS] ?? r.result }));
      return { date: day, rows, compliance: [...byType.values()], rejectedWithoutPatrol: loose };
    });
  }

  /** Open overdue alerts (section 6.5). */
  @Get('alerts')
  @RequirePermission('patrols.view')
  alerts(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT al.id, al.patrol_id AS "patrolId", al.raised_at AS "raisedAt", al.acknowledged_at AS "acknowledgedAt", al.escalated_at AS "escalatedAt",
                  u.full_name AS "acknowledgedBy", e.full_name AS "employeeName", e.cell_number AS "employeeCell", s.name AS "siteName",
                  t.name AS "typeName", t.code AS "typeCode", p.started_at AS "startedAt", p.max_duration_minutes AS "maxDurationMinutes",
                  (SELECT phone FROM site_contacts c WHERE c.site_id = al.site_id AND c.kind = 'control_room') AS "controlRoom"
             FROM patrol_alerts al JOIN patrol_instances p ON p.id = al.patrol_id JOIN patrol_types t ON t.id = p.patrol_type_id
             JOIN employees e ON e.id = al.employee_id JOIN sites s ON s.id = al.site_id LEFT JOIN users u ON u.id = al.acknowledged_by
            WHERE al.cleared_at IS NULL AND ($1::uuid[] IS NULL OR al.site_id = ANY($1::uuid[]))
            ORDER BY al.raised_at`,
          [user.siteIds],
        )
      ).rows;
    });
  }

  @Post('alerts/:id/acknowledge')
  @RequirePermission('patrols.alerts')
  acknowledge(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const al = await this.alert(tx, user, id);
      if (!al.acknowledged_at) await tx.query('UPDATE patrol_alerts SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1', [id, user.userId]);
      await this.audit.byUser(tx, user, { action: 'patrol.alert_ack', entityType: 'patrol_alert', entityId: id });
      return { ok: true };
    });
  }

  /** The supervisor confirms the guard is safe: clears the alert. */
  @Post('alerts/:id/safe')
  @RequirePermission('patrols.alerts')
  safe(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { note } = parseBody(SafeBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const al = await this.alert(tx, user, id);
      if (!al.acknowledged_at) await tx.query('UPDATE patrol_alerts SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1', [id, user.userId]);
      await this.patrols.clearAlert(tx, al.patrol_id, user.userId, `Guard confirmed safe: ${note}`);
      await this.audit.byUser(tx, user, { action: 'patrol.alert_safe', entityType: 'patrol_alert', entityId: id, reason: note });
      return { ok: true };
    });
  }

  @Get(':id')
  @RequirePermission('patrols.view')
  detail(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const p = (await tx.query('SELECT site_id, review, review_note, partial_reason, employee_id FROM patrol_instances WHERE id = $1', [id])).rows[0];
      if (!p) throw new NotFoundException('Patrol not found.');
      this.siteAccess(user, p.site_id);
      const view = await this.patrols.patrolView(tx, id);
      const employee = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [p.employee_id])).rows[0].full_name;
      const scans = (
        await tx.query(
          `SELECT sc.id, sc.result, sc.official_at AS "at", sc.received_at AS "receivedAt", sc.late_synced AS "lateSynced", sc.distance_m AS "distanceM",
                  sc.accuracy_m AS "accuracyM", pt.name AS "pointName"
             FROM patrol_scans sc LEFT JOIN patrol_points pt ON pt.id = sc.point_id WHERE sc.patrol_id = $1 ORDER BY sc.official_at`,
          [id],
        )
      ).rows.map((r) => ({ ...r, label: SCAN_RESULT_LABELS[r.result as keyof typeof SCAN_RESULT_LABELS] ?? r.result }));
      const visits = (
        await tx.query(
          `SELECT v.point_id AS "pointId", pt.name AS "pointName", v.scanned_at AS "scannedAt", v.done_at AS "doneAt", v.note,
                  v.photo_key IS NOT NULL AS "hasPhoto" FROM patrol_visits v JOIN patrol_points pt ON pt.id = v.point_id
            WHERE v.patrol_id = $1 ORDER BY v.scanned_at`,
          [id],
        )
      ).rows;
      const readings = (
        await tx.query(
          `SELECT r.point_id AS "pointId", r.label, r.kind, r.value_num::float AS "value", r.value_ok AS "ok", r.unit, r.out_of_limit AS "outOfLimit",
                  r.report_id AS "reportId", rep.number AS "reportNumber"
             FROM patrol_readings r LEFT JOIN reports rep ON rep.id = r.report_id WHERE r.patrol_id = $1 ORDER BY r.id`,
          [id],
        )
      ).rows;
      const alert = (
        await tx.query(
          `SELECT raised_at AS "raisedAt", acknowledged_at AS "acknowledgedAt", escalated_at AS "escalatedAt", cleared_at AS "clearedAt", clear_reason AS "clearReason"
             FROM patrol_alerts WHERE patrol_id = $1`,
          [id],
        )
      ).rows[0] ?? null;
      return { ...view, employeeName: employee, review: p.review, reviewNote: p.review_note, scans, visits, readings, alert };
    });
  }

  @Get(':id/points/:pointId/photo')
  @RequirePermission('patrols.view')
  async photo(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('pointId', ParseUUIDPipe) pointId: string, @Res() res: Response) {
    const v = await this.db.withTenant(user.companyId, async (tx) => {
      const row = (
        await tx.query(
          `SELECT v.photo_key, v.photo_content_type, p.site_id FROM patrol_visits v JOIN patrol_instances p ON p.id = v.patrol_id
            WHERE v.patrol_id = $1 AND v.point_id = $2`,
          [id, pointId],
        )
      ).rows[0];
      if (!row?.photo_key) throw new NotFoundException('Photo not found.');
      this.siteAccess(user, row.site_id);
      await this.retention.assertNotRemoved(tx, row.photo_key);
      return row;
    });
    res.setHeader('Content-Type', v.photo_content_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(v.photo_key));
  }

  /** Reviews a partial patrol. Not accepted counts as a missed patrol. */
  @Post(':id/review')
  @RequirePermission('patrols.alerts')
  review(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const r = parseBody(ReviewBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const p = (
        await tx.query(
          `SELECT p.*, t.name AS type_name, t.code, a.scheduled_start FROM patrol_instances p JOIN patrol_types t ON t.id = p.patrol_type_id
             JOIN attendance a ON a.id = p.attendance_id WHERE p.id = $1 FOR UPDATE OF p`,
          [id],
        )
      ).rows[0];
      if (!p) throw new NotFoundException('Patrol not found.');
      this.siteAccess(user, p.site_id);
      if (p.state !== 'partial') throw new ConflictException('Only a patrol that was ended early can be reviewed.');
      if (p.review) throw new ConflictException('This has already been reviewed.');
      await tx.query('UPDATE patrol_instances SET review = $2, reviewed_by = $3, review_note = $4 WHERE id = $1', [id, r.decision, user.userId, r.note]);
      if (r.decision === 'not_accepted') {
        await this.scoring.record(tx, {
          employeeId: p.employee_id,
          siteId: p.site_id,
          date: sastDate(new Date(p.scheduled_start)),
          type: 'missed_patrol',
          sourceType: 'patrol',
          sourceId: id,
          evidence: `${p.type_name} patrol (${p.code}) ended early (“${p.partial_reason}”); ${user.name} did not accept the reason: ${r.note}`,
        });
      }
      await this.audit.byUser(tx, user, { action: 'patrol.review', entityType: 'patrol', entityId: id, after: r });
      return { ok: true };
    });
  }

  private siteAccess(user: UserPrincipal, siteId: string) {
    if (user.siteIds && !user.siteIds.includes(siteId)) throw new NotFoundException('Site not found.');
  }

  private async type(tx: Tx, user: UserPrincipal, id: string) {
    const t = (await tx.query('SELECT * FROM patrol_types WHERE id = $1', [id])).rows[0];
    if (!t) throw new NotFoundException('Patrol type not found.');
    this.siteAccess(user, t.site_id);
    return t;
  }

  private async alert(tx: Tx, user: UserPrincipal, id: string) {
    const al = (await tx.query('SELECT * FROM patrol_alerts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!al) throw new NotFoundException('Alert not found.');
    this.siteAccess(user, al.site_id);
    if (al.cleared_at) throw new ConflictException('This alert has already been cleared.');
    return al;
  }
}

/** Patrols on the guard's post device. */
@Controller('device/patrols')
@UseGuards(GuardAuthGuard)
export class GuardPatrolsController {
  constructor(private readonly patrols: PatrolsService) {}

  @Get()
  state(@CurrentGuard() guard: GuardPrincipal) {
    return this.patrols.state(guard);
  }

  /** Scan a QR code. The first accepted scan with a new patrol ID starts that patrol. */
  @Post('scan')
  @HttpCode(200)
  scan(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    return this.patrols.scan(guard, parseBody(ScanBody, body));
  }

  /** Save the checks for a scanned point. Multipart: `data`, optional `photo`, and `check_<id>` for photo checks. */
  @Post(':patrolId/points/:pointId')
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 } }))
  checks(
    @CurrentGuard() guard: GuardPrincipal,
    @Param('patrolId', ParseUUIDPipe) patrolId: string,
    @Param('pointId', ParseUUIDPipe) pointId: string,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: Upload[] = [],
  ) {
    return this.patrols.saveChecks(guard, patrolId, pointId, parseBody(ChecksBody, jsonField(body)), files);
  }

  @Post(':patrolId/cannot-finish')
  @HttpCode(200)
  cannotFinish(@CurrentGuard() guard: GuardPrincipal, @Param('patrolId', ParseUUIDPipe) patrolId: string, @Body() body: unknown) {
    return this.patrols.cannotFinish(guard, patrolId, parseBody(CannotBody, body));
  }
}
