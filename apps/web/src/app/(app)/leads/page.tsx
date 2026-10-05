import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPhone } from '@crm/shared';
import { ButtonLink, Card, EmptyState, Input, PageHeader, Select } from '@/components/ui';
import { getOrgSettings, requireProfile } from '@/lib/auth';
import { getFeatures } from '@/lib/features';
import { getCourses, getProfileNames, getStatuses, getVisibleProfiles, statusMap } from '@/lib/data';
import { formatDateTime, relativeTime } from '@/lib/format';
import { applyLeadFilters, awaitingLeadIds, readLeadFilters, type Filterable } from '@/lib/lead-filters';
import { createClient } from '@/lib/supabase/server';
import type { Lead, LeadStatus, MessageTemplate, UpcomingSession } from '@/lib/types';
import { FilterBar } from './filter-bar';
import { LeadCards, type LeadCardData } from './lead-cards';
import { LeadTable } from './lead-table';

export const metadata: Metadata = { title: 'Leads' };

const PAGE_SIZE = 25;
const NO_MATCH = '00000000-0000-0000-0000-000000000000';

type LeadWithDeadline = Lead & {
  current: { id: string; contact_deadline_at: string; first_contact_at: string | null } | null;
};

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Start the lookups immediately; they don't depend on the profile.
  const lookups = Promise.all([getStatuses(), getCourses(), getVisibleProfiles(), getProfileNames(), getOrgSettings()]);
  const [profile, sp, features] = await Promise.all([requireProfile(), searchParams, getFeatures()]);
  const filters = readLeadFilters(sp);
  const page = Math.max(1, Number(Array.isArray(sp.page) ? sp.page[0] : sp.page) || 1);
  // Feature access "See the team's leads": the team view; otherwise only their own leads.
  const staff = features.has('team_leads');
  // Server Component: rendered once per request, so reading the clock here is safe.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  const supabase = await createClient();
  // Narrow type: the full PostgREST builder type is too deep for TypeScript to infer here.
  type ListQuery = Filterable<ListQuery> & {
    in(column: string, values: string[]): ListQuery;
    order(column: string, opts: { ascending: boolean }): ListQuery;
    range(from: number, to: number): PromiseLike<{ data: LeadWithDeadline[] | null; count: number | null; error: { message: string } | null }>;
  };
  let query = applyLeadFilters(
    supabase
      .from('leads')
      .select('*, current:lead_assignments!leads_current_assignment_fk(id, contact_deadline_at, first_contact_at)', { count: 'exact' }) as unknown as ListQuery,
    filters,
  );
  if (filters.view === 'awaiting' || filters.view === 'overdue') {
    const ids = await awaitingLeadIds(supabase, {
      assigneeId: staff ? undefined : profile.id,
      overdueOnly: filters.view === 'overdue',
    });
    query = query.in('id', ids.length ? ids : [NO_MATCH]);
  }
  query =
    filters.view === 'followups'
      ? query.order('next_follow_up_at', { ascending: true })
      : query.order('created_at', { ascending: false });

  const [{ data, count, error }, [statuses, courses, profiles, names, settings], sessions, templates] = await Promise.all([
    query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
    lookups,
    // For one-tap WhatsApp messages from the list.
    supabase.from('upcoming_sessions').select('*').order('starts_at').limit(100),
    supabase.from('message_templates').select('*').eq('is_active', true),
  ]);
  const leads = data ?? [];
  const sMap = statusMap(statuses);
  const volunteers = staff ? profiles.filter((p) => p.role === 'volunteer') : [];

  // Deadlines of the open assignments on this page (embedded in the lead query).
  const deadlines = new Map(leads.filter((l) => l.current).map((l) => [l.current!.id, l.current!]));

  const activeFilters = [filters.status, filters.view, filters.assignee, filters.course].filter(Boolean).length;
  const cards: LeadCardData[] = leads.map((l) => {
    const a = l.current_assignment_id ? deadlines.get(l.current_assignment_id) : undefined;
    const awaiting = !!a && !a.first_contact_at && !sMap.get(l.status)?.is_closed;
    const msLeft = awaiting ? new Date(a.contact_deadline_at).getTime() - now : null;
    const status = sMap.get(l.status);
    return {
      id: l.id,
      lead_code: l.lead_code,
      full_name: l.full_name,
      phoneDisplay: formatPhone(l.phone),
      phone: l.phone,
      whatsapp: l.whatsapp_phone ?? l.phone,
      courseId: l.course_id,
      statusLabel: status?.label ?? l.status,
      statusTone: statusTone(l.status, status),
      blocked: !!status?.blocks_contact,
      assignee: l.assigned_to ? (names.get(l.assigned_to) ?? 'Volunteer') : null,
      overdue: msLeft !== null && msLeft < 0,
      needsAttention: l.needs_attention,
      deadlineHours: msLeft !== null && msLeft >= 0 ? Math.max(1, Math.round(msLeft / 3_600_000)) : null,
      nextFollowUp: l.next_follow_up_at ? relativeTime(l.next_follow_up_at, now) : null,
    };
  });
  const ctx = {
    courses,
    sessions: (sessions.data ?? []) as UpcomingSession[],
    templates: (templates.data ?? []) as MessageTemplate[],
    volunteerName: profile.full_name,
    volunteerDefaultCourseId: profile.default_course_id,
    timeZone: settings.default_timezone,
  };

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const qs = (overrides: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, page: String(page), ...overrides })) if (v) p.set(k, v);
    return `?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={staff ? 'Leads' : 'My Leads'}
        description={staff ? `${count ?? 0} matching lead(s)` : 'Leads currently assigned to you.'}
        actions={
          staff ? (
            <div className="flex gap-2">
              {features.has('import_leads') ? (
                <ButtonLink href="/leads/import" variant="secondary">
                  Import
                </ButtonLink>
              ) : null}
              {features.has('add_leads') ? <OfflineAddLink /> : null}
              {features.has('add_leads') ? <ButtonLink href="/leads/new">Add lead</ButtonLink> : null}
            </div>
          ) : (
            features.has('add_leads') ? (
              <div className="flex gap-2">
                <OfflineAddLink />
                <ButtonLink href="/leads/new">Add a lead I met</ButtonLink>
              </div>
            ) : null
          )
        }
      />

      <FilterBar
        activeCount={activeFilters}
        search={<Input name="q" defaultValue={filters.q} placeholder="Name, phone or lead ID" aria-label="Search" enterKeyHint="search" />}
      >
        <Select name="status" defaultValue={filters.status ?? ''} aria-label="Status">
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select name="view" defaultValue={filters.view ?? ''} aria-label="View">
          <option value="">All</option>
          <option value="awaiting">Awaiting first call</option>
          <option value="overdue">Overdue (deadline missed)</option>
          <option value="followups">With follow-ups</option>
          {staff ? <option value="attention">Needs attention</option> : null}
        </Select>
        {staff ? (
          <Select name="assignee" defaultValue={filters.assignee ?? ''} aria-label="Volunteer">
            <option value="">Any volunteer</option>
            <option value="none">Unassigned</option>
            {volunteers.map((v) => (
              <option key={v.id} value={v.id}>
                {v.full_name || v.email}
              </option>
            ))}
          </Select>
        ) : (
          <Select name="course" defaultValue={filters.course ?? ''} aria-label="Course">
            <option value="">Any course</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <div className="flex gap-2">
          <button type="submit" className="min-h-10 flex-1 rounded-lg bg-ink px-4 text-sm font-medium text-on-ink">
            Filter
          </button>
          <Link href="/leads" className="flex min-h-10 items-center rounded-lg px-3 text-sm text-ink-muted hover:text-ink">
            Clear
          </Link>
        </div>
      </FilterBar>

      {error ? (
        <Card className="p-5 text-sm text-danger">Could not load leads: {error.message}</Card>
      ) : leads.length === 0 ? (
        <Card>
          <EmptyState
            title={staff ? 'No leads match' : 'No leads assigned to you'}
            description={
              staff ? 'Try clearing filters, or add a lead.' : 'When a teacher assigns leads to you, or you add someone you met, they appear here.'
            }
            action={features.has('add_leads') ? <ButtonLink href="/leads/new">{staff ? 'Add lead' : 'Add a lead I met'}</ButtonLink> : undefined}
          />
        </Card>
      ) : staff ? (
        <LeadTable
          rows={leads.map((l) => {
            const a = l.current_assignment_id ? deadlines.get(l.current_assignment_id) : undefined;
            return {
              id: l.id,
              lead_code: l.lead_code,
              full_name: l.full_name,
              phone: formatPhone(l.phone),
              status: l.status,
              statusLabel: sMap.get(l.status)?.label ?? l.status,
              assignee: l.assigned_to ? (names.get(l.assigned_to) ?? 'Volunteer') : null,
              needs_attention: l.needs_attention,
              overdue: !!a && !a.first_contact_at && !sMap.get(l.status)?.is_closed && new Date(a.contact_deadline_at) < new Date(),
              created_at: formatDateTime(l.created_at),
              last_contact: l.last_contact_at ? relativeTime(l.last_contact_at) : null,
            };
          })}
          volunteers={volunteers.filter((v) => v.status === 'active').map((v) => ({ id: v.id, name: v.full_name || v.email || 'Volunteer', accepting: v.accepting_leads }))}
          totalMatching={count ?? 0}
          filterQuery={qs({ page: undefined }).slice(1)}
          statuses={statuses}
          cards={cards}
          ctx={ctx}
          canAssign={features.has('assign_leads')}
        />
      ) : (
        <LeadCards rows={cards} ctx={ctx} />
      )}

      {totalPages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="text-ink-muted">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? <ButtonLink variant="secondary" href={qs({ page: String(page - 1) })}>Previous</ButtonLink> : null}
            {page < totalPages ? <ButtonLink variant="secondary" href={qs({ page: String(page + 1) })}>Next</ButtonLink> : null}
          </div>
        </nav>
      ) : null}
    </>
  );
}

function statusTone(code: string, s: LeadStatus | undefined): LeadCardData['statusTone'] {
  if (!s) return 'neutral';
  if (s.blocks_contact) return 'danger';
  if (code === 'registered' || code === 'converted') return 'ok';
  if (s.is_closed) return 'neutral';
  if (code === 'new' || code === 'assigned') return 'info';
  if (code === 'interested') return 'accent';
  return 'warn';
}

/** Plain <a>: a full page load, which works even when the page comes from the phone's offline copy. */
function OfflineAddLink() {
  return (
    <a
      href="/capture"
      className="inline-flex min-h-10 items-center justify-center rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-canvas"
    >
      Add offline
    </a>
  );
}
