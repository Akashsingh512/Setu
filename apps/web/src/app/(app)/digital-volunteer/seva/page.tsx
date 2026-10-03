import type { Metadata } from 'next';
import { formatPhone } from '@crm/shared';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { requireDv } from '@/lib/dv';
import { formatDateTime, relativeTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { ForgetSenderButton, PendingRequest, RevokeButton, type Candidate, type Plan } from './seva-controls';

export const metadata: Metadata = { title: 'Seva requests' };

type Req = {
  id: string;
  ref: number;
  group_id: string | null;
  chat_jid: string;
  sender_phone: string | null;
  sender_name: string | null;
  request_text: string | null;
  requested_count: number | null;
  requester_profile_id: string | null;
  status: 'pending' | 'fulfilled' | 'rejected' | 'no_leads' | 'cancelled';
  auto: boolean;
  assigned_count: number;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
};

const STATUS: Record<Req['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  pending: { label: 'Waiting', tone: 'warn' },
  fulfilled: { label: 'Leads assigned', tone: 'ok' },
  rejected: { label: 'Declined', tone: 'danger' },
  no_leads: { label: 'No leads available', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export default async function SevaPage() {
  const access = await requireDv('assign_seva');
  const supabase = await createClient();
  const settings = await getOrgSettings();

  const [{ data: reqs }, { data: groups }, { data: cands }, { data: links }, { data: senders }] = await Promise.all([
    supabase.from('dv_seva_requests').select('*').order('created_at', { ascending: false }).limit(60),
    supabase.from('wa_groups').select('id, name'),
    supabase.rpc('dv_seva_candidates'),
    supabase.from('dv_seva_request_leads').select('request_id, revoked_at'),
    supabase.from('dv_sender_links').select('sender_jid, profile_id, linked_at').order('linked_at', { ascending: false }),
  ]);
  const requests = (reqs ?? []) as Req[];
  const candidates = ((cands ?? []) as { id: string; full_name: string; team_name: string | null; has_phone: boolean }[]).map<Candidate>((c) => ({
    id: c.id,
    name: c.full_name,
    team: c.team_name,
    hasPhone: c.has_phone,
  }));
  const nameById = new Map(candidates.map((c) => [c.id, c.name]));
  const groupName = new Map((groups ?? []).map((g) => [g.id as string, g.name as string]));
  const live = new Map<string, number>();
  for (const l of links ?? []) if (!l.revoked_at) live.set(l.request_id as string, (live.get(l.request_id as string) ?? 0) + 1);

  const pending = requests.filter((r) => r.status === 'pending').reverse();
  const done = requests.filter((r) => r.status !== 'pending');
  const plans = new Map<string, Plan>();
  await Promise.all(
    pending
      .filter((r) => r.requester_profile_id)
      .map(async (r) => {
        const { data } = await supabase.rpc('dv_seva_preview', { p_request_id: r.id });
        if (data) plans.set(r.id, data as Plan);
      }),
  );

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-ink-muted">
        When someone asks for numbers to call, leads come only from their own team&apos;s unassigned leads, within their limits. Lead details are sent to the
        volunteer by private message, never into the group. Lead numbers are not shown on this page.
      </p>

      <section aria-labelledby="pending-h" className="space-y-3">
        <h2 id="pending-h" className="font-semibold">
          Waiting for a decision {pending.length ? <span className="text-ink-muted">({pending.length})</span> : null}
        </h2>
        {pending.length === 0 ? (
          <Card>
            <EmptyState title="Nothing waiting" description="New requests appear here when a group is in Assisted mode, or when the person could not be recognised." />
          </Card>
        ) : (
          pending.map((r) => (
            <PendingRequest
              key={r.id}
              id={r.id}
              refNo={r.ref}
              who={r.requester_profile_id ? (nameById.get(r.requester_profile_id) ?? 'Volunteer') : null}
              phone={r.sender_phone ? formatPhone(r.sender_phone) : null}
              senderName={r.sender_name}
              group={r.group_id ? (groupName.get(r.group_id) ?? 'Group') : 'Private chat'}
              text={r.request_text}
              asked={r.requested_count}
              when={relativeTime(r.created_at)}
              plan={plans.get(r.id) ?? null}
              note={r.reason}
              candidates={candidates}
              canIdentify={access.can('assign_seva')}
            />
          ))
        )}
      </section>

      {senders?.length ? (
        <section aria-labelledby="known-h">
          <Card>
            <CardHeader
              title="Remembered senders"
              description="People you confirmed earlier, recognised automatically even though WhatsApp hides their number. Forget one if it was a mistake."
            />
            <ul className="divide-y divide-line">
              {senders.map((l) => (
                <li key={l.sender_jid as string} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span>
                    <span className="font-medium">{nameById.get(l.profile_id as string) ?? 'Volunteer'}</span>
                    <span className="ml-2 text-xs text-ink-muted">WhatsApp id ending …{(l.sender_jid as string).replace(/@.*/, '').slice(-4)}</span>
                  </span>
                  <ForgetSenderButton jid={l.sender_jid as string} />
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      <section aria-labelledby="history-h">
        <Card>
          <CardHeader title="History" description="Recent requests, newest first." />
          {done.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-muted">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {done.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      <span className="mr-1 text-ink-muted">#{r.ref}</span>
                      {r.requester_profile_id ? (nameById.get(r.requester_profile_id) ?? 'Volunteer') : (r.sender_name ?? 'Unknown')}
                      <span className="ml-2">
                        <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                      </span>
                      {r.auto ? <span className="ml-2 text-xs text-ink-muted">automatic</span> : null}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {r.group_id ? (groupName.get(r.group_id) ?? 'Group') : 'Private chat'} · {formatDateTime(r.decided_at ?? r.created_at, settings.default_timezone)}
                      {r.status === 'fulfilled' ? ` · ${r.assigned_count} lead(s), ${live.get(r.id) ?? 0} still assigned` : ''}
                      {r.decided_by ? ` · by ${nameById.get(r.decided_by) ?? 'a person'}` : ''}
                    </p>
                    {r.reason && r.status !== 'fulfilled' ? <p className="mt-0.5 text-xs">{r.reason}</p> : null}
                  </div>
                  {r.status === 'fulfilled' && (live.get(r.id) ?? 0) > 0 ? <RevokeButton id={r.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
