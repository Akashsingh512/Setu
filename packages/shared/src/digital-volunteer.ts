// Digital Volunteer permissions (mirrors public.dv_permission). Labels for the UI;
// enforcement is in the database (private.dv_can).
export const DV_PERMISSIONS = [
  'view_messages',
  'reply_messages',
  'manage_groups',
  'assign_seva',
  'update_followups',
  'manage_content',
  'schedule_announcements',
  'manage_integration',
  'view_audit',
] as const;
export type DvPermission = (typeof DV_PERMISSIONS)[number];

export const DV_PERMISSION_INFO: Record<DvPermission, { label: string; description: string }> = {
  view_messages: { label: 'View messages', description: 'Read the inbox and message history' },
  reply_messages: { label: 'Reply', description: 'Send replies from the organisation number' },
  manage_groups: { label: 'Manage groups', description: 'Enable groups and set what the bot may do in each' },
  assign_seva: { label: 'Assign seva leads', description: 'Approve seva requests, which assigns leads' },
  update_followups: { label: 'Update follow-ups', description: 'Confirm WhatsApp follow-ups on leads' },
  manage_content: { label: 'Course responses', description: 'Edit the course reply templates' },
  schedule_announcements: { label: 'Announcements & bulk', description: 'Scheduled announcements to groups, and bulk messages to people' },
  manage_integration: { label: 'Manage integration', description: 'Link or unlink the number, emergency switch' },
  view_audit: { label: 'Reports & audit', description: 'See Digital Volunteer activity and audit logs' },
};

export type DvMode = 'manual' | 'assisted' | 'automatic';
export const DV_MODE_LABELS: Record<DvMode, string> = {
  manual: 'Manual - people answer everything',
  assisted: 'Assisted - bot suggests, a person sends',
  automatic: 'Automatic - bot answers approved topics',
};

export const WA_STATUS_LABELS: Record<string, string> = {
  not_linked: 'Not linked',
  waiting_for_scan: 'Waiting for QR scan',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  logged_out: 'Unlinked',
  error: 'Error',
};
