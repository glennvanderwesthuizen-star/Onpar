/** Roles from brief section 5. Phase 2 roles are listed so the data model is ready for them. */
export const ROLES = [
  'system_admin',
  'company_manager',
  'site_manager',
  'site_supervisor',
  'client_manager',
  'hr_admin',
  'payroll_clerk',
  'stores_clerk',
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
  stores_clerk: 'Stores clerk',
};

/** Roles limited to the sites they are assigned to. Everyone else sees the whole company. */
export const SITE_SCOPED_ROLES: readonly Role[] = ['site_manager', 'site_supervisor', 'client_manager'];

/**
 * What each role may do. The system administrator may do everything (owner's decision D-37,
 * 4 Oct 2026: one sign-in for all of On Par), including HR records; every action stays audited.
 */
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
  'attendance.manage': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  // Selfie checks (D-36): look at a Duty On/From selfie next to the enrolment photo and say whether it is him.
  'attendance.selfie_check': ['system_admin', 'company_manager', 'site_supervisor'],
  'tasks.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'tasks.manage': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'scores.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'scores.award': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'scores.answer': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'scores.reverse': ['system_admin', 'company_manager'],
  'scores.rules': ['system_admin', 'company_manager'],
  // The Wire, the reward programme (owner, 8 Oct 2026): managers look, the owner (administrator) sets the values.
  'wire.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'wire.manage': ['system_admin'],
  'reports.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'reports.manage': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'reports.close': ['system_admin', 'company_manager'],
  'people.manage': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'patrols.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'patrols.setup': ['system_admin', 'company_manager', 'site_manager'],
  'patrols.alerts': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'reorders.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'reorders.manage': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'kit.manage': ['system_admin', 'company_manager'],
  'kit.issue': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'training.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor', 'hr_admin'],
  'training.record': ['system_admin', 'company_manager', 'hr_admin'],
  'privacy.manage': ['system_admin', 'company_manager'],
  'roster.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'roster.manage': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'roster.patterns': ['system_admin', 'company_manager'],
  'register.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor', 'hr_admin', 'payroll_clerk'],
  'panic.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'panic.manage': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  // Uniform (D-33): see orders; decide lines; stores; collect and deliver; catalogue and site lists; record an issue.
  'uniform.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor', 'stores_clerk'],
  'uniform.review': ['system_admin', 'company_manager', 'site_manager'],
  'uniform.stores': ['system_admin', 'company_manager', 'stores_clerk'],
  'uniform.deliver': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'uniform.catalogue': ['system_admin', 'company_manager'],
  'uniform.issue': ['system_admin', 'company_manager', 'site_manager'],
  // Uniform condition notes: HR records (D-33). Written by supervisors; read by managers and HR; every view audited.
  'hr.uniform_notes.write': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'hr.uniform_notes.view': ['system_admin', 'company_manager', 'site_manager', 'hr_admin'],
  // Visitor management: gates, checks, time limits, categories and the barred list of a site. Only the administrator changes them (owner, 7 Oct 2026).
  'visitors.setup.view': ['system_admin', 'company_manager'],
  'visitors.setup.manage': ['system_admin'],
  // The visitors recorded at a site's gates.
  'visitors.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  // Staff of a unit (cleaners, gardeners): the administrator can register them for a tenant; tenants do it themselves in their app.
  'visitors.staff.manage': ['system_admin'],
  // Clear a visitor exception once it has been looked into (spec: the supervisor clears exceptions).
  'visitors.exceptions': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  // Customers (phase 3, D-39): units, the client and tenants of a site. Only the administrator creates them.
  'customers.view': ['system_admin', 'company_manager'],
  'customers.manage': ['system_admin'],
  // The Electronic Occurrence Book (brief section 27): read, and add a written entry.
  'eob.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'eob.write': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor'],
  'dashboard.view': ['system_admin', 'company_manager', 'site_manager', 'site_supervisor', 'client_manager', 'hr_admin'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
