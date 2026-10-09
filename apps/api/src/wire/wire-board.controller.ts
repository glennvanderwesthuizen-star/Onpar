import { Body, Controller, Get, HttpCode, Injectable, Post, UseGuards } from '@nestjs/common';
import { boardName, completedYears, milestonesCrossed, mostImproved, PROVINCES, sastDate } from '@onpar/rules';
import { z } from 'zod';
import { CurrentGuard, CurrentUser, GuardOrSelfAuthGuard, GuardPrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { WireService } from './wire.service';

const MILESTONE_DAYS = 60;
const region = (code: string | null) => PROVINCES.find((p) => p.code === code)?.name ?? null;

interface Person {
  id: string;
  name: string;
  showName: boolean;
  siteId: string | null;
  siteName: string | null;
  region: string | null;
  joined: string;
}

/**
 * The recognition board (rule book, 8 Oct 2026): the most improved guards of the last finished
 * month, each against his own record, and Wire milestones. Never a full ranking or a last place.
 */
@Injectable()
export class WireBoardService {
  constructor(private readonly wire: WireService) {}

  async board(tx: Tx, viewer: { siteId: string | null } | 'manager') {
    const { settings, startedOn } = await this.wire.settings(tx);
    const people = new Map(
      (
        await tx.query(
          `SELECT e.id, e.full_name AS name, coalesce(p.show_name, false) AS "showName", s.id AS "siteId", s.name AS "siteName", s.province,
                  to_char(coalesce(p.joined_on, e.created_at::date), 'YYYY-MM-DD') AS joined
             FROM employees e LEFT JOIN wire_profiles p ON p.employee_id = e.id LEFT JOIN sites s ON s.id = e.home_site_id WHERE e.status = 'active'`,
        )
      ).rows.map((r) => [r.id as string, { ...r, region: region(r.province) } as Person]),
    );
    const show = (p: Person) => ({
      display: viewer === 'manager' ? `${p.name}, ${p.siteName ?? ''}` : boardName(p, viewer.siteId !== null && viewer.siteId === p.siteId),
      hidden: !p.showName,
    });

    const month = (await tx.query('SELECT max(month) AS m FROM wire_month_runs')).rows[0].m as string | null;
    const rows = month
      ? (await tx.query(`SELECT employee_id, overall::float, average::float FROM wire_months WHERE month = $1 AND overall IS NOT NULL`, [month])).rows.filter((r) => people.has(r.employee_id))
      : [];
    const improved = mostImproved(rows as { employee_id: string; overall: number; average: number | null }[]).map((r) => ({
      ...show(people.get(r.employee_id)!),
      improvedBy: r.improvedBy,
    }));

    // Milestones passed in the last weeks: the Wire total, entry by entry, starting from his launch credit.
    const since = sastDate(new Date(Date.now() - MILESTONE_DAYS * 86_400_000));
    // Phase 2: each guard's total before the period in one sum, then only the recent entries (not his whole history).
    const before = new Map(
      (await tx.query(`SELECT employee_id, sum(barbs)::int AS n FROM wire_entries WHERE kind = 'earned' AND entry_date < $1 GROUP BY employee_id`, [since])).rows.map((r) => [r.employee_id as string, r.n as number]),
    );
    const entries = (
      await tx.query(`SELECT employee_id, to_char(entry_date, 'YYYY-MM-DD') AS date, barbs FROM wire_entries WHERE kind = 'earned' AND entry_date >= $1 ORDER BY employee_id, entry_date, id`, [since])
    ).rows as { employee_id: string; date: string; barbs: number }[];
    const milestones: { display: string; hidden: boolean; label: string; date: string }[] = [];
    const byGuard = new Map<string, { date: string; barbs: number }[]>();
    for (const e of entries) {
      const list = byGuard.get(e.employee_id);
      if (list) list.push(e);
      else byGuard.set(e.employee_id, [e]);
    }
    for (const id of before.keys()) if (!byGuard.has(id)) byGuard.set(id, []);
    for (const [id, list] of byGuard) {
      const p = people.get(id);
      if (!p) continue;
      const launch = completedYears(p.joined, startedOn) * settings.launchCreditPerYear;
      for (const m of milestonesCrossed(-1, launch, settings)) if (startedOn >= since) milestones.push({ ...show(p), label: m.label, date: startedOn });
      let total = launch + (before.get(id) ?? 0);
      for (const e of list) {
        const next = total + e.barbs;
        for (const m of milestonesCrossed(total, next, settings)) if (e.date >= since) milestones.push({ ...show(p), label: m.label, date: e.date });
        total = next;
      }
    }
    milestones.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { month, improved, milestones: milestones.slice(0, 20) };
  }

  /** His own month in one sentence, said positively. */
  async ownLine(tx: Tx, employeeId: string): Promise<string | null> {
    const m = (await tx.query(`SELECT month, overall::float, average::float, award, streak FROM wire_months WHERE employee_id = $1 ORDER BY month DESC LIMIT 1`, [employeeId])).rows[0];
    if (!m) return null;
    const barbs = (
      await tx.query(`SELECT coalesce(sum(barbs), 0)::int AS n FROM wire_entries WHERE employee_id = $1 AND kind = 'earned' AND to_char(entry_date, 'YYYY-MM') = $2`, [employeeId, m.month])
    ).rows[0].n as number;
    if (m.award === 'standard') return `Last month you held the standard, ${m.streak} month${m.streak === 1 ? '' : 's'} in a row, and earned ${barbs} barbs.`;
    if (m.award === 'improvement') return `Last month you beat your own average by ${Math.round((m.overall - m.average) * 10) / 10} points and earned ${barbs} barbs.`;
    return `Last month you earned ${barbs} barbs.`;
  }
}

@Controller('wire')
@UseGuards(UserAuthGuard)
export class WireBoardController {
  constructor(
    private readonly db: DbService,
    private readonly board: WireBoardService,
  ) {}

  /** The board as managers see it: real names, with a note of who has chosen to stay hidden. */
  @Get('board')
  @RequirePermission('wire.view')
  get(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, (tx) => this.board.board(tx, 'manager'));
  }
}

const ShowBody = z.object({ show: z.boolean() });

@Controller('device/wire')
@UseGuards(GuardOrSelfAuthGuard)
export class GuardWireBoardController {
  constructor(
    private readonly db: DbService,
    private readonly board: WireBoardService,
    private readonly audit: AuditService,
  ) {}

  @Get('board')
  get(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const home = (await tx.query('SELECT home_site_id FROM employees WHERE id = $1', [guard.employeeId])).rows[0]?.home_site_id ?? null;
      const b = await this.board.board(tx, { siteId: guard.siteId ?? home });
      const me = (await tx.query('SELECT coalesce((SELECT show_name FROM wire_profiles WHERE employee_id = $1), false) AS show', [guard.employeeId])).rows[0].show as boolean;
      return {
        month: b.month,
        improved: b.improved.map(({ display, improvedBy }) => ({ display, improvedBy })),
        milestones: b.milestones.map(({ display, label, date }) => ({ display, label, date })),
        ownLine: await this.board.ownLine(tx, guard.employeeId),
        showMyName: me,
      };
    });
  }

  /** His choice: whether his name shows on the board. Off until he turns it on. */
  @Post('show-name')
  @HttpCode(200)
  showName(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const { show } = parseBody(ShowBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => {
      await tx.query(
        `INSERT INTO wire_profiles (employee_id, company_id, joined_on, show_name)
         SELECT id, company_id, created_at::date, $2 FROM employees WHERE id = $1
         ON CONFLICT (employee_id) DO UPDATE SET show_name = excluded.show_name, updated_at = now()`,
        [guard.employeeId, show],
      );
      await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: 'Guard', action: 'wire.show_name', entityType: 'employee', entityId: guard.employeeId, after: { show } });
      return { showMyName: show };
    });
  }
}
