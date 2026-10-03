// Vocabularies mirrored from the database enums (supabase/migrations/*_core_schema.sql).
// Lead statuses are configurable and must be read from the lead_statuses table;
// only the codes the application logic depends on are listed here.

export const ROLES = ['super_admin', 'teacher', 'volunteer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  teacher: 'Teacher / Admin',
  volunteer: 'Volunteer',
};

export const ACCOUNT_STATUSES = ['active', 'inactive'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const CALL_OUTCOMES = ['connected', 'no_answer', 'busy', 'switched_off', 'call_failed', 'wrong_number'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected: 'Connected',
  no_answer: 'No answer',
  busy: 'Busy',
  switched_off: 'Switched off',
  call_failed: 'Call failed',
  wrong_number: 'Wrong number',
};

export const LEAD_SOURCES = ['event', 'public_place', 'referral', 'workshop', 'satsang', 'online', 'other'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  event: 'Event',
  public_place: 'Public place',
  referral: 'Referral',
  workshop: 'Workshop',
  satsang: 'Satsang',
  online: 'Online',
  other: 'Other',
};

/** Status codes referenced by application logic (is_system in the database). */
export const SYSTEM_STATUS = {
  new: 'new',
  assigned: 'assigned',
  doNotContact: 'do_not_contact',
} as const;

export const SESSION_MODES = ['in_person', 'online', 'hybrid'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const SESSION_MODE_LABELS: Record<SessionMode, string> = {
  in_person: 'In person',
  online: 'Online',
  hybrid: 'Hybrid',
};

export const SESSION_STATUSES = ['scheduled', 'cancelled', 'completed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ASSIGNMENT_KINDS = ['manual', 'bulk', 'auto_reassign', 'import', 'auto_assign'] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

export const ASSIGNMENT_END_REASONS = [
  'reassigned_manual',
  'reassigned_auto',
  'unassigned_manual',
  'auto_no_candidate',
  'lead_merged',
] as const;
export type AssignmentEndReason = (typeof ASSIGNMENT_END_REASONS)[number];

export const ASSIGNMENT_END_REASON_LABELS: Record<AssignmentEndReason, string> = {
  reassigned_manual: 'Reassigned by staff',
  reassigned_auto: 'Auto-reassigned (no call within deadline)',
  unassigned_manual: 'Unassigned by staff',
  auto_no_candidate: 'Moved to attention queue (no eligible volunteer)',
  lead_merged: 'Merged into another lead',
};

export const NOTIFICATION_TYPES = [
  'lead_assigned',
  'lead_reassigned_away',
  'leads_auto_reassigned',
  'leads_need_attention',
  'follow_up_due',
  'session_published',
  'session_updated',
  'session_cancelled',
  'volunteer_deactivated_with_leads',
  'announcement',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Maximum leads per assign_leads call (enforced in the database too). */
export const MAX_BULK_ASSIGN = 2000;
