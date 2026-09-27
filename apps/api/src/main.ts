import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { buildAppModule } from './app.module';
import { Config, loadConfig } from './config';

export async function createApp(config: Config = loadConfig()): Promise<INestApplication> {
  const app = await NestFactory.create(buildAppModule(config), { logger: ['error', 'warn'] });
  app.enableCors({ origin: config.webOrigin });
  app.setGlobalPrefix('api');
  return app;
}

if (require.main === module) {
  const config = loadConfig();
  createApp(config).then(async (app) => {
    await app.listen(config.port);
    console.log(`On Par API listening on http://localhost:${config.port}/api`);
  });
}
