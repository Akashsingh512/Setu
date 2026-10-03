import type { Metadata } from 'next';
import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { Button, Card, EmptyState, PageHeader, cn } from '@/components/ui';
import { requireProfile } from '@/lib/auth';
import { relativeTime, formatDateTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import type { Notification } from '@/lib/types';

export const metadata: Metadata = { title: 'Notifications' };

async function markAllRead() {
  'use server';
  const supabase = await createClient();
  await supabase.rpc('mark_notifications_read', { p_ids: null });
  revalidatePath('/', 'layout');
}

function linkFor(n: Notification): string | null {
  const d = n.data as Record<string, unknown>;
  if (typeof d.lead_id === 'string') return `/leads/${d.lead_id}`;
  if (Array.isArray(d.lead_ids) && d.lead_ids.length === 1) return `/leads/${d.lead_ids[0]}`;
  if (Array.isArray(d.lead_ids)) return '/leads';
  if (typeof d.session_id === 'string') return '/upcoming';
  if (n.type === 'registration_pending') return '/volunteers';
  if (n.type === 'seva_request_pending' || n.type === 'seva_assigned') return '/digital-volunteer/seva';
  if (n.type === 'leads_need_attention') return '/leads?view=attention';
  if (n.type === 'leads_auto_reassigned') return '/dashboard';
  if (n.type === 'volunteer_deactivated_with_leads' && typeof d.profile_id === 'string') return `/leads?assignee=${d.profile_id}`;
  return null;
}

export default async function NotificationsPage() {
  await requireProfile();
  const supabase = await createClient();
  const { data } = await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(100);
  const items = (data ?? []) as Notification[];
  const unread = items.filter((n) => !n.read_at).length;

  return (
    <>
      <PageHeader
        title="Notifications"
        description={unread ? `${unread} unread` : 'All caught up'}
        actions={
          unread ? (
            <form action={markAllRead}>
              <Button variant="secondary" type="submit">
                Mark all as read
              </Button>
            </form>
          ) : undefined
        }
      />
      <Card>
        {items.length ? (
          <ul className="divide-y divide-line">
            {items.map((n) => {
              const href = linkFor(n);
              const body = (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className={cn('text-sm', !n.read_at && 'font-semibold')}>
                      {!n.read_at ? <span className="mr-2 inline-block size-2 rounded-full bg-accent" aria-label="Unread" /> : null}
                      {n.title}
                    </p>
                    <span className="shrink-0 text-xs text-ink-muted" title={formatDateTime(n.created_at)}>
                      {relativeTime(n.created_at)}
                    </span>
                  </div>
                  {n.body ? <p className="mt-0.5 text-sm text-ink-muted">{n.body}</p> : null}
                </>
              );
              return (
                <li key={n.id}>
                  {href ? (
                    <Link href={href} className="block px-5 py-3 hover:bg-canvas">
                      {body}
                    </Link>
                  ) : (
                    <div className="px-5 py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No notifications yet" description="Lead assignments, reassignments, reminders and new programs appear here." />
        )}
      </Card>
    </>
  );
}
