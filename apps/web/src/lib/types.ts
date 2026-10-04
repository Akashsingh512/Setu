// Row shapes used by the web app. Mirrors supabase/migrations; regenerate full
// database types with `supabase gen types` once the schema is stable.
import type { AccountStatus, AssignmentEndReason, AssignmentKind, CallOutcome, LeadSource, Role, SessionMode, SessionStatus } from '@crm/shared';

export interface Profile {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  status: AccountStatus;
  team_id: string | null;
  accepting_leads: boolean;
  max_open_leads: number | null;
  default_course_id: string | null;
  timezone: string | null;
  approval_status: 'approved' | 'pending' | 'rejected';
  recommended_by: string | null;
  seva_days: string[];
  seva_times: string[];
  seva_note: string | null;
  nearest_centre: string | null;
  address: string | null;
  seva_interests: string[];
  last_login_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface Team {
  id: string;
  name: string;
  timezone: string;
  is_active: boolean;
}

export interface LeadStatus {
  code: string;
  label: string;
  sort_order: number;
  is_closed: boolean;
  blocks_contact: boolean;
  is_active: boolean;
  color: string | null;
}

export interface Lead {
  id: string;
  lead_code: string;
  full_name: string;
  phone: string;
  whatsapp_phone: string | null;
  email: string | null;
  source: LeadSource;
  source_detail: string | null;
  met_by_name: string | null;
  met_on: string | null;
  met_at_time: string | null;
  meeting_notes: string | null;
  course_id: string | null;
  team_id: string;
  status: string;
  assigned_to: string | null;
  current_assignment_id: string | null;
  needs_attention: boolean;
  last_contact_at: string | null;
  next_follow_up_at: string | null;
  call_attempt_count: number;
  latest_call_outcome: CallOutcome | null;
  notes: string | null;
  merged_into_id: string | null;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadAssignment {
  id: string;
  lead_id: string;
  assignee_id: string;
  assigned_by: string | null;
  kind: AssignmentKind;
  assigned_at: string;
  contact_deadline_at: string;
  first_contact_at: string | null;
  ended_at: string | null;
  end_reason: AssignmentEndReason | null;
  note: string | null;
}

export interface CallAttempt {
  id: string;
  lead_id: string;
  caller_id: string | null;
  outcome: CallOutcome;
  notes: string | null;
  attempted_at: string;
}

export interface LeadNote {
  id: string;
  lead_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

export interface FollowUp {
  id: string;
  lead_id: string;
  owner_id: string | null;
  due_at: string;
  note: string | null;
  status: 'open' | 'done' | 'cancelled';
  completed_at: string | null;
}

export interface LeadActivity {
  id: number;
  lead_id: string;
  actor_id: string | null;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface Course {
  id: string;
  name: string;
  short_description: string | null;
  details: string | null;
  target_audience: string | null;
  registration_url: string | null;
  category: string | null;
  is_active: boolean;
  team_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CourseSession {
  id: string;
  course_id: string;
  title: string | null;
  description: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  schedule_note: string | null;
  mode: SessionMode;
  venue: string | null;
  city: string | null;
  meeting_url: string | null;
  registration_url: string | null;
  instructor_name: string | null;
  status: SessionStatus;
  instructions: string | null;
  team_id: string | null;
  poster_path: string | null;
}

export interface UpcomingSession extends CourseSession {
  display_title: string;
  display_description: string | null;
  effective_registration_url: string | null;
  course_name: string;
  course_category: string | null;
}

export interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  course_id: string | null;
  is_default: boolean;
  is_active: boolean;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface OrgSettings {
  org_name: string;
  default_timezone: string;
  default_phone_country: string;
  contact_deadline_hours: number;
  auto_reassign_enabled: boolean;
  auto_assign_enabled: boolean;
  auto_assign_after_minutes: number;
  max_auto_reassignments: number;
  default_max_open_leads: number | null;
  follow_up_reminder_minutes: number;
}
