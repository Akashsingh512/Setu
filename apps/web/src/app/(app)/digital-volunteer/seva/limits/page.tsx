import type { Metadata } from 'next';
import { Card, CardHeader } from '@/components/ui';
import { requireDv } from '@/lib/dv';
import { createClient } from '@/lib/supabase/server';
import { AllotMessages, ApproverToggle, FollowupReminder, LeadDetailsSwitches, DefaultsForm, LeadAllotters, VolunteerLimitRow, type AllotterCandidate, type LimitRow } from './limit-forms';

export const metadata: Metadata = { title: 'Seva & allotting' };

export default async function SevaLimitsPage() {
  const access = await requireDv('manage_integration');
  const supabase = await createClient();
  const [{ data: settings }, { data: limits }, { data: cands }, { data: approvers }, { data: allotters }] = await Promise.all([
    supabase.from('dv_seva_settings').select('*').eq('id', true).maybeSingle(),
    supabase.from('dv_seva_limits').select('*'),
    supabase.rpc('dv_seva_candidates'),
    supabase.rpc('dv_approver_candidates'),
    access.isSuperAdmin ? supabase.rpc('dv_allotter_candidates') : Promise.resolve({ data: null }),
  ]);
  const [{ data: defAllot }, { data: defWelcome }] = await Promise.all([
    supabase.rpc('dv_allot_default_message', { p_kind: 'allot' }),
    supabase.rpc('dv_allot_default_message', { p_kind: 'welcome' }),
  ]);
  // eslint-disable-next-line react-hooks/purity -- server component: rendered once per request
  const now = Date.now();
  const byProfile = new Map((limits ?? []).map((l) => [l.profile_id as string, l]));
  const volunteers = ((cands ?? []) as { id: string; full_name: string; team_name: string | null }[]).map<LimitRow>((c) => {
    const l = byProfile.get(c.id);
    return {
      profileId: c.id,
      name: c.full_name,
      team: c.team_name,
      perRequest: l?.per_request ?? null,
      maxActive: l?.max_active ?? null,
      daily: l?.daily_limit ?? null,
      weekly: l?.weekly_limit ?? null,
      exceptionPerRequest: l?.exception_until && new Date(l.exception_until).getTime() > now ? (l.exception_per_request ?? null) : null,
      // Whole days left on an exception that has not expired; null once it has.
      exceptionDaysLeft: l?.exception_until && new Date(l.exception_until).getTime() > now ? Math.max(1, Math.ceil((new Date(l.exception_until).getTime() - now) / 86_400_000)) : null,
      note: l?.note ?? '',
    };
  });
  volunteers.sort((a, b) => Number(hasOverride(b)) - Number(hasOverride(a)) || a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-ink-muted">
        These decide how many leads a seva request can give. The smallest applicable number wins: the person&apos;s per-request limit, the group&apos;s limit,
        how many open leads they may hold, and the optional daily and weekly limits. A volunteer&apos;s normal workload cap also applies.
      </p>
      <Card>
        <CardHeader title="Defaults for everyone" description="Leave a box empty for no limit." />
        <div className="p-5">
          <DefaultsForm
            perRequest={settings?.default_per_request ?? 5}
            maxActive={settings?.default_max_active ?? null}
            daily={settings?.daily_limit ?? null}
            weekly={settings?.weekly_limit ?? null}
          />
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Approve from WhatsApp"
          description="Chosen people get a private WhatsApp message for each seva request that needs a decision, and can reply YES 12, YES 12 3 or NO 12 reason. They need the Assign seva leads permission and a phone number in Setu."
        />
        {(approvers ?? []).length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-muted">Nobody can approve seva requests yet. Give someone the Assign seva leads permission on Operators.</p>
        ) : (
          <ul className="divide-y divide-line">
            {((approvers ?? []) as { id: string; full_name: string; has_phone: boolean; can_approve: boolean; is_approver: boolean }[]).map((a) => (
              <ApproverToggle key={a.id} id={a.id} name={a.full_name} hasPhone={a.has_phone} canApprove={a.can_approve} on={a.is_approver} />
            ))}
          </ul>
        )}
      </Card>
      {access.isSuperAdmin ? (
        <Card>
          <CardHeader
            title="Allot leads from WhatsApp"
            description={`These people can write to the Setu number "Allot 5 leads to Srikesh" (a name or a phone number). The leads go to that person's own WhatsApp, saying who allotted them, and their replies with a lead code or name are saved as follow-up comments.`}
          />
          {allotters ? (
            <LeadAllotters people={allotters as AllotterCandidate[]} />
          ) : (
            <p className="px-5 py-4 text-sm text-ink-muted">Run the latest database migration to use this.</p>
          )}
        </Card>
      ) : null}
      {settings && 'followup_wa_minutes' in settings ? (
        <Card>
          <CardHeader
            title="Follow-up reminders on WhatsApp"
            description="Before each follow-up (scheduled in Setu, or on WhatsApp like 'Vimala follow up tomorrow 5pm'), the person who scheduled it gets a WhatsApp reminder with the lead's name, number and last note."
          />
          <FollowupReminder minutes={Number(settings.followup_wa_minutes)} />
        </Card>
      ) : null}
      {settings && 'send_notes' in settings ? (
        <Card>
          <CardHeader
            title="Lead details in WhatsApp messages"
            description="When leads are sent on WhatsApp (seva requests, and 'Allot N leads to …'), also include under each lead:"
          />
          <LeadDetailsSwitches notes={!!settings.send_notes} history={!!settings.send_history} />
        </Card>
      ) : null}
      {defAllot && defWelcome ? (
        <Card>
          <CardHeader
            title="Messages sent with allotted leads"
            description="What the person gets on WhatsApp when leads are allotted to them. Write it in your own words; the {{…}} parts are filled in for each person."
          />
          <AllotMessages
            allot={(settings?.allot_message as string | null) ?? null}
            welcome={(settings?.welcome_message as string | null) ?? null}
            defaults={{ allot: defAllot as string, welcome: defWelcome as string }}
          />
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Per volunteer" description="Only fill in what should differ from the defaults. A temporary exception lifts the per-request limit for a few days." />
        {volunteers.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-muted">No active volunteers in a team yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {volunteers.map((v) => (
              <VolunteerLimitRow key={v.profileId} row={v} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function hasOverride(v: LimitRow) {
  return v.perRequest !== null || v.maxActive !== null || v.daily !== null || v.weekly !== null || v.exceptionPerRequest !== null;
}
