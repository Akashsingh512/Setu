'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem, Role } from '@crm/shared';
import { cn } from '@/components/ui';

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function UnreadDot({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="ml-auto rounded-full bg-accent px-1.5 text-xs font-semibold text-on-accent tabular-nums" aria-label={`${count} unread`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function NavLinks({ items, unread }: { items: NavItem[]; unread: number }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-0.5 p-3" aria-label="Main">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActive(pathname, item.href) ? 'page' : undefined}
          className={cn(
            'flex items-center rounded-lg px-3 py-2 text-sm transition-colors',
            isActive(pathname, item.href) ? 'bg-accent-soft font-medium text-accent' : 'text-ink-muted hover:bg-canvas hover:text-ink',
          )}
        >
          {item.label}
          {item.module === 'notifications' ? <UnreadDot count={unread} /> : null}
        </Link>
      ))}
    </nav>
  );
}

const MOBILE: { href: string; label: string; staffLabel?: string }[] = [
  { href: '/dashboard', label: 'Home' },
  { href: '/leads', label: 'My Leads', staffLabel: 'Leads' },
  { href: '/upcoming', label: 'Upcoming' },
  { href: '/notifications', label: 'Alerts' },
  { href: '/profile', label: 'Profile' },
];

export function MobileNav({ role, unread }: { role: Role; unread: number }) {
  const pathname = usePathname();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      aria-label="Main"
    >
      {MOBILE.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn('relative flex min-h-14 flex-col items-center justify-center text-xs', active ? 'font-semibold text-accent' : 'text-ink-muted')}
          >
            {role !== 'volunteer' && item.staffLabel ? item.staffLabel : item.label}
            {item.href === '/notifications' && unread > 0 ? (
              <span className="absolute top-2 right-[calc(50%-1.6rem)] size-2 rounded-full bg-accent" aria-label={`${unread} unread`} />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
