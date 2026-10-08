import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { handoverItemErrors, handoverProblems, receiveDifferences, HandoverItem } from '@onpar/rules';
import { z } from 'zod';
import { assertSiteAccess, CurrentGuard, CurrentUser, GuardAuthGuard, GuardPrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { ReportsService } from '../reports/reports.service';

const Item = z.object({ name: z.string().trim().min(1).max(80), expected: z.number().int().min(0).max(999), present: z.number().int(), damaged: z.boolean().default(false) });
const HandOverBody = z.object({ eventId: z.string().uuid(), items: z.array(Item).max(50), note: z.string().trim().max(2000).default('') });
const ReceiveBody = z.object({ items: z.array(Item).max(50), note: z.string().trim().max(2000).default('') });

/** How long a handover waits for the next guard to receive it. */
const WAITING_HOURS = 18;

/**
 * The shift handover on the post phone (owner, 7 Oct 2026; D-45). One screen: the visitors (on a
 * gate phone), the shift's equipment counted, and a note. The next guard on duty at the site
 * checks it and receives it. Missing or damaged equipment, and any difference found on
 * receiving, becomes an equipment report. It does not stop Duty From; supervisors see it.
 */
@Controller('device/shift-handover')
@UseGuards(GuardAuthGuard)
export class GuardShiftHandoverController {
  constructor(
    private readonly db: DbService,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  private async onDuty(tx: Tx, guard: GuardPrincipal) {
    const a = (
      await tx.query(
        `SELECT a.id, a.site_id, a.shift_id, a.shift_name, a.duty_on_at, e.full_name FROM attendance a JOIN employees e ON e.id = a.employee_id
          WHERE a.employee_id = $1 AND a.duty_from_at IS NULL ORDER BY a.duty_on_at DESC LIMIT 1`,
        [guard.employeeId],
      )
    ).rows[0];
    return a ?? null;
  }

  private view(r: Record<string, unknown> | undefined) {
    if (!r) return null;
    return { id: r.id, from: r.from_name, shiftName: r.shift_name, signedAt: r.signed_at, items: r.items as HandoverItem[], note: r.note, receivedAt: r.received_at ?? null };
  }

  /** What to hand over (the shift's equipment from the site's setup), what he has handed over, and any handover waiting for him. */
  @Get()
  get(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, (tx) => this.state(tx, guard));
  }

  private async state(tx: Tx, guard: GuardPrincipal) {
    {
      const a = await this.onDuty(tx, guard);
      if (!a) return { onDuty: false, equipment: [], mine: null, incoming: null };
      const eq = (await tx.query('SELECT equipment FROM site_shifts WHERE id = $1', [a.shift_id])).rows[0]?.equipment ?? {};
      const equipment = Object.entries(eq as Record<string, number>).map(([name, count]) => ({ name, count: Number(count) }));
      const mine = (await tx.query(`SELECT h.*, e.full_name AS from_name FROM shift_handovers h JOIN employees e ON e.id = h.from_employee WHERE h.from_attendance = $1`, [a.id])).rows[0];
      const incoming = (
        await tx.query(
          `SELECT h.*, e.full_name AS from_name FROM shift_handovers h JOIN employees e ON e.id = h.from_employee
            WHERE h.site_id = $1 AND h.from_employee <> $2 AND h.received_at IS NULL AND h.signed_at > now() - make_interval(hours => $3)
              AND (h.device_id IS NULL OR $4::uuid IS NULL OR h.device_id = $4::uuid)
            ORDER BY h.signed_at DESC LIMIT 1`,
          [a.site_id, guard.employeeId, WAITING_HOURS, guard.deviceId],
        )
      ).rows[0];
      return { onDuty: true, equipment, mine: this.view(mine), incoming: this.view(incoming) };
    }
  }

  /** The outgoing guard signs the handover. Once per shift. Anything missing or damaged is reported. */
  @Post()
  @HttpCode(200)
  handOver(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const b = parseBody(HandOverBody, body);
    const problem = handoverItemErrors(b.items);
    if (problem) throw new BadRequestException(problem);
    return this.db.withTenant(guard.companyId, async (tx) => {
      if ((await tx.query('SELECT 1 FROM shift_handovers WHERE id = $1', [b.eventId])).rowCount) return this.state(tx, guard);
      const a = await this.onDuty(tx, guard);
      if (!a) throw new BadRequestException('Come on duty first.');
      if ((await tx.query('SELECT 1 FROM shift_handovers WHERE from_attendance = $1', [a.id])).rowCount) throw new ConflictException('You have already handed over this shift.');
      const problems = handoverProblems(b.items);
      let reportId: string | null = null;
      if (problems.length) {
        reportId = await this.reports.create(
          tx,
          guard.companyId,
          {
            siteId: a.site_id,
            category: 'equipment',
            priority: 'amber',
            description: `Shift handover: ${problems.join('; ')}.${b.note ? ` Note: ${b.note}` : ''}`,
            source: 'guard',
            employeeId: guard.employeeId,
            deviceId: guard.deviceId,
            reportedAt: new Date(),
          },
          { type: 'employee', id: guard.employeeId, name: a.full_name },
        );
      }
      await tx.query(
        `INSERT INTO shift_handovers (id, company_id, site_id, device_id, from_employee, from_attendance, shift_name, items, note, report_id)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [b.eventId, a.site_id, guard.deviceId, guard.employeeId, a.id, a.shift_name, JSON.stringify(b.items), b.note, reportId],
      );
      await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: a.full_name, action: 'handover.sign', entityType: 'shift_handover', entityId: b.eventId, after: { problems } });
      return this.state(tx, guard);
    });
  }

  /** The incoming guard checks and receives it. Any difference from what was handed over is reported. */
  @Post(':id/receive')
  @HttpCode(200)
  receive(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(ReceiveBody, body);
    const problem = handoverItemErrors(b.items);
    if (problem) throw new BadRequestException(problem);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const a = await this.onDuty(tx, guard);
      if (!a) throw new BadRequestException('Come on duty first.');
      const h = (await tx.query('SELECT * FROM shift_handovers WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!h || h.site_id !== a.site_id) throw new NotFoundException('Handover not found.');
      if (h.from_employee === guard.employeeId) throw new BadRequestException('You cannot receive your own handover.');
      if (h.received_at) throw new ConflictException('This handover has already been received.');
      const diffs = receiveDifferences(h.items as HandoverItem[], b.items);
      let reportId: string | null = null;
      if (diffs.length) {
        reportId = await this.reports.create(
          tx,
          guard.companyId,
          {
            siteId: a.site_id,
            category: 'equipment',
            priority: 'amber',
            description: `Received at shift handover: ${diffs.join('; ')}.${b.note ? ` Note: ${b.note}` : ''}`,
            source: 'guard',
            employeeId: guard.employeeId,
            deviceId: guard.deviceId,
            reportedAt: new Date(),
          },
          { type: 'employee', id: guard.employeeId, name: a.full_name },
        );
      }
      await tx.query(
        `UPDATE shift_handovers SET to_employee = $2, received_at = now(), received_items = $3, received_note = $4, received_report = $5 WHERE id = $1`,
        [id, guard.employeeId, JSON.stringify(b.items), b.note, reportId],
      );
      await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: a.full_name, action: 'handover.receive', entityType: 'shift_handover', entityId: id, after: { differences: diffs } });
      return this.state(tx, guard);
    });
  }
}

/** A site's shift handovers, for supervisors and managers. */
@Controller('sites/:siteId/shift-handovers')
@UseGuards(UserAuthGuard)
export class SiteShiftHandoverController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequirePermission('attendance.view')
  list(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string) {
    assertSiteAccess(user, siteId);
    return this.db.withTenant(user.companyId, async (tx) => {
      if (!(await tx.query('SELECT 1 FROM sites WHERE id = $1', [siteId])).rowCount) throw new NotFoundException('Site not found.');
      return (
        await tx.query(
          `SELECT h.id, h.shift_name AS "shiftName", h.signed_at AS "signedAt", h.items, h.note, h.received_at AS "receivedAt", h.received_items AS "receivedItems",
                  h.received_note AS "receivedNote", f.full_name AS "from", t.full_name AS "to", d.post_name AS "post",
                  r1.number AS "reportNumber", r2.number AS "receivedReportNumber"
             FROM shift_handovers h JOIN employees f ON f.id = h.from_employee LEFT JOIN employees t ON t.id = h.to_employee LEFT JOIN devices d ON d.id = h.device_id
             LEFT JOIN reports r1 ON r1.id = h.report_id LEFT JOIN reports r2 ON r2.id = h.received_report
            WHERE h.site_id = $1 ORDER BY h.signed_at DESC LIMIT 30`,
          [siteId],
        )
      ).rows;
    });
  }
}
