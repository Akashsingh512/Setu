import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPhone } from '@crm/shared';
import { Badge, Card, cn, EmptyState } from '@/components/ui';
import { getOrgSettings } from '@/lib/auth';
import { requireDv } from '@/lib/dv';
import { formatDateTime, relativeTime } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { CancelOutboxButton, ConfirmFollowUpButton, MarkHandledButton, ReplyBox, SuggestionCard } from './reply-box';

export const metadata: Metadata = { title: 'Inbox' };

type Msg = {
  id: string;
  chat_jid: string;
  direction: 'in' | 'out';
  sender_name: string | null;
  sender_phone: string | null;
  sender_profile_id: string | null;
  lead_id: string | null;
  body: string | null;
  media_type: string | null;
  sent_at: string;
  status: string;
  intent: string | null;
};
type FollowUpCandidate = { follow_up_id: string; lead_id: string; lead_code: string; due_at: string; note: string | null };
type Outbox = { id: string; chat_jid: string; body: string | null; status: string; last_error: string | null; created_at: string; quoted_message_id: string | null };

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ chat?: string }> }) {
  const access = await requireDv('view_messages');
  const { chat } = await searchParams;
  const supabase = await createClient();
  const settings = await getOrgSettings();

  const showFollowUps = !!chat && !chat.endsWith('@g.us') && access.can('update_followups');
  const [recent, groups, thread, pending, followUps] = await Promise.all([
    supabase.from('wa_messages').select('id, chat_jid, direction, sender_name, sender_phone, body, media_type, sent_at, status').order('sent_at', { ascending: false }).limit(400),
    supabase.from('wa_groups').select('jid, name, enabled'),
    chat
      ? supabase.from('wa_messages').select('*').eq('chat_jid', chat).order('sent_at', { ascending: false }).limit(150)
      : Promise.resolve({ data: [] as Msg[] }),
    chat
      ? supabase.from('wa_outbox').select('id, chat_jid, body, status, last_error, created_at, quoted_message_id').eq('chat_jid', chat).in('status', ['queued', 'sending', 'failed', 'pending_approval']).order('created_at')
      : Promise.resolve({ data: [] as Outbox[] }),
    showFollowUps ? supabase.rpc('dv_followup_candidates', { p_chat_jid: chat }) : Promise.resolve({ data: [] as FollowUpCandidate[] }),
  ]);

  const groupName = new Map((groups.data ?? []).map((g) => [g.jid as string, g.name as string]));
  const chats = new Map<string, { last: Msg; title: string; review: number }>();
  for (const m of (recent.data ?? []) as Msg[]) {
    const entry = chats.get(m.chat_jid);
    const title = groupName.get(m.chat_jid) ?? (m.direction === 'in' ? m.sender_name || (m.sender_phone ? formatPhone(m.sender_phone) : 'Unknown') : '');
    if (!entry) chats.set(m.chat_jid, { last: m, title, review: m.status === 'needs_review' ? 1 : 0 });
    else {
      if (!entry.title && title) entry.title = title;
      if (m.status === 'needs_review') entry.review += 1;
    }
  }
  const messages = ((thread.data ?? []) as Msg[]).reverse();
  const leadIds = [...new Set(messages.map((m) => m.lead_id).filter(Boolean))] as string[];
  const { data: leads } = leadIds.length ? await supabase.from('leads').select('id, full_name, lead_code').in('id', leadIds) : { data: [] };
  const leadById = new Map((leads ?? []).map((l) => [l.id as string, l as { id: string; full_name: string; lead_code: string }]));
  const isGroup = chat?.endsWith('@g.us');
  const pendingRows = (pending.data ?? []) as Outbox[];
  const suggestions = pendingRows.filter((o) => o.status === 'pending_approval');
  const outgoing = pendingRows.filter((o) => o.status !== 'pending_approval');
  // A follow-up is confirmed against the lead's latest message in this chat.
  const lastLeadMessage = new Map<string, string>();
  for (const m of messages) if (m.direction === 'in' && m.lead_id) lastLeadMessage.set(m.lead_id, m.id);
  const openFollowUps = ((followUps.data ?? []) as FollowUpCandidate[]).filter((f) => lastLeadMessage.has(f.lead_id));
  const selectedTitle = chat ? (chats.get(chat)?.title ?? groupName.get(chat) ?? chat) : '';

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <Card className={cn('overflow-hidden', chat && 'hidden lg:block')}>
        {chats.size === 0 ? (
          <EmptyState title="No messages yet" description="Messages appear here from enabled groups and direct chats once Digital Volunteer is on." />
        ) : (
          <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
            {[...chats.entries()].map(([jid, c]) => (
              <li key={jid}>
                <Link
                  href={`/digital-volunteer/inbox?chat=${encodeURIComponent(jid)}`}
                  className={cn('block px-4 py-3 hover:bg-canvas', jid === chat && 'bg-accent-soft')}
                  aria-current={jid === chat ? 'true' : undefined}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {jid.endsWith('@g.us') ? '👥 ' : ''}
                      {c.title || 'Chat'}
                    </span>
                    <span className="shrink-0 text-xs text-ink-muted">{relativeTime(c.last.sent_at)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-muted">
                    {c.last.direction === 'out' ? 'You: ' : ''}
                    {c.last.body ?? (c.last.media_type ? `[${c.last.media_type}]` : '')}
                  </p>
                  {c.review ? <Badge tone="warn" className="mt-1">{c.review} to review</Badge> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {chat ? (
        <Card className="flex min-h-[60vh] flex-col">
          <div className="flex items-center gap-3 border-b border-line px-5 py-3">
            <Link href="/digital-volunteer/inbox" className="text-sm text-ink-muted hover:text-ink lg:hidden">
              ← Back
            </Link>
            <h2 className="truncate font-semibold">{selectedTitle}</h2>
          </div>
          {openFollowUps.length ? (
            <div className="border-b border-line bg-canvas px-5 py-3 text-sm">
              <p className="font-medium">Open follow-ups for this lead</p>
              <p className="text-xs text-ink-muted">If the messages show the follow-up happened, close it here. It is recorded on the lead, not counted as a call.</p>
              <ul className="mt-2 space-y-1">
                {openFollowUps.map((f) => (
                  <li key={f.follow_up_id} className="flex flex-wrap items-center gap-x-2">
                    <Link href={`/leads/${f.lead_id}`} className="text-accent hover:underline">
                      {f.lead_code}
                    </Link>
                    <span className="text-ink-muted">due {formatDateTime(f.due_at, settings.default_timezone)}</span>
                    {f.note ? <span className="text-ink-muted">· {f.note}</span> : null}
                    <ConfirmFollowUpButton messageId={lastLeadMessage.get(f.lead_id)!} followUpId={f.follow_up_id} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <ol className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
            {messages.map((m) => {
              const lead = m.lead_id ? leadById.get(m.lead_id) : undefined;
              return (
                <li key={m.id} className={cn('flex flex-col', m.direction === 'out' ? 'items-end' : 'items-start')}>
                  <div className={cn('max-w-[85%] rounded-xl px-3 py-2', m.direction === 'out' ? 'bg-accent-soft' : 'border border-line bg-canvas')}>
                    {m.direction === 'in' && isGroup ? (
                      <p className="text-xs font-medium text-accent">{m.sender_name || (m.sender_phone ? formatPhone(m.sender_phone) : 'Member')}</p>
                    ) : null}
                    <p className="break-words whitespace-pre-wrap">{m.body ?? (m.media_type ? `[${m.media_type}]` : '')}</p>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {formatDateTime(m.sent_at, settings.default_timezone)}
                    {lead ? (
                      <>
                        {' · '}
                        <Link href={`/leads/${lead.id}`} className="text-accent hover:underline">
                          Lead {lead.lead_code}
                        </Link>
                      </>
                    ) : null}
                    {m.status === 'needs_review' ? (
                      <>
                        {' · '}
                        <span className="text-warn">{m.intent === 'seva_request' ? 'seva request' : 'needs a person'}</span>
                        {access.can('reply_messages') ? <MarkHandledButton messageId={m.id} /> : null}
                      </>
                    ) : null}
                  </p>
                  {suggestions
                    .filter((o) => o.quoted_message_id === m.id)
                    .map((o) => (
                      <div key={o.id} className="mt-2 flex w-full justify-end">
                        <SuggestionCard id={o.id} body={o.body ?? ''} canSend={access.can('reply_messages')} />
                      </div>
                    ))}
                </li>
              );
            })}
            {outgoing.map((o) => (
              <li key={o.id} className="flex flex-col items-end">
                <div className="max-w-[85%] rounded-xl border border-dashed border-line-strong px-3 py-2 text-ink-muted">
                  <p className="whitespace-pre-wrap">{o.body}</p>
                </div>
                <p className="mt-0.5 text-xs">
                  {o.status === 'failed' ? <span className="text-danger">Not sent: {o.last_error}</span> : <span className="text-ink-muted">Sending…</span>}
                  {access.can('reply_messages') && o.status !== 'sending' ? <CancelOutboxButton id={o.id} /> : null}
                </p>
              </li>
            ))}
          </ol>
          {access.can('reply_messages') ? <ReplyBox chat={chat} /> : null}
        </Card>
      ) : (
        <Card className="hidden items-center justify-center lg:flex">
          <p className="p-10 text-sm text-ink-muted">Choose a conversation.</p>
        </Card>
      )}
    </div>
  );
}
