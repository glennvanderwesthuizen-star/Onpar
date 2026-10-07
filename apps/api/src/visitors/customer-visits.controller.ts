import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { EXCEPTION_LABELS, ExceptionType, STAY_ANSWERS, VISIT_STATUS_LABELS, VisitStatus, vehicleLine, visitorName } from '@onpar/rules';
import { CurrentCustomer, CustomerAuthGuard, CustomerPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { VisitApprovalService } from './visit-approval.service';
import { VisitOnSiteService } from './visit-onsite.service';

const StayBody = z.object({ answer: z.enum(STAY_ANSWERS, { message: 'Choose an answer.' }), until: z.string().trim().nullable().default(null) });
const DecideBody = z.object({ decision: z.enum(['accept', 'refuse'], { message: 'Choose Accept or Refuse.' }) });

const COLUMNS = `v.id, v.type, v.status, v.captured_at AS "at", v.respond_by AS "respondBy", v.decided_at AS "decidedAt", p.surname, p.names, ve.registration, ve.make, ve.model, ve.colour,
  v.pax_in AS "pax", c.name AS "category", g.name AS "gateName", u.name AS "unitName", v.face_photo_key IS NOT NULL AS "hasFace", v.pass_id AS "passId",
  (SELECT cu.full_name FROM visit_approvals a JOIN customers cu ON cu.id = a.customer_id WHERE a.visit_id = v.id AND a.method = 'push' ORDER BY a.at DESC LIMIT 1) AS "answeredBy",
  (SELECT a.method FROM visit_approvals a WHERE a.visit_id = v.id AND a.outcome <> 'no_answer' ORDER BY a.at DESC LIMIT 1) AS "answeredHow"`;
const FROM = `visits v JOIN visitor_people p ON p.id = v.person_id LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id JOIN visitor_categories c ON c.id = v.category_id
  JOIN site_gates g ON g.id = v.gate_id LEFT JOIN site_units u ON u.id = v.unit_id`;
/** The visits that are this customer's: for their unit, or for the office when they are the client. */
const MINE = `v.site_id = $1 AND (($2::uuid IS NOT NULL AND v.unit_id = $2::uuid) OR (v.unit_id IS NULL AND $3 = 'client'))`;

/**
 * Visitors in the customer app (visitor management, step 3): the client and the tenants of a
 * site accept or refuse a visitor who is at the gate for them. A customer sees only visitors
 * for their own unit, and never a visitor's ID number.
 */
@Controller('customer/visits')
@UseGuards(CustomerAuthGuard)
export class CustomerVisitsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly approval: VisitApprovalService,
    private readonly onSite: VisitOnSiteService,
  ) {}

  /** Visitors waiting for an answer, and the last few that were answered. */
  @Get()
  list(@CurrentCustomer() me: CustomerPrincipal) {
    return this.db.withTenant(me.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT ${COLUMNS} FROM ${FROM}
            WHERE ${MINE} AND (v.status = 'awaiting_approval' OR v.captured_at > now() - interval '7 days') AND v.denied_reason IS DISTINCT FROM 'barred'
            ORDER BY (v.status = 'awaiting_approval') DESC, v.captured_at DESC LIMIT 30`,
          [me.siteId, me.unitId, me.customerKind],
        )
      ).rows.map(shape);
      // This customer's own visitors who are on site now.
      const onSite = (await this.onSite.list(tx, me.siteId, new Date(), { unitId: me.customerKind === 'client' && !me.unitId ? null : me.unitId }))
        .filter((v) => (v.unitId ? v.unitId === me.unitId : me.customerKind === 'client'))
        .map((v) => ({ id: v.id, visitor: v.visitor, vehicle: v.vehicle, pax: v.pax, category: v.category, enteredAt: v.enteredAt, stay: v.stay, overdue: v.overdue, overBy: v.overBy }));
      return { waiting: rows.filter((r) => r.status === 'awaiting_approval'), recent: rows.filter((r) => r.status !== 'awaiting_approval'), onSite };
    });
  }

  /** History: this customer's past visitors, newest first, with anything that did not match at the gate. */
  @Get('history')
  history(@CurrentCustomer() me: CustomerPrincipal) {
    return this.db.withTenant(me.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT ${COLUMNS}, v.exit_at AS "exitAt", COALESCE(v.entry_at, v.captured_at) AS "enteredAt",
                  (SELECT array_agg(DISTINCT x.type) FROM visit_exceptions x WHERE x.visit_id = v.id) AS exceptions
             FROM ${FROM} WHERE ${MINE} AND v.status <> 'awaiting_approval' AND v.denied_reason IS DISTINCT FROM 'barred'
            ORDER BY v.captured_at DESC LIMIT 100`,
          [me.siteId, me.unitId, me.customerKind],
        )
      ).rows;
      return rows.map((r) => ({
        ...shape(r),
        enteredAt: r.status === 'denied' || r.status === 'denied_no_response' ? null : (r.enteredAt as Date),
        exitAt: r.exitAt as Date | null,
        exceptions: ((r.exceptions ?? []) as ExceptionType[]).map((t) => EXCEPTION_LABELS[t]),
      }));
    });
  }

  @Get(':id')
  one(@CurrentCustomer() me: CustomerPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(me.companyId, async (tx) => this.find(tx, me, id));
  }

  /** The face photo of a visitor on foot, for the customer the visitor is here to see. Each look is recorded. */
  @Get(':id/face')
  async face(@CurrentCustomer() me: CustomerPrincipal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const photo = await this.db.withTenant(me.companyId, async (tx) => {
      const r = (await tx.query(`SELECT v.face_photo_key AS key, v.face_photo_type AS type FROM visits v WHERE v.id = $4 AND ${MINE}`, [me.siteId, me.unitId, me.customerKind, id])).rows[0];
      if (!r?.key) throw new NotFoundException('There is no photo for this visitor.');
      await this.audit.byAccount(tx, me, { action: 'visit.face_view', entityType: 'visit', entityId: id });
      return r as { key: string; type: string };
    });
    res.setHeader('Content-Type', photo.type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(photo.key));
  }

  /** Accept or refuse. The first answer for the unit counts; a later one is told it was already answered. */
  @Post(':id/decide')
  @HttpCode(200)
  decide(@CurrentCustomer() me: CustomerPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(DecideBody, body);
    return this.db.withTenant(me.companyId, async (tx) => {
      await this.approval.decideInApp(tx, me, id, b.decision === 'accept');
      return this.find(tx, me, id);
    });
  }

  /**
   * About a visitor of theirs who is on site: "still busy until HH:MM", which can be said at any
   * time, or "should have left" once they are past their time. No phone call is needed.
   */
  @Post(':id/stay')
  @HttpCode(200)
  stay(@CurrentCustomer() me: CustomerPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(StayBody, body);
    return this.db.withTenant(me.companyId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM visits v WHERE v.id = $4 AND ${MINE}`, [me.siteId, me.unitId, me.customerKind, id])).rowCount) throw new NotFoundException('Visitor not found.');
      await this.onSite.answerStay(tx, me, id, b.answer, b.until);
      return this.find(tx, me, id);
    });
  }

  private async find(tx: Tx, me: CustomerPrincipal, id: string) {
    const r = (await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE v.id = $4 AND ${MINE}`, [me.siteId, me.unitId, me.customerKind, id])).rows[0];
    if (!r) throw new NotFoundException('Visitor not found.');
    // While on site: when they are due to leave, and what this unit has told the gate about it.
    const here = r.status === 'on_site' ? (await this.onSite.list(tx, me.siteId, new Date())).find((v) => v.id === id) : undefined;
    return { ...shape(r), stay: here ? { dueAt: here.dueAt, overdue: here.overdue, overBy: here.overBy, says: here.customerSays, contractor: here.contractor } : null };
  }
}

function shape(r: Record<string, any>) {
  const status = r.status as VisitStatus;
  const how =
    status === 'on_site' ? (r.answeredHow === 'pass' ? 'Expected: let in without asking' : r.answeredHow === 'phone' ? 'Approved by phone at the gate' : `Accepted by ${r.answeredBy ?? 'your unit'}`)
    : status === 'denied' ? (r.answeredHow === 'phone' ? 'Refused by phone at the gate' : `Refused by ${r.answeredBy ?? 'your unit'}`)
    : status === 'denied_no_response' ? 'Nobody answered, so the visitor was turned away'
    : status === 'exited' ? 'Left the site'
    : status === 'exited_exception' ? 'Left the site. Something did not match at the gate'
    : status === 'left_no_scan_out' ? 'Left without being scanned out'
    : null;
  return {
    id: r.id as string,
    type: r.type as 'vehicle' | 'pedestrian',
    status,
    statusLabel: VISIT_STATUS_LABELS[status],
    at: r.at as Date,
    visitor: visitorName(r.surname, r.names),
    vehicle: r.type === 'pedestrian' ? null : vehicleLine(r as { registration: string }),
    pax: r.pax as number | null,
    category: r.category as string,
    gateName: r.gateName as string,
    visiting: r.unitName ? `Unit ${r.unitName}` : 'The office',
    hasFace: r.hasFace as boolean,
    outcome: how,
    // A visitor the unit let in can be put on its list, so the gate does not ask next time.
    canPass: (status === 'on_site' || status === 'exited') && !r.passId,
  };
}
