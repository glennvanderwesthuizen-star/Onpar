import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  faceVerdict,
  normaliseCell,
  normaliseIdNumber,
  normalisePlate,
  sastTime,
  STAFF_FACE_TEXT,
  staffCode,
  staffEntryAutomatic,
  staffEntryNeedsReason,
  StaffFaceResult,
  staffErrors,
  StaffInput,
  WEEKDAYS,
} from '@onpar/rules';
import { UserPrincipal, CustomerPrincipal } from '../common/auth';
import { throwIfErrors } from '../common/validation';
import { Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { FaceEngine } from '../face/face-engine';
import { NotificationsService } from '../notifications/notifications.service';
import { IMAGE_TYPES, StorageService } from '../storage/storage.service';
import { Gate, GuardActor } from './visit-exit.service';
import { VisitorSetupService } from './visitor-setup.service';

interface Photo {
  mimetype: string;
  buffer: Buffer;
}

/** The ID the guard scanned (or typed, with a photo) on a staff member's first day. */
export interface StaffEnrolment {
  idNumber: string;
  surname: string;
  names: string;
  document: string;
  method: 'scan' | 'manual';
}

export interface StaffEntry {
  eventId: string;
  enrol: StaffEnrolment | null;
  /** The guard looked at the two photos and says it is the same person. */
  samePerson: boolean;
  /** When the guard, or the comparison, is in doubt: his reason and his decision. */
  handling: { note: string; allowed: boolean } | null;
  /** The vehicle they came in today. Null: on foot. */
  registration: string | null;
}

const LOCAL = `(now() AT TIME ZONE 'Africa/Johannesburg')`;
/** Due at work now: not past their last day, on one of their days, and within their hours (from an hour before they start). */
const DUE_NOW = `((s.end_date IS NULL OR s.end_date >= ${LOCAL}::date) AND (s.days IS NULL OR extract(isodow FROM ${LOCAL})::int = ANY(s.days))
  AND (s.hours_from IS NULL OR (${LOCAL}::time >= GREATEST(s.hours_from - interval '1 hour', '00:00'::time) AND ${LOCAL}::time <= s.hours_to)))`;
const COLUMNS = `s.id, s.site_id AS "siteId", s.unit_id AS "unitId", u.name AS "unitName", s.full_name AS "fullName", s.cell, s.code, s.id_number AS "idNumber", s.days,
  to_char(s.hours_from, 'HH24:MI') AS "hoursFrom", to_char(s.hours_to, 'HH24:MI') AS "hoursTo", to_char(s.end_date, 'YYYY-MM-DD') AS "endDate", s.person_id AS "personId",
  s.identity_document AS "identityDocument", s.ref_photo_key AS "refPhotoKey", s.ref_photo_type AS "refPhotoType", s.enrolled_at AS "enrolledAt", s.created_at AS "createdAt", s.by_vehicle AS "byVehicle", s.registration,
  ${DUE_NOW} AS "dueNow", (s.end_date IS NOT NULL AND s.end_date < ${LOCAL}::date) AS ended,
  (SELECT v.id FROM visits v WHERE v.staff_id = s.id AND v.status = 'on_site' ORDER BY v.captured_at DESC LIMIT 1) AS "onSiteVisitId",
  (SELECT max(COALESCE(v.entry_at, v.captured_at)) FROM visits v WHERE v.staff_id = s.id) AS "lastIn",
  (SELECT max(v.exit_at) FROM visits v WHERE v.staff_id = s.id) AS "lastOut"`;
const FROM = `unit_staff s LEFT JOIN site_units u ON u.id = s.unit_id`;

type Who = { kind: 'customer'; customer: CustomerPrincipal } | { kind: 'user'; user: UserPrincipal };

function when(s: { days: number[] | null; hoursFrom: string | null; hoursTo: string | null; endDate: string | null }): string {
  const days = s.days && s.days.length && s.days.length < 7 ? [...s.days].sort((a, b) => a - b).map((d) => WEEKDAYS[d - 1]).join(', ') : 'Every day';
  return [days, s.hoursFrom && s.hoursTo ? `${s.hoursFrom} to ${s.hoursTo}` : 'any time', s.endDate ? `until ${s.endDate}` : ''].filter(Boolean).join(', ');
}

/**
 * Staff of a unit (owner, 7 Oct 2026; D-47). The tenant, or the administrator for them, says
 * who works for the unit and when. At the gate a staff member gives the last six digits of
 * their cell number. The first time, the guard scans their ID and takes a reference photo.
 * After that a snapshot is compared with it: the comparison advises, the guard decides, and
 * letting someone in against a doubt needs a reason. No approval is asked on their working days.
 */
@Injectable()
export class UnitStaffService {
  constructor(
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly setup: VisitorSetupService,
    private readonly storage: StorageService,
  ) {}

  private view(r: Record<string, any>, full: boolean) {
    return {
      id: r.id as string,
      fullName: r.fullName as string,
      visiting: r.unitName ? `Unit ${r.unitName}` : 'The office',
      // The person who registered them knows the number; elsewhere only its end is shown.
      cell: full ? (r.cell as string) : `ends ${String(r.cell).slice(-4)}`,
      code: r.code as string,
      // The vehicle they usually come in; null when they come on foot.
      vehicle: (r.byVehicle ? r.registration : null) as string | null,
      when: when(r as { days: number[] | null; hoursFrom: string | null; hoursTo: string | null; endDate: string | null }),
      enrolled: !!r.enrolledAt,
      ended: r.ended as boolean,
      onSite: !!r.onSiteVisitId,
      lastIn: (r.lastIn ?? null) as Date | null,
      lastOut: (r.lastOut ?? null) as Date | null,
    };
  }

  /** The staff registered for one unit (a customer's own) or for a whole site (the administrator). */
  async list(tx: Tx, siteId: string, unit?: { unitId: string | null }) {
    const rows = (
      await tx.query(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE s.site_id = $1 AND s.removed_at IS NULL AND ($2::boolean IS NOT TRUE OR s.unit_id IS NOT DISTINCT FROM $3::uuid)
          ORDER BY length(coalesce(u.name, '')), lower(coalesce(u.name, '')), lower(s.full_name)`,
        [siteId, !!unit, unit?.unitId ?? null],
      )
    ).rows;
    return rows.map((r) => this.view(r, true));
  }

  async create(tx: Tx, siteId: string, unitId: string | null, who: Who, input: StaffInput) {
    const today = (await tx.query(`SELECT to_char(${LOCAL}, 'YYYY-MM-DD') AS d`)).rows[0].d as string;
    throwIfErrors(staffErrors(input, today));
    if (unitId && !(await tx.query('SELECT 1 FROM site_units WHERE id = $1 AND site_id = $2 AND active', [unitId, siteId])).rowCount) {
      throw new BadRequestException({ message: 'Choose a unit of this site.', errors: { unitId: 'Unknown unit.' } });
    }
    const cell = normaliseCell(input.cell);
    if ((await tx.query('SELECT 1 FROM unit_staff WHERE site_id = $1 AND unit_id IS NOT DISTINCT FROM $2 AND cell = $3 AND removed_at IS NULL', [siteId, unitId, cell])).rowCount) {
      throw new ConflictException({ message: 'Someone with that cell number is already on this list.', errors: { cell: 'Already on the list.' } });
    }
    const id = (
      await tx.query(
        `INSERT INTO unit_staff (company_id, site_id, unit_id, full_name, cell, code, id_number, days, hours_from, hours_to, end_date, added_by_customer, added_by_user, by_vehicle, registration)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7::smallint[], $8::time, $9::time, $10::date, $11, $12, $13, $14) RETURNING id`,
        [
          siteId,
          unitId,
          input.fullName.trim(),
          cell,
          staffCode(input.cell),
          normaliseIdNumber(input.idNumber) || null,
          !input.days.length || input.days.length === 7 ? null : [...new Set(input.days)].sort((a, b) => a - b),
          input.hoursFrom,
          input.hoursTo,
          input.endDate,
          who.kind === 'customer' ? who.customer.customerId : null,
          who.kind === 'user' ? who.user.userId : null,
          input.byVehicle,
          input.byVehicle ? normalisePlate(input.registration) : null,
        ],
      )
    ).rows[0].id as string;
    // The audit trail says a staff member was registered and for when, without their numbers.
    await this.audit.byAccount(tx, who.kind === 'customer' ? who.customer : who.user, { action: 'unit_staff.add', entityType: 'unit_staff', entityId: id, after: { siteId, unitId, when: when(input), hasIdNumber: !!input.idNumber.trim(), byVehicle: input.byVehicle } });
    return { id };
  }

  /** Taken off the list: their access stops at once. The record is kept. */
  async remove(tx: Tx, siteId: string, id: string, who: Who, unit?: { unitId: string | null }) {
    const r = await tx.query(
      `UPDATE unit_staff s SET removed_at = now(), removed_by_customer = $5, removed_by_user = $6
        WHERE s.id = $1 AND s.site_id = $2 AND s.removed_at IS NULL AND ($3::boolean IS NOT TRUE OR s.unit_id IS NOT DISTINCT FROM $4::uuid) RETURNING s.id`,
      [id, siteId, !!unit, unit?.unitId ?? null, who.kind === 'customer' ? who.customer.customerId : null, who.kind === 'user' ? who.user.userId : null],
    );
    if (!r.rowCount) throw new NotFoundException('That person is not on the list.');
    await this.audit.byAccount(tx, who.kind === 'customer' ? who.customer : who.user, { action: 'unit_staff.remove', entityType: 'unit_staff', entityId: id });
    return { ok: true };
  }

  // --- At the gate ----------------------------------------------------------------------------

  /** The staff of this site whose cell number ends in these six digits. Usually one; the guard picks when there are more. */
  async find(tx: Tx, gate: Gate, code: string) {
    const rows = (await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.site_id = $1 AND s.code = $2 AND s.removed_at IS NULL ORDER BY lower(s.full_name)`, [gate.siteId, code])).rows;
    return rows.map((r) => ({
      id: r.id as string,
      fullName: r.fullName as string,
      visiting: r.unitName ? `Unit ${r.unitName}` : 'The office',
      when: when(r as { days: number[] | null; hoursFrom: string | null; hoursTo: string | null; endDate: string | null }),
      /** The vehicle they usually come in; null when they come on foot. */
      vehicle: (r.byVehicle ? r.registration : null) as string | null,
      /** First arrival: the ID is scanned and the reference photo taken. */
      enrolled: !!r.enrolledAt,
      /** On site now: the next thing is leaving. */
      onSite: !!r.onSiteVisitId,
      /** Whether they are due at work at this moment. When not, they come in as a visitor and the customer is asked. */
      dueNow: r.dueNow as boolean,
      notDue: r.dueNow ? null : r.ended ? 'Their last day has passed.' : 'They are not due at work at this time.',
    }));
  }

  private async load(tx: Tx, gate: Gate, id: string, lock = false) {
    const r = (await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.id = $1 AND s.site_id = $2 AND s.removed_at IS NULL${lock ? ' FOR UPDATE OF s' : ''}`, [id, gate.siteId])).rows[0];
    if (!r) throw new NotFoundException('That person is not on the staff list.');
    return r as Record<string, any>;
  }

  /** The reference photo, for the guard to compare by eye. */
  async refPhoto(tx: Tx, gate: Gate, guard: GuardActor, id: string) {
    const s = await this.load(tx, gate, id);
    if (!s.refPhotoKey) throw new NotFoundException('No reference photo has been taken yet.');
    await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: guard.name, action: 'unit_staff.photo_view', entityType: 'unit_staff', entityId: id, after: { deviceId: guard.deviceId } });
    return { key: s.refPhotoKey as string, type: s.refPhotoType as string };
  }

  /** How alike the snapshot and the reference photo are, where the site has switched the comparison on. It only advises. */
  private async faceResult(tx: Tx, siteId: string, refKey: string, snapshot: Buffer): Promise<{ result: StaffFaceResult; distance: number | null }> {
    if (!(await this.setup.settings(tx, siteId)).checks.staffFaceMatch) return { result: 'off', distance: null };
    try {
      const { distance } = await FaceEngine.compare(await this.storage.get(refKey), snapshot);
      return { result: faceVerdict(distance), distance };
    } catch {
      // A comparison that cannot run never stops the gate: the guard compares by eye.
      return { result: 'off', distance: null };
    }
  }

  async compare(tx: Tx, gate: Gate, id: string, snapshot: Photo) {
    const s = await this.load(tx, gate, id);
    if (!s.refPhotoKey) throw new ConflictException('No reference photo has been taken yet.');
    const { result } = await this.faceResult(tx, gate.siteId, s.refPhotoKey, snapshot.buffer);
    return { result, text: STAFF_FACE_TEXT[result] };
  }

  private async staffCategory(tx: Tx, siteId: string): Promise<string> {
    const found = (await tx.query(`SELECT id FROM visitor_categories WHERE site_id = $1 AND lower(name) = 'staff' ORDER BY active DESC LIMIT 1`, [siteId])).rows[0];
    if (found) return found.id;
    return (await tx.query(`INSERT INTO visitor_categories (company_id, site_id, name, kind, contractor, sort) VALUES (app_company_id(), $1, 'Staff', 'regular', false, 90) RETURNING id`, [siteId])).rows[0].id;
  }

  private async unitCustomers(tx: Tx, siteId: string, unitId: string | null, notMuted: 'mute_arrival_alerts' | 'mute_exit_alerts' | null) {
    return (
      await tx.query(
        `SELECT id FROM customers WHERE site_id = $1 AND active AND (($2::uuid IS NOT NULL AND unit_id = $2::uuid) OR ($2::uuid IS NULL AND kind = 'client'))${notMuted ? ` AND NOT ${notMuted}` : ''}`,
        [siteId, unitId],
      )
    ).rows.map((r) => r.id as string);
  }

  /**
   * A staff member coming in. First arrival: their ID and the reference photo are taken. Later:
   * the snapshot is held against the reference photo. Safe to send twice.
   */
  async enter(tx: Tx, gate: Gate, guard: GuardActor, id: string, b: StaffEntry, at: Date, face: Photo | undefined, identityPhoto: Photo | undefined) {
    const again = (await tx.query('SELECT id FROM visits WHERE event_id = $1', [b.eventId])).rows[0];
    if (again) return { status: 'on_site', visitId: again.id as string, message: 'Let them in.' };
    if ((await tx.query('SELECT 1 FROM visit_exceptions WHERE event_id = $1 AND NOT allowed', [b.eventId])).rowCount) return { status: 'refused', visitId: null, message: 'Not let in. Your supervisor has been told.' };

    const s = await this.load(tx, gate, id, true);
    if (!s.dueNow) throw new ConflictException(`${s.fullName} is not due at work at this time. Scan them in as a visitor, and the customer will be asked.`);
    if (s.onSiteVisitId) throw new ConflictException(`${s.fullName} is already recorded as on site. Use Leaving when they go.`);
    if (!face) throw new BadRequestException({ message: 'Take a photo of their face.', errors: { face: 'Take the photo.' } });

    let personId = s.personId as string | null;
    let refKey = s.refPhotoKey as string | null;
    let result: StaffFaceResult = 'off';
    let distance: number | null = null;
    const snapshotKey = await this.storage.put(guard.companyId, 'visitors', face.buffer, IMAGE_TYPES[face.mimetype]);
    const firstDay = !s.enrolledAt;

    if (firstDay) {
      const e = b.enrol;
      if (!e) throw new BadRequestException('This is their first day: scan their ID first.');
      const idNumber = normaliseIdNumber(e.idNumber);
      if (idNumber.length < 5 || !e.surname.trim()) throw new BadRequestException({ message: 'Scan the ID, or type the ID number and surname.', errors: { idNumber: 'Enter the ID number and surname.' } });
      if (e.method === 'manual' && !identityPhoto) throw new BadRequestException({ message: 'Photograph the ID you typed the details from.', errors: { identity: 'Take the photo.' } });
      if (s.idNumber && s.idNumber !== idNumber) throw new ConflictException('This ID is not the one registered for this staff member. Scan them in as a visitor, and the customer will be asked.');
      const barred = (await this.setup.settings(tx, gate.siteId)).checks.barredList
        ? await tx.query(`SELECT 1 FROM barred_entries WHERE site_id = $1 AND removed_at IS NULL AND (unit_id IS NULL OR unit_id = $2) AND kind = 'id_number' AND value = $3 LIMIT 1`, [gate.siteId, s.unitId, idNumber])
        : { rowCount: 0 };
      if (barred.rowCount) throw new ConflictException('This person is on the barred list. Do not let them in. Scan them in as a visitor so the attempt is recorded.');
      personId = (
        await tx.query(
          `INSERT INTO visitor_people (company_id, site_id, id_number, surname, names, cell, first_seen, last_seen) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $6)
           ON CONFLICT (site_id, id_number) DO UPDATE SET surname = excluded.surname, names = CASE WHEN excluded.names = '' THEN visitor_people.names ELSE excluded.names END,
             cell = excluded.cell, last_seen = greatest(visitor_people.last_seen, excluded.last_seen) RETURNING id`,
          [gate.siteId, idNumber, e.surname.trim(), e.names.trim(), s.cell, at],
        )
      ).rows[0].id as string;
      refKey = snapshotKey;
      await tx.query('UPDATE unit_staff SET person_id = $2, identity_document = $3, ref_photo_key = $4, ref_photo_type = $5, enrolled_at = now(), enrolled_by = $6 WHERE id = $1', [id, personId, e.document, refKey, face.mimetype, guard.employeeId]);
      await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: guard.name, action: 'unit_staff.enrol', entityType: 'unit_staff', entityId: id, after: { gateId: gate.id, deviceId: guard.deviceId, document: e.document, method: e.method } });
    } else {
      ({ result, distance } = await this.faceResult(tx, gate.siteId, refKey!, face.buffer));
      await tx.query('UPDATE visitor_people SET last_seen = greatest(last_seen, $2) WHERE id = $1', [personId, at]);
    }

    // In doubt, by the guard's eye or the comparison: he gives a reason and decides. It goes to the supervisor either way.
    const doubt = !firstDay && staffEntryNeedsReason(b.samePerson, result);
    if (doubt) {
      if (!b.handling || b.handling.note.trim().length < 3) throw new BadRequestException({ message: 'Type a note to say why, then choose whether to let them in.', errors: { note: 'Type a note.' } });
      const exceptionId = (
        await tx.query(
          `INSERT INTO visit_exceptions (company_id, site_id, gate_id, type, person_id, staff_id, note, photo_key, photo_type, allowed, raised_by, device_id, event_id)
           VALUES (app_company_id(), $1, $2, 'face_mismatch', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [gate.siteId, gate.id, personId, id, b.handling.note.trim(), snapshotKey, face.mimetype, b.handling.allowed, guard.employeeId, guard.deviceId, b.eventId],
        )
      ).rows[0].id as string;
      const decision = b.handling.allowed ? 'The guard let them in.' : 'The guard did not let them in.';
      await this.audit.record(tx, {
        actorType: 'employee',
        actorId: guard.employeeId,
        actorLabel: guard.name,
        action: 'unit_staff.face_doubt',
        entityType: 'unit_staff',
        entityId: id,
        after: { gateId: gate.id, deviceId: guard.deviceId, guardSaysSame: b.samePerson, comparison: result, distance: distance === null ? null : Number(distance.toFixed(4)), note: b.handling.note.trim(), allowed: b.handling.allowed, exceptionId },
      });
      await this.notifications.recordForSite(tx, gate.siteId, {
        kind: 'visitor_exception',
        title: `Visitor exception at ${gate.siteName}`,
        body: `Staff photo in doubt at ${gate.name}: someone arrived as ${s.fullName}, ${s.unitName ? `unit ${s.unitName}` : 'the office'}. ${decision}`,
        lockScreen: 'A visitor exception was raised at a gate.',
        url: `/sites/${gate.siteId}`,
        entityType: 'visit_exception',
        entityId: exceptionId,
      });
      const people = await this.unitCustomers(tx, gate.siteId, s.unitId, null);
      if (people.length) {
        await this.notifications.record(tx, {
          userIds: [],
          customerIds: people,
          kind: 'visitor_exit_exception',
          title: 'The gate was not sure about your staff member',
          body: `Someone arrived at ${gate.name} as ${s.fullName}, and the photo did not clearly match. ${decision}`,
          lockScreen: 'The gate was not sure about a member of your staff.',
          url: '/c/visitors',
          siteId: gate.siteId,
          entityType: 'unit_staff',
          entityId: id,
        });
      }
      if (!b.handling.allowed) return { status: 'refused', visitId: null, message: 'Not let in. Your supervisor and the customer have been told.' };
    }

    // Let in on the photos alone when the comparison is a clear match (owner, 7 Oct 2026); otherwise the guard decided.
    const automatic = !firstDay && !doubt && staffEntryAutomatic(result);
    // The vehicle they came in today, if any.
    const plate = b.registration ? normalisePlate(b.registration) : '';
    if (b.registration && (plate.length < 2 || plate.length > 12)) throw new BadRequestException({ message: 'Enter the number plate.', errors: { registration: 'Enter the number plate.' } });
    const vehicleId = plate
      ? ((
          await tx.query(
            `INSERT INTO visitor_vehicles (company_id, site_id, registration, first_seen, last_seen) VALUES (app_company_id(), $1, $2, $3, $3)
             ON CONFLICT (site_id, registration) DO UPDATE SET last_seen = greatest(visitor_vehicles.last_seen, excluded.last_seen) RETURNING id`,
            [gate.siteId, plate, at],
          )
        ).rows[0].id as string)
      : null;
    const checks = {
      staff: true,
      firstDay,
      face: { guardSaysSame: firstDay || automatic ? null : b.samePerson, comparison: result, automatic },
      ...(plate && s.registration !== plate ? { otherVehicle: true } : {}),
      ...(!plate && s.byVehicle ? { onFootToday: true } : {}),
    };
    const visitId = (
      await tx.query(
        `INSERT INTO visits (company_id, site_id, gate_id, device_id, event_id, type, person_id, category_id, unit_id, status, capture_method, identity_document, identity_method,
                             checks, captured_at, entry_guard, face_photo_key, face_photo_type, announced, staff_id, entry_at, decided_at, vehicle_id)
         VALUES (app_company_id(), $1, $2, $3, $4, CASE WHEN $17::uuid IS NULL THEN 'pedestrian' ELSE 'vehicle' END, $5, $6, $7, 'on_site', $8, $9, $10, $11, $12, $13, $14, $15, true, $16, now(), now(), $17) RETURNING id`,
        [
          gate.siteId,
          gate.id,
          guard.deviceId,
          b.eventId,
          personId,
          await this.staffCategory(tx, gate.siteId),
          s.unitId,
          firstDay ? b.enrol!.method : 'staff',
          firstDay ? b.enrol!.document : (s.identityDocument ?? 'other'),
          firstDay ? b.enrol!.method : 'staff',
          JSON.stringify(checks),
          at,
          guard.employeeId,
          snapshotKey,
          face.mimetype,
          id,
          vehicleId,
        ],
      )
    ).rows[0].id as string;
    if (firstDay && b.enrol!.method === 'manual' && identityPhoto) {
      const key = await this.storage.put(guard.companyId, 'visitors', identityPhoto.buffer, IMAGE_TYPES[identityPhoto.mimetype]);
      await tx.query(`INSERT INTO visit_documents (company_id, visit_id, kind, storage_key, content_type) VALUES (app_company_id(), $1, 'identity', $2, $3)`, [visitId, key, identityPhoto.mimetype]);
    }
    // Approved in advance by the unit: recorded as such, as for an announced visitor.
    await tx.query(`INSERT INTO visit_approvals (company_id, visit_id, method, outcome) VALUES (app_company_id(), $1, 'pass', 'approved')`, [visitId]);
    await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: guard.name, action: 'unit_staff.enter', entityType: 'visit', entityId: visitId, after: { staffId: id, gateId: gate.id, deviceId: guard.deviceId, ...checks } });
    const people = await this.unitCustomers(tx, gate.siteId, s.unitId, 'mute_arrival_alerts');
    if (people.length) {
      await this.notifications.record(tx, { userIds: [], customerIds: people, kind: 'visitor_arrived', title: 'Your staff member has arrived', body: `${s.fullName} came in at ${gate.name} at ${sastTime(at)}.`, lockScreen: 'A member of your staff has arrived.', url: `/c/visits/${visitId}`, siteId: gate.siteId, entityType: 'visit', entityId: visitId });
    }
    return { status: 'on_site', visitId, message: firstDay ? 'Registered. Let them in.' : automatic ? 'The photos match. Let them in.' : 'Let them in.' };
  }

  /** A staff member going home: their code again, and the visit is closed. Safe to send twice. */
  async leave(tx: Tx, gate: Gate, guard: GuardActor, id: string, eventId: string, at: Date) {
    if ((await tx.query('SELECT 1 FROM visits WHERE exit_event_id = $1', [eventId])).rowCount) return { status: 'exited', message: 'Scanned out.' };
    const s = await this.load(tx, gate, id, true);
    if (!s.onSiteVisitId) throw new ConflictException(`${s.fullName} is not recorded as on site.`);
    await tx.query(`UPDATE visits SET status = 'exited', exit_at = $2, exit_guard = $3, exit_gate_id = $4, exit_device_id = $5, exit_person_check = 'guard', exit_event_id = $6 WHERE id = $1`, [s.onSiteVisitId, at, guard.employeeId, gate.id, guard.deviceId, eventId]);
    await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: guard.name, action: 'unit_staff.leave', entityType: 'visit', entityId: s.onSiteVisitId, after: { staffId: id, gateId: gate.id, deviceId: guard.deviceId } });
    const people = await this.unitCustomers(tx, gate.siteId, s.unitId, 'mute_exit_alerts');
    if (people.length) {
      await this.notifications.record(tx, { userIds: [], customerIds: people, kind: 'visitor_left', title: 'Your staff member has left', body: `${s.fullName} went out at ${gate.name} at ${sastTime(at)}.`, lockScreen: 'A member of your staff has left.', url: `/c/visits/${s.onSiteVisitId}`, siteId: gate.siteId, entityType: 'visit', entityId: s.onSiteVisitId });
    }
    return { status: 'exited', message: 'Scanned out.' };
  }
}
