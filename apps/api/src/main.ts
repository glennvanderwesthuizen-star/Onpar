import { JobRunner } from './common/jobs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { buildAppModule } from './app.module';
import { Config, loadConfig } from './config';
import { TasksService } from './tasks/tasks.service';
import { PatrolsService } from './patrols/patrols.service';
import { RetentionService } from './privacy/retention.service';
import { DutyService } from './attendance/duty.service';
import { WireService } from './wire/wire.service';
import { VisitOnSiteService } from './visitors/visit-onsite.service';
import { VisitPassService } from './visitors/visit-pass.service';
import { NotificationsService } from './notifications/notifications.service';
import { NoticesService } from './notices/notices.service';

export async function createApp(config: Config = loadConfig()): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(buildAppModule(config), { logger: ['error', 'warn'] });
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  // The API only serves data and files, never pages, so it can forbid everything else.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.setGlobalPrefix('api');
  return app;
}

if (require.main === module) {
  const config = loadConfig();
  createApp(config).then(async (app) => {
    await app.listen(config.port);
    // Every background job through one runner: no overlaps, one server at a time, the same logging (phase 2).
    const jobs = new JobRunner(config.databaseUrl);
    const MIN = 60_000;
    jobs.every('Tasks', 5 * MIN, () => app.get(TasksService).runSchedule(new Date()), { now: true });
    jobs.every('Patrols', MIN, () => app.get(PatrolsService).tick(new Date()), { now: true });
    jobs.every('Retention', 24 * 60 * MIN, () => app.get(RetentionService).runAll(new Date()), { now: true });
    jobs.every('Relief', MIN, () => app.get(DutyService).reliefTick(new Date()), { now: true });
    jobs.every('Alerts', 30_000, () => app.get(NotificationsService).dispatchAll());
    jobs.every('Visitor passes', 30 * MIN, () => app.get(VisitPassService).endingTick(), { now: true });
    jobs.every('Overstays', MIN, () => app.get(VisitOnSiteService).tick(new Date()));
    jobs.every('The Wire', 15 * MIN, () => app.get(WireService).sweepAll(), { now: true });
    jobs.every('Notices', 15 * MIN, () => app.get(NoticesService).sweepAll(new Date()));
    console.log(`On Par API listening on http://localhost:${config.port}/api`);
  });
}
