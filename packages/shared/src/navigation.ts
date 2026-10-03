// Role-based navigation. This only decides what to *show*; access is enforced
// by RLS and RPC checks in the database.
import type { Role } from './constants';

export type WebModule =
  | 'dashboard'
  | 'leads'
  | 'volunteers'
  | 'users'
  | 'courses'
  | 'upcoming'
  | 'reports'
  | 'notifications'
  | 'digital_volunteer'
  | 'settings'
  | 'profile';

export interface NavItem {
  module: WebModule;
  label: string;
  href: string;
}

const ALL: Record<WebModule, NavItem> = {
  dashboard: { module: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  leads: { module: 'leads', label: 'Leads', href: '/leads' },
  volunteers: { module: 'volunteers', label: 'Volunteers', href: '/volunteers' },
  users: { module: 'users', label: 'Teachers / Users', href: '/users' },
  courses: { module: 'courses', label: 'Courses', href: '/courses' },
  upcoming: { module: 'upcoming', label: 'Upcoming Programs', href: '/upcoming' },
  reports: { module: 'reports', label: 'Reports', href: '/reports' },
  notifications: { module: 'notifications', label: 'Notifications', href: '/notifications' },
  digital_volunteer: { module: 'digital_volunteer', label: 'Digital Volunteer', href: '/digital-volunteer' },
  settings: { module: 'settings', label: 'Settings', href: '/settings' },
  profile: { module: 'profile', label: 'Profile', href: '/profile' },
};

const BY_ROLE: Record<Role, WebModule[]> = {
  super_admin: ['dashboard', 'leads', 'volunteers', 'users', 'courses', 'upcoming', 'reports', 'notifications', 'settings', 'profile'],
  teacher: ['dashboard', 'leads', 'volunteers', 'courses', 'upcoming', 'reports', 'notifications', 'profile'],
  volunteer: ['dashboard', 'leads', 'upcoming', 'notifications', 'profile'],
};

/**
 * Digital Volunteer is permission-based, not role-based: shown to super admins
 * and to anyone granted at least one Digital Volunteer permission.
 */
export function navForRole(role: Role, opts: { digitalVolunteer?: boolean } = {}): NavItem[] {
  const items = BY_ROLE[role].map((m) => (m === 'leads' && role === 'volunteer' ? { ...ALL.leads, label: 'My Leads' } : ALL[m]));
  if (opts.digitalVolunteer) {
    const at = items.findIndex((i) => i.module === 'notifications');
    items.splice(at < 0 ? items.length : at, 0, ALL.digital_volunteer);
  }
  return items;
}

export function canSeeModule(role: Role, module: WebModule): boolean {
  return BY_ROLE[role].includes(module);
}

export function isStaff(role: Role | null | undefined): boolean {
  return role === 'super_admin' || role === 'teacher';
}
