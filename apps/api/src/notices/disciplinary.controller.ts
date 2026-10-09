import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { HEARING_FINDINGS, HEARING_SANCTIONS, hearingDateError, HearingRecord, hearingRecordErrors, inquiryDocuments, noticeErrors, NoticeType, NOTICE_TYPE_LABELS, noticeStatus, NOTICE_EVENT_LABELS, NoticeEventKind } from '@onpar/rules';
import { z } from 'zod';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { CERTIFICATE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';
import { NoticesService } from './notices.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as year-month-day.');
const OpenBody = z.object({
  employeeId: z.string().uuid(),
  charge: z.string().trim().min(5, 'Write the charge.').max(1000),
  warningIds: z.array(z.string().uuid()).max(20).default([]),
  hearingDate: day,
  hearingTime: z.string().regex(/^\d{2}:\d{2}$/, 'Enter the time.'),
  venue: z.string().trim().min(2, 'Enter the venue.').max(200),
  chairperson: z.string().trim().max(120).default(''),
  initiator: z.string().trim().max(120).default(''),
  witnesses: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  representative: z.string().trim().max(120).default(''),
  // The notice to appear, as HR edited it.
  subject: z.string().trim().max(200),
  body: z.string().trim().max(20000),
});
const text = (max: number) => z.string().trim().max(max).optional();
const HearingBody = z.object({
  heldOn: day.optional(),
  chairperson: text(120),
  initiator: text(120),
  employeePresent: z.boolean().optional(),
  representative: text(120),
  interpreter: text(120),
  witnesses: text(2000),
  plea: z.enum(['guilty', 'not_guilty', '']).optional(),
  companyCase: text(5000),
  employeeCase: text(5000),
  mitigating: text(2000),
  aggravating: text(2000),
  finding: z.enum(['guilty', 'not_guilty', '']).optional(),
  reasons: text(5000),
  sanction: z.enum(['none', 'written_warning', 'final_written_warning', 'suspension', 'dismissal', 'other', '']).optional(),
  sanctionNote: text(500),
});
const PublishBody = z.object({ subject: z.string().trim().max(200), body: z.string().trim().max(20000) });
const WithdrawBody = z.object({ reason: z.string().trim().min(5, 'Say why the inquiry is withdrawn.').max(1000) });
const FileBody = z.object({ title: z.string().trim().min(2, 'Name the document, for example "Signed inquiry form".').max(120) });

/**
 * Disciplinary inquiries (owner, 9 Oct 2026; D-53). The manager chooses to proceed after the
 * third warning: the notice to appear goes with the three rights documents, at least three days
 * ahead (by default); after the inquiry HR fills in the form, uploads the signed copy, decides and
 * publishes the outcome to the employee. On Par records; people decide. Once published or
 * withdrawn a case never changes.
 */
@Controller('hr')
@UseGuards(UserAuthGuard)
export class DisciplinaryController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notices: NoticesService,
    private readonly storage: StorageService,
  ) {}

  private async today(tx: Tx) {
    return (await tx.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS d`)).rows[0].d as string;
  }

  private async employee(tx: Tx, id: string) {
    const e = (await tx.query(`SELECT e.id, e.full_name, e.employee_number, c.name AS company FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.id = $1`, [id])).rows[0];
    if (!e) throw new NotFoundException('Employee not found.');
    return e as { id: string; full_name: string; employee_number: string; company: string };
  }

  private async event(tx: Tx, caseId: string, kind: string, user: UserPrincipal, note = '', snapshot?: unknown) {
    await tx.query(`INSERT INTO disciplinary_events (company_id, case_id, kind, actor_id, actor_label, note, snapshot) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6)`, [
      caseId,
      kind,
      user.userId,
      user.name,
      note,
      snapshot === undefined ? null : JSON.stringify(snapshot),
    ]);
  }

  private async noticeState(tx: Tx, id: string | null) {
    if (!id) return null;
    const n = (await tx.query(`SELECT id, type, subject, issued_at FROM notices WHERE id = $1`, [id])).rows[0];
    if (!n) return null;
    const events = (await tx.query(`SELECT kind, at FROM notice_events WHERE notice_id = $1`, [id])).rows as { kind: NoticeEventKind; at: Date }[];
    const status = noticeStatus(events);
    return { id: n.id as string, typeLabel: NOTICE_TYPE_LABELS[n.type as NoticeType], subject: n.subject as string, issuedAt: n.issued_at as Date, status, statusLabel: NOTICE_EVENT_LABELS[status] };
  }

  /** What the "Proceed to disciplinary action" form starts from: the warnings and the settings. */
  @Get('case-draft/:employeeId')
  @RequirePermission('notices.issue')
  draft(@CurrentUser() user: UserPrincipal, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = await this.employee(tx, employeeId);
      const d = await this.notices.discipline(tx);
      return {
        companyName: e.company,
        employeeName: e.full_name,
        employeeNumber: e.employee_number,
        issuedBy: user.name,
        today: await this.today(tx),
        hearingMinDays: d.hearingMinDays,
        warnings: (await this.notices.warningsOnFile(tx, employeeId, d.warningMonths)).map(({ issuedAt: _i, ...w }) => w),
      };
    });
  }

  @Get('cases')
  @RequirePermission('notices.view')
  list(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT c.id, c.status, c.charge, to_char(c.hearing_date, 'YYYY-MM-DD') AS "hearingDate", to_char(c.hearing_time, 'HH24:MI') AS "hearingTime", c.venue, c.opened_at AS "openedAt",
                  c.closed_at AS "closedAt", c.hearing->>'finding' AS finding, c.hearing->>'sanction' AS sanction, e.full_name AS employee, e.employee_number AS "employeeNumber"
             FROM disciplinary_cases c JOIN employees e ON e.id = c.employee_id ORDER BY (c.status = 'notice_sent') DESC, c.opened_at DESC LIMIT 200`,
        )
      ).rows,
    );
  }

  @Get('cases/:id')
  @RequirePermission('notices.view')
  one(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const c = (await tx.query(`SELECT *, to_char(hearing_date, 'YYYY-MM-DD') AS hd, to_char(hearing_time, 'HH24:MI') AS ht FROM disciplinary_cases WHERE id = $1`, [id])).rows[0];
      if (!c) throw new NotFoundException('Case not found.');
      const e = await this.employee(tx, c.employee_id);
      const warnings = (await tx.query(`SELECT id, type, to_char(issued_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS date, coalesce(nullif(details->>'charge', ''), subject) AS charge FROM notices WHERE id = ANY($1::uuid[]) ORDER BY issued_at`, [
        c.warning_ids,
      ])).rows.map((w) => ({ id: w.id, label: NOTICE_TYPE_LABELS[w.type as NoticeType], date: w.date, charge: w.charge }));
      const events = (await tx.query(`SELECT id::text, kind, at, actor_label, note FROM disciplinary_events WHERE case_id = $1 ORDER BY at, id`, [id])).rows;
      const files = (await tx.query(`SELECT f.id, f.title, f.content_type AS "contentType", f.uploaded_at AS "uploadedAt", u.full_name AS "uploadedBy" FROM disciplinary_files f JOIN users u ON u.id = f.uploaded_by WHERE f.case_id = $1 ORDER BY f.uploaded_at`, [id])).rows;
      await this.audit.byUser(tx, user, { action: 'case.view', entityType: 'disciplinary_case', entityId: id });
      return {
        id: c.id as string,
        status: c.status as string,
        employeeId: e.id,
        employee: e.full_name,
        employeeNumber: e.employee_number,
        companyName: e.company,
        charge: c.charge as string,
        hearingDate: c.hd as string,
        hearingTime: c.ht as string,
        venue: c.venue as string,
        chairperson: c.chairperson as string,
        initiator: c.initiator as string,
        witnesses: c.witnesses as string[],
        hearing: c.hearing as HearingRecord,
        warnings,
        notice: await this.noticeState(tx, c.notice_id),
        outcome: await this.noticeState(tx, c.outcome_notice_id),
        events,
        files,
        openedAt: c.opened_at as Date,
        closedAt: (c.closed_at ?? null) as Date | null,
        findings: HEARING_FINDINGS,
        sanctions: HEARING_SANCTIONS,
      };
    });
  }

  /** Proceeds to a disciplinary inquiry: opens the case and sends the notice to appear with the three documents. */
  @Post('cases')
  @RequirePermission('notices.issue')
  open(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(OpenBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = await this.employee(tx, b.employeeId);
      const d = await this.notices.discipline(tx);
      const today = await this.today(tx);
      const dateProblem = hearingDateError(b.hearingDate, today, d.hearingMinDays);
      if (dateProblem) throw new BadRequestException({ message: dateProblem, errors: { hearingDate: dateProblem } });
      if ((await tx.query(`SELECT 1 FROM disciplinary_cases WHERE employee_id = $1 AND status = 'notice_sent'`, [b.employeeId])).rowCount) {
        throw new ConflictException('An inquiry is already open for this employee. Finish or withdraw it first.');
      }
      const warnings = (await this.notices.warningsOnFile(tx, b.employeeId, 120)).filter((w) => b.warningIds.includes(w.id));
      const documents = inquiryDocuments({
        companyName: e.company,
        employeeName: e.full_name,
        employeeNumber: e.employee_number,
        date: today,
        charge: b.charge,
        hearingDate: b.hearingDate,
        hearingTime: b.hearingTime,
        venue: b.venue,
        chairperson: b.chairperson,
      });
      const details = {
        charge: b.charge,
        hearingDate: b.hearingDate,
        hearingTime: b.hearingTime,
        venue: b.venue,
        chairperson: b.chairperson || undefined,
        witnesses: b.witnesses,
        representative: b.representative || undefined,
        warnings: warnings.map((w) => ({ label: w.label, date: w.date, charge: w.charge })),
        attachments: documents.map((x) => x.title),
      };
      const problems = noticeErrors('notice_to_appear', b.subject, b.body, details);
      if (problems) throw new BadRequestException({ message: Object.values(problems)[0], errors: problems });
      const noticeId = (
        await tx.query(
          `INSERT INTO notices (company_id, employee_id, type, subject, body, details, documents, ack_hours, issued_by) VALUES (app_company_id(), $1, 'notice_to_appear', $2, $3, $4, $5, $6, $7) RETURNING id`,
          [b.employeeId, b.subject, b.body, JSON.stringify(details), JSON.stringify(documents), await this.notices.ackHours(tx), user.userId],
        )
      ).rows[0].id as string;
      await this.notices.event(tx, noticeId, 'sent', { type: 'user', id: user.userId, label: user.name });
      const id = (
        await tx.query(
          `INSERT INTO disciplinary_cases (company_id, employee_id, charge, warning_ids, hearing_date, hearing_time, venue, chairperson, initiator, witnesses, notice_id, opened_by)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [b.employeeId, b.charge, JSON.stringify(warnings.map((w) => w.id)), b.hearingDate, b.hearingTime, b.venue, b.chairperson, b.initiator, JSON.stringify(b.witnesses), noticeId, user.userId],
        )
      ).rows[0].id as string;
      await this.event(tx, id, 'opened', user, b.charge);
      await this.event(tx, id, 'notice_sent', user, `Notice to appear, with: ${documents.map((x) => x.title).join('; ')}.`);
      await this.audit.byUser(tx, user, { action: 'case.open', entityType: 'disciplinary_case', entityId: id, after: { employeeId: b.employeeId, hearingDate: b.hearingDate, noticeId } });
      return { id, noticeId };
    });
  }

  private async openCase(tx: Tx, id: string) {
    const c = (await tx.query(`SELECT * FROM disciplinary_cases WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!c) throw new NotFoundException('Case not found.');
    if (c.status !== 'notice_sent') throw new ConflictException('This case is closed and can no longer be changed.');
    return c;
  }

  /** The inquiry form, saved as it is filled in. Fixed once the decision is published. */
  @Put('cases/:id/hearing')
  @RequirePermission('notices.issue')
  saveHearing(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const h = parseBody(HearingBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.openCase(tx, id);
      await tx.query(`UPDATE disciplinary_cases SET hearing = $2 WHERE id = $1`, [id, JSON.stringify(h)]);
      await this.event(tx, id, 'form_saved', user);
      return { ok: true, missing: hearingRecordErrors(h) };
    });
  }

  /** The signed inquiry form, statements or other evidence (PDF or photo). Kept; never removed. */
  @Post('cases/:id/files')
  @RequirePermission('notices.issue')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async addFile(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @UploadedFile() file?: { mimetype: string; buffer: Buffer }) {
    const b = parseBody(FileBody, body);
    if (!file) throw new BadRequestException('Choose the file to upload.');
    if (!CERTIFICATE_TYPES[file.mimetype]) throw new BadRequestException('Upload a PDF or a photo (JPEG, PNG or WebP).');
    return this.db.withTenant(user.companyId, async (tx) => {
      if (!(await tx.query('SELECT 1 FROM disciplinary_cases WHERE id = $1', [id])).rowCount) throw new NotFoundException('Case not found.');
      const key = await this.storage.put(user.companyId, 'discipline', file.buffer, CERTIFICATE_TYPES[file.mimetype]);
      const fileId = (await tx.query(`INSERT INTO disciplinary_files (company_id, case_id, title, storage_key, content_type, uploaded_by) VALUES (app_company_id(), $1, $2, $3, $4, $5) RETURNING id`, [id, b.title, key, file.mimetype, user.userId])).rows[0]
        .id as string;
      await this.event(tx, id, 'file_added', user, b.title);
      return { id: fileId };
    });
  }

  @Get('cases/:id/files/:fileId')
  @RequirePermission('notices.view')
  async file(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string, @Res() res: Response) {
    const f = await this.db.withTenant(user.companyId, async (tx) => {
      const r = (await tx.query(`SELECT storage_key AS key, content_type AS type, title FROM disciplinary_files WHERE id = $1 AND case_id = $2`, [fileId, id])).rows[0];
      if (!r) throw new NotFoundException('File not found.');
      await this.audit.byUser(tx, user, { action: 'case.file_view', entityType: 'disciplinary_case', entityId: id, after: { fileId } });
      return r as { key: string; type: string; title: string };
    });
    res.setHeader('Content-Type', f.type);
    res.setHeader('Content-Disposition', `inline; filename="${f.title.replace(/[^\w .-]/g, '')}${CERTIFICATE_TYPES[f.type] ?? ''}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(f.key));
  }

  /** The decision: the outcome notice goes to the employee and the case closes for good. */
  @Post('cases/:id/publish')
  @HttpCode(200)
  @RequirePermission('notices.issue')
  publish(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(PublishBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const c = await this.openCase(tx, id);
      const h = c.hearing as HearingRecord;
      const missing = hearingRecordErrors(h);
      if (missing) throw new BadRequestException({ message: `Finish the inquiry form first: ${Object.values(missing)[0]}`, errors: missing });
      const problems = noticeErrors('hearing_outcome', b.subject, b.body, { outcome: h.reasons });
      if (problems) throw new BadRequestException({ message: Object.values(problems)[0], errors: problems });
      const details = { charge: c.charge, hearingDate: h.heldOn, outcome: `${h.finding ? HEARING_FINDINGS[h.finding] : ''}: ${h.reasons ?? ''}`, sanction: h.sanction ? HEARING_SANCTIONS[h.sanction] : undefined };
      const noticeId = (
        await tx.query(`INSERT INTO notices (company_id, employee_id, type, subject, body, details, ack_hours, issued_by) VALUES (app_company_id(), $1, 'hearing_outcome', $2, $3, $4, $5, $6) RETURNING id`, [
          c.employee_id,
          b.subject,
          b.body,
          JSON.stringify(details),
          await this.notices.ackHours(tx),
          user.userId,
        ])
      ).rows[0].id as string;
      await this.notices.event(tx, noticeId, 'sent', { type: 'user', id: user.userId, label: user.name });
      await this.event(tx, id, 'published', user, `${h.finding ? HEARING_FINDINGS[h.finding] : ''}${h.sanction ? `; ${HEARING_SANCTIONS[h.sanction]}` : ''}`, h);
      await tx.query(`UPDATE disciplinary_cases SET status = 'published', outcome_notice_id = $2, closed_at = now() WHERE id = $1`, [id, noticeId]);
      await this.audit.byUser(tx, user, { action: 'case.publish', entityType: 'disciplinary_case', entityId: id, after: { finding: h.finding, sanction: h.sanction, noticeId } });
      return { ok: true, noticeId };
    });
  }

  /** The inquiry will not go ahead. The reason is kept. */
  @Post('cases/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('notices.issue')
  withdraw(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(WithdrawBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.openCase(tx, id);
      await this.event(tx, id, 'withdrawn', user, b.reason);
      await tx.query(`UPDATE disciplinary_cases SET status = 'withdrawn', closed_at = now() WHERE id = $1`, [id]);
      await this.audit.byUser(tx, user, { action: 'case.withdraw', entityType: 'disciplinary_case', entityId: id, reason: b.reason });
      return { ok: true };
    });
  }
}
