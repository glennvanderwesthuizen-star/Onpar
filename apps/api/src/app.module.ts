import { Controller, Get, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CONFIG, Config, loadConfig } from './config';
import { DbService } from './db/db.service';
import { AuditService } from './audit/audit.service';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { SitesController } from './sites/sites.controller';
import { OfficersController } from './officers/officers.controller';
import { DevicesController } from './devices/devices.controller';
import { DeviceController } from './device-api/device.controller';
import { StorageService } from './storage/storage.service';
import { UserAuthGuard, DeviceAuthGuard, GuardAuthGuard } from './common/auth';
import { PinService } from './device-api/pin.service';
import { GuardController } from './device-api/guard.controller';
import { DutyService } from './attendance/duty.service';
import { AttendanceController } from './attendance/attendance.controller';
import { TasksService } from './tasks/tasks.service';
import { TasksController, GuardTasksController } from './tasks/tasks.controller';
import { ScoringService } from './scoring/scoring.service';
import { ScoresController, GuardScoreController } from './scoring/scores.controller';
import { ReportsService } from './reports/reports.service';
import { ReportsController, GuardReportsController } from './reports/reports.controller';
import { PatrolsService } from './patrols/patrols.service';
import { PatrolsController, GuardPatrolsController } from './patrols/patrols.controller';
import { ReordersController, GuardReordersController } from './reorders/reorders.controller';
import { TrainingController, GuardTrainingController } from './training/training.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { UsersController } from './users/users.controller';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}

export function buildAppModule(config: Config = loadConfig()) {
  @Module({
    imports: [JwtModule.register({ secret: config.jwtSecret })],
    controllers: [
      HealthController,
      AuthController,
      SitesController,
      OfficersController,
      DevicesController,
      DeviceController,
      GuardController,
      AttendanceController,
      TasksController,
      GuardTasksController,
      ScoresController,
      GuardScoreController,
      ReportsController,
      GuardReportsController,
      PatrolsController,
      GuardPatrolsController,
      ReordersController,
      GuardReordersController,
      TrainingController,
      GuardTrainingController,
      DashboardController,
      UsersController,
      AuditController,
    ],
    providers: [{ provide: CONFIG, useValue: config }, DbService, AuditService, StorageService,
      UserAuthGuard,
      DeviceAuthGuard,
      GuardAuthGuard,
      PinService,
      DutyService,
      TasksService,
      ScoringService,
      ReportsService,
      PatrolsService,
    ],
  })
  class AppModule {}
  return AppModule;
}
