import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UnprocessableEntityException, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  BARRED_KIND_LABELS,
  BarredKind,
  CALL_CONTACTS,
  CALL_OUTCOMES,
  CAPTURE_METHODS,
  IDENTITY_DOCUMENTS,
  normaliseIdNumber,
  normalisePlate,
  reconcileTime,
  VISIT_STATUS_LABELS,
  VISIT_TYPES,
  VISIT_WARNING_TEXT,
  VISIT_WARNINGS,
  VisitStatus,
  visitWarnings,
} from '@onpar/rules';
import { CurrentGuard, GuardAuthGuard, GuardPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';
import { VisitApprovalService } from './visit-approval.service';
import { VisitorSetupService } from './visitor-setup.service';

interface Upload {
  mimetype: string;
  size: number;
  buffer: Buffer;
}
type Files = Partial<Record<'face' | 'identity' | 'disc', Upload[]>>;

const isoTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as year-month-day.').nullable().default(null);
const idNumber = z.string().transform(normaliseIdNumber).pipe(z.string().min(5, 'Enter the ID or passport number.').max(20, 'That ID number is too long.'));
const registration = z.string().transform(normalisePlate).pipe(z.string().min(2, 'Enter the number plate.').max(12, 'That number plate is too long.'));
const short = (max: number) => z.string().trim().max(max).default('');

const CheckBody = z.object({
  idNumber: idNumber.optional(),
  registration: registration.optional(),
  unitId: z.string().uuid().nullable().default(null),
});
const VisitBody = z.object({
  eventId: z.string().uuid(),
  type: z.enum(VISIT_TYPES),
  person: z.object({
    idNumber,
    surname: z.string().trim().min(1, 'Enter the surname.').max(80),
    names: short(120),
    document: z.enum(IDENTITY_DOCUMENTS),
    method: z.enum(CAPTURE_METHODS),
  }),
  vehicle: z
    .object({ registration, make: short(60), model: short(60), colour: short(40), vin: short(30), discExpiry: day, method: z.enum(CAPTURE_METHODS) })
    .nullable()
    .default(null),
  licenceExpiry: day,
  pax: z.number().int().min(0, 'Enter the number of passengers.').max(99).nullable().default(null),
  categoryId: z.string().uuid('Choose the kind of visitor.'),
  // Null: visiting the client (the estate office).
  unitId: z.string().uuid().nullable(),
  // The warnings the guard saw and chose to continue past.
  acknowledged: z.array(z.enum(VISIT_WARNINGS)).default([]),
  capturedOffline: z.boolean().default(false),
  trustedAt: isoTime,
  deviceClock: isoTime,
});

const DialBody = z.object({ contact: z.enum(CALL_CONTACTS) });
const OutcomeBody = z.object({ eventId: z.string().uuid(), contact: z.enum(CALL_CONTACTS), outcome: z.enum(CALL_OUTCOMES, { message: 'Choose how the call went.' }) });
const EventBody = z.object({ eventId: z.string().uuid() });

function jsonField(body: Record<string, unknown>): unknown {
  if (typeof body?.data !== 'string') return body;
  try {
    return JSON.parse(body.data);
  } catch {
    throw new BadRequestException('The form data could not be read.');
  }
}

const NOT_A_GATE = 'This phone is not set up as a gate phone. Ask the administrator to give it a gate on the site’s page.';

/**
 * Visitors on the gate phone (visitor management, step 2): what the gate needs to scan a
 * visitor in, the check of a scanned ID number or number plate, and saving the visit.
 * A guard only ever sees his own site.
 */
@Controller('device/visitors')
@UseGuards(GuardAuthGuard)
export class GateController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly setup: VisitorSetupService,
    private readonly notifications: NotificationsService,
    private readonly approval: VisitApprovalService,
  ) {}

  /** Everything the gate phone needs before a visitor arrives: its gate, the site's checks, categories and units. */
  @Get('setup')
  get(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const gate = await this.gate(tx, guard);
      if (!gate) return { gate: null, message: NOT_A_GATE };
      const settings = await this.setup.settings(tx, gate.siteId);
      const categories = (await this.setup.categories(tx, gate.siteId)).filter((c) => c.active).map(({ active: _a, ...c }) => c);
      const units = (await tx.query('SELECT id, name FROM site_units WHERE site_id = $1 AND active ORDER BY length(name), lower(name)', [gate.siteId])).rows;
      return {
        gate: { id: gate.id, name: gate.name },
        siteName: gate.siteName,
        checks: settings.checks,
        noResponseSeconds: settings.noResponseSeconds,
        categories,
        units,
        hasClient: await this.hasClient(tx, gate.siteId),
        today: await this.today(tx),
      };
    });
  }

  /**
   * After a scan: what this site already knows about the ID number or number plate (a returning
   * visitor), and whether either is on the barred list. Sent in the body, never in the address.
   */
  @Post('check')
  @HttpCode(200)
  check(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const b = parseBody(CheckBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const gate = await this.requireGate(tx, guard);
      const settings = await this.setup.settings(tx, gate.siteId);
      const person = b.idNumber ? (await tx.query('SELECT id, surname, names, last_seen AS "lastSeen" FROM visitor_people WHERE site_id = $1 AND id_number = $2', [gate.siteId, b.idNumber])).rows[0] : null;
      const vehicle = b.registration
        ? (await tx.query('SELECT id, make, model, colour, last_seen AS "lastSeen" FROM visitor_vehicles WHERE site_id = $1 AND registration = $2', [gate.siteId, b.registration])).rows[0]
        : null;
      const barred = settings.checks.barredList ? await this.barred(tx, gate.siteId, b.unitId, b.idNumber, b.registration) : [];
      // The audit trail says a scan was checked and what came of it, without copying the numbers into it.
      await this.audit.record(tx, {
        actorType: 'employee',
        actorId: guard.employeeId,
        actorLabel: await this.guardName(tx, guard),
        action: 'visitor.scan_check',
        entityType: 'site_gate',
        entityId: gate.id,
        after: { deviceId: guard.deviceId, checked: [b.idNumber ? 'id_number' : null, b.registration ? 'registration' : null].filter(Boolean), knownPerson: !!person, knownVehicle: !!vehicle, barred: barred.map((x) => x.entryId) },
      });
      return {
        person: person ? { surname: person.surname, names: person.names, lastSeen: person.lastSeen } : null,
        vehicle: vehicle ? { make: vehicle.make, model: vehicle.model, colour: vehicle.colour, lastSeen: vehicle.lastSeen } : null,
        barred: barred.map((x) => ({ kind: x.kind, kindLabel: BARRED_KIND_LABELS[x.kind], from: x.unitId ? 'unit' : 'site' })),
      };
    });
  }

  /**
   * Saves a scanned visitor and asks for approval. Multipart: `data` (JSON) with the photos
   * `face` (a visitor on foot), `identity` and `disc` (documents typed by hand). Safe to retry.
   */
  @Post()
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'face', maxCount: 1 }, { name: 'identity', maxCount: 1 }, { name: 'disc', maxCount: 1 }], { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  create(@CurrentGuard() guard: GuardPrincipal, @Body() body: Record<string, unknown>, @UploadedFiles() files: Files = {}) {
    const b = parseBody(VisitBody, jsonField(body));
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    const face = files.face?.[0];
    const identityPhoto = files.identity?.[0];
    const discPhoto = files.disc?.[0];
    for (const f of [face, identityPhoto, discPhoto]) if (f && !IMAGE_TYPES[f.mimetype]) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');

    return this.db.withTenant(guard.companyId, async (tx) => {
      const gate = await this.requireGate(tx, guard);
      const existing = (await tx.query('SELECT id, status, denied_reason FROM visits WHERE event_id = $1', [b.eventId])).rows[0];
      if (existing) return this.reply(existing.id, existing.status, existing.denied_reason);

      const settings = await this.setup.settings(tx, gate.siteId);
      const errors: Record<string, string> = {};
      if (b.type === 'vehicle' && !b.vehicle) errors.vehicle = 'Scan the licence disc, or type the vehicle’s details.';
      if (b.type === 'pedestrian' && b.vehicle) errors.vehicle = 'A visitor on foot has no vehicle.';
      if (b.type === 'vehicle' && settings.checks.paxCount && b.pax === null) errors.pax = 'Enter the number of passengers (0 if the driver is alone).';
      if (b.type === 'pedestrian' && settings.checks.facePhoto && !face) errors.face = 'Take a photo of the visitor’s face.';
      if (b.person.method === 'manual' && !identityPhoto) errors.identity = 'Photograph the document you typed the details from.';
      if (b.vehicle?.method === 'manual' && !discPhoto) errors.disc = 'Photograph the licence disc you typed the details from.';
      if (!settings.checks.expiredLicenceOk && b.person.document === 'drivers_licence' && !b.licenceExpiry) errors.licenceExpiry = 'Enter the date the licence expires.';
      const category = (await this.setup.categories(tx, gate.siteId)).find((c) => c.id === b.categoryId && c.active);
      if (!category) errors.categoryId = 'Choose the kind of visitor.';
      if (b.unitId) {
        if (!(await tx.query('SELECT 1 FROM site_units WHERE id = $1 AND site_id = $2 AND active', [b.unitId, gate.siteId])).rowCount) errors.unitId = 'Choose who the visitor is here to see.';
      } else if (!(await this.hasClient(tx, gate.siteId))) {
        errors.unitId = 'Choose who the visitor is here to see.';
      }
      if (Object.keys(errors).length) throw new BadRequestException({ message: Object.values(errors)[0], errors });

      const today = await this.today(tx);
      const warnings = visitWarnings(settings.checks, today, b.licenceExpiry, b.vehicle?.discExpiry ?? null);
      const unseen = warnings.filter((w) => !b.acknowledged.includes(w));
      if (unseen.length) throw new UnprocessableEntityException({ message: unseen.map((w) => VISIT_WARNING_TEXT[w]).join(' '), warnings: unseen });

      const at = time.officialAt;
      const personId = (
        await tx.query(
          `INSERT INTO visitor_people (company_id, site_id, id_number, surname, names, first_seen, last_seen) VALUES (app_company_id(), $1, $2, $3, $4, $5, $5)
           ON CONFLICT (site_id, id_number) DO UPDATE SET surname = excluded.surname, names = CASE WHEN excluded.names = '' THEN visitor_people.names ELSE excluded.names END,
             last_seen = greatest(visitor_people.last_seen, excluded.last_seen)
           RETURNING id`,
          [gate.siteId, b.person.idNumber, b.person.surname, b.person.names, at],
        )
      ).rows[0].id as string;
      const v = b.vehicle;
      const vehicleId = v
        ? ((
            await tx.query(
              `INSERT INTO visitor_vehicles (company_id, site_id, registration, make, model, colour, vin, first_seen, last_seen) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $7)
               ON CONFLICT (site_id, registration) DO UPDATE SET make = excluded.make, model = excluded.model, colour = excluded.colour,
                 vin = CASE WHEN excluded.vin = '' THEN visitor_vehicles.vin ELSE excluded.vin END, last_seen = greatest(visitor_vehicles.last_seen, excluded.last_seen)
               RETURNING id`,
              [gate.siteId, v.registration, v.make, v.model, v.colour, v.vin.toUpperCase(), at],
            )
          ).rows[0].id as string)
        : null;

      const barred = settings.checks.barredList ? await this.barred(tx, gate.siteId, b.unitId, b.person.idNumber, v?.registration) : [];
      const status: VisitStatus = barred.length ? 'denied' : 'awaiting_approval';
      const deniedReason = barred.length ? 'barred' : null;
      const checks = { barred: barred.map((x) => ({ entryId: x.entryId, kind: x.kind, from: x.unitId ? 'unit' : 'site' })), warnings };
      const faceKey = b.type === 'pedestrian' && face ? await this.storage.put(guard.companyId, 'visitors', face.buffer, IMAGE_TYPES[face.mimetype]) : null;
      const manual = b.person.method === 'manual' || v?.method === 'manual';
      const id = (
        await tx.query(
          `INSERT INTO visits (company_id, site_id, gate_id, device_id, event_id, type, person_id, vehicle_id, category_id, unit_id, pax_in, status, denied_reason,
                               capture_method, identity_document, identity_method, disc_method, licence_expiry, disc_expiry, checks, captured_offline, captured_at,
                               late_synced, entry_guard, face_photo_key, face_photo_type)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::date, $18::date, $19, $20, $21, $22, $23, $24, $25)
           RETURNING id`,
          [
            gate.siteId,
            gate.id,
            guard.deviceId,
            b.eventId,
            b.type,
            personId,
            vehicleId,
            b.categoryId,
            b.unitId,
            b.type === 'vehicle' ? b.pax : null,
            status,
            deniedReason,
            manual ? 'manual' : 'scan',
            b.person.document,
            b.person.method,
            v?.method ?? null,
            b.licenceExpiry,
            v?.discExpiry ?? null,
            JSON.stringify(checks),
            b.capturedOffline,
            at,
            time.lateSynced,
            guard.employeeId,
            faceKey,
            faceKey ? face!.mimetype : null,
          ],
        )
      ).rows[0].id as string;

      // A photo of a document is kept only when its details were typed by hand.
      const documents: ['identity' | 'licence_disc', Upload | undefined, boolean][] = [
        ['identity', identityPhoto, b.person.method === 'manual'],
        ['licence_disc', discPhoto, v?.method === 'manual'],
      ];
      for (const [kind, photo, keep] of documents) {
        if (!photo || !keep) continue;
        const key = await this.storage.put(guard.companyId, 'visitors', photo.buffer, IMAGE_TYPES[photo.mimetype]);
        await tx.query('INSERT INTO visit_documents (company_id, visit_id, kind, storage_key, content_type) VALUES (app_company_id(), $1, $2, $3, $4)', [id, kind, key, photo.mimetype]);
      }

      await this.audit.record(tx, {
        actorType: 'employee',
        actorId: guard.employeeId,
        actorLabel: await this.guardName(tx, guard),
        action: 'visit.create',
        entityType: 'visit',
        entityId: id,
        after: { gateId: gate.id, deviceId: guard.deviceId, type: b.type, status, deniedReason, captureMethod: manual ? 'manual' : 'scan', document: b.person.document, categoryId: b.categoryId, unitId: b.unitId, pax: b.pax, checks, capturedOffline: b.capturedOffline, lateSynced: time.lateSynced },
      });
      if (barred.length) {
        await this.notifications.recordForSite(tx, gate.siteId, {
          kind: 'visitor_barred',
          title: `Barred visitor at ${gate.siteName}`,
          body: `Someone on the barred list was stopped at ${gate.name}. The guard was told not to let them in.`,
          lockScreen: 'A barred visitor was stopped at a gate.',
          url: `/sites/${gate.siteId}`,
          entityType: 'visit',
          entityId: id,
        });
      }
      // Not barred: the customers of the unit are asked, and the gate waits for the answer.
      if (status === 'awaiting_approval') await this.approval.request(tx, id);
      return this.reply(id, status, deniedReason);
    });
  }

  /** Today's visitors at this site, newest first, for the gate's own list. */
  @Get('recent')
  recent(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const gate = await this.gate(tx, guard);
      if (!gate) return [];
      return (
        await tx.query(
          `SELECT v.id, v.type, v.status, v.captured_at AS "at", p.surname, p.names, ve.registration, ve.make, ve.model, ve.colour, u.name AS "unitName", c.name AS "category",
                  v.pax_in AS "pax", g.name AS "gateName"
             FROM visits v JOIN visitor_people p ON p.id = v.person_id LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id LEFT JOIN site_units u ON u.id = v.unit_id
             JOIN visitor_categories c ON c.id = v.category_id JOIN site_gates g ON g.id = v.gate_id
            WHERE v.site_id = $1 AND (v.captured_at > now() - interval '24 hours' OR v.status IN ('awaiting_approval','on_site'))
            ORDER BY v.captured_at DESC LIMIT 50`,
          [gate.siteId],
        )
      ).rows.map((r) => ({ ...r, statusLabel: VISIT_STATUS_LABELS[r.status as VisitStatus] }));
    });
  }

  /** Where a visit stands: the countdown, the answer, and whether the guard may phone. The waiting screen asks every few seconds. */
  @Get(':id')
  state(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(guard.companyId, async (tx) => this.approval.gateState(tx, id, (await this.requireGate(tx, guard)).siteId));
  }

  /**
   * "No response. Dial the customer?" Returns the number for the phone to dial; the guard is
   * shown only whose it is. Allowed once the customer's time to answer in the app is over.
   */
  @Post(':id/dial')
  @HttpCode(200)
  dial(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(DialBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => this.approval.dial(tx, await this.actor(tx, guard), id, (await this.requireGate(tx, guard)).siteId, b.contact));
  }

  /** After the call: Approved by phone, Denied by phone or No answer. Safe to retry. */
  @Post(':id/call-outcome')
  @HttpCode(200)
  callOutcome(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(OutcomeBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const siteId = (await this.requireGate(tx, guard)).siteId;
      await this.approval.callOutcome(tx, await this.actor(tx, guard), id, siteId, b);
      return this.approval.gateState(tx, id, siteId);
    });
  }

  /** Nobody could be reached: the visitor is turned away. Safe to retry. */
  @Post(':id/no-response')
  @HttpCode(200)
  noResponse(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(EventBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const siteId = (await this.requireGate(tx, guard)).siteId;
      await this.approval.noResponse(tx, await this.actor(tx, guard), id, siteId, b.eventId);
      return this.approval.gateState(tx, id, siteId);
    });
  }

  private reply(id: string, status: VisitStatus, deniedReason: string | null) {
    return {
      id,
      status,
      statusLabel: VISIT_STATUS_LABELS[status],
      blocked: deniedReason === 'barred' ? 'This visitor is on the barred list. Do not let them in. Your supervisor has been told.' : null,
    };
  }

  private async gate(tx: Tx, guard: GuardPrincipal): Promise<{ id: string; name: string; siteId: string; siteName: string } | null> {
    if (!guard.deviceId) return null;
    const r = (
      await tx.query(
        `SELECT g.id, g.name, g.site_id AS "siteId", s.name AS "siteName" FROM devices d JOIN site_gates g ON g.id = d.gate_id AND g.site_id = d.site_id AND g.active
           JOIN sites s ON s.id = g.site_id WHERE d.id = $1`,
        [guard.deviceId],
      )
    ).rows[0];
    return r ?? null;
  }

  private async requireGate(tx: Tx, guard: GuardPrincipal) {
    const gate = await this.gate(tx, guard);
    if (!gate) throw new BadRequestException(NOT_A_GATE);
    return gate;
  }

  /** Active barred entries that match, for the whole site or for the unit being visited. */
  private async barred(tx: Tx, siteId: string, unitId: string | null, idNumber?: string, registration?: string) {
    return (
      await tx.query(
        `SELECT id AS "entryId", kind, unit_id AS "unitId" FROM barred_entries
          WHERE site_id = $1 AND removed_at IS NULL AND (unit_id IS NULL OR unit_id = $2)
            AND ((kind = 'id_number' AND value = $3) OR (kind = 'registration' AND value = $4))
          ORDER BY added_at`,
        [siteId, unitId, idNumber ?? null, registration ?? null],
      )
    ).rows as { entryId: string; kind: BarredKind; unitId: string | null }[];
  }

  private async hasClient(tx: Tx, siteId: string) {
    return !!(await tx.query(`SELECT 1 FROM customers WHERE site_id = $1 AND kind = 'client' AND active LIMIT 1`, [siteId])).rowCount;
  }

  /** Today's date in South Africa. */
  private async today(tx: Tx): Promise<string> {
    return (await tx.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS d`)).rows[0].d;
  }

  private async actor(tx: Tx, guard: GuardPrincipal) {
    return { actorType: 'employee' as const, actorId: guard.employeeId, actorLabel: await this.guardName(tx, guard), employeeId: guard.employeeId, deviceId: guard.deviceId };
  }

  private async guardName(tx: Tx, guard: GuardPrincipal): Promise<string> {
    return (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0]?.full_name ?? '';
  }
}
