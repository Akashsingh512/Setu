import type { Metadata } from 'next';
import { getCourses, getStatuses } from '@/lib/data';
import { requireDv } from '@/lib/dv';
import { JourneyEditor } from '../editor';

export const metadata: Metadata = { title: 'New journey' };

export default async function NewJourneyPage() {
  await requireDv('schedule_announcements');
  const [statuses, courses] = await Promise.all([getStatuses(), getCourses()]);
  return (
    <JourneyEditor
      id={null}
      initial={{
        name: '',
        description: '',
        active: true,
        ai_auto_reply: true,
        forward_replies: true,
        pause_on_reply: false,
        resume_after_hours: 48,
        stop_statuses: ['not_interested', 'invalid_number'],
      }}
      initialSteps={[]}
      statuses={statuses.filter((s) => s.is_active && !s.blocks_contact).map((s) => ({ id: s.code, label: s.label }))}
      courses={courses.map((c) => ({ id: c.id, label: c.name }))}
    />
  );
}
