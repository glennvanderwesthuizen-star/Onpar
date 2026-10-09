import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { NOTICE_TYPES, NoticeEventKind, noticeErrors, NoticeType, suggestedActions, WARNING_LADDER } from '@onpar/rules';
import { z } from 'zod';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { hashToken } from '../common/crypto';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';
import { NoticesService } from './notices.service';

const Details = z
  .object({
    charge: z.string().trim().max(500).optional(),
    incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    hearingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    hearingTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    venue: z.string().trim().max(200).optional(),
    chairperson: z.string().trim().max(120).optional(),
    witnesses: z.array(z.string().trim().max(120)).max(20).optional(),
    representative: z.string().trim().max(120).optional(),
    outcome: z.string().trim().max(2000).optional(),
    sanction: z.string().trim().max(500).optional(),
  })
  .default({});
const IssueBody = z.object({
  employeeId: z.string().uuid(),
  type: z.enum(NOTICE_TYPES),
  subject: z.string().trim().max(200),
  body: z.string().trim().max(20000),
  details: Details,
  evidence: z.array(z.string().uuid()).max(50).default([]),
});
const HandBody = z.object({ note: z.string().trim().min(3, 'Say who delivered it, where, and whether the employee signed.').max(1000) });
const SettingsBody = z.object({ noticeAckHours: z.number().int().min(1).max(720), noticesOnPostPhone: z.boolean().default(true), reason: z.string().trim().min(3, 'Say why.') });

/** One-time portal codes: no confusable letters, 10 characters. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function portalCode(): string {
  const b = randomBytes(10);
  return Array.from(b, (x) => CODE_LETTERS[x % CODE_LETTERS.length]).join('');
}
/** A portal code is printed or read out, so spaces and case do not matter. */
export const tidyCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const PORTAL_CODE_DAYS = 7;

/**
 * HR notices (brief sections 6.16 and 28; owner's step 7, 8 Oct 2026). Only HR and management.
 * A notice is never changed once sent; everything that happens to it is a new event.
 */
@Controller('hr')
@UseGuards(UserAuthGuard)
export class HrNoticesController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notices: NoticesService,
    private readonly storage: StorageService,
  ) {}

  private async list(tx: Tx, where: string, params: unknown[]) {
    const rows = (
      await tx.query(
        `SELECT n.*, e.full_name AS employee, e.employee_number, s.name AS site, u.full_name AS issued_by_name
           FROM notices n JOIN employees e ON e.id = n.employee_id LEFT JOIN sites s ON s.id = e.home_site_id JOIN users u ON u.id = n.issued_by
          WHERE ${where} ORDER BY n.issued_at DESC LIMIT 200`,
        params,
      )
    ).rows;
    const events = rows.length ? (await tx.query(`SELECT notice_id, kind, at FROM notice_events WHERE notice_id = ANY($1::uuid[]) ORDER BY at, id`, [rows.map((r) => r.id)])).rows : [];
    return rows.map((n) => ({ row: n, view: this.notices.shape(n, events.filter((e) => e.notice_id === n.id) as { kind: NoticeEventKind; at: Date }[]) }));
  }

  /** Every notice, newest first; those needing hand delivery are marked. */
  @Get('notices')
  @RequirePermission('notices.view')
  all(@CurrentUser() user: UserPrincipal, @Query('employeeId') employeeId?: string) {
    if (employeeId && !/^[0-9a-f-]{36}$/.test(employeeId)) throw new BadRequestException('Unknown employee.');
    return this.db.withTenant(user.companyId, async (tx) => (await this.list(tx, '($1::uuid IS NULL OR n.employee_id = $1::uuid)', [employeeId ?? null])).map((x) => x.view));
  }

  /** The employees HR can send a notice to, with whether their portal is open. */
  @Get('employees')
  @RequirePermission('notices.view')
  employees(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT e.id, e.full_name AS name, e.employee_number AS "employeeNumber", s.name AS site, a.login, a.activated_at IS NOT NULL AS "portalActive"
             FROM employees e LEFT JOIN sites s ON s.id = e.home_site_id LEFT JOIN portal_accounts a ON a.employee_id = e.id
            WHERE e.status = 'active' ORDER BY lower(e.full_name)`,
        )
      ).rows,
    );
  }

  @Get('notices/:id')
  @RequirePermission('notices.view')
  one(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const [n] = await this.list(tx, 'n.id = $1', [id]);
      if (!n) throw new NotFoundException('Notice not found.');
      const events = (await this.notices.events(tx, id)).map(({ photo_key, ...e }) => ({ ...e, hasPhoto: !!photo_key }));
      await this.audit.byUser(tx, user, { action: 'notice.view', entityType: 'notice', entityId: id });
      return { ...n.view, body: n.row.body, details: n.row.details, evidence: n.row.evidence, ackHours: n.row.ack_hours, events };
    });
  }

  /** What the notice form fills in: the employee's details and how many of each kind are already on file. */
  @Get('notice-context/:employeeId')
  @RequirePermission('notices.issue')
  context(@CurrentUser() user: UserPrincipal, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = (
        await tx.query(
          `SELECT e.id, e.full_name, e.employee_number, s.name AS site, c.name AS company FROM employees e LEFT JOIN sites s ON s.id = e.home_site_id JOIN companies c ON c.id = e.company_id WHERE e.id = $1`,
          [employeeId],
        )
      ).rows[0];
      if (!e) throw new NotFoundException('Employee not found.');
      const counts = (await tx.query(`SELECT type, count(*)::int AS n FROM notices WHERE employee_id = $1 GROUP BY type`, [employeeId])).rows;
      const portal = (await tx.query(`SELECT login, activated_at FROM portal_accounts WHERE employee_id = $1`, [employeeId])).rows[0];
      // Not yet reversed, newest first.
      const events = (
        await tx.query(
          `SELECT p.id, p.evidence AS label, p.impact::float AS points, to_char(p.event_date, 'YYYY-MM-DD') AS date FROM performance_events p
            WHERE p.employee_id = $1 AND p.impact < 0 AND p.reverses_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM performance_events r WHERE r.reverses_event_id = p.id)
            ORDER BY p.event_date DESC, p.created_at DESC LIMIT 20`,
          [employeeId],
        )
      ).rows;
      return {
        companyName: e.company,
        employeeName: e.full_name,
        employeeNumber: e.employee_number,
        siteName: e.site ?? null,
        issuedBy: user.name,
        prior: Object.fromEntries(NOTICE_TYPES.map((t) => [t, counts.find((c) => c.type === t)?.n ?? 0])),
        portal: portal ? { login: portal.login, active: !!portal.activated_at } : null,
        // Recent negative performance events HR may cite as evidence. Never a trigger.
        evidence: events,
        ackHours: await this.notices.ackHours(tx),
      };
    });
  }

  /** Sends a notice. It is never changed afterwards. */
  @Post('notices')
  @RequirePermission('notices.issue')
  issue(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(IssueBody, body);
    const problems = noticeErrors(b.type, b.subject, b.body, b.details);
    if (problems) throw new BadRequestException({ message: Object.values(problems)[0], errors: problems });
    return this.db.withTenant(user.companyId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM employees WHERE id = $1`, [b.employeeId])).rowCount) throw new NotFoundException('Employee not found.');
      const id = (
        await tx.query(
          `INSERT INTO notices (company_id, employee_id, type, subject, body, details, evidence, ack_hours, issued_by) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [b.employeeId, b.type, b.subject, b.body, JSON.stringify(b.details), JSON.stringify(b.evidence), await this.notices.ackHours(tx), user.userId],
        )
      ).rows[0].id as string;
      await this.notices.event(tx, id, 'sent', { type: 'user', id: user.userId, label: user.name });
      await this.audit.byUser(tx, user, { action: 'notice.issue', entityType: 'notice', entityId: id, after: { employeeId: b.employeeId, type: b.type } });
      return { id };
    });
  }

  /** The notice was delivered by hand: who, where, whether signed, with a photo of the signed copy. */
  @Post('notices/:id/hand-delivered')
  @HttpCode(200)
  @RequirePermission('notices.issue')
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async handDelivered(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @UploadedFile() photo?: { mimetype: string; buffer: Buffer }) {
    const b = parseBody(HandBody, body);
    if (photo && !IMAGE_TYPES[photo.mimetype]) throw new BadRequestException('The photo must be JPEG, PNG or WebP.');
    return this.db.withTenant(user.companyId, async (tx) => {
      if (!(await tx.query('SELECT 1 FROM notices WHERE id = $1', [id])).rowCount) throw new NotFoundException('Notice not found.');
      const key = photo ? await this.storage.put(user.companyId, 'notices', photo.buffer, IMAGE_TYPES[photo.mimetype]) : null;
      await this.notices.event(tx, id, 'hand_delivered', { type: 'user', id: user.userId, label: user.name }, b.note, key ? { key, type: photo!.mimetype } : undefined);
      await this.audit.byUser(tx, user, { action: 'notice.hand_delivered', entityType: 'notice', entityId: id, after: { photo: !!key } });
      return { ok: true };
    });
  }

  /** The photo of the signed copy. Each look is recorded. */
  @Get('notices/:id/events/:eventId/photo')
  @RequirePermission('notices.view')
  async signedCopy(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('eventId') eventId: string, @Res() res: Response) {
    if (!/^\d+$/.test(eventId)) throw new NotFoundException('Photo not found.');
    const p = await this.db.withTenant(user.companyId, async (tx) => {
      const r = (await tx.query(`SELECT photo_key AS key, photo_type AS type FROM notice_events WHERE id = $1 AND notice_id = $2`, [eventId, id])).rows[0];
      if (!r?.key) throw new NotFoundException('Photo not found.');
      await this.audit.byUser(tx, user, { action: 'notice.signed_copy_view', entityType: 'notice', entityId: id });
      return r as { key: string; type: string };
    });
    res.setHeader('Content-Type', p.type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(p.key));
  }

  /** Patterns HR may want to look at. A suggestion only fills in the form; it never sends anything. */
  @Get('suggestions')
  @RequirePermission('notices.issue')
  suggestions(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT e.id, e.full_name AS name, s.name AS site,
                  (SELECT count(*)::int FROM attendance a WHERE a.employee_id = e.id AND a.arrival_status = 'LATE' AND a.duty_on_at > now() - interval '30 days') AS late,
                  (SELECT count(*)::int FROM task_occurrences o WHERE o.assignee_employee_id = e.id AND o.state = 'missed' AND o.occurrence_date > current_date - 30) AS missed,
                  EXISTS (SELECT 1 FROM notices n WHERE n.employee_id = e.id AND n.type = ANY($1::text[]) AND n.issued_at > now() - interval '90 days') AS warned
             FROM employees e LEFT JOIN sites s ON s.id = e.home_site_id WHERE e.status = 'active'`,
          [WARNING_LADDER],
        )
      ).rows;
      return rows.flatMap((r) =>
        suggestedActions({ lateArrivals30: r.late, missedTasks30: r.missed, recentWarning: r.warned }).map((s) => ({ employeeId: r.id as string, name: r.name as string, site: (r.site ?? null) as string | null, ...s })),
      );
    });
  }

  @Get('settings')
  @RequirePermission('notices.view')
  settings(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => ({ noticeAckHours: await this.notices.ackHours(tx), noticesOnPostPhone: await this.notices.onPostPhone(tx) }));
  }

  @Put('settings')
  @RequirePermission('notices.issue')
  saveSettings(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(SettingsBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = { noticeAckHours: await this.notices.ackHours(tx), noticesOnPostPhone: await this.notices.onPostPhone(tx) };
      await tx.query(
        `INSERT INTO hr_settings (company_id, notice_ack_hours, notices_on_post_phone, updated_by, updated_at) VALUES (app_company_id(), $1, $3, $2, now())
         ON CONFLICT (company_id) DO UPDATE SET notice_ack_hours = $1, notices_on_post_phone = $3, updated_by = $2, updated_at = now()`,
        [b.noticeAckHours, user.userId, b.noticesOnPostPhone],
      );
      const after = { noticeAckHours: b.noticeAckHours, noticesOnPostPhone: b.noticesOnPostPhone };
      await this.audit.byUser(tx, user, { action: 'hr.settings', entityType: 'company', entityId: user.companyId, before, after, reason: b.reason });
      return after;
    });
  }

  /**
   * A one-time code for the employee to open his portal on his own phone (no SMS yet). Shown
   * once; a new code replaces the old one and resets his password.
   */
  @Post('employees/:id/portal-code')
  @HttpCode(200)
  @RequirePermission('notices.issue')
  portalCode(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = (await tx.query(`SELECT id, full_name, employee_number, tsf_number, status FROM employees WHERE id = $1`, [id])).rows[0];
      if (!e) throw new NotFoundException('Employee not found.');
      if (e.status !== 'active') throw new BadRequestException('This employee is not active.');
      let login = (await tx.query('SELECT login FROM portal_accounts WHERE employee_id = $1', [id])).rows[0]?.login as string | undefined;
      if (!login) {
        const base = String(e.tsf_number ?? e.employee_number).replace(/\s+/g, '').toUpperCase();
        login = base;
        for (let i = 2; (await tx.query('SELECT auth_portal_login_taken($1, $2) AS t', [login, id])).rows[0].t; i++) login = `${base}-${i}`;
      }
      const code = portalCode();
      const expires = new Date(Date.now() + PORTAL_CODE_DAYS * 86_400_000);
      await tx.query(
        `INSERT INTO portal_accounts (employee_id, company_id, login, code_hash, code_expires_at) VALUES ($1, app_company_id(), $2, $3, $4)
         ON CONFLICT (employee_id) DO UPDATE SET code_hash = $3, code_expires_at = $4, password_hash = NULL, activated_at = NULL, updated_at = now()`,
        [id, login, hashToken(code), expires],
      );
      await this.audit.byUser(tx, user, { action: 'portal.code', entityType: 'employee', entityId: id, after: { login, expires } });
      return { login, code, expiresAt: expires, employee: e.full_name as string };
    });
  }
}
