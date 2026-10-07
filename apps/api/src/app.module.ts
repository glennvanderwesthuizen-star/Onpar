import { Controller, Get, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CONFIG, Config, loadConfig } from './config';
import { DbService } from './db/db.service';
import { AuditService } from './audit/audit.service';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { SitesController } from './sites/sites.controller';
import { OfficersController } from './officers/officers.controller';
import { BadgesController } from './officers/badges';
import { SelfieChecksController } from './attendance/selfie-checks.controller';
import { FaceMatchService } from './face/face-match.service';
import { DevicesController } from './devices/devices.controller';
import { DeviceController } from './device-api/device.controller';
import { StorageService } from './storage/storage.service';
import { UserAuthGuard, DeviceAuthGuard, GuardAuthGuard, GuardOrSelfAuthGuard, CustomerAuthGuard, AccountAuthGuard } from './common/auth';
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
import { PrivacyController } from './privacy/privacy.controller';
import { RetentionService } from './privacy/retention.service';
import { RosterService } from './roster/roster.service';
import { RosterController } from './roster/roster.controller';
import { RegisterController } from './roster/register.controller';
import { DevicePanicBoloController, PanicBoloController } from './alerts/panic-bolo.controller';
import { GuardUniformController, UniformController } from './uniform/uniform.controller';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { SupervisorController } from './supervisor/supervisor.controller';
import { CustomersController } from './customers/customers.controller';
import { CustomerAppController } from './customers/customer-app.controller';
import { VisitorSetupController } from './visitors/visitor-setup.controller';
import { GateController } from './visitors/gate.controller';
import { CustomerVisitsController } from './visitors/customer-visits.controller';
import { CustomerPassesController } from './visitors/customer-passes.controller';
import { VisitPassService } from './visitors/visit-pass.service';
import { VisitExitService } from './visitors/visit-exit.service';
import { VisitApprovalService } from './visitors/visit-approval.service';
import { VisitorSetupService } from './visitors/visitor-setup.service';

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
      BadgesController,
      SelfieChecksController,
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
      PrivacyController,
      AuditController,
      RosterController,
      RegisterController,
      DevicePanicBoloController,
      PanicBoloController,
      UniformController,
      GuardUniformController,
      NotificationsController,
      SupervisorController,
      CustomersController,
      CustomerAppController,
      VisitorSetupController,
      GateController,
      CustomerVisitsController,
      CustomerPassesController,
    ],
    providers: [{ provide: CONFIG, useValue: config }, DbService, AuditService, StorageService, RetentionService,
      UserAuthGuard,
      DeviceAuthGuard,
      GuardAuthGuard,
      GuardOrSelfAuthGuard,
      CustomerAuthGuard,
      AccountAuthGuard,
      PinService,
      DutyService,
      TasksService,
      ScoringService,
      ReportsService,
      PatrolsService,
      RosterService,
      FaceMatchService,
      NotificationsService,
      VisitorSetupService,
      VisitApprovalService,
      VisitPassService,
      VisitExitService,
    ],
  })
  class AppModule {}
  return AppModule;
}
