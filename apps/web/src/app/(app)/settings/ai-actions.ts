'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/components/form';
import { requireSuperAdmin } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { createClient } from '@/lib/supabase/server';

// Settings > AI (super admins). Keys go straight to the database function, which
// stores them where only the WhatsApp gateway can read them; they are never sent
// back to the browser.

const schema = z.object({
  provider: z.enum(['none', 'anthropic', 'bedrock']),
  anthropic_model: z.string().trim().max(100),
  bedrock_region: z.string().trim().max(40),
  bedrock_model_id: z.string().trim().max(200),
  classify_enabled: z.boolean(),
  draft_enabled: z.boolean(),
  ask_on_whatsapp: z.enum(['ai', 'all', 'none']),
  // Empty = keep the saved key; clear_* = remove it.
  anthropic_key: z.string().trim().max(500),
  aws_key_id: z.string().trim().max(200),
  aws_secret: z.string().trim().max(500),
  clear_anthropic_key: z.boolean(),
  clear_aws_keys: z.boolean(),
});

export async function saveAiSettings(input: z.input<typeof schema>): Promise<ActionState> {
  await requireSuperAdmin();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Some settings are not valid.' };
  const s = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_ai_settings_save', {
    p_provider: s.provider,
    p_anthropic_model: s.anthropic_model,
    p_bedrock_region: s.bedrock_region,
    p_bedrock_model_id: s.bedrock_model_id,
    p_classify: s.classify_enabled,
    p_draft: s.draft_enabled,
    p_ask_on_whatsapp: s.ask_on_whatsapp,
    // null keeps what is saved; '' removes it.
    p_anthropic_key: s.clear_anthropic_key ? '' : s.anthropic_key || null,
    p_aws_key_id: s.clear_aws_keys ? '' : s.aws_key_id || null,
    p_aws_secret: s.clear_aws_keys ? '' : s.aws_secret || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/settings');
  return { ok: true, message: 'AI settings saved. The WhatsApp gateway uses them within a minute.' };
}

/** Asks the gateway (which holds the keys) to make one small test call. */
export async function testAiSettings(): Promise<ActionState> {
  await requireSuperAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc('dv_request_command', { p_command: 'test_ai' });
  if (error) return { error: friendlyError(error) };
  return { ok: true, message: 'Testing… (the gateway must be running)' };
}
