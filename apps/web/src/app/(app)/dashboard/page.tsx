import type { Metadata } from 'next';
import Link from 'next/link';
import { isStaff } from '@crm/shared';
import { CallLink, DeadlineBadge, StatusBadge } from '@/components/lead-bits';
import { Card, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui';
import { getOrgSettings, requireProfile } from '@/lib/auth';
import { getProfileNames, getStatuses, startOfTodayIso, statusMap } from '@/lib/data';
import { formatDateTime, relativeTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import type { Lead, OrgSettings, Profile } from '@/lib/types';
import { OPEN_LEAD_EMBED, OPEN_LEAD_FILTER } from '@/lib/lead-filters';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const [profile, settings] = await Promise.all([requireProfile(), getOrgSettings()]);
  return isStaff(profile.role) ? (
    <StaffDashboard profile={profile} settings={settings} />
  ) : (
    <VolunteerDashboard profile={profile} settings={settings} />
  );
}

async function VolunteerDashboard({ profile, settings }: { profile: Profile; settings: OrgSettings }) {
  const supabase = await createClient();
  const today = startOfTodayIso(settings.default_timezone);
  const nowIso = new Date().toISOString();
  // Open assignments still waiting for a first call; closed leads (e.g. Registered) owe none.
  const owed = () =>
    supabase.from('lead_assignments').select(`id, ${OPEN_LEAD_EMBED}`, { count: 'exact', head: true }).eq(OPEN_LEAD_FILTER, false).is('ended_at', null).is('first_contact_at', null);
  const endOfDay = new Date(new Date(today).getTime() + 86_400_000).toISOString();
  const mine = () => supabase.from('leads').select('id', { count: 'exact', head: true }).eq('assigned_to', profile.id).is('archived_at', null);

  const [total, awaiting, overdue, contactedToday, followUpsDue, interested, registered, queue, followUps, statuses] = await Promise.all([
    mine(),
    owed().eq('assignee_id', profile.id),
    owed().eq('assignee_id', profile.id).lt('contact_deadline_at', nowIso),
    supabase.from('call_attempts').select('lead_id').eq('caller_id', profile.id).gte('attempted_at', today),
    supabase.from('follow_ups').select('id', { count: 'exact', head: true }).eq('owner_id', profile.id).eq('status', 'open').lt('due_at', endOfDay),
    mine().eq('status', 'interested'),
    mine().eq('status', 'registered'),
    supabase
      .from('lead_assignments')
      .select('contact_deadline_at, lead:leads!lead_assignments_lead_id_fkey!inner(id, full_name, phone, status, lead_code, st:lead_statuses!inner(is_closed))')
      .eq('lead.st.is_closed', false)
      .eq('assignee_id', profile.id)
      .is('ended_at', null)
      .is('first_contact_at', null)
      .order('contact_deadline_at')
      .limit(8),
    supabase
      .from('follow_ups')
      .select('id, due_at, note, lead:leads(id, full_name, phone)')
      .eq('owner_id', profile.id)
      .eq('status', 'open')
      .order('due_at')
      .limit(6),
    getStatuses(),
  ]);
  const sMap = statusMap(statuses);
  const uniqueContacted = new Set((contactedToday.data ?? []).map((c) => c.lead_id)).size;
  type QueueRow = { contact_deadline_at: string; lead: Pick<Lead, 'id' | 'full_name' | 'phone' | 'status' | 'lead_code'> | null };
  type FollowRow = { id: string; due_at: string; note: string | null; lead: Pick<Lead, 'id' | 'full_name' | 'phone'> | null };

  return (
    <>
      <PageHeader title={`Namaste${profile.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}`} description="Leads waiting for you and today's follow-ups." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Assigned leads" value={total.count ?? 0} href="/leads" />
        <Stat label="Awaiting first call" value={awaiting.count ?? 0} tone={(awaiting.count ?? 0) > 0 ? 'warn' : undefined} href="/leads?view=awaiting" />
        <Stat label="Overdue" value={overdue.count ?? 0} tone={(overdue.count ?? 0) > 0 ? 'danger' : undefined} href="/leads?view=awaiting" />
        <Stat label="Contacted today" value={uniqueContacted} />
        <Stat label="Follow-ups due today" value={followUpsDue.count ?? 0} href="/leads?view=followups" />
        <Stat label="Interested" value={interested.count ?? 0} href="/leads?status=interested" />
        <Stat label="Registered" value={registered.count ?? 0} tone="ok" href="/leads?status=registered" />
        <Stat label="Upcoming programs" value="View" href="/upcoming" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Call these first" description={`New leads must be called within ${settings.contact_deadline_hours} hours.`} />
          {(queue.data as unknown as QueueRow[] | null)?.length ? (
            <ul className="divide-y divide-line">
              {(queue.data as unknown as QueueRow[]).map((row) =>
                row.lead ? (
                  <li key={row.lead.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <Link href={`/leads/${row.lead.id}`} className="min-w-0 flex-1">
                      <p className="truncate font-medium">{row.lead.full_name}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <StatusBadge code={row.lead.status} statuses={sMap} />
                        <DeadlineBadge deadline={row.contact_deadline_at} contacted={false} now={Date.parse(nowIso)} />
                      </div>
                    </Link>
                    <CallLink phone={row.lead.phone} />
                  </li>
                ) : null,
              )}
            </ul>
          ) : (
            <EmptyState title="All caught up" description="No new leads are waiting for a first call." />
          )}
        </Card>

        <Card>
          <CardHeader title="Upcoming follow-ups" />
          {(followUps.data as unknown as FollowRow[] | null)?.length ? (
            <ul className="divide-y divide-line">
              {(followUps.data as unknown as FollowRow[]).map((f) =>
                f.lead ? (
                  <li key={f.id} className="flex items-center gap-3 px-5 py-3">
                    <Link href={`/leads/${f.lead.id}`} className="min-w-0 flex-1">
                      <p className="truncate font-medium">{f.lead.full_name}</p>
                      <p className={`text-sm ${new Date(f.due_at) < new Date() ? 'text-danger' : 'text-ink-muted'}`}>
                        {formatDateTime(f.due_at)} · {relativeTime(f.due_at)}
                        {f.note ? ` · ${f.note}` : ''}
                      </p>
                    </Link>
                    <CallLink phone={f.lead.phone} />
                  </li>
                ) : null,
              )}
            </ul>
          ) : (
            <EmptyState title="No follow-ups scheduled" description="Schedule one from a lead after your call." />
          )}
        </Card>
      </div>
    </>
  );
}

async function StaffDashboard({ profile, settings }: { profile: Profile; settings: OrgSettings }) {
  const supabase = await createClient();
  const today = startOfTodayIso(settings.default_timezone);
  const nowIso = new Date().toISOString();
  // Open assignments still waiting for a first call; closed leads (e.g. Registered) owe none.
  const owed = () =>
    supabase.from('lead_assignments').select(`id, ${OPEN_LEAD_EMBED}`, { count: 'exact', head: true }).eq(OPEN_LEAD_FILTER, false).is('ended_at', null).is('first_contact_at', null);
  const leads = () => supabase.from('leads').select('id', { count: 'exact', head: true }).is('archived_at', null);
  const vols = () => supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'volunteer');

  const [total, fresh, unassigned, attention, assignedToday, overdue, followUp, interested, registered, activeVols, inactiveVols, upcoming, contactedToday, recent, names] =
    await Promise.all([
      leads(),
      leads().eq('status', 'new'),
      leads().is('assigned_to', null),
      leads().eq('needs_attention', true),
      supabase.from('lead_assignments').select('id', { count: 'exact', head: true }).gte('assigned_at', today),
      owed().lt('contact_deadline_at', nowIso),
      leads().eq('status', 'follow_up_required'),
      leads().eq('status', 'interested'),
      leads().eq('status', 'registered'),
      vols().eq('status', 'active'),
      vols().eq('status', 'inactive'),
      supabase.from('upcoming_sessions').select('id', { count: 'exact', head: true }),
      supabase.from('call_attempts').select('lead_id').gte('attempted_at', today),
      supabase
        .from('lead_activities')
        .select('id, lead_id, actor_id, type, data, created_at, lead:leads(full_name, lead_code)')
        .in('type', ['assigned', 'unassigned'])
        .order('created_at', { ascending: false })
        .limit(10),
      getProfileNames(),
    ]);
  const contactedUnique = new Set((contactedToday.data ?? []).map((c) => c.lead_id)).size;
  type RecentRow = { id: number; lead_id: string; actor_id: string | null; type: string; data: Record<string, string>; created_at: string; lead: { full_name: string; lead_code: string } | null };

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={profile.role === 'super_admin' ? 'Organisation overview' : 'Your team at a glance'}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Total leads" value={total.count ?? 0} href="/leads" />
        <Stat label="New" value={fresh.count ?? 0} href="/leads?status=new" />
        <Stat label="Unassigned" value={unassigned.count ?? 0} tone={(unassigned.count ?? 0) > 0 ? 'warn' : undefined} href="/leads?assignee=none" />
        <Stat label="Need attention" value={attention.count ?? 0} tone={(attention.count ?? 0) > 0 ? 'danger' : undefined} href="/leads?view=attention" />
        <Stat label={`Not called in ${settings.contact_deadline_hours} h`} value={overdue.count ?? 0} tone={(overdue.count ?? 0) > 0 ? 'danger' : undefined} href="/leads?view=overdue" />
        <Stat label="Assigned today" value={assignedToday.count ?? 0} />
        <Stat label="Contacted today" value={contactedUnique} />
        <Stat label="Follow-up required" value={followUp.count ?? 0} href="/leads?status=follow_up_required" />
        <Stat label="Interested" value={interested.count ?? 0} href="/leads?status=interested" />
        <Stat label="Registered" value={registered.count ?? 0} tone="ok" href="/leads?status=registered" />
        <Stat label="Active volunteers" value={activeVols.count ?? 0} href="/volunteers" />
        <Stat label="Inactive volunteers" value={inactiveVols.count ?? 0} href="/volunteers" />
        <Stat label="Upcoming programs" value={upcoming.count ?? 0} href="/upcoming" />
      </div>

      <Card className="mt-6">
        <CardHeader title="Recent assignment activity" />
        {(recent.data as unknown as RecentRow[] | null)?.length ? (
          <ul className="divide-y divide-line text-sm">
            {(recent.data as unknown as RecentRow[]).map((a) => {
              const who = a.data.assignee_id ? (names.get(a.data.assignee_id) ?? 'a volunteer') : null;
              const by = a.actor_id ? (names.get(a.actor_id) ?? 'staff') : 'System (deadline missed)';
              return (
                <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
                  <span>
                    <Link href={`/leads/${a.lead_id}`} className="font-medium hover:underline">
                      {a.lead?.full_name ?? 'Lead'}
                    </Link>{' '}
                    {a.type === 'assigned' ? <>assigned to {who}</> : <>unassigned</>}
                    <span className="text-ink-muted"> · by {by}</span>
                  </span>
                  <span className="text-ink-muted">{relativeTime(a.created_at)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No assignments yet" description="Assign leads from the Leads page." />
        )}
      </Card>
    </>
  );
}
