import 'server-only';
import { cache } from 'react';
import { localInputToIso } from './format';
import { createClient } from './supabase/server';
import type { Course, LeadStatus, Profile, Team } from './types';

export const getStatuses = cache(async (): Promise<LeadStatus[]> => {
  const supabase = await createClient();
  const { data } = await supabase.from('lead_statuses').select('*').order('sort_order');
  return (data ?? []) as LeadStatus[];
});

export const getCourses = cache(async (activeOnly = true): Promise<Course[]> => {
  const supabase = await createClient();
  let query = supabase.from('courses').select('*').order('name');
  if (activeOnly) query = query.eq('is_active', true);
  const { data } = await query;
  return (data ?? []) as Course[];
});

export const getTeams = cache(async (): Promise<Team[]> => {
  const supabase = await createClient();
  const { data } = await supabase.from('teams').select('*').order('name');
  return (data ?? []) as Team[];
});

/** Profiles visible to the caller (RLS: staff see their scope; volunteers see staff + self). */
export const getVisibleProfiles = cache(async (): Promise<Profile[]> => {
  const supabase = await createClient();
  const { data } = await supabase.from('profiles').select('*').order('full_name');
  return (data ?? []) as Profile[];
});

export const getProfileNames = cache(async (): Promise<Map<string, string>> => {
  const profiles = await getVisibleProfiles();
  return new Map(profiles.map((p) => [p.id, p.full_name || p.email || 'Unnamed']));
});

export function statusMap(statuses: LeadStatus[]): Map<string, LeadStatus> {
  return new Map(statuses.map((s) => [s.code, s]));
}

/** Start of "today" in the given timezone, as an ISO string. */
export function startOfTodayIso(timeZone = 'Asia/Kolkata'): string {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return localInputToIso(`${ymd}T00:00`, timeZone)!;
}
