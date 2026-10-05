// Feature access: which features teachers and volunteers get (super admins get all).
// The switches live in public.role_features and every one is enforced in the
// database (private.role_can); the app only uses them to decide what to show.
import type { Role } from './constants';
import { DV_PERMISSION_INFO, DV_PERMISSIONS, type DvPermission } from './digital-volunteer';

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
  ...DV_PERMISSIONS.map((p) => `dv_${p}` as const),
] as const;
export type Feature = (typeof FEATURES)[number];
/** A Digital Volunteer permission given to a whole role ("dv_" + the permission). */
export type DvFeature = `dv_${DvPermission}`;

export function isDvFeature(f: Feature): f is DvFeature {
  return f.startsWith('dv_');
}

/** Digital Volunteer permissions that need a confirmation before a whole role gets them. */
const DV_CAUTION: Partial<Record<DvPermission, string>> = {
  reply_messages: 'They can send WhatsApp messages from the organisation number.',
  manage_groups: 'They decide which groups the bot reads and what it may do there.',
  assign_seva: 'They can approve seva requests, which hands out leads.',
  schedule_announcements: 'They can post announcements to WhatsApp groups.',
  manage_integration: 'They can unlink the WhatsApp number and use the emergency switch.',
};

export interface FeatureInfo {
  label: string;
  description: string;
  group: string;
  /** Lets the person see their whole team's leads. */
  teamWide?: boolean;
  needsTeamLeads?: boolean;
  /** Asked to confirm before switching it on for a whole role. */
  caution?: string;
}

export const FEATURE_INFO: Record<Feature, FeatureInfo> = {
  ...(Object.fromEntries(
    DV_PERMISSIONS.map((p) => [
      `dv_${p}`,
      { label: DV_PERMISSION_INFO[p].label, description: DV_PERMISSION_INFO[p].description, group: 'Digital Volunteer', caution: DV_CAUTION[p] },
    ]),
  ) as Record<DvFeature, FeatureInfo>),
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
  teacher: FEATURES.filter((f) => !isDvFeature(f)),
  volunteer: ['add_leads', 'sevak_directory', 'send_from_setu'],
};
