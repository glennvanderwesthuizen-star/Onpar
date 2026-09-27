/** Roles from brief section 5. Phase 2 roles are listed so the data model is ready for them. */
export const ROLES = [
  'system_admin',
  'company_manager',
  'site_manager',
  'site_supervisor',
  'client_manager',
  'hr_admin',
  'payroll_clerk',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  system_admin: 'System administrator',
  company_manager: 'Company manager',
  site_manager: 'Site manager',
  site_supervisor: 'Site supervisor',
  client_manager: 'Client or estate manager',
  hr_admin: 'HR administrator',
  payroll_clerk: 'Payroll clerk',
};

/** Roles limited to the sites they are assigned to. Everyone else sees the whole company. */
export const SITE_SCOPED_ROLES: readonly Role[] = ['site_manager', 'site_supervisor', 'client_manager'];

/** What each role may do in the foundation milestone. Later milestones add to this. */
export const PERMISSIONS = {
  'sites.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor', 'client_manager'],
  'sites.edit': ['system_admin', 'company_manager'],
  'officers.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor', 'hr_admin'],
  'officers.enrol': ['system_admin', 'company_manager'],
  'officers.unlock': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'devices.manage': ['system_admin'],
  'devices.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'users.manage': ['system_admin'],
  'audit.view': ['system_admin', 'company_manager'],
  'attendance.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'attendance.manage': ['company_manager', 'site_manager', 'site_supervisor'],
  'tasks.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'tasks.manage': ['company_manager', 'site_manager', 'site_supervisor'],
  'scores.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'scores.award': ['company_manager', 'site_manager', 'site_supervisor'],
  'scores.answer': ['company_manager', 'site_manager', 'site_supervisor'],
  'scores.reverse': ['company_manager'],
  'scores.rules': ['company_manager'],
  'reports.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'reports.manage': ['company_manager', 'site_manager', 'site_supervisor'],
  'reports.close': ['company_manager'],
  'people.manage': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'patrols.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'patrols.setup': ['system_admin', 'company_manager', 'site_manager'],
  'patrols.alerts': ['company_manager', 'site_manager', 'site_supervisor'],
  'reorders.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'reorders.manage': ['company_manager', 'site_manager', 'site_supervisor'],
  'kit.manage': ['system_admin', 'company_manager'],
  'kit.issue': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'training.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor', 'hr_admin'],
  'training.record': ['system_admin', 'company_manager', 'hr_admin'],
  'dashboard.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor', 'client_manager', 'hr_admin'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
