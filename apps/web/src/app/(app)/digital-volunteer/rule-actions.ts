'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { DV_RULE_ACTIONS } from '@crm/shared';
import type { ActionState } from '@/components/form';
import { friendlyError } from '@/lib/errors';
import { createClient } from '@/lib/supabase/server';

// Reply rules and reply approvers. Row-level security / RPC checks decide who may
// change them (Course responses / Manage integration); these validate input.

const ruleSchema = z
  .object({
    id: z.union([z.uuid(), z.literal('')]),
    name: z.string().trim().min(1, 'Give the rule a name.').max(80),
    keywords: z
      .string()
      .transform((v) =>
        v
          .split(/[\n,]/)
          .map((k) => k.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().max(60, 'Each trigger word or phrase can be up to 60 characters.')).min(1, 'Add at least one trigger word.').max(50)),
    action: z.enum(DV_RULE_ACTIONS),
    reply_body: z.string().trim().max(2000),
    course_id: z.union([z.uuid(), z.literal('')]),
    priority: z.coerce.number().int().min(1).max(1000),
    in_groups: z.boolean(),
    in_direct: z.boolean(),
    enabled: z.boolean(),
  })
  .refine((r) => r.action !== 'reply' || r.reply_body, { message: 'Write the reply to send.' })
  .refine((r) => r.action !== 'course' || r.course_id, { message: 'Choose the course.' })
  .refine((r) => r.in_groups || r.in_direct, { message: 'Choose where the rule applies.' });

export async function saveRule(input: z.input<typeof ruleSchema>): Promise<ActionState> {
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Some details are not valid.' };
  const { id, course_id, reply_body, ...rest } = parsed.data;
  const row = { ...rest, reply_body: reply_body || null, course_id: course_id || null };
  const supabase = await createClient();
  const { data, error } = id
    ? await supabase.from('dv_rules').update(row).eq('id', id).select('id')
    : await supabase.from('dv_rules').insert(row).select('id');
  if (error) return { error: friendlyError(error) };
  if (!data?.length) return { error: "You don't have permission to change reply rules." };
  revalidatePath('/digital-volunteer/rules');
  return { ok: true, message: id ? 'Rule saved.' : 'Rule added. It applies to new messages within a minute.' };
}

export async function setRuleEnabled(id: string, enabled: boolean): Promise<ActionState> {
  if (!z.uuid().safeParse(id).success) return { error: 'Invalid rule.' };
  const supabase = await createClient();
  const { data, error } = await supabase.from('dv_rules').update({ enabled }).eq('id', id).select('id');
  if (error) return { error: friendlyError(error) };
  if (!data?.length) return { error: "You don't have permission to change reply rules." };
  revalidatePath('/digital-volunteer/rules');
  return { ok: true };
}

export async function deleteRule(id: string): Promise<ActionState> {
  if (!z.uuid().safeParse(id).success) return { error: 'Invalid rule.' };
  const supabase = await createClient();
  const { error } = await supabase.from('dv_rules').delete().eq('id', id);
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/rules');
  return { ok: true };
}

export async function setReplyApprover(profileId: string, enabled: boolean): Promise<ActionState> {
  if (!z.uuid().safeParse(profileId).success) return { error: 'Invalid person.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_set_reply_approver', { p_profile_id: profileId, p_enabled: enabled });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/digital-volunteer/account');
  return { ok: true };
}
