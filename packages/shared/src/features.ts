// Feature access: which features teachers and volunteers get (super admins get all).
// The switches live in public.role_features and every one is enforced in the
// database (private.role_can); the app only uses them to decide what to show.
import type { Role } from './constants';

export const FEATURES = [
  'team_leads',
  'add_leads',
  'import_leads',
  'edit_leads',
  'assign_leads',
  'manage_volunteers',
  'view_reports',
  'manage_courses',
  'manage_programs',
  'sevak_directory',
  'send_from_setu',
] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_INFO: Record<Feature, { label: string; description: string; group: string; teamWide?: boolean; needsTeamLeads?: boolean }> = {
  team_leads: {
    label: "See the team's leads",
    description: 'All leads of their team, the team dashboard and lead exports. Off: only the leads assigned to them.',
    group: 'Leads',
    teamWide: true,
  },
  add_leads: { label: 'Add leads', description: 'Add new people, including offline from the phone.', group: 'Leads' },
  import_leads: { label: 'Import leads', description: 'Upload a list of leads from a file.', group: 'Leads', needsTeamLeads: true },
  edit_leads: { label: 'Edit leads', description: "Change a lead's details, archive leads and merge duplicates.", group: 'Leads', needsTeamLeads: true },
  assign_leads: { label: 'Assign leads', description: 'Give leads to volunteers and take them back.', group: 'Leads', needsTeamLeads: true },
  send_from_setu: { label: 'Send from Setu number', description: "Send a lead the message and poster from the centre's WhatsApp number.", group: 'Leads' },
  manage_volunteers: {
    label: 'Manage volunteers',
    description: 'The Volunteers page: approve sign-ups, add volunteers, change their limits.',
    group: 'People and programs',
    teamWide: true,
  },
  view_reports: { label: 'Reports', description: 'The Reports page, for the leads they can see.', group: 'People and programs', teamWide: true },
  manage_courses: { label: 'Courses and messages', description: 'Create and edit courses and WhatsApp message templates.', group: 'People and programs' },
  manage_programs: { label: 'Publish programs', description: 'Publish, edit, cancel and complete programs, with posters.', group: 'People and programs' },
  sevak_directory: { label: 'Sevak Directory', description: "See other members' seva profiles.", group: 'People and programs' },
};

/** What each role had before feature access existed (the database seeds the same). */
export const DEFAULT_FEATURES: Record<Exclude<Role, 'super_admin'>, Feature[]> = {
  teacher: [...FEATURES],
  volunteer: ['add_leads', 'sevak_directory', 'send_from_setu'],
};
