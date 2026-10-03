// Client-side validation (web + mobile). The database re-validates everything
// with constraints and RPC checks; these schemas exist for good UX, not security.
import { z } from 'zod';
import { CALL_OUTCOMES, LEAD_SOURCES, ROLES, SESSION_MODES } from './constants';
import { normalizePhone } from './phone';
import { unknownPlaceholders } from './messages';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const httpUrl = z
  .string()
  .trim()
  .url('Enter a valid link')
  .refine((v) => /^https?:\/\//i.test(v), 'Link must start with http:// or https://');

// Optional keys must use .nullish(): in zod 4 a union containing z.undefined()
// does not make the key itself optional.
const optionalHttpUrl = z
  .union([httpUrl, z.literal('')])
  .nullish()
  .transform((v) => (v ? v : null));

export function phoneSchema(defaultCountry = 'IN') {
  return z
    .string()
    .transform((value, ctx) => {
      const r = normalizePhone(value, defaultCountry);
      if (!r.ok) {
        ctx.addIssue({ code: 'custom', message: r.error });
        return z.NEVER;
      }
      return r.e164;
    });
}

export function optionalPhoneSchema(defaultCountry = 'IN') {
  return z
    .string()
    .optional()
    .nullable()
    .transform((value, ctx) => {
      if (!value || !value.trim()) return null;
      const r = normalizePhone(value, defaultCountry);
      if (!r.ok) {
        ctx.addIssue({ code: 'custom', message: r.error });
        return z.NEVER;
      }
      return r.e164;
    });
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const timeOfDay = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM');

export function leadInputSchema(defaultCountry = 'IN') {
  return z.object({
    full_name: z.string().trim().min(1, 'Name is required').max(200),
    phone: phoneSchema(defaultCountry),
    whatsapp_phone: optionalPhoneSchema(defaultCountry),
    email: z
      .union([z.email('Enter a valid email'), z.literal('')])
      .nullish()
      .transform((v) => (v ? v : null)),
    source: z.enum(LEAD_SOURCES).default('other'),
    source_detail: optionalText(300),
    met_by_name: optionalText(200),
    met_by_id: z.uuid().optional().nullable(),
    met_on: isoDate.optional().nullable(),
    met_at_time: timeOfDay.optional().nullable(),
    meeting_notes: optionalText(4000),
    course_id: z.uuid().optional().nullable(),
    team_id: z.uuid(),
    notes: optionalText(4000),
  });
}
export type LeadInput = z.output<ReturnType<typeof leadInputSchema>>;

/** One CSV import row (team comes from the import dialog). */
export function leadImportRowSchema(defaultCountry = 'IN') {
  return leadInputSchema(defaultCountry).omit({ team_id: true, met_by_id: true, met_at_time: true });
}

export const callAttemptSchema = z.object({
  lead_id: z.uuid(),
  outcome: z.enum(CALL_OUTCOMES),
  notes: optionalText(4000),
  duration_seconds: z.number().int().min(0).max(86400).optional().nullable(),
  new_status: z.string().optional().nullable(),
  follow_up_at: z.iso.datetime({ offset: true }).optional().nullable(),
  follow_up_note: optionalText(2000),
});
export type CallAttemptInput = z.output<typeof callAttemptSchema>;

export const followUpSchema = z.object({
  lead_id: z.uuid(),
  due_at: z.iso
    .datetime({ offset: true })
    .refine((v) => new Date(v).getTime() > Date.now() - 5 * 60_000, 'Follow-up time must be in the future'),
  note: optionalText(2000),
});

export const noteSchema = z.object({
  lead_id: z.uuid(),
  body: z.string().trim().min(1, 'Note cannot be empty').max(4000),
});

export const courseInputSchema = z.object({
  name: z.string().trim().min(1, 'Course name is required').max(200),
  short_description: optionalText(500),
  details: optionalText(20000),
  target_audience: optionalText(500),
  registration_url: optionalHttpUrl,
  category: optionalText(100),
  is_active: z.boolean().default(true),
  team_id: z.uuid().optional().nullable(),
});
export type CourseInput = z.output<typeof courseInputSchema>;

export const sessionInputSchema = z
  .object({
    course_id: z.uuid(),
    title: optionalText(200),
    description: optionalText(4000),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    timezone: z.string().min(1).default('Asia/Kolkata'),
    schedule_note: optionalText(200),
    mode: z.enum(SESSION_MODES).default('in_person'),
    venue: optionalText(300),
    city: optionalText(120),
    meeting_url: optionalHttpUrl,
    registration_url: optionalHttpUrl,
    instructor_id: z.uuid().optional().nullable(),
    instructor_name: optionalText(200),
    instructions: optionalText(4000),
    team_id: z.uuid().optional().nullable(),
  })
  .refine((s) => new Date(s.ends_at) > new Date(s.starts_at), {
    message: 'End must be after start',
    path: ['ends_at'],
  })
  .refine((s) => s.mode === 'in_person' || s.meeting_url, {
    message: 'Online and hybrid sessions need a meeting link',
    path: ['meeting_url'],
  })
  .refine((s) => s.mode === 'online' || s.venue, {
    message: 'In-person and hybrid sessions need a venue',
    path: ['venue'],
  });
export type SessionInput = z.output<typeof sessionInputSchema>;

export const messageTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  body: z
    .string()
    .min(1)
    .max(4000)
    .superRefine((body, ctx) => {
      const unknown = unknownPlaceholders(body);
      if (unknown.length > 0) {
        ctx.addIssue({ code: 'custom', message: `Unknown placeholder(s): ${unknown.join(', ')}` });
      }
    }),
  course_id: z.uuid().optional().nullable(),
  team_id: z.uuid().optional().nullable(),
  is_default: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

export function inviteUserSchema(defaultCountry = 'IN') {
  return z.object({
    email: z.email('Enter a valid email'),
    full_name: z.string().trim().min(1, 'Name is required').max(200),
    phone: optionalPhoneSchema(defaultCountry),
    role: z.enum(ROLES),
    team_id: z.uuid().optional().nullable(),
  }).refine((u) => u.role === 'super_admin' || !!u.team_id, {
    message: 'Teachers and volunteers must belong to a team',
    path: ['team_id'],
  });
}
export type InviteUserInput = z.output<ReturnType<typeof inviteUserSchema>>;

export const assignLeadsSchema = z.object({
  lead_ids: z.array(z.uuid()).min(1, 'Select at least one lead').max(2000),
  assignee_id: z.uuid('Choose a volunteer'),
  note: optionalText(500),
});
