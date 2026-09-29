import { Controller, Get, NotFoundException, Query, UseGuards } from '@nestjs/common';
import {
  dateRange,
  hoursBetween,
  nextPayrollPeriod,
  payrollPeriod,
  previousPayrollPeriod,
  registerStatus,
  sastDate,
  shiftLengthMinutes,
  shiftWindow,
  REGISTER_STATUS_LABELS,
} from '@onpar/rules';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { DbService } from '../db/db.service';
import { RosterService } from './roster.service';

/**
 * The attendance register (milestone 22, brief sections 32 and 41): for one site
 * and one payroll period, each guard's rostered shifts next to the Duty On and
 * Duty From times really logged. It never invents a time (scenario 26) and it is
 * not a payslip: no rates, deductions or leave.
 */
@Controller('register')
@UseGuards(UserAuthGuard)
export class RegisterController {
  constructor(
    private readonly db: DbService,
    private readonly roster: RosterService,
  ) {}

  @Get()
  @RequirePermission('register.view')
  register(@CurrentUser() user: UserPrincipal, @Query('siteId') siteId: string, @Query('date') date?: string) {
    if (!siteId) throw new NotFoundException('Choose a site.');
    assertSiteAccess(user, siteId);
    const now = new Date();
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : sastDate(now);
    return this.db.withTenant(user.companyId, async (tx) => {
      const site = (await tx.query('SELECT id, name, client, payroll_start_day AS "payrollStartDay" FROM sites WHERE id = $1', [siteId])).rows[0];
      if (!site) throw new NotFoundException('Site not found.');
      const period = payrollPeriod(day, site.payrollStartDay);
      const { start, end } = period;
      const grace = (await tx.query('SELECT grace_minutes FROM companies')).rows[0].grace_minutes;

      // The guards on this site's register: rostered here during the period, moved here for a
      // day of it, or with this home site and no roster elsewhere, or who worked here.
      const ids = (
        await tx.query(
          `SELECT employee_id FROM roster_allocations WHERE site_id = $1 AND start_date <= $3 AND (end_date IS NULL OR end_date > $2)
           UNION
           SELECT c.employee_id FROM roster_changes c JOIN site_shifts sh ON sh.id = c.shift_id
            WHERE sh.site_id = $1 AND ((c.date BETWEEN $2 AND $3) OR (c.date IS NULL AND c.from_date <= $3 AND (c.until_date IS NULL OR c.until_date >= $2)))
           UNION
           SELECT e.id FROM employees e WHERE e.home_site_id = $1 AND e.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM roster_allocations a WHERE a.employee_id = e.id AND a.start_date <= $3 AND (a.end_date IS NULL OR a.end_date > $2))
           UNION
           SELECT employee_id FROM attendance WHERE site_id = $1 AND shift_date BETWEEN $2 AND $3`,
          [siteId, start, end],
        )
      ).rows.map((r) => r.employee_id);
      const people = (
        await tx.query(
          `SELECT id, full_name AS name, employee_number AS "employeeNumber" FROM employees WHERE id = ANY($1::uuid[]) ORDER BY lower(full_name)`,
          [ids],
        )
      ).rows;
      const days = await this.roster.days(tx, ids, start, end);
      const attendance = (
        await tx.query(
          `SELECT a.employee_id, a.site_id, s.name AS site_name, a.shift_date AS date, a.shift_name, a.duty_on_at, a.duty_from_at,
                  a.arrival_status, a.late_minutes, a.departure_status, a.early_minutes
             FROM attendance a JOIN sites s ON s.id = a.site_id
            WHERE a.employee_id = ANY($1::uuid[]) AND a.shift_date BETWEEN $2 AND $3 ORDER BY a.duty_on_at`,
          [ids, start, end],
        )
      ).rows;
      const siteNames = new Map((await tx.query('SELECT id, name FROM sites')).rows.map((s) => [s.id, s.name]));

      const totals = { scheduled: 0, completed: 0, absent: 0, onDuty: 0, hoursScheduled: 0, hoursWorked: 0 };
      const guards = people.map((p) => {
        const sum = { scheduled: 0, completed: 0, absent: 0, late: 0, unscheduled: 0, hoursScheduled: 0, hoursWorked: 0 };
        const rows = dateRange(start, end).map((date, i) => {
          const r = days.get(p.id)![i];
          const worked = attendance.find((a) => a.employee_id === p.id && a.date === date) ?? null;
          const shift =
            r.status === 'working'
              ? { name: r.shiftName, startTime: r.startTime, endTime: r.endTime, hours: Math.round((shiftLengthMinutes(r.startTime, r.endTime) / 60) * 100) / 100 }
              : null;
          const started = r.status === 'working' ? now.getTime() > shiftWindow(date, r.startTime, r.endTime).start.getTime() + grace * 60_000 : true;
          const dutyOn = worked ? new Date(worked.duty_on_at) : null;
          const dutyFrom = worked?.duty_from_at ? new Date(worked.duty_from_at) : null;
          const status = registerStatus(r.status, dutyOn, dutyFrom, started);
          const rosterSite = r.status === 'working' ? r.siteId : null;
          const atSiteId = worked?.site_id ?? rosterSite;
          // Days at another site count on that site's register, never twice.
          const here = atSiteId === null || atSiteId === siteId;
          const hoursWorked = dutyOn && dutyFrom ? hoursBetween(dutyOn, dutyFrom) : null;
          if (here) {
            if (shift) {
              sum.scheduled++;
              sum.hoursScheduled += shift.hours;
            }
            if (status === 'complete') sum.completed++;
            if (status === 'absent') sum.absent++;
            if (status === 'unscheduled') sum.unscheduled++;
            if (worked?.arrival_status === 'LATE') sum.late++;
            if (hoursWorked) sum.hoursWorked += hoursWorked;
          }
          return {
            date,
            here,
            siteName: atSiteId ? (siteNames.get(atSiteId) ?? null) : null,
            scheduled: shift,
            dutyOnAt: worked?.duty_on_at ?? null,
            dutyFromAt: worked?.duty_from_at ?? null,
            arrival: worked ? { status: worked.arrival_status, lateMinutes: worked.late_minutes } : null,
            departure: worked?.departure_status ? { status: worked.departure_status, earlyMinutes: worked.early_minutes } : null,
            hoursWorked,
            status,
            statusLabel: REGISTER_STATUS_LABELS[status],
          };
        });
        sum.hoursScheduled = Math.round(sum.hoursScheduled * 100) / 100;
        sum.hoursWorked = Math.round(sum.hoursWorked * 100) / 100;
        totals.scheduled += sum.scheduled;
        totals.completed += sum.completed;
        totals.absent += sum.absent;
        totals.onDuty += rows.filter((x) => x.here && x.status === 'on_duty').length;
        totals.hoursScheduled += sum.hoursScheduled;
        totals.hoursWorked += sum.hoursWorked;
        return { ...p, summary: sum, days: rows };
      });
      totals.hoursScheduled = Math.round(totals.hoursScheduled * 100) / 100;
      totals.hoursWorked = Math.round(totals.hoursWorked * 100) / 100;
      return {
        site,
        period,
        previous: previousPayrollPeriod(period, site.payrollStartDay).start,
        next: nextPayrollPeriod(period, site.payrollStartDay).start,
        today: sastDate(now),
        totals,
        guards,
        note: 'This register is the record for payroll. It is not a payslip: it does not work out pay, deductions or leave.',
      };
    });
  }
}

