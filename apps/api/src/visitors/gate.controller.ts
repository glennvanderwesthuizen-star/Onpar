import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Res, UnprocessableEntityException, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import {
  BARRED_KIND_LABELS,
  BarredKind,
  CALL_CONTACTS,
  CALL_OUTCOMES,
  CAPTURE_METHODS,
  EXCEPTION_REASONS,
  EXCEPTION_TEXT,
  IDENTITY_DOCUMENTS,
  normaliseCell,
  normaliseIdNumber,
  normalisePlate,
  OVERSTAY_ACTIONS,
  reconcileTime,
  VISIT_STATUS_LABELS,
  VISIT_TYPES,
  VISIT_WARNING_TEXT,
  VISIT_WARNINGS,
  VisitStatus,
  vehicleLine,
  visitorName,
  visitWarnings,
} from '@onpar/rules';
import { CurrentGuard, GuardAuthGuard, GuardPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';
import { VisitApprovalService } from './visit-approval.service';
import { REASON_LIST, VisitExitService } from './visit-exit.service';
import { VisitOnSiteService } from './visit-onsite.service';
import { VisitPassService } from './visit-pass.service';
import { VisitorSetupService } from './visitor-setup.service';

interface Upload {
  mimetype: string;
  size: number;
  buffer: Buffer;
}
type Files = Partial<Record<'face' | 'identity' | 'disc' | 'photo', Upload[]>>;

const isoTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as year-month-day.').nullable().default(null);
const idNumber = z.string().transform(normaliseIdNumber).pipe(z.string().min(5, 'Enter the ID or passport number.').max(20, 'That ID number is too long.'));
const registration = z.string().transform(normalisePlate).pipe(z.string().min(2, 'Enter the number plate.').max(12, 'That number plate is too long.'));
const short = (max: number) => z.string().trim().max(max).default('');

const cell = z.string().transform(normaliseCell).pipe(z.string().min(9, 'Enter the full cell number.').max(15));
const CheckBody = z.object({
  idNumber: idNumber.optional(),
  registration: registration.optional(),
  // Typed by the guard when the visitor says they are expected and gives their cell number.
  cell: cell.optional(),
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
  // With a pass, the kind of visitor and the unit come from the pass.
  categoryId: z.string().uuid('Choose the kind of visitor.').nullable().default(null),
  // Null: visiting the client (the estate office).
  unitId: z.string().uuid().nullable().default(null),
  // The pass the gate phone found for this visitor ("Expected by ..."), and the cell number that found it, if that was how.
  passId: z.string().uuid().nullable().default(null),
  cell: cell.optional(),
  // The warnings the guard saw and chose to continue past.
  acknowledged: z.array(z.enum(VISIT_WARNINGS)).default([]),
  // The visitor is still recorded as on site: the guard's reason for letting them in again.
  onSite: z.object({ reason: z.enum(EXCEPTION_REASONS).nullable().default(null), note: short(300) }).nullable().default(null),
  capturedOffline: z.boolean().default(false),
  trustedAt: isoTime,
  deviceClock: isoTime,
});

const ExitFindBody = z
  .object({
    idNumber: idNumber.optional(),
    registration: registration.optional(),
    // Sent once the guard has answered, to see what the exit would raise before it is recorded.
    sameDriver: z.boolean().nullable().default(null),
    paxOut: z.number().int().min(0).max(99).nullable().default(null),
  })
 .refine((b) => b.idNumber || b.registration, 'Scan the licence disc or the visitor’s ID.');
const ExitBody = z.object({
  eventId: z.string().uuid(),
  // The open visit the phone was shown. Null: nobody recorded as on site matched.
  visitId: z.string().uuid().nullable().default(null),
  idNumber: idNumber.optional(),
  registration: registration.optional(),
  sameDriver: z.boolean().nullable().default(null),
  paxOut: z.number().int().min(0).max(99).nullable().default(null),
  handling: z.object({ reason: z.enum(EXCEPTION_REASONS).nullable().default(null), note: short(300), allowed: z.boolean({ message: 'Choose whether to let the visitor go.' }) }).nullable().default(null),
  trustedAt: isoTime,
  deviceClock: isoTime,
});

const OverstayBody = z.object({ eventId: z.string().uuid(), action: z.enum(OVERSTAY_ACTIONS, { message: 'Choose what to do.' }), note: short(300), handoverId: z.string().uuid().nullable().default(null) });
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
    private readonly passes: VisitPassService,
    private readonly exits: VisitExitService,
    private readonly onSite: VisitOnSiteService,
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
        // For the home screen: how many are on site, and how many are past their time and waiting for the guard.
        counts: await this.onSite.counts(tx, gate.siteId, new Date()),
        // A handover from the last guard that this guard has not yet acknowledged.
        handover: await this.onSite.pending(tx, gate, guard.employeeId),
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
      // An announced visitor or a regular: let in without asking the customer again.
      const pass = await this.passes.match(tx, gate.siteId, gate.id, b);
      const barred = settings.checks.barredList ? await this.barred(tx, gate.siteId, pass ? pass.unitId : b.unitId, b.idNumber, b.registration) : [];
      // Still recorded as on site from an earlier visit: the guard is warned and decides (owner, 7 Oct 2026).
      const onSite = await this.exits.onSite(tx, gate.siteId, b);
      // The audit trail says a scan was checked and what came of it, without copying the numbers into it.
      await this.audit.record(tx, {
        actorType: 'employee',
        actorId: guard.employeeId,
        actorLabel: await this.guardName(tx, guard),
        action: 'visitor.scan_check',
        entityType: 'site_gate',
        entityId: gate.id,
        after: { deviceId: guard.deviceId, checked: [b.idNumber ? 'id_number' : null, b.registration ? 'registration' : null].filter(Boolean), knownPerson: !!person, knownVehicle: !!vehicle, barred: barred.map((x) => x.entryId), passId: pass?.passId ?? null, onSite: onSite.map((v) => v.id) },
      });
      return {
        onSite: onSite.map((v) => ({
          what: v.by,
          visitor: visitorName(v.surname, v.names),
          vehicle: v.type === 'vehicle' ? vehicleLine({ registration: v.registration ?? '', colour: v.colour, make: v.make, model: v.model }) : null,
          visiting: v.unitName ? `Unit ${v.unitName}` : 'The office',
          since: v.enteredAt,
          gateName: v.gateName,
        })),
        reasons: REASON_LIST,
        person: person ? { surname: person.surname, names: person.names, lastSeen: person.lastSeen } : null,
        vehicle: vehicle ? { make: vehicle.make, model: vehicle.model, colour: vehicle.colour, lastSeen: vehicle.lastSeen } : null,
        barred: barred.map((x) => ({ kind: x.kind, kindLabel: BARRED_KIND_LABELS[x.kind], from: x.unitId ? 'unit' : 'site' })),
        expected: pass
          ? {
              passId: pass.passId,
              visitorName: pass.visitorName,
              visiting: pass.unitName ? `Unit ${pass.unitName}` : 'The office',
              category: pass.category,
              by: pass.by,
              regular: pass.kind === 'ongoing',
              namedGate: pass.namedGate,
              mismatch: pass.mismatch,
              contractor: pass.contractor,
              // Workers who may come with a contractor, not counting him. More than this and the customer is asked.
              maxWorkers: pass.maxWorkers,
              leaveBy: pass.contractor ? pass.leaveBy : null,
            }
          : null,
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
      // A pass the gate phone found is checked again here: it must still fit this visitor at this moment.
      const pass = b.passId ? await this.passes.match(tx, gate.siteId, gate.id, { idNumber: b.person.idNumber, registration: b.vehicle?.registration, cell: b.cell }) : null;
      if (b.passId && pass?.passId !== b.passId) throw new ConflictException('This visitor is no longer expected. Go back one step and ask for approval.');
      if (pass) {
        b.categoryId = pass.categoryId;
        b.unitId = pass.unitId;
      }
      const kinds = await this.setup.categories(tx, gate.siteId);
      // Anyone who arrives unannounced is a visitor (owner, 7 Oct 2026): the guard does not choose a kind.
      if (!pass && !b.categoryId) b.categoryId = (kinds.find((c) => c.active && !c.contractor) ?? kinds.find((c) => c.active))?.id ?? null;
      const category = kinds.find((c) => c.id === b.categoryId && (c.active || pass));
      if (!category) errors.categoryId = 'Choose the kind of visitor.';
      if (pass) {
        // The unit comes from the pass.
      } else if (b.unitId) {
        if (!(await tx.query('SELECT 1 FROM site_units WHERE id = $1 AND site_id = $2 AND active', [b.unitId, gate.siteId])).rowCount) errors.unitId = 'Choose who the visitor is here to see.';
      } else if (!(await this.hasClient(tx, gate.siteId))) {
        errors.unitId = 'Choose who the visitor is here to see.';
      }
      if (Object.keys(errors).length) throw new BadRequestException({ message: Object.values(errors)[0], errors });

      const today = await this.today(tx);
      const warnings = visitWarnings(settings.checks, today, b.licenceExpiry, b.vehicle?.discExpiry ?? null);
      const unseen = warnings.filter((w) => !b.acknowledged.includes(w));
      if (unseen.length) throw new UnprocessableEntityException({ message: unseen.map((w) => VISIT_WARNING_TEXT[w]).join(' '), warnings: unseen });

      // The same person already waiting for an answer from the same unit: the guard is taken back to that visit, not given a second one.
      const waiting = (
        await tx.query(
          `SELECT v.id FROM visits v JOIN visitor_people p ON p.id = v.person_id WHERE v.site_id = $1 AND v.status = 'awaiting_approval' AND p.id_number = $2 AND v.unit_id IS NOT DISTINCT FROM $3 ORDER BY v.captured_at DESC LIMIT 1`,
          [gate.siteId, b.person.idNumber, b.unitId],
        )
      ).rows[0];
      if (waiting) return this.reply(waiting.id, 'awaiting_approval', null);
      // Still recorded as on site: the guard was warned and must give a reason before letting them in again.
      const earlier = await this.exits.onSite(tx, gate.siteId, { idNumber: b.person.idNumber, registration: b.vehicle?.registration }, true);
      if (earlier.length && !b.onSite) throw new UnprocessableEntityException({ message: `${EXCEPTION_TEXT.no_scan_out} Give a reason before you continue.`, onSite: true, reasons: REASON_LIST });

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
      // A barred visitor is turned away, so the earlier visit is left as it is.
      if (earlier.length && !barred.length) await this.exits.closeUnscanned(tx, gate, await this.exitActor(tx, guard), earlier, b.onSite!, b.eventId);
      // Barred comes first; then a pass lets the visitor straight in; anyone else waits for the customer.
      // A contractor with more workers than the customer approved is not let in on the registration: the customer is asked.
      const extraWorkers = pass && pass.maxWorkers !== null && (b.pax ?? 0) > pass.maxWorkers ? { approved: pass.maxWorkers, arrived: b.pax ?? 0 } : null;
      const status: VisitStatus = barred.length ? 'denied' : pass && !extraWorkers ? 'on_site' : 'awaiting_approval';
      const deniedReason = barred.length ? 'barred' : null;
      const checks = { barred: barred.map((x) => ({ entryId: x.entryId, kind: x.kind, from: x.unitId ? 'unit' : 'site' })), warnings, ...(earlier.length && !barred.length ? { alreadyOnSite: earlier.map((x) => x.id) } : {}), ...(pass?.mismatch.length ? { mismatch: pass.mismatch } : {}), ...(extraWorkers ? { extraWorkers } : {}) };
      const faceKey = b.type === 'pedestrian' && face ? await this.storage.put(guard.companyId, 'visitors', face.buffer, IMAGE_TYPES[face.mimetype]) : null;
      const manual = b.person.method === 'manual' || v?.method === 'manual';
      const id = (
        await tx.query(
          `INSERT INTO visits (company_id, site_id, gate_id, device_id, event_id, type, person_id, vehicle_id, category_id, unit_id, pax_in, status, denied_reason,
                               capture_method, identity_document, identity_method, disc_method, licence_expiry, disc_expiry, checks, captured_offline, captured_at,
                               late_synced, entry_guard, face_photo_key, face_photo_type, announced, pass_id, entry_at, decided_at)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::date, $18::date, $19, $20, $21, $22, $23, $24, $25, $26, $27,
                   CASE WHEN $11 = 'on_site' THEN now() END, CASE WHEN $11 <> 'awaiting_approval' THEN now() END)
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
            !!pass && !barred.length && !extraWorkers,
            pass && !barred.length ? pass.passId : null,
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
        after: { gateId: gate.id, deviceId: guard.deviceId, type: b.type, status, deniedReason, captureMethod: manual ? 'manual' : 'scan', document: b.person.document, categoryId: b.categoryId, unitId: b.unitId, pax: b.pax, checks, passId: pass?.passId ?? null, capturedOffline: b.capturedOffline, lateSynced: time.lateSynced },
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
      if (status === 'awaiting_approval') await this.approval.request(tx, id, extraWorkers ? `Your contractor has ${extraWorkers.arrived} worker${extraWorkers.arrived === 1 ? '' : 's'} with them; you approved ${extraWorkers.approved}.` : undefined);
      // Expected: let in at once, the pass marked as used, and the customer told who arrived.
      if (status === 'on_site' && pass) {
        await this.passes.used(tx, pass.passId, id, settings.checks.entryLimit);
        await this.approval.arrivedOnPass(tx, id, pass.passId, pass.mismatch);
      }
      return this.reply(id, status, deniedReason);
    });
  }

  /** The exit scan: finds the visitor's open visit and returns the entry record to compare against. */
  @Post('exit/find')
  @HttpCode(200)
  exitFind(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const b = parseBody(ExitFindBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const gate = await this.requireGate(tx, guard);
      const found = await this.exits.find(tx, gate, b);
      await this.audit.record(tx, {
        actorType: 'employee',
        actorId: guard.employeeId,
        actorLabel: await this.guardName(tx, guard),
        action: 'visitor.exit_scan',
        entityType: found.visit ? 'visit' : 'site_gate',
        entityId: found.visit?.id ?? gate.id,
        after: { deviceId: guard.deviceId, checked: [b.idNumber ? 'id_number' : null, b.registration ? 'registration' : null].filter(Boolean), found: !!found.visit, exceptions: found.exceptions.map((x) => x.type) },
      });
      return found;
    });
  }

  /**
   * Scans a visitor out. Multipart: `data` (JSON) and an optional `photo` for an exception.
   * When something does not match, the first send comes back with the exceptions; the guard
   * gives a reason and his decision, and it is sent again. Safe to retry.
   */
  @Post('exit')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'photo', maxCount: 1 }], { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  exit(@CurrentGuard() guard: GuardPrincipal, @Body() body: Record<string, unknown>, @UploadedFiles() files: Files = {}) {
    const b = parseBody(ExitBody, jsonField(body));
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    const photo = files.photo?.[0];
    if (photo && !IMAGE_TYPES[photo.mimetype]) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
    return this.db.withTenant(guard.companyId, async (tx) => this.exits.exit(tx, await this.requireGate(tx, guard), await this.exitActor(tx, guard), b, time.officialAt, photo));
  }

  /** Everyone on site now: overstays first, in red on the phone. */
  @Get('on-site')
  onSiteList(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const gate = await this.requireGate(tx, guard);
      const visitors = await this.onSite.list(tx, gate.siteId, new Date());
      return { onSite: visitors.length, overstays: visitors.filter((v) => v.overdue).length, visitors };
    });
  }

  /** "Hand over shift": the outgoing guard's handover, with every overstay to deal with. */
  @Post('handover/start')
  @HttpCode(200)
  handoverStart(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => this.onSite.start(tx, await this.requireGate(tx, guard), await this.exitActor(tx, guard)));
  }

  /** The outgoing guard signs the list off. Safe to retry. */
  @Post('handover/:id/sign-off')
  @HttpCode(200)
  handoverSignOff(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(guard.companyId, async (tx) => this.onSite.signOff(tx, await this.requireGate(tx, guard), await this.exitActor(tx, guard), id));
  }

  /** The incoming guard has read the handover. Safe to retry. */
  @Post('handover/:id/acknowledge')
  @HttpCode(200)
  handoverAcknowledge(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(guard.companyId, async (tx) => this.onSite.acknowledge(tx, await this.requireGate(tx, guard), await this.exitActor(tx, guard), id));
  }

  /** The gate's "Expected today" list: announced visitors and regulars due today. */
  @Get('expected')
  expected(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const gate = await this.gate(tx, guard);
      return gate ? this.passes.expectedToday(tx, gate.siteId) : [];
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

  /** The face photo taken when a visitor on foot came in, for the guard to compare when they leave. Each look is recorded. */
  @Get(':id/face')
  async face(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const photo = await this.db.withTenant(guard.companyId, async (tx) => {
      const gate = await this.requireGate(tx, guard);
      const r = (await tx.query(`SELECT face_photo_key AS key, face_photo_type AS type FROM visits WHERE id = $1 AND site_id = $2 AND status IN ('awaiting_approval','on_site')`, [id, gate.siteId])).rows[0];
      if (!r?.key) throw new NotFoundException('There is no photo for this visitor.');
      await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: await this.guardName(tx, guard), action: 'visit.face_view', entityType: 'visit', entityId: id, after: { deviceId: guard.deviceId } });
      return r as { key: string; type: string };
    });
    res.setHeader('Content-Type', photo.type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(photo.key));
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

  /**
   * What the guard does about a visitor on site past their time: phone the customer (the number
   * goes to the phone to dial, unseen), confirm they are still on site, or mark them as having
   * left without being scanned out. Safe to retry.
   */
  @Post(':id/overstay')
  @HttpCode(200)
  overstay(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(OverstayBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => this.onSite.act(tx, await this.requireGate(tx, guard), await this.exitActor(tx, guard), id, b));
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

  private async exitActor(tx: Tx, guard: GuardPrincipal) {
    return { employeeId: guard.employeeId, deviceId: guard.deviceId, companyId: guard.companyId, name: await this.guardName(tx, guard) };
  }

  private async guardName(tx: Tx, guard: GuardPrincipal): Promise<string> {
    return (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0]?.full_name ?? '';
  }
}
