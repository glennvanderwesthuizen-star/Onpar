import {
  BadRequestException,
  Body,
  ConflictException,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { occurrenceStatus, sastDate, taskErrors, COULD_NOT_COMPLETE_REASONS, OccurrenceState } from '@onpar/rules';
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
import { TasksService, Upload } from './tasks.service';

const TaskBody = z.object({
  title: z.string().trim(),
  instructions: z.string().trim().max(2000).default(''),
  siteId: z.string().default(''),
  assigneeType: z.string(),
  assigneeEmployeeId: z.string().uuid().nullable().default(null),
  assigneeDeviceId: z.string().uuid().nullable().default(null),
  recurrence: z.string(),
  startDate: z.string(),
  endDate: z.string().nullable().default(null),
  timeRequired: z.boolean().default(false),
  dueTime: z.string().nullable().default(null),
  photoRequired: z.boolean().default(false),
});

/** What may change on an existing task. To change how often it repeats, stop it and create a new one. */
const TaskEdit = TaskBody.pick({
  title: true,
  instructions: true,
  assigneeType: true,
  assigneeEmployeeId: true,
  assigneeDeviceId: true,
  endDate: true,
  timeRequired: true,
  dueTime: true,
  photoRequired: true,
});

const ReviewBody = z.object({
  decision: z.enum(['accepted', 'not_accepted']),
  note: z.string().trim().min(3, 'Add a short note.'),
});

const isoTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const ActionBody = z.object({
  eventId: z.string().uuid(),
  comment: z.string().max(2000).default(''),
  trustedAt: isoTime,
  deviceClock: isoTime,
  photoToFollow: z.boolean().default(false),
});
const CannotBody = ActionBody.extend({
  reason: z.enum(Object.keys(COULD_NOT_COMPLETE_REASONS) as [keyof typeof COULD_NOT_COMPLETE_REASONS]),
});

function jsonField(body: Record<string, unknown>): unknown {
  if (typeof body?.data !== 'string') return body;
  try {
    return JSON.parse(body.data);
  } catch {
    throw new BadRequestException('The form data could not be read.');
  }
}

/** Tasks for supervisors and managers. */
@Controller('tasks')
@UseGuards(UserAuthGuard)
export class TasksController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly tasks: TasksService,
  ) {}

  @Get()
  @RequirePermission('tasks.view')
  list(@CurrentUser() user: UserPrincipal, @Query('siteId') siteId?: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT t.id, t.title, t.instructions, t.site_id AS "siteId", s.name AS "siteName", t.assignee_type AS "assigneeType",
                  t.assignee_employee_id AS "assigneeEmployeeId", t.assignee_device_id AS "assigneeDeviceId",
                  coalesce(e.full_name, d.label || coalesce(' (' || nullif(d.post_name, '') || ')', '')) AS "assigneeName",
                  t.recurrence, t.start_date AS "startDate", t.end_date AS "endDate", t.time_required AS "timeRequired",
                  to_char(t.due_time, 'HH24:MI') AS "dueTime", t.photo_required AS "photoRequired", t.active
             FROM tasks t JOIN sites s ON s.id = t.site_id
             LEFT JOIN employees e ON e.id = t.assignee_employee_id
             LEFT JOIN devices d ON d.id = t.assignee_device_id
            WHERE ($1::uuid IS NULL OR t.site_id = $1::uuid) AND ($2::uuid[] IS NULL OR t.site_id = ANY($2::uuid[]))
            ORDER BY t.active DESC, s.name, t.title`,
          [siteId || null, user.siteIds],
        )
      ).rows;
    });
  }

  @Post()
  @RequirePermission('tasks.manage')
  create(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const t = parseBody(TaskBody, body);
    throwIfErrors(taskErrors(t));
    if (t.startDate < sastDate(new Date())) {
      throwIfErrors({ startDate: 'The first date cannot be in the past.' });
    }
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.checkAssignee(tx, user, t);
      const { id } = (
        await tx.query(
          `INSERT INTO tasks (company_id, site_id, title, instructions, assignee_type, assignee_employee_id, assignee_device_id,
                              recurrence, start_date, end_date, time_required, due_time, photo_required, created_by)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [
            t.siteId,
            t.title,
            t.instructions,
            t.assigneeType,
            t.assigneeType === 'employee' ? t.assigneeEmployeeId : null,
            t.assigneeType === 'post' ? t.assigneeDeviceId : null,
            t.recurrence,
            t.startDate,
            t.endDate || null,
            t.timeRequired,
            t.timeRequired ? t.dueTime : null,
            t.photoRequired,
            user.userId,
          ],
        )
      ).rows[0];
      await this.tasks.generate(tx, id, new Date());
      await this.audit.byUser(tx, user, { action: 'task.create', entityType: 'task', entityId: id, after: t });
      return { id };
    });
  }

  /** Edits a task. Open occurrences from today onwards pick up the change; past ones keep what they were. */
  @Put(':id')
  @RequirePermission('tasks.manage')
  update(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const t = parseBody(TaskEdit, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = (await tx.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before || (user.siteIds && !user.siteIds.includes(before.site_id))) throw new NotFoundException('Task not found.');
      if (!before.active) throw new ConflictException('This task has been stopped.');
      throwIfErrors(
        taskErrors({ ...t, siteId: before.site_id, recurrence: before.recurrence, startDate: before.start_date }),
      );
      await this.checkAssignee(tx, user, { ...t, siteId: before.site_id });
      await tx.query(
        `UPDATE tasks SET title = $2, instructions = $3, assignee_type = $4, assignee_employee_id = $5, assignee_device_id = $6,
                end_date = $7, time_required = $8, due_time = $9, photo_required = $10, updated_at = now()
          WHERE id = $1`,
        [
          id,
          t.title,
          t.instructions,
          t.assigneeType,
          t.assigneeType === 'employee' ? t.assigneeEmployeeId : null,
          t.assigneeType === 'post' ? t.assigneeDeviceId : null,
          t.endDate || null,
          t.timeRequired,
          t.timeRequired ? t.dueTime : null,
          t.photoRequired,
        ],
      );
      const today = sastDate(new Date());
      await tx.query(
        `UPDATE task_occurrences o SET (title, instructions, due_time, photo_required, assignee_type, assignee_employee_id, assignee_device_id)
              = (SELECT title, instructions, due_time, photo_required, assignee_type, assignee_employee_id, assignee_device_id FROM tasks WHERE id = $1)
          WHERE o.task_id = $1 AND o.state = 'open' AND o.occurrence_date >= $2`,
        [id, today],
      );
      if (t.endDate) await this.cancelAfter(tx, id, t.endDate, user, 'After the new end date.');
      await this.audit.byUser(tx, user, { action: 'task.update', entityType: 'task', entityId: id, before, after: t });
      return { id };
    });
  }

  /** Stops a task. Today's occurrence stays; later ones are cancelled. */
  @Post(':id/stop')
  @RequirePermission('tasks.manage')
  stop(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const t = (await tx.query('SELECT site_id, active FROM tasks WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!t || (user.siteIds && !user.siteIds.includes(t.site_id))) throw new NotFoundException('Task not found.');
      await tx.query('UPDATE tasks SET active = false, updated_at = now() WHERE id = $1', [id]);
      const cancelled = await this.cancelAfter(tx, id, sastDate(new Date()), user, 'Task stopped.');
      await this.audit.byUser(tx, user, { action: 'task.stop', entityType: 'task', entityId: id, after: { cancelled } });
      return { cancelled };
    });
  }

  /** One day's task occurrences, with the status as of now (dashboard section 6.11). */
  @Get('board')
  @RequirePermission('tasks.view')
  board(@CurrentUser() user: UserPrincipal, @Query('date') date?: string, @Query('siteId') siteId?: string) {
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : sastDate(new Date());
    const now = new Date();
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT o.id, o.task_id AS "taskId", o.occurrence_date AS "date", o.title, to_char(o.due_time, 'HH24:MI') AS "dueTime",
                  o.photo_required AS "photoRequired", o.state, o.done_at AS "doneAt", o.cannot_reason AS "cannotReason",
                  o.review, o.photo_key IS NOT NULL AS "hasPhoto", o.photo_pending AS "photoPending",
                  s.name AS "siteName", ex.full_name AS "doneByName",
                  coalesce(e.full_name, d.label || coalesce(' (' || nullif(d.post_name, '') || ')', '')) AS "assigneeName"
             FROM task_occurrences o JOIN sites s ON s.id = o.site_id
             LEFT JOIN employees e ON e.id = o.assignee_employee_id
             LEFT JOIN devices d ON d.id = o.assignee_device_id
             LEFT JOIN employees ex ON ex.id = o.done_by
            WHERE o.occurrence_date = $1 AND ($2::uuid IS NULL OR o.site_id = $2::uuid)
              AND ($3::uuid[] IS NULL OR o.site_id = ANY($3::uuid[]))
            ORDER BY s.name, o.due_time NULLS LAST, o.title`,
          [day, siteId || null, user.siteIds],
        )
      ).rows.map((r) => ({ ...r, status: occurrenceStatus(r.state as OccurrenceState, r.date, r.dueTime, now) }));
      const count = (s: string) => rows.filter((r) => r.status === s).length;
      return {
        date: day,
        rows,
        counts: {
          completed: count('completed'),
          outstanding: count('open') + count('upcoming'),
          overdue: count('overdue'),
          missed: count('missed'),
          couldNotComplete: count('could_not_complete'),
          awaitingReview: rows.filter((r) => r.state === 'could_not_complete' && !r.review).length,
        },
      };
    });
  }

  @Get('occurrences/:id')
  @RequirePermission('tasks.view')
  occurrence(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const o = (
        await tx.query(
          `SELECT o.*, to_char(o.due_time, 'HH24:MI') AS due_hhmm, s.name AS site_name, ex.full_name AS done_by_name,
                  u.full_name AS reviewed_by_name, t.recurrence, t.active AS task_active,
                  coalesce(e.full_name, d.label || coalesce(' (' || nullif(d.post_name, '') || ')', '')) AS assignee_name
             FROM task_occurrences o JOIN sites s ON s.id = o.site_id JOIN tasks t ON t.id = o.task_id
             LEFT JOIN employees e ON e.id = o.assignee_employee_id
             LEFT JOIN devices d ON d.id = o.assignee_device_id
             LEFT JOIN employees ex ON ex.id = o.done_by
             LEFT JOIN users u ON u.id = o.reviewed_by
            WHERE o.id = $1`,
          [id],
        )
      ).rows[0];
      if (!o || (user.siteIds && !user.siteIds.includes(o.site_id))) throw new NotFoundException('Task not found.');
      const history = (
        await tx.query(
          `SELECT id, at, received_at, actor_type, actor_label, action, note, late_synced, drift_flagged
             FROM task_history WHERE occurrence_id = $1 ORDER BY at, id`,
          [id],
        )
      ).rows;
      const { photo_key, ...rest } = o;
      return {
        ...rest,
        has_photo: !!photo_key,
        status: occurrenceStatus(o.state, o.occurrence_date, o.due_hhmm, new Date()),
        history,
      };
    });
  }

  @Get('occurrences/:id/photo')
  @RequirePermission('tasks.view')
  async photo(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const o = await this.db.withTenant(user.companyId, async (tx) => {
      return (await tx.query('SELECT site_id, photo_key, photo_content_type FROM task_occurrences WHERE id = $1', [id])).rows[0];
    });
    if (!o?.photo_key || (user.siteIds && !user.siteIds.includes(o.site_id))) throw new NotFoundException('Photo not found.');
    res.setHeader('Content-Type', o.photo_content_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(o.photo_key));
  }

  /** A supervisor reviews "could not complete". Accepted: no penalty. Not accepted: counts as not done. */
  @Post('occurrences/:id/review')
  @RequirePermission('tasks.manage')
  review(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const r = parseBody(ReviewBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const o = (await tx.query('SELECT site_id, state, review FROM task_occurrences WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o || (user.siteIds && !user.siteIds.includes(o.site_id))) throw new NotFoundException('Task not found.');
      if (o.state !== 'could_not_complete') throw new ConflictException('Only "could not complete" can be reviewed.');
      if (o.review) throw new ConflictException('This has already been reviewed.');
      await tx.query(
        'UPDATE task_occurrences SET review = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1',
        [id, r.decision, user.userId, r.note],
      );
      await this.history(tx, id, user, r.decision === 'accepted' ? 'review_accepted' : 'review_not_accepted', r.note);
      await this.audit.byUser(tx, user, { action: 'task.review', entityType: 'task_occurrence', entityId: id, after: r });
      return { ok: true };
    });
  }

  private async checkAssignee(tx: Tx, user: UserPrincipal, t: { siteId: string; assigneeType: string; assigneeEmployeeId: string | null; assigneeDeviceId: string | null }) {
    if (user.siteIds && !user.siteIds.includes(t.siteId)) throw new NotFoundException('Site not found.');
    if (!(await tx.query('SELECT 1 FROM sites WHERE id = $1', [t.siteId])).rowCount) {
      throwIfErrors({ siteId: 'Choose a site.' });
    }
    if (t.assigneeType === 'employee') {
      const e = (await tx.query(`SELECT 1 FROM employees WHERE id = $1 AND status = 'active'`, [t.assigneeEmployeeId])).rowCount;
      if (!e) throwIfErrors({ assigneeEmployeeId: 'Choose an active officer.' });
    } else {
      const d = (await tx.query(`SELECT site_id FROM devices WHERE id = $1 AND status NOT IN ('disabled','retired')`, [t.assigneeDeviceId])).rows[0];
      if (!d) throwIfErrors({ assigneeDeviceId: 'Choose a working post device.' });
      if (d.site_id !== t.siteId) throwIfErrors({ assigneeDeviceId: 'That post is at a different site.' });
    }
  }

  private async cancelAfter(tx: Tx, taskId: string, date: string, user: UserPrincipal, note: string): Promise<number> {
    const rows = (
      await tx.query(
        `UPDATE task_occurrences SET state = 'cancelled' WHERE task_id = $1 AND state = 'open' AND occurrence_date > $2 RETURNING id`,
        [taskId, date],
      )
    ).rows;
    for (const r of rows) await this.history(tx, r.id, user, 'cancelled', note);
    return rows.length;
  }

  private history(tx: Tx, occurrenceId: string, user: UserPrincipal, action: string, note: string) {
    return tx.query(
      `INSERT INTO task_history (company_id, occurrence_id, at, actor_type, actor_id, actor_label, action, note)
       VALUES (app_company_id(), $1, now(), 'user', $2, $3, $4, $5)`,
      [occurrenceId, user.userId, user.name, action, note],
    );
  }
}

/** Tasks on the guard's post device. */
@Controller('device/tasks')
@UseGuards(GuardAuthGuard)
export class GuardTasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@CurrentGuard() guard: GuardPrincipal) {
    return this.tasks.guardTasks(guard);
  }

  /** Multipart: fields in `data`, optional `photo`. Or plain JSON. */
  @Post(':id/complete')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  complete(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @UploadedFile() photo?: Upload) {
    return this.tasks.complete(guard, id, parseBody(ActionBody, jsonField(body)), photo);
  }

  @Post(':id/cannot-complete')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  cannot(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @UploadedFile() photo?: Upload) {
    return this.tasks.cannotComplete(guard, id, parseBody(CannotBody, jsonField(body)), photo);
  }

  @Post(':id/photo')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  photo(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() photo?: Upload) {
    if (!photo) throw new BadRequestException('Attach the photo.');
    return this.tasks.attachPhoto(guard, id, photo);
  }
}
