import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROLE_LABELS, type DvPermission } from '@crm/shared';
import { Card } from '@/components/ui';
import { getVisibleProfiles } from '@/lib/data';
import { requireDv } from '@/lib/dv';
import { createClient } from '@/lib/supabase/server';
import { OperatorRow } from './operator-row';

export const metadata: Metadata = { title: 'Digital Volunteer operators' };

export default async function OperatorsPage() {
  const access = await requireDv();
  if (!access.isSuperAdmin) redirect('/digital-volunteer');
  const supabase = await createClient();
  const [profiles, { data: grants }] = await Promise.all([
    getVisibleProfiles(),
    supabase.from('dv_operator_permissions').select('profile_id, permission'),
  ]);
  const byUser = new Map<string, DvPermission[]>();
  for (const g of grants ?? []) byUser.set(g.profile_id, [...(byUser.get(g.profile_id) ?? []), g.permission as DvPermission]);

  const people = profiles
    .filter((p) => p.status === 'active' && p.role !== 'super_admin')
    .sort((a, b) => Number(byUser.has(b.id)) - Number(byUser.has(a.id)) || (a.full_name || '').localeCompare(b.full_name || ''));

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-ink-muted">
        Super admins always have full access. Give other people only what they need. They use their normal CRM login - there are no separate
        passwords. Changes apply immediately and are recorded in the audit log. To give a permission to all teachers or all volunteers at once, use{' '}
        <a href="/access" className="text-accent underline">
          Feature access
        </a>
        .
      </p>
      <Card>
        <ul className="divide-y divide-line">
          {people.map((p) => (
            <OperatorRow
              key={p.id}
              profileId={p.id}
              name={p.full_name || p.email || 'User'}
              role={ROLE_LABELS[p.role]}
              granted={byUser.get(p.id) ?? []}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}
