import { PageHeader } from '@/components/ui';
import { requireDv } from '@/lib/dv';
import { DvRealtime } from './realtime';
import { DvTabs } from './tabs';

export default async function DigitalVolunteerLayout({ children }: { children: React.ReactNode }) {
  const access = await requireDv();
  const tabs = [
    { href: '/digital-volunteer', label: 'Overview', show: true },
    { href: '/digital-volunteer/inbox', label: 'Inbox', show: access.can('view_messages') },
    { href: '/digital-volunteer/groups', label: 'Groups', show: true },
    { href: '/digital-volunteer/responses', label: 'Course responses', show: access.can('manage_content') },
    { href: '/digital-volunteer/seva', label: 'Seva requests', show: access.can('assign_seva') },
    { href: '/digital-volunteer/announcements', label: 'Announcements', show: access.can('schedule_announcements') },
    { href: '/digital-volunteer/reports', label: 'Reports', show: access.can('view_audit') },
    { href: '/digital-volunteer/seva/limits', label: 'Seva limits', show: access.can('manage_integration') },
    { href: '/digital-volunteer/account', label: 'WhatsApp account', show: access.can('manage_integration') },
    { href: '/digital-volunteer/operators', label: 'Operators', show: access.isSuperAdmin },
  ].filter((t) => t.show);

  return (
    <>
      <PageHeader title="Digital Volunteer" description="The organisation's WhatsApp assistant." />
      <DvTabs tabs={tabs.map(({ href, label }) => ({ href, label }))} />
      <DvRealtime />
      {children}
    </>
  );
}
