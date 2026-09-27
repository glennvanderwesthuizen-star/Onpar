import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import {
  reconcileTime,
  FOLLOW_UP_OUTCOMES,
  MANAGEMENT_ACTIONS,
  PRIORITIES,
  REPORT_CATEGORIES,
  REPORT_COLOURS,
} from '@onpar/rules';
import {
  CurrentGuard,
  CurrentUser,
  GuardAuthGuard,
  GuardPrincipal,
  RequirePermission,
  UserAuthGuard,
  UserPrincipal,
} from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';
import { ReportsService, Upload } from './reports.service';

const category = z.enum(Object.keys(REPORT_CATEGORIES) as [keyof typeof REPORT_CATEGORIES], { message: 'Choose a category.' });
const priority = z.enum(PRIORITIES, { message: 'Choose Green, Amber or Red.' });
const description = z.string().trim().min(3, 'Describe what you saw.').max(4000);
const isoTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));

const UserReportBody = z.object({ siteId: z.string().uuid('Choose a site.'), category, priority, description });
const ActBody = z.object({ note: z.string().trim().max(2000).default(''), assigneePersonId: z.string().uuid().nullable().optional() });
const NoteBody = z.object({ note: z.string().trim().min(2, 'Write the note.').max(2000) });
const PersonBody = z.object({
  name: z.string().trim().min(2, 'Enter the name.'),
  role: z.string().trim().min(2, 'Enter what they do, for example Plumber.'),
  phone: z.string().trim().min(6, 'Enter a phone number.'),
  kind: z.enum(['internal', 'contractor']),
  active: z.boolean().default(true),
});
const GuardReportBody = z.object({
  eventId: z.string().uuid(),
  category,
  priority,
  description,
  trustedAt: isoTime,
  deviceClock: isoTime,
  photoToFollow: z.boolean().default(false),
});
const FollowUpBody = z.object({
  eventId: z.string().uuid(),
  outcome: z.enum(Object.keys(FOLLOW_UP_OUTCOMES) as [keyof typeof FOLLOW_UP_OUTCOMES]),
  note: z.string().max(2000).default(''),
  trustedAt: isoTime,
  deviceClock: isoTime,
});

function jsonField(body: Record<string, unknown>): unknown {
  if (typeof body?.data !== 'string') return body;
  try {
    return JSON.parse(body.data);
  } catch {
    throw new BadRequestException('The form data could not be read.');
  }
}

const LIST_COLUMNS = `r.id, r.number, r.site_id AS "siteId", s.name AS "siteName", r.category, r.priority, r.description, r.stage,
  r.colour_slot AS "colourSlot", r.needs_attention AS "needsAttention", r.reported_at AS "reportedAt", r.closed_at AS "closedAt",
  r.photo_key IS NOT NULL AS "hasPhoto", r.photo_pending AS "photoPending", r.source,
  coalesce(e.full_name, u.full_name) AS "reportedBy", p.name AS "assigneeName", p.role AS "assigneeRole"`;
const LIST_FROM = `reports r JOIN sites s ON s.id = r.site_id
  LEFT JOIN employees e ON e.id = r.reported_by_employee LEFT JOIN users u ON u.id = r.reported_by_user
  LEFT JOIN people p ON p.id = r.assignee_person_id`;

const withColour = <T extends { colourSlot: number }>(r: T) => ({ ...r, colour: REPORT_COLOURS[r.colourSlot] });

/** Reports for supervisors and managers (section 6.6). */
@Controller()
@UseGuards(UserAuthGuard)
export class ReportsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly reports: ReportsService,
  ) {}

  @Get('reports')
  @RequirePermission('reports.view')
  list(@CurrentUser() user: UserPrincipal, @Query('status') status = 'open', @Query('siteId') siteId?: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT ${LIST_COLUMNS},
                  EXISTS (SELECT 1 FROM report_recipients rr WHERE rr.report_id = r.id AND rr.user_id = $4) AS "routedToMe"
             FROM ${LIST_FROM}
            WHERE ($1 = 'all' OR ($1 = 'open' AND r.stage <> 'closed') OR ($1 = 'closed' AND r.stage = 'closed'))
              AND ($2::uuid IS NULL OR r.site_id = $2::uuid) AND ($3::uuid[] IS NULL OR r.site_id = ANY($3::uuid[]))
            ORDER BY (r.stage = 'closed'), r.needs_attention DESC, (r.priority = 'red') DESC, r.number DESC
            LIMIT 500`,
          [status, siteId || null, user.siteIds, user.userId],
        )
      ).rows.map(withColour);
      // "400 reported, 387 resolved, 13 outstanding" (section 6.6)
      const counts = (
        await tx.query(
          `SELECT count(*)::int AS reported, count(*) FILTER (WHERE stage = 'closed')::int AS resolved,
                  count(*) FILTER (WHERE stage <> 'closed')::int AS outstanding,
                  count(*) FILTER (WHERE stage <> 'closed' AND needs_attention)::int AS "needsAttention",
                  count(*) FILTER (WHERE stage <> 'closed' AND priority = 'red')::int AS "redOpen"
             FROM reports WHERE ($1::uuid IS NULL OR site_id = $1::uuid) AND ($2::uuid[] IS NULL OR site_id = ANY($2::uuid[]))`,
          [siteId || null, user.siteIds],
        )
      ).rows[0];
      return { rows, counts };
    });
  }

  @Post('reports')
  @RequirePermission('reports.manage')
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  create(@CurrentUser() user: UserPrincipal, @Body() body: Record<string, unknown>, @UploadedFile() photo?: Upload) {
    const b = parseBody(UserReportBody, jsonField(body));
    if (user.siteIds && !user.siteIds.includes(b.siteId)) throw new NotFoundException('Site not found.');
    return this.db.withTenant(user.companyId, async (tx) => {
      if (!(await tx.query('SELECT 1 FROM sites WHERE id = $1', [b.siteId])).rowCount) throw new NotFoundException('Site not found.');
      const id = await this.reports.create(tx, user.companyId, { ...b, source: 'user', userId: user.userId, reportedAt: new Date(), photo }, { type: 'user', user });
      await this.audit.byUser(tx, user, { action: 'report.create', entityType: 'report', entityId: id, after: b });
      return { id };
    });
  }

  @Get('reports/:id')
  @RequirePermission('reports.view')
  get(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const r = (await tx.query(`SELECT ${LIST_COLUMNS}, r.linked_attendance_id AS "linkedAttendanceId", r.late_synced AS "lateSynced", r.received_at AS "receivedAt", r.assignee_person_id AS "assigneePersonId", p.phone AS "assigneePhone", p.kind AS "assigneeKind" FROM ${LIST_FROM} WHERE r.id = $1`, [id])).rows[0];
      if (!r || (user.siteIds && !user.siteIds.includes(r.siteId))) throw new NotFoundException('Report not found.');
      const history = (
        await tx.query(
          `SELECT h.id, h.at, h.received_at AS "receivedAt", h.actor_type AS "actorType", h.actor_label AS "actorLabel",
                  h.actor_role AS "actorRole", h.action, h.stage_after AS "stageAfter", h.outcome, h.note, h.late_synced AS "lateSynced",
                  h.photo_key IS NOT NULL AS "hasPhoto", p.name AS "assigneeName", p.role AS "assigneeRole"
             FROM report_history h LEFT JOIN people p ON p.id = h.assignee_person_id
            WHERE h.report_id = $1 ORDER BY h.at, h.id`,
          [id],
        )
      ).rows;
      const recipients = (
        await tx.query('SELECT u.full_name AS name, u.role FROM report_recipients rr JOIN users u ON u.id = rr.user_id WHERE rr.report_id = $1', [id])
      ).rows;
      const declaration = r.linkedAttendanceId
        ? (
            await tx.query(
              `SELECT d.official_at AS "at", d.statements, d.comment, a.shift_name AS "shiftName", a.shift_date AS "shiftDate"
                 FROM declarations d JOIN attendance a ON a.id = d.attendance_id
                WHERE d.attendance_id = $1 AND d.kind = 'duty_on'`,
              [r.linkedAttendanceId],
            )
          ).rows[0] ?? { pending: true }
        : null;
      const inspection = (
        await tx.query(
          `SELECT o.id, o.state, o.occurrence_date AS "date" FROM task_occurrences o JOIN tasks t ON t.id = o.task_id WHERE t.report_id = $1 ORDER BY o.created_at`,
          [id],
        )
      ).rows;
      return { ...withColour(r), history, recipients, declaration, inspection };
    });
  }

  @Get('reports/:id/photo')
  @RequirePermission('reports.view')
  async photo(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const r = await this.db.withTenant(user.companyId, async (tx) =>
      (await tx.query('SELECT site_id, photo_key AS key, photo_content_type AS type FROM reports WHERE id = $1', [id])).rows[0],
    );
    return this.sendPhoto(user, r, res);
  }

  @Get('reports/:id/history/:historyId/photo')
  @RequirePermission('reports.view')
  async historyPhoto(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('historyId') historyId: string, @Res() res: Response) {
    const r = await this.db.withTenant(user.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT r.site_id, h.photo_key AS key, h.photo_content_type AS type FROM report_history h JOIN reports r ON r.id = h.report_id
            WHERE h.report_id = $1 AND h.id = $2`,
          [id, Number(historyId) || 0],
        )
      ).rows[0],
    );
    return this.sendPhoto(user, r, res);
  }

  @Post('reports/:id/note')
  @RequirePermission('reports.manage')
  note(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { note } = parseBody(NoteBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.reports.note(tx, user, id, note);
      return { ok: true };
    });
  }

  /** assign | actioned | attendance_checked | close. Multipart allowed for a photo of the work. */
  @Post('reports/:id/:action')
  @RequirePermission('reports.manage')
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  act(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: keyof typeof MANAGEMENT_ACTIONS,
    @Body() body: Record<string, unknown>,
    @UploadedFile() photo?: Upload,
  ) {
    if (!Object.hasOwn(MANAGEMENT_ACTIONS, action)) throw new NotFoundException('Unknown action.');
    const b = parseBody(ActBody, jsonField(body));
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.reports.act(tx, user, id, action, { note: b.note, assigneePersonId: b.assigneePersonId, photo });
      await this.audit.byUser(tx, user, { action: `report.${action}`, entityType: 'report', entityId: id, after: b });
      return { ok: true };
    });
  }

  @Get('people')
  @RequirePermission('reports.view')
  people(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => (await tx.query('SELECT id, name, role, phone, kind, active FROM people ORDER BY NOT active, lower(name)')).rows);
  }

  @Post('people')
  @RequirePermission('people.manage')
  addPerson(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const p = parseBody(PersonBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const { id } = (
        await tx.query(`INSERT INTO people (company_id, name, role, phone, kind, active) VALUES (app_company_id(), $1, $2, $3, $4, $5) RETURNING id`, [
          p.name,
          p.role,
          p.phone,
          p.kind,
          p.active,
        ])
      ).rows[0];
      await this.audit.byUser(tx, user, { action: 'people.create', entityType: 'person', entityId: id, after: p });
      return { id };
    });
  }

  @Put('people/:id')
  @RequirePermission('people.manage')
  updatePerson(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const p = parseBody(PersonBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = (await tx.query('SELECT name, role, phone, kind, active FROM people WHERE id = $1', [id])).rows[0];
      if (!before) throw new NotFoundException('Person not found.');
      await tx.query('UPDATE people SET name = $2, role = $3, phone = $4, kind = $5, active = $6 WHERE id = $1', [id, p.name, p.role, p.phone, p.kind, p.active]);
      await this.audit.byUser(tx, user, { action: 'people.update', entityType: 'person', entityId: id, before, after: p });
      return { id };
    });
  }

  private async sendPhoto(user: UserPrincipal, r: { site_id: string; key: string | null; type: string } | undefined, res: Response) {
    if (!r?.key || (user.siteIds && !user.siteIds.includes(r.site_id))) throw new NotFoundException('Photo not found.');
    res.setHeader('Content-Type', r.type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(r.key));
  }
}

/** Reports on the guard's post device. */
@Controller('device/reports')
@UseGuards(GuardAuthGuard)
export class GuardReportsController {
  constructor(
    private readonly db: DbService,
    private readonly reports: ReportsService,
    private readonly storage: StorageService,
  ) {}

  /** The guard's own reports, and open reports at this site that anyone on site can follow up. */
  @Get()
  list(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT ${LIST_COLUMNS}, (r.reported_by_employee = $1) AS "mine"
             FROM ${LIST_FROM}
            WHERE (r.reported_by_employee = $1 AND (r.stage <> 'closed' OR r.closed_at > now() - interval '30 days'))
               OR (r.site_id = $2 AND r.stage <> 'closed')
            ORDER BY (r.stage = 'closed'), r.number DESC`,
          [guard.employeeId, guard.siteId],
        )
      ).rows.map(withColour);
    });
  }

  /** Make a report. Multipart with `data` and optional `photo`, or JSON. Safe to retry. */
  @Post()
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  create(@CurrentGuard() guard: GuardPrincipal, @Body() body: Record<string, unknown>, @UploadedFile() photo?: Upload) {
    const b = parseBody(GuardReportBody, jsonField(body));
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    if (!guard.siteId) throw new BadRequestException('This device is not assigned to a site.');
    return this.db.withTenant(guard.companyId, async (tx) => {
      const existing = (await tx.query('SELECT id, number FROM reports WHERE event_id = $1', [b.eventId])).rows[0];
      if (existing) return existing;
      const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0].full_name;
      const id = await this.reports.create(
        tx,
        guard.companyId,
        {
          siteId: guard.siteId!,
          category: b.category,
          priority: b.priority,
          description: b.description,
          source: 'guard',
          employeeId: guard.employeeId,
          deviceId: guard.deviceId,
          reportedAt: time.officialAt,
          lateSynced: time.lateSynced,
          eventId: b.eventId,
          photo,
          photoPending: b.photoToFollow,
        },
        { type: 'employee', id: guard.employeeId, name },
      );
      return (await tx.query('SELECT id, number FROM reports WHERE id = $1', [id])).rows[0];
    });
  }

  @Post(':id/photo')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  addPhoto(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() photo?: Upload) {
    if (!photo) throw new BadRequestException('Attach the photo.');
    return this.db.withTenant(guard.companyId, async (tx) => {
      const r = (await tx.query('SELECT reported_by_employee, photo_key FROM reports WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r || r.reported_by_employee !== guard.employeeId) throw new NotFoundException('Report not found.');
      if (!r.photo_key) {
        if (!IMAGE_TYPES[photo.mimetype]) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
        const key = await this.storage.put(guard.companyId, 'reports', photo.buffer, IMAGE_TYPES[photo.mimetype]);
        await tx.query('UPDATE reports SET photo_key = $2, photo_content_type = $3, photo_pending = false WHERE id = $1', [id, key, photo.mimetype]);
      }
      return { ok: true };
    });
  }

  /** Follow up on a report (section 6.6). Multipart with `data` and optional `photo`, or JSON. Safe to retry. */
  @Post(':id/follow-up')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  followUp(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @UploadedFile() photo?: Upload) {
    const b = parseBody(FollowUpBody, jsonField(body));
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    return this.db.withTenant(guard.companyId, async (tx) => {
      await this.reports.followUp(tx, guard, id, { eventId: b.eventId, outcome: b.outcome, note: b.note, at: time.officialAt, lateSynced: time.lateSynced, photo });
      return (await tx.query('SELECT id, number, stage FROM reports WHERE id = $1', [id])).rows[0];
    });
  }
}
