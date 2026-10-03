import { formatPhone, telUrl } from '@crm/shared';
import type { LeadStatus } from '@/lib/types';
import { Badge, cn } from './ui';

export function StatusBadge({ code, statuses }: { code: string; statuses: Map<string, LeadStatus> }) {
  const s = statuses.get(code);
  const tone = !s
    ? 'neutral'
    : s.blocks_contact
      ? 'danger'
      : code === 'registered' || code === 'converted'
        ? 'ok'
        : s.is_closed
          ? 'neutral'
          : code === 'new' || code === 'assigned'
            ? 'info'
            : code === 'interested'
              ? 'accent'
              : 'warn';
  return <Badge tone={tone}>{s?.label ?? code}</Badge>;
}

export function DeadlineBadge({ deadline, contacted, now }: { deadline: string | null | undefined; contacted: boolean; now: number }) {
  if (!deadline || contacted) return null;
  const ms = new Date(deadline).getTime() - now;
  if (ms < 0) return <Badge tone="danger">Overdue</Badge>;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return <Badge tone={hours <= 6 ? 'warn' : 'info'}>Call within {hours} h</Badge>;
}

export function CallLink({ phone, className, label = 'Call' }: { phone: string; className?: string; label?: string }) {
  return (
    <a
      href={telUrl(phone)}
      className={cn(
        'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium hover:bg-canvas',
        className,
      )}
      aria-label={`Call ${formatPhone(phone)}`}
    >
      <span aria-hidden>📞</span> {label}
    </a>
  );
}
