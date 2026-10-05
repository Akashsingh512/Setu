import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { requireFeature } from '@/lib/features';
import { getCourses, getTeams } from '@/lib/data';
import { createClient } from '@/lib/supabase/server';
import type { Lead } from '@/lib/types';
import { updateLead } from '../../actions';
import { LeadForm } from '../../lead-form';

export const metadata: Metadata = { title: 'Edit lead' };

export default async function EditLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireFeature('edit_leads');
  const supabase = await createClient();
  const { data: lead } = await supabase.from('leads').select('*').eq('id', id).maybeSingle<Lead>();
  if (!lead) notFound();
  const [courses, teams] = await Promise.all([getCourses(false), getTeams()]);

  return (
    <>
      <PageHeader title={`Edit ${lead.full_name}`} description={lead.lead_code} />
      <LeadForm
        action={updateLead.bind(null, lead.id)}
        lead={lead}
        courses={courses}
        teams={teams}
        fixedTeamId={profile.role === 'super_admin' ? null : profile.team_id}
      />
    </>
  );
}
