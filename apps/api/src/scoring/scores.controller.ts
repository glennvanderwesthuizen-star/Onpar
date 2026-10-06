import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  addWorkingDays,
  can,
  computeScore,
  mergeScoring,
  queryDeadline,
  sastDate,
  scoringErrors,
  DEFAULT_SCORING,
  EVENT_TYPES,
  POSITION_LABELS,
} from '@onpar/rules';
import {
  CurrentGuard,
  CurrentUser,
  GuardAuthGuard,
  GuardPrincipal,
  RequirePermission,
  UserAuthGuard,
  UserPrincipal, GuardOrSelfAuthGuard } from '../common/auth';
import { parseBody, throwIfErrors } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { ScoringService } from './scoring.service';

const AwardBody = z.object({
  points: z.number().positive('Awards are positive.').multipleOf(0.5, 'Use whole or half points.'),
  reason: z.string().trim().min(5, 'Say what the officer did.'),
});
const ReverseBody = z.object({ reason: z.string().trim().min(5, 'Give the reason for reversing.') });
const AnswerBody = z.object({
  decision: z.enum(['upheld', 'reversed']),
  answer: z.string().trim().min(5, 'Write the answer the officer will see.'),
});
const QueryBody = z.object({ text: z.string().trim().min(5, 'Say why you disagree.').max(2000) });

/** Scores for supervisors and managers (section 6.8). */
@Controller('scores')
@UseGuards(UserAuthGuard)
export class ScoresController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scoring: ScoringService,
  ) {}

  /** Every officer's score and position, for the sites the user can see. */
  @Get()
  @RequirePermission('scores.view')
  list(@CurrentUser() user: UserPrincipal, @Query('siteId') siteId?: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const c = await this.scoring.config(tx);
      const today = sastDate(new Date());
      const from = computeScore([], today, c).from;
      const officers = (
        await tx.query(
          `SELECT e.id, e.full_name AS "name", e.employee_number AS "employeeNumber", s.name AS "siteName"
             FROM employees e JOIN sites s ON s.id = e.home_site_id
            WHERE e.status = 'active' AND ($1::uuid IS NULL OR e.home_site_id = $1::uuid)
              AND ($2::uuid[] IS NULL OR e.home_site_id = ANY($2::uuid[]))
            ORDER BY lower(e.full_name)`,
          [siteId || null, user.siteIds],
        )
      ).rows;
      const events = (
        await tx.query(
          `SELECT employee_id, event_date AS "date", impact::float AS "impact" FROM performance_events
            WHERE event_date >= $1 AND event_date <= $2 AND employee_id = ANY($3::uuid[])`,
          [from, today, officers.map((o) => o.id)],
        )
      ).rows;
      const openQueries = (
        await tx.query(`SELECT employee_id, count(*)::int AS n FROM score_queries WHERE status = 'open' GROUP BY employee_id`)
      ).rows;
      const byEmployee = new Map<string, typeof events>();
      for (const e of events) {
        if (!byEmployee.has(e.employee_id)) byEmployee.set(e.employee_id, []);
        byEmployee.get(e.employee_id)!.push(e);
      }
      return officers.map((o) => {
        const r = computeScore(byEmployee.get(o.id) ?? [], today, c);
        return {
          ...o,
          score: r.score,
          position: r.position,
          positionLabel: POSITION_LABELS[r.position],
          openQueries: openQueries.find((q) => q.employee_id === o.id)?.n ?? 0,
        };
      });
    });
  }

  /** Open queries, oldest deadline first. */
  @Get('queries')
  @RequirePermission('scores.view')
  queries(@CurrentUser() user: UserPrincipal, @Query('status') status = 'open') {
    return this.db.withTenant(user.companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT q.id, q.text, q.asked_at AS "askedAt", q.answer_due AS "answerDue", q.status, q.answer, q.answered_at AS "answeredAt",
                  u.full_name AS "answeredBy", e.id AS "employeeId", e.full_name AS "employeeName", ev.event_type AS "eventType",
                  ev.impact::float AS "impact", ev.evidence, ev.event_date AS "eventDate", s.name AS "siteName"
             FROM score_queries q
             JOIN performance_events ev ON ev.id = q.event_id
             JOIN employees e ON e.id = q.employee_id
             LEFT JOIN sites s ON s.id = e.home_site_id
             LEFT JOIN users u ON u.id = q.answered_by
            WHERE ($1 = 'all' OR q.status = $1 OR ($1 = 'answered' AND q.status <> 'open'))
              AND ($2::uuid[] IS NULL OR e.home_site_id = ANY($2::uuid[]) OR ev.site_id = ANY($2::uuid[]))
            ORDER BY q.status = 'open' DESC, q.answer_due, q.asked_at`,
          [status, user.siteIds],
        )
      ).rows.map((q) => ({ ...q, label: EVENT_TYPES[q.eventType as keyof typeof EVENT_TYPES]?.label ?? q.eventType }));
    });
  }

  /**
   * Answers a query. Upholding the event is for any supervisor; reversing it
   * needs a manager, like every reversal (section 6.8).
   */
  @Post('queries/:id/answer')
  @RequirePermission('scores.answer')
  answer(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const a = parseBody(AnswerBody, body);
    if (a.decision === 'reversed' && !can(user.role, 'scores.reverse')) {
      throw new ForbiddenException('Only a manager can reverse points. You can uphold it, or ask a manager to reverse it.');
    }
    return this.db.withTenant(user.companyId, async (tx) => {
      const q = (
        await tx.query(
          `SELECT q.*, e.home_site_id, ev.site_id FROM score_queries q JOIN employees e ON e.id = q.employee_id
             JOIN performance_events ev ON ev.id = q.event_id WHERE q.id = $1 FOR UPDATE OF q`,
          [id],
        )
      ).rows[0];
      if (!q || !this.canSee(user, q.home_site_id, q.site_id)) throw new NotFoundException('Query not found.');
      if (q.status !== 'open') throw new ConflictException('This query has already been answered.');
      if (a.decision === 'reversed') {
        await this.scoring.reverse(tx, q.event_id, `Query answered: ${a.answer}`, { type: 'user', id: user.userId, label: user.name });
      }
      await tx.query(`UPDATE score_queries SET status = $2, answer = $3, answered_by = $4, answered_at = now() WHERE id = $1`, [
        id,
        a.decision,
        a.answer,
        user.userId,
      ]);
      await this.audit.byUser(tx, user, { action: 'score.query_answer', entityType: 'score_query', entityId: id, after: a });
      return { ok: true };
    });
  }

  @Get('rules')
  @RequirePermission('scores.view')
  rules(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => ({
      config: await this.scoring.config(tx),
      defaults: DEFAULT_SCORING,
      eventTypes: EVENT_TYPES,
    }));
  }

  /** Changes the rules. Events already recorded keep their points; only later events use the new ones (scenario 15). */
  @Put('rules')
  @RequirePermission('scores.rules')
  updateRules(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const next = mergeScoring(body as never);
    throwIfErrors(scoringErrors(next));
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = await this.scoring.config(tx);
      await tx.query(
        `INSERT INTO scoring_settings (company_id, config, updated_by) VALUES (app_company_id(), $1, $2)
         ON CONFLICT (company_id) DO UPDATE SET config = $1, updated_by = $2, updated_at = now()`,
        [JSON.stringify(next), user.userId],
      );
      await this.audit.byUser(tx, user, { action: 'score.rules', entityType: 'company', entityId: user.companyId, before, after: next });
      return next;
    });
  }

  /** One officer's score, every event behind it, and their queries. */
  @Get(':employeeId')
  @RequirePermission('scores.view')
  officer(@CurrentUser() user: UserPrincipal, @Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = await this.employee(tx, user, employeeId);
      const score = await this.scoring.employeeScore(tx, employeeId);
      return { employee: e, ...score, positionLabel: POSITION_LABELS[score.position] };
    });
  }

  /** Award points for good work. Supervisors up to the limit (default +2); larger awards need a manager. */
  @Post(':employeeId/award')
  @RequirePermission('scores.award')
  award(@CurrentUser() user: UserPrincipal, @Param('employeeId', ParseUUIDPipe) employeeId: string, @Body() body: unknown) {
    const a = parseBody(AwardBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = await this.employee(tx, user, employeeId);
      const c = await this.scoring.config(tx);
      const limit = can(user.role, 'scores.reverse') ? c.managerAwardLimit : c.supervisorAwardLimit;
      if (a.points > limit) {
        throw new ForbiddenException(
          limit === c.supervisorAwardLimit
            ? `Supervisors can award up to ${limit} points. Ask a manager for a larger award.`
            : `The most that can be awarded at once is ${limit} points.`,
        );
      }
      const { id } = (
        await tx.query(
          `INSERT INTO performance_events (company_id, employee_id, site_id, event_date, event_type, impact, source_type, evidence,
                                           created_by_type, created_by, created_by_label, reason)
           VALUES (app_company_id(), $1, $2, $3, 'outstanding', $4, 'manual', $5, 'user', $6, $7, $5) RETURNING id`,
          [employeeId, e.siteId, sastDate(new Date()), a.points, a.reason, user.userId, user.name],
        )
      ).rows[0];
      await this.audit.byUser(tx, user, { action: 'score.award', entityType: 'performance_event', entityId: id, after: { ...a, officer: e.name } });
      return { id };
    });
  }

  /** Reverses an event. Managers only (section 6.8). */
  @Post('events/:id/reverse')
  @RequirePermission('scores.reverse')
  reverse(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseBody(ReverseBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const ev = (await tx.query('SELECT employee_id, event_type FROM performance_events WHERE id = $1', [id])).rows[0];
      if (!ev) throw new NotFoundException('Event not found.');
      await this.employee(tx, user, ev.employee_id);
      if (ev.event_type === 'reversal') throw new ConflictException('A reversal cannot itself be reversed.');
      const rid = await this.scoring.reverse(tx, id, reason, { type: 'user', id: user.userId, label: user.name });
      if (!rid) throw new ConflictException('This event has already been reversed.');
      // A reversal settles any open query on the event.
      await tx.query(
        `UPDATE score_queries SET status = 'reversed', answer = $2, answered_by = $3, answered_at = now() WHERE event_id = $1 AND status = 'open'`,
        [id, reason, user.userId],
      );
      await this.audit.byUser(tx, user, { action: 'score.reverse', entityType: 'performance_event', entityId: id, reason });
      return { id: rid };
    });
  }

  private canSee(user: UserPrincipal, homeSiteId: string, eventSiteId?: string | null) {
    return !user.siteIds || user.siteIds.includes(homeSiteId) || (!!eventSiteId && user.siteIds.includes(eventSiteId));
  }

  private async employee(tx: Tx, user: UserPrincipal, id: string) {
    const e = (
      await tx.query(
        `SELECT e.id, e.full_name AS name, e.employee_number AS "employeeNumber", e.home_site_id AS "siteId", s.name AS "siteName"
           FROM employees e JOIN sites s ON s.id = e.home_site_id WHERE e.id = $1`,
        [id],
      )
    ).rows[0];
    if (!e || !this.canSee(user, e.siteId)) throw new NotFoundException('Officer not found.');
    return e;
  }
}

/** The guard's own score on the post device: why it changed, and the Query button. */
@Controller('device/score')
@UseGuards(GuardOrSelfAuthGuard)
export class GuardScoreController {
  constructor(
    private readonly db: DbService,
    private readonly scoring: ScoringService,
  ) {}

  @Get()
  mine(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const s = await this.scoring.employeeScore(tx, guard.employeeId);
      // Who awarded or reversed is shown; internal source IDs are not.
      const events = s.events.map(({ sourceId: _s, ...e }) => e);
      return { ...s, events, positionLabel: POSITION_LABELS[s.position] };
    });
  }

  /** Query a negative event within the window (default 7 days). */
  @Post('events/:id/query')
  query(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { text } = parseBody(QueryBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const ev = (
        await tx.query(
          `SELECT e.id, e.employee_id, e.event_type, e.impact::float AS impact, e.event_date,
                  EXISTS (SELECT 1 FROM performance_events r WHERE r.reverses_event_id = e.id) AS reversed
             FROM performance_events e WHERE e.id = $1`,
          [id],
        )
      ).rows[0];
      if (!ev || ev.employee_id !== guard.employeeId) throw new NotFoundException('Event not found.');
      if (ev.impact >= 0 || ev.event_type === 'reversal') throw new BadRequestException('Only lost points can be queried.');
      if (ev.reversed) throw new ConflictException('This has already been reversed.');
      const c = await this.scoring.config(tx);
      const today = sastDate(new Date());
      if (today > queryDeadline(ev.event_date, c)) {
        throw new ConflictException(`Queries must be made within ${c.queryWindowDays} days.`);
      }
      const due = addWorkingDays(today, c.answerWorkingDays);
      try {
        const q = (
          await tx.query(
            `INSERT INTO score_queries (company_id, event_id, employee_id, text, answer_due) VALUES (app_company_id(), $1, $2, $3, $4)
             RETURNING id, answer_due AS "answerDue"`,
            [id, guard.employeeId, text, due],
          )
        ).rows[0];
        return q;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('You have already queried this.');
        throw e;
      }
    });
  }
}
