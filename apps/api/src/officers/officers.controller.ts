import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import {
  enrolmentErrors,
  maskIdNumber,
  qualificationStatus,
  siteFitWarnings,
  validateSaId,
  REQUIRED_PHOTO_KINDS,
  PhotoKind,
  PsiraGrade,
} from '@onpar/rules';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { encrypt, hashSecret, hmac, newPin } from '../common/crypto';
import { parseBody, throwIfErrors } from '../common/validation';
import { CONFIG, Config } from '../config';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { CERTIFICATE_TYPES, IMAGE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.');

const EnrolBody = z.object({
  employeeNumber: z.string().trim().max(20).optional(),
  fullName: z.string().trim().default(''),
  idNumber: z.string().trim().default(''),
  cellNumber: z.string().trim().default(''),
  nextOfKinName: z.string().trim().default(''),
  nextOfKinNumber: z.string().trim().default(''),
  psiraNumber: z.string().trim().default(''),
  psiraGrade: z.string().trim().default(''),
  psiraExpiry: z.string().trim().default(''),
  siteId: z.string().trim().default(''),
  qualifications: z
    .array(
      z.object({
        type: z.string().trim().min(1, 'Choose a qualification type.'),
        name: z.string().trim().min(1, 'Name the qualification.'),
        completionDate: date.optional().or(z.literal('')),
        expiryDate: date.optional().or(z.literal('')),
      }),
    )
    .default([]),
  issuedItems: z
    .array(
      z.object({
        item: z.string().trim().min(1, 'Name the item.'),
        size: z.string().trim().optional(),
        assetNumber: z.string().trim().optional(),
        issueDate: date,
      }),
    )
    .default([]),
  /** Must be set to proceed when the site-fit checks show warnings. */
  acknowledgeWarnings: z.boolean().default(false),
});

const ResetPinBody = z.object({ reason: z.string().trim().min(3, 'Give a reason for the reset.') });

type UploadedFile = { fieldname: string; mimetype: string; size: number; buffer: Buffer };

@Controller('officers')
@UseGuards(UserAuthGuard)
export class OfficersController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get()
  @RequirePermission('officers.view')
  list(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT e.id, e.employee_number, e.full_name, e.id_number_last4, e.psira_grade, e.psira_expiry, e.status,
                  e.pin_locked_at IS NOT NULL AS locked, s.id AS site_id, s.name AS site_name
             FROM employees e JOIN sites s ON s.id = e.home_site_id
            WHERE ($1::uuid[] IS NULL OR e.home_site_id = ANY($1::uuid[]))
            ORDER BY lower(e.full_name)`,
          [user.siteIds],
        )
      ).rows;
      return rows.map((r) => ({ ...r, id_number_masked: maskIdNumber('000000000' + r.id_number_last4) }));
    });
  }

  @Get(':id')
  @RequirePermission('officers.view')
  get(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, (tx) => this.load(tx, user, id));
  }

  /** Viewing a photo is logged, since photos are sensitive personal information. */
  @Get(':id/photos/:kind')
  @RequirePermission('officers.view')
  async photo(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Res() res: Response,
  ) {
    const photo = await this.db.withTenant(user.companyId, async (tx) => {
      const e = (await tx.query('SELECT home_site_id FROM employees WHERE id = $1', [id])).rows[0];
      if (!e) throw new NotFoundException('Officer not found.');
      assertSiteAccess(user, e.home_site_id);
      const p = (
        await tx.query('SELECT storage_key, content_type FROM employee_photos WHERE employee_id = $1 AND kind = $2', [
          id,
          kind,
        ])
      ).rows[0];
      if (!p) throw new NotFoundException('Photo not found.');
      await this.audit.byUser(tx, user, { action: 'officer.photo_view', entityType: 'employee', entityId: id, after: { kind } });
      return p;
    });
    res.setHeader('Content-Type', photo.content_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(photo.storage_key));
  }

  /**
   * Enrols an officer (section 6.12). Multipart form: `data` holds the JSON
   * fields; files are `photo_<kind>` for the four photos and `certificate_<n>`
   * for qualification n. Returns the officer and a one-time initial PIN.
   */
  @Post()
  @RequirePermission('officers.enrol')
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 30 } }))
  async enrol(@CurrentUser() user: UserPrincipal, @Body('data') data: string, @UploadedFiles() files: UploadedFile[] = []) {
    let json: unknown;
    try {
      json = JSON.parse(data ?? '{}');
    } catch {
      throw new BadRequestException('The form data could not be read.');
    }
    const input = parseBody(EnrolBody, json);
    const byField = new Map(files.map((f) => [f.fieldname, f]));

    const photoKinds = REQUIRED_PHOTO_KINDS.filter((k) => byField.has(`photo_${k}`));
    const errors = enrolmentErrors({ ...input, photoKinds });
    for (const k of photoKinds) {
      const f = byField.get(`photo_${k}`)!;
      if (!IMAGE_TYPES[f.mimetype]) errors[`photo_${k}`] = 'Photos must be JPEG, PNG or WebP images.';
    }
    input.qualifications.forEach((q, i) => {
      const f = byField.get(`certificate_${i}`);
      if (f && !CERTIFICATE_TYPES[f.mimetype]) errors[`qualifications.${i}.certificate`] = 'Certificates must be a PDF or an image.';
    });
    throwIfErrors(errors);

    const id = validateSaId(input.idNumber);
    if (!id.valid) throw new BadRequestException(id.reason);
    const pin = newPin(6);
    const pinHash = await hashSecret(pin);

    const officer = await this.db.withTenant(user.companyId, async (tx) => {
      const site = (await tx.query('SELECT id, name, minimum_grade, armed FROM sites WHERE id = $1', [input.siteId])).rows[0];
      if (!site) throw new BadRequestException({ message: 'Please fix the highlighted fields.', errors: { siteId: 'Choose a site.' } });
      assertSiteAccess(user, site.id);

      const warnings = siteFitWarnings(
        {
          psiraGrade: input.psiraGrade as PsiraGrade,
          qualifications: input.qualifications.map((q) => ({ type: q.type, expiryDate: q.expiryDate || null })),
        },
        { name: site.name, minimumGrade: site.minimum_grade, armed: site.armed },
        new Date(),
      );
      if (warnings.length && !input.acknowledgeWarnings) {
        throw new ConflictException({ message: 'Please confirm the warnings to continue.', warnings });
      }

      const idHmac = hmac(input.idNumber.replace(/\s/g, ''), this.config.dataKey);
      if ((await tx.query('SELECT 1 FROM employees WHERE id_number_hmac = $1', [idHmac])).rowCount) {
        throw new ConflictException({
          message: 'An officer with this ID number is already enrolled.',
          errors: { idNumber: 'An officer with this ID number is already enrolled.' },
        });
      }
      const employeeNumber = input.employeeNumber || (await this.nextEmployeeNumber(tx));
      if ((await tx.query('SELECT 1 FROM employees WHERE employee_number = $1', [employeeNumber])).rowCount) {
        throw new ConflictException({
          message: 'This employee number is already in use.',
          errors: { employeeNumber: 'This employee number is already in use.' },
        });
      }

      const cleanId = input.idNumber.replace(/\s/g, '');
      const { id: employeeId } = (
        await tx.query(
          `INSERT INTO employees (company_id, employee_number, full_name, id_number_enc, id_number_hmac, id_number_last4,
                                  date_of_birth, cell_number, next_of_kin_name, next_of_kin_number, psira_number,
                                  psira_grade, psira_expiry, home_site_id, pin_hash, created_by)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
          [
            employeeNumber,
            input.fullName,
            encrypt(cleanId, this.config.dataKey),
            idHmac,
            cleanId.slice(-4),
            id.dateOfBirth,
            input.cellNumber,
            input.nextOfKinName,
            input.nextOfKinNumber,
            input.psiraNumber,
            input.psiraGrade,
            input.psiraExpiry,
            site.id,
            pinHash,
            user.userId,
          ],
        )
      ).rows[0];

      for (const k of REQUIRED_PHOTO_KINDS) {
        const f = byField.get(`photo_${k}`)!;
        const key = await this.storage.put(user.companyId, `employees/${employeeId}`, f.buffer, IMAGE_TYPES[f.mimetype]);
        await tx.query(
          `INSERT INTO employee_photos (company_id, employee_id, kind, storage_key, content_type, size_bytes, uploaded_by)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6)`,
          [employeeId, k, key, f.mimetype, f.size, user.userId],
        );
      }
      for (const [i, q] of input.qualifications.entries()) {
        const f = byField.get(`certificate_${i}`);
        const key = f
          ? await this.storage.put(user.companyId, `employees/${employeeId}`, f.buffer, CERTIFICATE_TYPES[f.mimetype])
          : null;
        await tx.query(
          `INSERT INTO qualifications (company_id, employee_id, type, name, completion_date, expiry_date, certificate_key)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6)`,
          [employeeId, q.type, q.name, q.completionDate || null, q.expiryDate || null, key],
        );
      }
      for (const it of input.issuedItems) {
        await tx.query(
          `INSERT INTO issued_items (company_id, employee_id, item, size, asset_number, issue_date)
           VALUES (app_company_id(), $1, $2, $3, $4, $5)`,
          [employeeId, it.item, it.size || null, it.assetNumber || null, it.issueDate],
        );
      }

      const after = await this.load(tx, user, employeeId);
      await this.audit.byUser(tx, user, {
        action: 'officer.enrol',
        entityType: 'employee',
        entityId: employeeId,
        after,
        reason: warnings.length ? `Enrolled despite warnings: ${warnings.join(' ')}` : null,
      });
      return after;
    });
    return { officer, initialPin: pin };
  }

  /** Unlocks an officer after 5 wrong PINs, or when a PIN is forgotten, by issuing a new one (section 6.1). */
  @Post(':id/reset-pin')
  @RequirePermission('officers.unlock')
  async resetPin(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseBody(ResetPinBody, body);
    const pin = newPin(6);
    const pinHash = await hashSecret(pin);
    await this.db.withTenant(user.companyId, async (tx) => {
      const e = (await tx.query('SELECT home_site_id, pin_locked_at FROM employees WHERE id = $1', [id])).rows[0];
      if (!e) throw new NotFoundException('Officer not found.');
      assertSiteAccess(user, e.home_site_id);
      await tx.query('UPDATE employees SET pin_hash = $2, pin_failed_attempts = 0, pin_locked_at = NULL WHERE id = $1', [
        id,
        pinHash,
      ]);
      await this.audit.byUser(tx, user, {
        action: 'officer.pin_reset',
        entityType: 'employee',
        entityId: id,
        before: { locked: !!e.pin_locked_at },
        after: { locked: false },
        reason,
      });
    });
    return { newPin: pin };
  }

  private async nextEmployeeNumber(tx: Tx): Promise<string> {
    const r = await tx.query(
      `SELECT coalesce(max(employee_number::int), 0) + 1 AS n FROM employees WHERE employee_number ~ '^[0-9]+$'`,
    );
    return String(r.rows[0].n).padStart(4, '0');
  }

  private async load(tx: Tx, user: UserPrincipal, id: string) {
    const e = (
      await tx.query(
        `SELECT e.id, e.employee_number AS "employeeNumber", e.full_name AS "fullName", e.id_number_last4,
                e.date_of_birth AS "dateOfBirth", e.cell_number AS "cellNumber", e.next_of_kin_name AS "nextOfKinName",
                e.next_of_kin_number AS "nextOfKinNumber", e.psira_number AS "psiraNumber", e.psira_grade AS "psiraGrade",
                e.psira_expiry AS "psiraExpiry", e.status, e.pin_locked_at IS NOT NULL AS locked, e.created_at AS "createdAt",
                s.id AS "siteId", s.name AS "siteName", s.minimum_grade AS "siteMinimumGrade", s.armed AS "siteArmed"
           FROM employees e JOIN sites s ON s.id = e.home_site_id WHERE e.id = $1`,
        [id],
      )
    ).rows[0];
    if (!e) throw new NotFoundException('Officer not found.');
    assertSiteAccess(user, e.siteId);
    const today = new Date();
    const qualifications = (
      await tx.query(
        `SELECT id, type, name, completion_date AS "completionDate", expiry_date AS "expiryDate",
                certificate_key IS NOT NULL AS "hasCertificate"
           FROM qualifications WHERE employee_id = $1 ORDER BY name`,
        [id],
      )
    ).rows.map((q) => ({ ...q, status: qualificationStatus(q.expiryDate, today) }));
    const issuedItems = (
      await tx.query(
        `SELECT id, item, size, asset_number AS "assetNumber", issue_date AS "issueDate"
           FROM issued_items WHERE employee_id = $1 ORDER BY item`,
        [id],
      )
    ).rows;
    const photos = (await tx.query('SELECT kind FROM employee_photos WHERE employee_id = $1', [id])).rows.map(
      (p) => p.kind as PhotoKind,
    );
    const { id_number_last4, siteMinimumGrade, siteArmed, ...rest } = e;
    return {
      ...rest,
      idNumberMasked: maskIdNumber('000000000' + id_number_last4),
      psiraStatus: qualificationStatus(e.psiraExpiry, today),
      qualifications,
      issuedItems,
      photos,
      siteWarnings: siteFitWarnings(
        { psiraGrade: e.psiraGrade, qualifications },
        { name: e.siteName, minimumGrade: siteMinimumGrade, armed: siteArmed },
        today,
      ),
    };
  }
}
