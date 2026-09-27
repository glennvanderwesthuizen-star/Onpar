import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import {
  complianceSummary,
  currentQualifications,
  qualificationStatus,
  sastDate,
  sastLongDate,
  PSIRA_GRADES,
  QUALIFICATION_TYPES,
  QualificationStatus,
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
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { CERTIFICATE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';
import { ScoringService } from '../scoring/scoring.service';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.');
const QualificationBody = z.object({
  type: z.enum(Object.keys(QUALIFICATION_TYPES) as [keyof typeof QUALIFICATION_TYPES], { message: 'Choose the type.' }),
  name: z.string().trim().min(2, 'Name the course or qualification.').max(120),
  completionDate: date.nullable().optional(),
  expiryDate: date.nullable().optional(),
});
const PsiraBody = z.object({
  psiraNumber: z.string().trim().min(3, 'Enter the PSIRA number.'),
  psiraGrade: z.enum(PSIRA_GRADES, { message: 'Choose a grade, A to E.' }),
  psiraExpiry: date,
  reason: z.string().trim().min(3, 'Say what changed, for example renewed at PSIRA.'),
});

type Upload = { mimetype: string; size: number; buffer: Buffer };

function jsonField(body: Record<string, unknown>): unknown {
  if (typeof body?.data !== 'string') return body;
  try {
    return JSON.parse(body.data);
  } catch {
    throw new BadRequestException('The form data could not be read.');
  }
}

interface Item {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  siteId: string;
  siteName: string;
  qualificationId: string | null;
  type: string;
  name: string;
  expiryDate: string | null;
  status: QualificationStatus;
}

/** Every officer's current qualifications, plus PSIRA registration, with their status today. */
export async function currentItems(tx: Tx, siteIds: string[] | null, siteId: string | null, employeeId: string | null = null): Promise<Item[]> {
  const today = sastDate(new Date());
  const officers = (
    await tx.query(
      `SELECT e.id, e.full_name, e.employee_number, e.psira_grade, e.psira_expiry, s.id AS site_id, s.name AS site_name
         FROM employees e JOIN sites s ON s.id = e.home_site_id
        WHERE e.status = 'active' AND ($1::uuid IS NULL OR e.home_site_id = $1::uuid)
          AND ($2::uuid[] IS NULL OR e.home_site_id = ANY($2::uuid[])) AND ($3::uuid IS NULL OR e.id = $3::uuid)
        ORDER BY lower(e.full_name)`,
      [siteId, siteIds, employeeId],
    )
  ).rows;
  const records = (
    await tx.query(
      `SELECT id, employee_id, type, name, expiry_date AS "expiryDate" FROM qualifications WHERE employee_id = ANY($1::uuid[])`,
      [officers.map((o) => o.id)],
    )
  ).rows;
  const out: Item[] = [];
  for (const o of officers) {
    const base = { employeeId: o.id, employeeName: o.full_name, employeeNumber: o.employee_number, siteId: o.site_id, siteName: o.site_name };
    out.push({ ...base, qualificationId: null, type: 'psira', name: `PSIRA registration (grade ${o.psira_grade})`, expiryDate: o.psira_expiry, status: qualificationStatus(o.psira_expiry, today) });
    for (const q of currentQualifications(records.filter((r) => r.employee_id === o.id))) {
      out.push({ ...base, qualificationId: q.id, type: q.type, name: q.name, expiryDate: q.expiryDate, status: qualificationStatus(q.expiryDate, today) });
    }
  }
  return out;
}

/** Qualifications and training for managers (section 6.9). */
@Controller()
@UseGuards(UserAuthGuard)
export class TrainingController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly scoring: ScoringService,
  ) {}

  /** Compliance figures and every current item, most urgent first. */
  @Get('training')
  @RequirePermission('training.view')
  overview(@CurrentUser() user: UserPrincipal, @Query('siteId') siteId?: string, @Query('status') status?: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const items = await currentItems(tx, user.siteIds, siteId || null);
      const order: Record<QualificationStatus, number> = { EXPIRED: 0, EXPIRING: 1, COMPLIANT: 2 };
      const rows = items
        .filter((i) => !status || status === 'all' || i.status === status.toUpperCase())
        .sort((a, b) => order[a.status] - order[b.status] || (a.expiryDate ?? '9999').localeCompare(b.expiryDate ?? '9999'));
      return { summary: complianceSummary(items.map((i) => i.status)), rows };
    });
  }

  /** Records a qualification or a renewal, with its certificate. Completing training earns +1. */
  @Post('officers/:id/qualifications')
  @RequirePermission('training.record')
  @UseInterceptors(FileInterceptor('certificate', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async add(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @UploadedFile() file?: Upload) {
    const q = parseBody(QualificationBody, jsonField(body));
    if (file && !CERTIFICATE_TYPES[file.mimetype]) throw new BadRequestException('Certificates must be a PDF or an image.');
    const today = sastDate(new Date());
    if (q.completionDate && q.completionDate > today) throw new BadRequestException({ message: 'The completion date cannot be in the future.', errors: { completionDate: 'Not in the future.' } });
    if (q.completionDate && q.expiryDate && q.expiryDate < q.completionDate) {
      throw new BadRequestException({ message: 'The expiry date must be after completion.', errors: { expiryDate: 'After the completion date.' } });
    }
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = await this.officer(tx, user, id);
      const key = file ? await this.storage.put(user.companyId, `employees/${id}`, file.buffer, CERTIFICATE_TYPES[file.mimetype]) : null;
      const { id: qid } = (
        await tx.query(
          `INSERT INTO qualifications (company_id, employee_id, type, name, completion_date, expiry_date, certificate_key, certificate_content_type, recorded_by)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [id, q.type, q.name, q.completionDate ?? null, q.expiryDate ?? null, key, file?.mimetype ?? null, user.userId],
        )
      ).rows[0];
      await this.scoreCompletion(tx, qid, id, e.home_site_id, q.name, q.completionDate ?? null);
      await this.audit.byUser(tx, user, { action: 'training.record', entityType: 'employee', entityId: id, after: { ...q, certificate: !!file } });
      return { id: qid };
    });
  }

  /** Corrects a record (for example a typing mistake in a date). Audited with before and after. */
  @Put('qualifications/:id')
  @RequirePermission('training.record')
  async correct(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const q = parseBody(QualificationBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = (await tx.query('SELECT * FROM qualifications WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new NotFoundException('Qualification not found.');
      const e = await this.officer(tx, user, before.employee_id);
      await tx.query('UPDATE qualifications SET type = $2, name = $3, completion_date = $4, expiry_date = $5, updated_at = now() WHERE id = $1', [
        id,
        q.type,
        q.name,
        q.completionDate ?? null,
        q.expiryDate ?? null,
      ]);
      await this.scoreCompletion(tx, id, before.employee_id, e.home_site_id, q.name, q.completionDate ?? null);
      await this.audit.byUser(tx, user, { action: 'training.correct', entityType: 'employee', entityId: before.employee_id, before, after: q });
      return { id };
    });
  }

  @Get('qualifications/:id/certificate')
  @RequirePermission('training.view')
  async certificate(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const q = await this.db.withTenant(user.companyId, async (tx) => {
      const row = (await tx.query('SELECT employee_id, certificate_key, certificate_content_type FROM qualifications WHERE id = $1', [id])).rows[0];
      if (!row?.certificate_key) throw new NotFoundException('Certificate not found.');
      await this.officer(tx, user, row.employee_id);
      return row;
    });
    res.setHeader('Content-Type', q.certificate_content_type ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(q.certificate_key));
  }

  /** Updates PSIRA registration, for example after a renewal or a grade upgrade. Check it against PSIRA's records first. */
  @Put('officers/:id/psira')
  @RequirePermission('training.record')
  psira(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const p = parseBody(PsiraBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.officer(tx, user, id);
      const before = (await tx.query('SELECT psira_number, psira_grade, psira_expiry FROM employees WHERE id = $1', [id])).rows[0];
      await tx.query('UPDATE employees SET psira_number = $2, psira_grade = $3, psira_expiry = $4 WHERE id = $1', [id, p.psiraNumber, p.psiraGrade, p.psiraExpiry]);
      await this.audit.byUser(tx, user, { action: 'officer.psira_update', entityType: 'employee', entityId: id, before, after: p, reason: p.reason });
      return { ok: true };
    });
  }

  /** +1 for completed training (section 10), once per record. */
  private scoreCompletion(tx: Tx, qualificationId: string, employeeId: string, siteId: string, name: string, completionDate: string | null) {
    if (!completionDate) return null;
    return this.scoring.record(tx, {
      employeeId,
      siteId,
      date: completionDate,
      type: 'training_completed',
      sourceType: 'training',
      sourceId: qualificationId,
      evidence: `Completed ${name} on ${sastLongDate(completionDate)}.`,
    });
  }

  private async officer(tx: Tx, user: UserPrincipal, id: string) {
    const e = (await tx.query('SELECT id, home_site_id FROM employees WHERE id = $1', [id])).rows[0];
    if (!e || (user.siteIds && !user.siteIds.includes(e.home_site_id))) throw new NotFoundException('Officer not found.');
    return e;
  }
}

/** The officer's own qualifications on the device: employees can see their own data. */
@Controller('device/qualifications')
@UseGuards(GuardAuthGuard)
export class GuardTrainingController {
  constructor(private readonly db: DbService) {}

  @Get()
  mine(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const items = await currentItems(tx, null, null, guard.employeeId);
      return items.map(({ name, type, expiryDate, status }) => ({ name, type, expiryDate, status }));
    });
  }
}
