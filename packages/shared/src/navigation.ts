// Role- and feature-based navigation. This only decides what to *show*; access is
// enforced by RLS and RPC checks in the database.
import type { Role } from './constants';
import type { Feature } from './features';

export type WebModule =
  | 'dashboard'
  | 'leads'
  | 'volunteers'
  | 'users'
  | 'courses'
  | 'upcoming'
  | 'directory'
  | 'reports'
  | 'notifications'
  | 'digital_volunteer'
  | 'access'
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
  directory: { module: 'directory', label: 'Sevak Directory', href: '/directory' },
  reports: { module: 'reports', label: 'Reports', href: '/reports' },
  notifications: { module: 'notifications', label: 'Notifications', href: '/notifications' },
  digital_volunteer: { module: 'digital_volunteer', label: 'Digital Volunteer', href: '/digital-volunteer' },
  access: { module: 'access', label: 'Feature access', href: '/access' },
  settings: { module: 'settings', label: 'Settings', href: '/settings' },
  profile: { module: 'profile', label: 'Profile', href: '/profile' },
};

/** Pages a feature switch decides; the rest are for everyone or super admins only. */
const MODULE_FEATURE: Partial<Record<WebModule, Feature>> = {
  volunteers: 'manage_volunteers',
  courses: 'manage_courses',
  reports: 'view_reports',
  directory: 'sevak_directory',
};
const ORDER: WebModule[] = ['dashboard', 'leads', 'volunteers', 'users', 'courses', 'upcoming', 'directory', 'reports', 'notifications', 'access', 'settings', 'profile'];
const SUPER_ADMIN_ONLY: WebModule[] = ['users', 'access', 'settings'];

/**
 * Digital Volunteer is permission-based: shown to super admins and to anyone
 * granted at least one Digital Volunteer permission.
 */
export function navForRole(role: Role, opts: { digitalVolunteer?: boolean; features?: ReadonlySet<Feature> } = {}): NavItem[] {
  const has = (f: Feature) => role === 'super_admin' || !!opts.features?.has(f);
  const items = ORDER.filter((m) => {
    if (SUPER_ADMIN_ONLY.includes(m)) return role === 'super_admin';
    const f = MODULE_FEATURE[m];
    return !f || has(f);
  }).map((m) => (m === 'leads' && !has('team_leads') ? { ...ALL.leads, label: 'My Leads' } : ALL[m]));
  if (opts.digitalVolunteer) {
    const at = items.findIndex((i) => i.module === 'notifications');
    items.splice(at < 0 ? items.length : at, 0, ALL.digital_volunteer);
  }
  return items;
}

export function isStaff(role: Role | null | undefined): boolean {
  return role === 'super_admin' || role === 'teacher';
}
