import type { Metadata } from 'next';
import { Card, EmptyState } from '@/components/ui';
import { getVisibleProfiles } from '@/lib/data';
import { requireDv } from '@/lib/dv';
import { relativeTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { GroupEditor, RefreshGroupsButton, type GroupSettings } from './group-editor';

export const metadata: Metadata = { title: 'WhatsApp groups' };

type GroupRow = GroupSettings & { jid: string; name: string; description: string | null; participant_count: number | null; is_member: boolean; last_activity_at: string | null };

export default async function GroupsPage() {
  const access = await requireDv();
  const supabase = await createClient();
  const [{ data }, profiles] = await Promise.all([
    supabase.from('wa_groups').select('*').order('is_member', { ascending: false }).order('enabled', { ascending: false }).order('name'),
    getVisibleProfiles(),
  ]);
  const groups = (data ?? []) as GroupRow[];
  const canEdit = access.can('manage_groups');
  const admins = profiles
    .filter((p) => p.status === 'active' && (p.role === 'super_admin' || p.role === 'teacher'))
    .map((p) => ({ id: p.id, name: p.full_name || p.email || 'Admin' }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-muted">
          These are the groups the linked number is a member of. The bot ignores a group completely until it is enabled here, and then only does what is ticked.
        </p>
        {canEdit ? <RefreshGroupsButton /> : null}
      </div>

      {groups.length === 0 ? (
        <Card>
          <EmptyState title="No groups yet" description="Once the number is linked, add it to your WhatsApp groups and click Refresh groups." />
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.id} className={g.is_member ? undefined : 'opacity-70'}>
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-3">
              <div className="min-w-0">
                <h2 className="truncate font-semibold">{g.name || 'Unnamed group'}</h2>
                <p className="text-xs text-ink-muted">
                  {g.participant_count != null ? `${g.participant_count} members · ` : ''}
                  {g.last_activity_at ? `last message ${relativeTime(g.last_activity_at)}` : 'no messages read yet'}
                  {!g.is_member ? ' · the number is no longer in this group' : ''}
                </p>
              </div>
              <span className={g.enabled && g.is_member ? 'text-sm font-medium text-ok' : 'text-sm text-ink-muted'}>
                {g.enabled && g.is_member ? 'Enabled' : 'Off'}
              </span>
            </div>
            <GroupEditor group={g} admins={admins} canEdit={canEdit && g.is_member} />
          </Card>
        ))
      )}
    </div>
  );
}
