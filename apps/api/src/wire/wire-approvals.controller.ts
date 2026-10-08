import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AWARD_KIND_LABELS, AWARD_KINDS, awardBarbsError, can, NOTE_STATUS_LABELS, noteErrors, sastDate } from '@onpar/rules';
import { z } from 'zod';
import { CurrentGuard, CurrentUser, GuardOrSelfAuthGuard, GuardPrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody, throwIfErrors } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';
import { WireService } from './wire.service';

const NoteBody = z.object({
  eventId: z.string().uuid(),
  noticed: z.string().trim().max(1000),
  suggestion: z.string().trim().max(1000),
  improves: z.string().trim().max(500),
});
const NoteDecision = z.object({
  status: z.enum(['under_review', 'adopted', 'declined']),
  reason: z.string().trim().max(1000).default(''),
});
const AwardBody = z.object({
  employeeId: z.string().uuid(),
  kind: z.enum(AWARD_KINDS),
  barbs: z.number().int().min(1).max(1000).optional(),
  why: z.string().trim().min(5, 'Say why, in a sentence the guard will read.').max(1000),
});
const AwardDecision = z.object({ approve: z.boolean(), reason: z.string().trim().max(1000).default('') });

function jsonField(body: Record<string, unknown>): unknown {
  if (typeof body?.data !== 'string') return body;
  try {
    return JSON.parse(body.data);
  } catch {
    throw new BadRequestException('The form data could not be read.');
  }
}

/** Approved awards and adopted notes of this month, for the limits in the rule book. */
async function monthCount(tx: Tx, employeeId: string, rule: string, today: string) {
  return (
    await tx.query(`SELECT count(*)::int AS n FROM wire_entries WHERE employee_id = $1 AND rule = $2 AND to_char(entry_date, 'YYYY-MM') = $3`, [employeeId, rule, today.slice(0, 7)])
  ).rows[0].n as number;
}

/** Recognition barbs a site has awarded this month. */
async function siteRecognitionUsed(tx: Tx, siteId: string | null, today: string) {
  return (
    await tx.query(`SELECT coalesce(sum(barbs), 0)::int AS n FROM wire_entries WHERE rule = 'discretionary' AND site_id IS NOT DISTINCT FROM $1 AND to_char(entry_date, 'YYYY-MM') = $2`, [
      siteId,
      today.slice(0, 7),
    ])
  ).rows[0].n as number;
}

/**
 * Thuthuka notes and awards approved by a person (rule book, 8 Oct 2026). Managers see and
 * propose; the owner (administrator) decides. Every decision has a reason the guard can read.
 */
@Controller('wire')
@UseGuards(UserAuthGuard)
export class WireApprovalsController {
  constructor(
    private readonly db: DbService,
    private readonly wire: WireService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /** What is waiting for a decision, and how much of each site's recognition budget is used this month. */
  @Get('approvals')
  @RequirePermission('wire.view')
  approvals(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const { settings } = await this.wire.settings(tx);
      const today = sastDate(new Date());
      const notes = (
        await tx.query(
          `SELECT n.id, n.status, n.noticed, n.suggestion, n.improves, n.photo_key IS NOT NULL AS "hasPhoto", n.reason, n.sent_at AS "sentAt", n.decided_at AS "decidedAt",
                  e.full_name AS guard, s.name AS site, u.full_name AS "decidedBy"
             FROM wire_notes n JOIN employees e ON e.id = n.employee_id LEFT JOIN sites s ON s.id = n.site_id LEFT JOIN users u ON u.id = n.decided_by
            WHERE ($1::uuid[] IS NULL OR n.site_id = ANY($1::uuid[])) AND (n.status IN ('sent','under_review') OR n.decided_at > now() - interval '30 days')
            ORDER BY (n.status IN ('sent','under_review')) DESC, n.sent_at DESC`,
          [user.siteIds],
        )
      ).rows.map((n) => ({ ...n, statusLabel: NOTE_STATUS_LABELS[n.status as keyof typeof NOTE_STATUS_LABELS] }));
      const awards = (
        await tx.query(
          `SELECT a.id, a.kind, a.barbs, a.why, a.status, a.reason, a.raised_at AS "raisedAt", a.decided_at AS "decidedAt", a.source_key IS NOT NULL AS "suggested",
                  e.full_name AS guard, s.name AS site, r.full_name AS "raisedBy", u.full_name AS "decidedBy"
             FROM wire_awards a JOIN employees e ON e.id = a.employee_id LEFT JOIN sites s ON s.id = a.site_id
             LEFT JOIN users r ON r.id = a.raised_by LEFT JOIN users u ON u.id = a.decided_by
            WHERE ($1::uuid[] IS NULL OR a.site_id = ANY($1::uuid[])) AND (a.status = 'pending' OR a.decided_at > now() - interval '30 days')
            ORDER BY (a.status = 'pending') DESC, a.raised_at DESC`,
          [user.siteIds],
        )
      ).rows.map((a) => ({ ...a, kindLabel: AWARD_KIND_LABELS[a.kind as keyof typeof AWARD_KIND_LABELS] }));
      const budget = (
        await tx.query(
          `SELECT s.id, s.name, coalesce((SELECT sum(w.barbs) FROM wire_entries w WHERE w.rule = 'discretionary' AND w.site_id = s.id AND to_char(w.entry_date, 'YYYY-MM') = $2), 0)::int AS used
             FROM sites s WHERE ($1::uuid[] IS NULL OR s.id = ANY($1::uuid[])) ORDER BY lower(s.name)`,
          [user.siteIds, today.slice(0, 7)],
        )
      ).rows.map((b) => ({ siteId: b.id, site: b.name, used: b.used, budget: settings.discretionaryBudgetPerSite }));
      return {
        notes,
        awards,
        budget,
        canDecide: can(user.role, 'wire.manage'),
        range: { min: settings.barbs.discretionaryMin, max: settings.barbs.discretionaryMax, praise: settings.barbs.customerPraise },
      };
    });
  }

  @Get('notes/:id/photo')
  @RequirePermission('wire.view')
  async notePhoto(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const n = await this.db.withTenant(user.companyId, async (tx) => (await tx.query('SELECT site_id, photo_key, photo_type FROM wire_notes WHERE id = $1', [id])).rows[0]);
    if (!n?.photo_key || (user.siteIds && !user.siteIds.includes(n.site_id))) throw new NotFoundException('No photo.');
    res.setHeader('Content-Type', n.photo_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(n.photo_key));
  }

  /**
   * A note is looked at (anyone who manages it), or adopted or not taken up (the owner). Adopting
   * pays the adoption barbs; the reason is shown to the guard either way.
   */
  @Post('notes/:id/decide')
  @RequirePermission('wire.view')
  @HttpCode(200)
  decideNote(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(NoteDecision, body);
    if (b.status !== 'under_review' && !can(user.role, 'wire.manage')) throw new ForbiddenException('Only the owner adopts or declines a Thuthuka note.');
    if (b.status !== 'under_review' && b.reason.length < 5) throw new BadRequestException({ message: 'Give the reason. The guard reads it.', errors: { reason: 'Give the reason.' } });
    return this.db.withTenant(user.companyId, async (tx) => {
      const n = (await tx.query('SELECT employee_id, site_id, status FROM wire_notes WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!n || (user.siteIds && !user.siteIds.includes(n.site_id))) throw new NotFoundException('Note not found.');
      if (n.status === 'adopted' || n.status === 'declined') throw new ConflictException('This note has already been decided.');
      await tx.query(
        `UPDATE wire_notes SET status = $2, reason = CASE WHEN $2 = 'under_review' THEN reason ELSE $3 END, acknowledged_at = coalesce(acknowledged_at, now()),
                decided_by = CASE WHEN $2 = 'under_review' THEN decided_by ELSE $4::uuid END, decided_at = CASE WHEN $2 = 'under_review' THEN decided_at ELSE now() END
          WHERE id = $1`,
        [id, b.status, b.reason, user.userId],
      );
      if (b.status === 'adopted') {
        const { settings } = await this.wire.settings(tx);
        await this.wire.earn(tx, { employeeId: n.employee_id, siteId: n.site_id, date: sastDate(new Date()), rule: 'thuthuka_adopted', barbs: settings.barbs.thuthukaAdopted, key: `note:${id}`, note: b.reason, by: user.userId });
      }
      await this.audit.byUser(tx, user, { action: `wire.note_${b.status}`, entityType: 'wire_note', entityId: id, reason: b.reason || undefined });
      return { ok: true };
    });
  }

  /** Customer praise (entered by a person until the customer app sends it) or a recognition award, waiting for the owner. */
  @Post('awards')
  @RequirePermission('wire.view')
  propose(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(AwardBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const { settings } = await this.wire.settings(tx);
      const e = (await tx.query('SELECT home_site_id FROM employees WHERE id = $1', [b.employeeId])).rows[0];
      if (!e || (user.siteIds && !user.siteIds.includes(e.home_site_id))) throw new NotFoundException('Guard not found.');
      const barbs = b.kind === 'customer_praise' ? settings.barbs.customerPraise : (b.barbs ?? 0);
      const problem = awardBarbsError(b.kind, barbs, settings);
      if (problem) throw new BadRequestException({ message: problem, errors: { barbs: problem } });
      const id = (
        await tx.query(`INSERT INTO wire_awards (company_id, employee_id, site_id, kind, barbs, why, raised_by) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6) RETURNING id`, [
          b.employeeId,
          e.home_site_id,
          b.kind,
          barbs,
          b.why,
          user.userId,
        ])
      ).rows[0].id;
      await this.audit.byUser(tx, user, { action: 'wire.award_propose', entityType: 'wire_award', entityId: id, after: { ...b, barbs } });
      return { id };
    });
  }

  /** The owner approves or declines. Approval pays the barbs, inside the monthly limits. */
  @Post('awards/:id/decide')
  @RequirePermission('wire.manage')
  @HttpCode(200)
  decideAward(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(AwardDecision, body);
    if (!b.approve && b.reason.length < 5) throw new BadRequestException({ message: 'Give the reason for declining.', errors: { reason: 'Give the reason.' } });
    return this.db.withTenant(user.companyId, async (tx) => {
      const a = (await tx.query('SELECT employee_id, site_id, kind, barbs, why, status FROM wire_awards WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!a) throw new NotFoundException('Award not found.');
      if (a.status !== 'pending') throw new ConflictException('This award has already been decided.');
      if (b.approve) {
        const { settings } = await this.wire.settings(tx);
        const today = sastDate(new Date());
        if (a.kind === 'customer_praise' && (await monthCount(tx, a.employee_id, 'customer_praise', today)) >= 1) {
          throw new ConflictException('This guard already has a customer praise award this month (one a month). Decline this one or approve it next month.');
        }
        if (a.kind === 'discretionary') {
          const used = await siteRecognitionUsed(tx, a.site_id, today);
          if (used + a.barbs > settings.discretionaryBudgetPerSite) {
            throw new ConflictException(`This site has ${Math.max(0, settings.discretionaryBudgetPerSite - used)} recognition barbs left this month.`);
          }
        }
        await this.wire.earn(tx, { employeeId: a.employee_id, siteId: a.site_id, date: today, rule: a.kind, barbs: a.barbs, key: `award:${id}`, note: b.reason || a.why, by: user.userId });
      }
      await tx.query(`UPDATE wire_awards SET status = $2, reason = $3, decided_by = $4, decided_at = now() WHERE id = $1`, [id, b.approve ? 'approved' : 'declined', b.reason, user.userId]);
      await this.audit.byUser(tx, user, { action: b.approve ? 'wire.award_approve' : 'wire.award_decline', entityType: 'wire_award', entityId: id, reason: b.reason || undefined });
      return { ok: true };
    });
  }
}

/** Thuthuka notes from the guard's phone. */
@Controller('device/wire/notes')
@UseGuards(GuardOrSelfAuthGuard)
export class GuardWireNotesController {
  constructor(
    private readonly db: DbService,
    private readonly wire: WireService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  mine(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT id, to_char(sent_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS date, suggestion, status, reason FROM wire_notes WHERE employee_id = $1 ORDER BY sent_at DESC LIMIT 20`,
          [guard.employeeId],
        )
      ).rows.map((n) => ({ ...n, statusLabel: NOTE_STATUS_LABELS[n.status as keyof typeof NOTE_STATUS_LABELS] })),
    );
  }

  /** Sends a note. Multipart with `data` and an optional `photo`, or JSON. Safe to retry. */
  @Post()
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async send(@CurrentGuard() guard: GuardPrincipal, @Body() body: Record<string, unknown>, @UploadedFile() photo?: { mimetype: string; buffer: Buffer }) {
    const b = parseBody(NoteBody, jsonField(body));
    throwIfErrors(noteErrors(b));
    if (photo && !IMAGE_TYPES[photo.mimetype]) throw new BadRequestException('The photo must be a JPEG, PNG or WebP image.');
    return this.db.withTenant(guard.companyId, async (tx) => {
      if ((await tx.query('SELECT 1 FROM wire_notes WHERE id = $1', [b.eventId])).rowCount) return { id: b.eventId, barbs: 0 };
      const key = photo ? await this.storage.put(guard.companyId, 'wire-notes', photo.buffer, IMAGE_TYPES[photo.mimetype]) : null;
      await tx.query(
        `INSERT INTO wire_notes (id, company_id, employee_id, site_id, noticed, suggestion, improves, photo_key, photo_type) VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8)`,
        [b.eventId, guard.employeeId, guard.siteId, b.noticed, b.suggestion, b.improves, key, photo?.mimetype ?? null],
      );
      // Submission barbs for the first notes of the month only (rule book: two a month).
      const { settings } = await this.wire.settings(tx);
      const today = sastDate(new Date());
      let barbs = 0;
      if ((await monthCount(tx, guard.employeeId, 'thuthuka_sent', today)) < settings.notesPaidPerMonth) {
        if (await this.wire.earn(tx, { employeeId: guard.employeeId, siteId: guard.siteId, date: today, rule: 'thuthuka_sent', barbs: settings.barbs.thuthukaSent, key: `note:${b.eventId}` })) {
          barbs = settings.barbs.thuthukaSent;
        }
      }
      return { id: b.eventId, barbs };
    });
  }
}
