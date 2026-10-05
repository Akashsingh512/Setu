import type { Metadata } from 'next';
import type { Feature } from '@crm/shared';
import { PageHeader } from '@/components/ui';
import { requireSuperAdmin } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { AccessMatrix } from './access-matrix';

export const metadata: Metadata = { title: 'Feature access' };

export default async function AccessPage() {
  await requireSuperAdmin();
  const supabase = await createClient();
  const { data } = await supabase.from('role_features').select('role, feature, enabled');
  const on = { teacher: [] as Feature[], volunteer: [] as Feature[] };
  for (const r of (data ?? []) as { role: 'teacher' | 'volunteer'; feature: Feature; enabled: boolean }[]) if (r.enabled) on[r.role].push(r.feature);

  return (
    <>
      <PageHeader
        title="Feature access"
        description="Choose what teachers and volunteers can use. Super admins always have everything. Changes apply straight away."
      />
      <AccessMatrix teacher={on.teacher} volunteer={on.volunteer} />
    </>
  );
}
