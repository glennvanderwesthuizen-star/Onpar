import { BadRequestException, ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  EXCEPTION_LABELS,
  EXCEPTION_REASON_LABELS,
  EXCEPTION_REASONS,
  EXCEPTION_TEXT,
  ExceptionReason,
  ExceptionType,
  exceptionHandlingError,
  exitExceptions,
  vehicleLine,
  visitorName,
} from '@onpar/rules';
import { Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IMAGE_TYPES, StorageService } from '../storage/storage.service';
import { VisitorSetupService } from './visitor-setup.service';

/** A visit recorded as on site, as the gate needs it when the visitor leaves. */
export interface OpenVisit {
  id: string;
  type: 'vehicle' | 'pedestrian';
  personId: string;
  vehicleId: string | null;
  idNumber: string;
  surname: string;
  names: string;
  registration: string | null;
  make: string | null;
  model: string | null;
  colour: string | null;
  paxIn: number | null;
  unitId: string | null;
  unitName: string | null;
  category: string;
  gateName: string;
  enteredAt: Date;
  hasFace: boolean;
}

export interface Gate {
  id: string;
  name: string;
  siteId: string;
  siteName: string;
}
export interface GuardActor {
  employeeId: string;
  deviceId: string | null;
  name: string;
  companyId: string;
}
export interface Handling {
  reason: ExceptionReason | null;
  note: string;
  /** The guard let the visitor go (or in). */
  allowed: boolean;
}
export interface ExitInput {
  eventId: string;
  visitId: string | null;
  idNumber?: string;
  registration?: string;
  /** The guard looked at the entry record and says it is (or is not) the same driver. */
  sameDriver: boolean | null;
  paxOut: number | null;
  handling: Handling | null;
}
interface Photo {
  mimetype: string;
  buffer: Buffer;
}

const OPEN = `SELECT v.id, v.type, v.person_id AS "personId", v.vehicle_id AS "vehicleId", p.id_number AS "idNumber", p.surname, p.names, ve.registration, ve.make, ve.model, ve.colour,
    v.pax_in AS "paxIn", v.unit_id AS "unitId", u.name AS "unitName", c.name AS category, g.name AS "gateName", COALESCE(v.entry_at, v.captured_at) AS "enteredAt",
    v.face_photo_key IS NOT NULL AS "hasFace"
  FROM visits v JOIN visitor_people p ON p.id = v.person_id LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id LEFT JOIN site_units u ON u.id = v.unit_id
  JOIN visitor_categories c ON c.id = v.category_id JOIN site_gates g ON g.id = v.gate_id`;

export const exceptionView = (t: ExceptionType) => ({ type: t, label: EXCEPTION_LABELS[t], text: EXCEPTION_TEXT[t] });
export const REASON_LIST = EXCEPTION_REASONS.map((r) => ({ id: r, label: EXCEPTION_REASON_LABELS[r] }));

/**
 * A visitor leaving (visitor management, step 5). The person, the vehicle and the passengers
 * are held against the entry record. A difference is an exception: the guard gives a reason,
 * decides whether the visitor may go, and the customer and the supervisor are told. Nothing
 * here stops a visitor by itself, and nothing is deleted.
 */
@Injectable()
export class VisitExitService {
  constructor(
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly setup: VisitorSetupService,
    private readonly storage: StorageService,
  ) {}

  /** The visits recorded as on site for this ID number or number plate. The vehicle's visit comes first. */
  async onSite(tx: Tx, siteId: string, keys: { idNumber?: string; registration?: string }, lock = false): Promise<(OpenVisit & { by: 'vehicle' | 'person' })[]> {
    if (!keys.idNumber && !keys.registration) return [];
    const rows = (
      await tx.query(
        `${OPEN} WHERE v.site_id = $1 AND v.status = 'on_site' AND (ve.registration = $2 OR p.id_number = $3)
         ORDER BY (ve.registration IS NOT DISTINCT FROM $2) DESC, v.captured_at DESC${lock ? ' FOR UPDATE OF v' : ''}`,
        [siteId, keys.registration ?? null, keys.idNumber ?? null],
      )
    ).rows as OpenVisit[];
    return rows.map((r) => ({ ...r, by: keys.registration && r.registration === keys.registration ? ('vehicle' as const) : ('person' as const) }));
  }

  /** What the gate phone shows after the exit scan: the entry record, and what the guard still has to say. */
  async find(tx: Tx, gate: Gate, keys: { idNumber?: string; registration?: string }) {
    const { checks } = await this.setup.settings(tx, gate.siteId);
    const v = (await this.onSite(tx, gate.siteId, keys))[0] ?? null;
    if (!v) return { visit: null, askDriver: false, askPax: false, exceptions: [exceptionView('no_open_visit')], reasons: REASON_LIST };
    const facts = this.facts(v, keys, null, null);
    return {
      visit: {
        id: v.id,
        type: v.type,
        visitor: visitorName(v.surname, v.names),
        vehicle: v.type === 'vehicle' ? vehicleLine({ registration: v.registration ?? '', colour: v.colour, make: v.make, model: v.model }) : null,
        visiting: v.unitName ? `Unit ${v.unitName}` : 'The office',
        category: v.category,
        gateName: v.gateName,
        enteredAt: v.enteredAt,
        paxIn: v.paxIn,
        hasFace: v.hasFace,
      },
      // The driver's licence cannot be read by the phone, so without a scanned ID the guard compares the driver with the entry record himself.
      askDriver: checks.exitMatch && facts.samePerson === null,
      askPax: checks.paxCount && v.type === 'vehicle' && facts.sameVehicle,
      exceptions: exitExceptions(checks, { ...facts, visit: { type: v.type, paxIn: v.paxIn } }).map(exceptionView),
      reasons: REASON_LIST,
    };
  }

  private facts(v: OpenVisit & { by: 'vehicle' | 'person' }, keys: { idNumber?: string; registration?: string }, sameDriver: boolean | null, paxOut: number | null) {
    const samePerson = keys.idNumber ? keys.idNumber === v.idNumber : v.by === 'person' ? true : sameDriver;
    // Came in a vehicle: it must be that vehicle leaving. Came on foot: must leave on foot.
    const sameVehicle = v.type === 'vehicle' ? !!keys.registration && keys.registration === v.registration : !keys.registration;
    return { samePerson, sameVehicle, paxOut };
  }

  /** Records a visitor leaving. Safe to send twice. */
  async exit(tx: Tx, gate: Gate, guard: GuardActor, b: ExitInput, at: Date, photo?: Photo) {
    const done = (await tx.query('SELECT status FROM visits WHERE exit_event_id = $1', [b.eventId])).rows[0];
    if (done) return this.result(done.status === 'exited' ? 'exited' : 'exited_exception');
    const logged = (await tx.query('SELECT allowed, visit_id FROM visit_exceptions WHERE event_id = $1 LIMIT 1', [b.eventId])).rows[0];
    if (logged) return this.result(logged.visit_id ? 'held' : 'logged');

    const { checks } = await this.setup.settings(tx, gate.siteId);
    const keys = { idNumber: b.idNumber, registration: b.registration };
    if (!keys.idNumber && !keys.registration) throw new BadRequestException('Scan the licence disc or the visitor’s ID.');
    const v = (await this.onSite(tx, gate.siteId, keys, true))[0] ?? null;
    if ((v?.id ?? null) !== b.visitId) throw new ConflictException('This visitor’s record has changed. Go back and scan again.');

    const facts = v ? this.facts(v, keys, b.sameDriver, b.paxOut) : { samePerson: null, sameVehicle: false, paxOut: b.paxOut };
    if (v && checks.exitMatch && facts.samePerson === null) throw new BadRequestException({ message: 'Say whether this is the same driver who came in.', errors: { sameDriver: 'Choose Yes or No.' } });
    if (v && checks.paxCount && v.type === 'vehicle' && facts.sameVehicle && b.paxOut === null) {
      throw new BadRequestException({ message: 'Enter the number of passengers leaving (0 if the driver is alone).', errors: { paxOut: 'Enter the passengers.' } });
    }
    const types = exitExceptions(checks, { ...facts, visit: v ? { type: v.type, paxIn: v.paxIn } : null });
    const personCheck = keys.idNumber ? 'scan' : 'guard';

    if (!types.length && v) {
      await tx.query(
        `UPDATE visits SET status = 'exited', exit_at = $2, exit_guard = $3, exit_gate_id = $4, exit_device_id = $5, exit_person_check = $6, exit_event_id = $7, pax_out = $8 WHERE id = $1`,
        [v.id, at, guard.employeeId, gate.id, guard.deviceId, personCheck, b.eventId, v.type === 'vehicle' ? b.paxOut : null],
      );
      await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: guard.name, action: 'visit.exit', entityType: 'visit', entityId: v.id, after: { gateId: gate.id, deviceId: guard.deviceId, paxOut: b.paxOut, personCheck } });
      await this.tellCustomers(tx, gate, v, 'visitor_left', 'Your visitor has left', `${visitorName(v.surname, v.names)} was scanned out at ${gate.name}.`, 'A visitor has left.');
      return this.result('exited');
    }

    // An exception: the guard must have given a reason or a note, and his decision.
    if (!b.handling) {
      throw new UnprocessableEntityException({ message: types.map((t) => EXCEPTION_TEXT[t]).join(' '), exceptions: types.map(exceptionView), reasons: REASON_LIST });
    }
    const problem = exceptionHandlingError(b.handling.reason, b.handling.note);
    if (problem) throw new BadRequestException({ message: problem, errors: { reason: problem } });

    // Who and what was at the gate, where this site already knows them. An unknown ID number is not kept.
    const personId = keys.idNumber ? ((await tx.query('SELECT id FROM visitor_people WHERE site_id = $1 AND id_number = $2', [gate.siteId, keys.idNumber])).rows[0]?.id ?? null) : null;
    const vehicleId = keys.registration
      ? ((
          await tx.query(
            `INSERT INTO visitor_vehicles (company_id, site_id, registration, first_seen, last_seen) VALUES (app_company_id(), $1, $2, $3, $3)
             ON CONFLICT (site_id, registration) DO UPDATE SET last_seen = greatest(visitor_vehicles.last_seen, excluded.last_seen) RETURNING id`,
            [gate.siteId, keys.registration, at],
          )
        ).rows[0].id as string)
      : null;
    const photoKey = photo ? await this.storage.put(guard.companyId, 'visitors', photo.buffer, IMAGE_TYPES[photo.mimetype]) : null;
    const ids = await this.raise(tx, gate, guard, types, { visitId: v?.id ?? null, personId, vehicleId, paxOut: b.paxOut, handling: b.handling, eventId: b.eventId, photoKey, photoType: photo?.mimetype ?? null });
    if (v && b.handling.allowed) {
      await tx.query(
        `UPDATE visits SET status = 'exited_exception', exit_at = $2, exit_guard = $3, exit_gate_id = $4, exit_device_id = $5, exit_person_check = $6, exit_event_id = $7, pax_out = $8 WHERE id = $1`,
        [v.id, at, guard.employeeId, gate.id, guard.deviceId, personCheck, b.eventId, v.type === 'vehicle' ? b.paxOut : null],
      );
    }
    await this.audit.record(tx, {
      actorType: 'employee',
      actorId: guard.employeeId,
      actorLabel: guard.name,
      action: 'visit.exit_exception',
      entityType: v ? 'visit' : 'site_gate',
      entityId: v?.id ?? gate.id,
      after: { gateId: gate.id, deviceId: guard.deviceId, exceptions: types, exceptionIds: ids, reason: b.handling.reason, note: b.handling.note, allowed: b.handling.allowed, paxIn: v?.paxIn ?? null, paxOut: b.paxOut, personCheck, photo: !!photoKey },
    });
    const what = types.map((t) => EXCEPTION_LABELS[t]).join(', ');
    const decision = b.handling.allowed ? 'The guard let them go.' : 'The guard did not let them go.';
    await this.notifications.recordForSite(tx, gate.siteId, {
      kind: 'visitor_exception',
      title: `Visitor exception at ${gate.siteName}`,
      body: `${what} at ${gate.name}${v ? `, ${visitorName(v.surname, v.names)} leaving ${v.unitName ? `unit ${v.unitName}` : 'the office'}` : ''}. ${decision}`,
      lockScreen: 'A visitor exception was raised at a gate.',
      url: `/sites/${gate.siteId}`,
      entityType: 'visit_exception',
      entityId: ids[0],
    });
    if (v) await this.tellCustomers(tx, gate, v, 'visitor_exit_exception', 'Your visitor left: something did not match', `${visitorName(v.surname, v.names)} at ${gate.name}: ${what}. ${decision}`, 'Something did not match when a visitor left.');
    return this.result(!v ? 'logged' : b.handling.allowed ? 'exited_exception' : 'held');
  }

  /**
   * A visitor scanned in while still recorded as on site (owner, 7 Oct 2026: warn the guard
   * and let him decide, with a reason). The earlier visits are closed as "Left without
   * scan-out", each with an exception for the supervisor.
   */
  async closeUnscanned(tx: Tx, gate: Gate, guard: GuardActor, earlier: OpenVisit[], handling: { reason: ExceptionReason | null; note: string }, eventId: string): Promise<void> {
    const problem = exceptionHandlingError(handling.reason, handling.note);
    if (problem) throw new BadRequestException({ message: problem, errors: { onSite: problem } });
    for (const v of earlier) {
      await tx.query(`UPDATE visits SET status = 'left_no_scan_out', exit_gate_id = $2, exit_device_id = $3, exit_guard = $4 WHERE id = $1 AND status = 'on_site'`, [v.id, gate.id, guard.deviceId, guard.employeeId]);
      const ids = await this.raise(tx, gate, guard, ['no_scan_out'], { visitId: v.id, personId: v.personId, vehicleId: v.vehicleId, paxOut: null, handling: { ...handling, allowed: true }, eventId, photoKey: null, photoType: null });
      await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: guard.name, action: 'visit.left_no_scan_out', entityType: 'visit', entityId: v.id, after: { gateId: gate.id, deviceId: guard.deviceId, exceptionIds: ids, reason: handling.reason, note: handling.note, because: 'scanned_in_again' } });
    }
    if (!earlier.length) return;
    await this.notifications.recordForSite(tx, gate.siteId, {
      kind: 'visitor_exception',
      title: `Visitor exception at ${gate.siteName}`,
      body: `A visitor was scanned in at ${gate.name} while still recorded as on site. The earlier visit was closed as left without scan-out.`,
      lockScreen: 'A visitor exception was raised at a gate.',
      url: `/sites/${gate.siteId}`,
      entityType: 'visit',
      entityId: earlier[0].id,
    });
  }

  private async raise(
    tx: Tx,
    gate: Gate,
    guard: GuardActor,
    types: ExceptionType[],
    x: { visitId: string | null; personId: string | null; vehicleId: string | null; paxOut: number | null; handling: Handling; eventId: string; photoKey: string | null; photoType: string | null },
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const type of types) {
      ids.push(
        (
          await tx.query(
            `INSERT INTO visit_exceptions (company_id, site_id, gate_id, visit_id, type, person_id, vehicle_id, pax_out, reason, note, photo_key, photo_type, allowed, raised_by, device_id, event_id)
             VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
            [gate.siteId, gate.id, x.visitId, type, x.personId, x.vehicleId, x.paxOut, x.handling.reason, x.handling.note.trim(), x.photoKey, x.photoType, x.handling.allowed, guard.employeeId, guard.deviceId, x.eventId],
          )
        ).rows[0].id as string,
      );
    }
    return ids;
  }

  /** Tells the people of the unit visited. "Your visitor has left" skips anyone who switched it off. */
  private async tellCustomers(tx: Tx, gate: Gate, v: OpenVisit, kind: 'visitor_left' | 'visitor_exit_exception', title: string, body: string, lockScreen: string) {
    const ids = (
      await tx.query(
        `SELECT id FROM customers WHERE site_id = $1 AND active AND (($2::uuid IS NOT NULL AND unit_id = $2::uuid) OR ($2::uuid IS NULL AND kind = 'client')) AND ($3 OR NOT mute_exit_alerts)`,
        [gate.siteId, v.unitId, kind !== 'visitor_left'],
      )
    ).rows.map((r) => r.id as string);
    if (!ids.length) return;
    await this.notifications.record(tx, { userIds: [], customerIds: ids, kind, title, body, lockScreen, url: `/c/visits/${v.id}`, siteId: gate.siteId, entityType: 'visit', entityId: v.id });
  }

  private result(status: 'exited' | 'exited_exception' | 'held' | 'logged') {
    const message = {
      exited: 'Scanned out. The visit is closed.',
      exited_exception: 'Scanned out with an exception. Your supervisor and the customer have been told.',
      held: 'Exception recorded. The visitor is still on site. Your supervisor and the customer have been told.',
      logged: 'Exception recorded. Your supervisor has been told.',
    }[status];
    return { status, message };
  }
}
