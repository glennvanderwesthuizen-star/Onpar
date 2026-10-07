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
import { VisitPassService } from './visitors/visit-pass.service';
import { NotificationsService } from './notifications/notifications.service';

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
    app.get(TasksService).startScheduler();
    app.get(PatrolsService).startTimer();
    app.get(RetentionService).startTimer();
    app.get(DutyService).startReliefTimer();
    app.get(NotificationsService).startTimer();
    app.get(VisitPassService).startTimer();
    console.log(`On Par API listening on http://localhost:${config.port}/api`);
  });
}
