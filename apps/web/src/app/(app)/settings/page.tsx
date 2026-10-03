import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { Card, Field, Input, PageHeader } from '@/components/ui';
import { getOrgSettings, requireSuperAdmin } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { SettingsSubmit } from './settings-submit';

export const metadata: Metadata = { title: 'Settings' };

async function saveSettings(formData: FormData) {
  'use server';
  await requireSuperAdmin();
  const schema = z.object({
    org_name: z.string().trim().min(1).max(120),
    default_timezone: z.string().trim().min(1),
    default_phone_country: z.string().trim().regex(/^[A-Z]{2}$/),
    contact_deadline_hours: z.coerce.number().int().min(1).max(168),
    max_auto_reassignments: z.coerce.number().int().min(0).max(20),
    default_max_open_leads: z.union([z.literal(''), z.coerce.number().int().min(0)]).transform((v) => (v === '' ? null : v)),
    follow_up_reminder_minutes: z.coerce.number().int().min(0).max(1440),
    auto_assign_after_minutes: z.coerce.number().int().min(0).max(1440),
  });
  const parsed = schema.parse(Object.fromEntries(formData));
  const supabase = await createClient();
  const { error } = await supabase
    .from('org_settings')
    .update({
      ...parsed,
      auto_reassign_enabled: formData.get('auto_reassign_enabled') === 'on',
      auto_assign_enabled: formData.get('auto_assign_enabled') === 'on',
    })
    .eq('id', true);
  if (error) throw new Error(error.message);
  revalidatePath('/', 'layout');
}

export default async function SettingsPage() {
  await requireSuperAdmin();
  const s = await getOrgSettings();
  return (
    <>
      <PageHeader title="Settings" description="Organisation-wide rules. Changes apply to new assignments." />
      <Card className="max-w-2xl p-5">
        <form action={saveSettings} className="grid gap-4 sm:grid-cols-2">
          <Field label="Organisation name" htmlFor="org_name">
            <Input id="org_name" name="org_name" defaultValue={s.org_name} required />
          </Field>
          <Field label="Default timezone" htmlFor="tz" hint="IANA name, e.g. Asia/Kolkata">
            <Input id="tz" name="default_timezone" defaultValue={s.default_timezone} required />
          </Field>
          <Field label="Default phone country" htmlFor="cc" hint="Two-letter code, e.g. IN">
            <Input id="cc" name="default_phone_country" defaultValue={s.default_phone_country} maxLength={2} required />
          </Field>
          <Field label="Contact deadline (hours)" htmlFor="dl" hint="Leads not called within this time are reassigned.">
            <Input id="dl" name="contact_deadline_hours" type="number" min={1} max={168} defaultValue={s.contact_deadline_hours} required />
          </Field>
          <Field label="Max automatic reassignments per lead" htmlFor="mar" hint="After this, the lead goes to the attention queue.">
            <Input id="mar" name="max_auto_reassignments" type="number" min={0} max={20} defaultValue={s.max_auto_reassignments} required />
          </Field>
          <Field label="Default workload cap (open leads)" htmlFor="cap" hint="Blank = unlimited. Applies to automatic reassignment.">
            <Input id="cap" name="default_max_open_leads" type="number" min={0} defaultValue={s.default_max_open_leads ?? ''} />
          </Field>
          <Field label="Follow-up reminder (minutes before)" htmlFor="rem">
            <Input id="rem" name="follow_up_reminder_minutes" type="number" min={0} max={1440} defaultValue={s.follow_up_reminder_minutes} required />
          </Field>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" name="auto_reassign_enabled" defaultChecked={s.auto_reassign_enabled} className="size-4 accent-accent" />
            Automatic reassignment enabled
          </label>
          <Field
            label="Auto-assign unassigned leads after (minutes)"
            htmlFor="aa"
            hint="Leads nobody assigns go to the team volunteer with the fewest open leads. Checked every 5 minutes."
          >
            <Input id="aa" name="auto_assign_after_minutes" type="number" min={0} max={1440} defaultValue={s.auto_assign_after_minutes} required />
          </Field>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" name="auto_assign_enabled" defaultChecked={s.auto_assign_enabled} className="size-4 accent-accent" />
            Automatic assignment enabled
          </label>
          <div className="flex justify-end sm:col-span-2">
            <SettingsSubmit />
          </div>
        </form>
      </Card>
    </>
  );
}
